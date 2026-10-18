import { importSessionsAtomically } from '../db';
import { storageErrorCode } from '../storageErrors';
import type { AttachmentRecord, AttachmentRef, ChatError, Execution, Message, Session, ToolInvocation, Usage } from '../types';
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, sniffImageType } from './policy';
import { exportAttachmentsForSessions } from './store';

/**
 * Recovery is a whole-history backup, NOT an API request. Limit UTF-8 JSON to
 * 32 MiB (including whitespace/base64), 1,000 sessions, 100,000 messages and
 * 10,000 unique payloads. Shared refs may expand to at most 64 MiB of UTF-8
 * payloads across all imported copies. Per-file limits still apply; no per-chat/request limit.
 * JSON/tool data: depth <=64, <=500,000 values, no duplicate object keys,
 * accessors or prototype keys. Unknown envelope/typed-record fields are rejected.
 * UI should check File.size before File.text(), then call parseRecovery().
 * Browser-only primitives are intentional: never import the server validator.
 */
export const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;
export const MAX_RECOVERY_SESSIONS = 1000;
export const MAX_RECOVERY_MESSAGES = 100_000;
export const MAX_RECOVERY_ATTACHMENTS = 10_000;
export const MAX_RECOVERY_EXPANDED_BYTES = 64 * 1024 * 1024;

export type RecoverySession = Pick<Session, 'id' | 'messages'>;
export type RecoveryBackup = {
  version: 1 | 2;
  exportedAt: string;
  sessions: RecoverySession[];
  /** Normalized to [] for the old, text-only v1 exporter. */
  attachments: AttachmentRecord[];
};

export class RecoveryValidationError extends Error {
  readonly code: 'InvalidRecovery' | 'RecoveryTooLarge' | 'UnsupportedRecoveryVersion';
  constructor(code: RecoveryValidationError['code'] = 'InvalidRecovery') {
    super(code === 'RecoveryTooLarge' ? 'Recovery backup exceeds the supported limits.' :
      code === 'UnsupportedRecoveryVersion' ? 'Recovery backup version is not supported.' : 'Recovery backup is invalid or incomplete.');
    this.name = 'RecoveryValidationError';
    this.code = code;
  }
}

/** Safe to display separately from invalid-file errors. No raw cause/content. */
export class RecoveryStorageError extends Error {
  readonly code: string;
  constructor(error: unknown) {
    super('Recovery could not be saved. Keep the backup and retry local storage.');
    this.name = 'RecoveryStorageError';
    this.code = storageErrorCode(error);
  }
}

const encoder = new TextEncoder();
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const roles = ['user', 'assistant', 'system', 'data', 'tool'] as const;
const statuses = ['waiting', 'streaming', 'approval', 'tools', 'pending-model', 'retry-wait', 'complete', 'error', 'cancelled', 'interrupted'] as const;
const categories = ['app-rate-limit', 'redis-unavailable', 'provider-rate-limit', 'quota', 'context', 'auth', 'provider', 'network', 'timeout', 'interrupted', 'response-limit', 'content-filter', 'protocol', 'mcp', 'storage', 'attachment', 'request', 'tool-schema', 'image-incompatible', 'model-not-found'] as const;

function invalid(): never { throw new RecoveryValidationError(); }
function tooLarge(): never { throw new RecoveryValidationError('RecoveryTooLarge'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  // Own properties only, including in an already-polluted host environment.
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
  const obj = object(value);
  if (Object.keys(obj).some(key => !allowed.includes(key))) invalid();
  return obj;
}
function string(value: unknown, max = MAX_RECOVERY_BYTES): string {
  if (typeof value !== 'string' || value.length > max) return invalid();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 200);
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) invalid();
  return result;
}
function number(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) return invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid();
  return value as T;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return invalid();
  if (value.length > max) tooLarge();
  return value;
}

/** Validate before copying/stringifying; never invoke getters/toJSON. */
function inspectJSON(value: unknown, depth = 0, budget = { nodes: 0, characters: 0 }): void {
  if (depth > 64 || ++budget.nodes > 500_000) tooLarge();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    budget.characters += value.length;
    if (budget.characters > MAX_RECOVERY_BYTES) tooLarge();
    return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (!value || typeof value !== 'object') invalid();
  const proto = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
  const properties = Reflect.ownKeys(value);
  if (properties.length > 500_000 - budget.nodes) tooLarge();
  for (const key of properties) {
    if (typeof key !== 'string' || forbidden.has(key)) invalid();
    if (isArray && key === 'length') continue;
    if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    budget.characters += key.length;
    inspectJSON(descriptor.value, depth + 1, budget);
  }
  if (isArray && properties.length !== value.length + 1) invalid(); // no sparse arrays
}

function byteLimit(text: string): void {
  if (text.length > MAX_RECOVERY_BYTES || encoder.encode(text).byteLength > MAX_RECOVERY_BYTES) tooLarge();
}

/** Bound nesting BEFORE JSON.parse allocates a tree; reject ambiguous keys. */
function inspectText(text: string): void {
  const stack: Array<{ keys: Set<string>; expectingKey: boolean } | null> = [];
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (i >= text.length) invalid();
      const parent = stack.at(-1);
      if (parent?.expectingKey) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== 'string' || forbidden.has(key) || parent.keys.has(key)) invalid();
        parent.keys.add(key);
        parent.expectingKey = false;
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? { keys: new Set(), expectingKey: true } : null);
      if (stack.length > 64) tooLarge();
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') {
      const parent = stack.at(-1);
      if (parent) parent.expectingKey = true;
    }
    if ((char === '{' || char === '[' || char === ',') && ++tokens > 500_000) tooLarge();
  }
}

function readRef(value: unknown): AttachmentRef {
  const ref = keys(value, ['id', 'name', 'kind', 'mediaType', 'size']);
  const name = string(ref.name, 255);
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) invalid();
  const kind = choice(ref.kind, ['text', 'image']);
  const mediaType = choice(ref.mediaType, kind === 'text' ? ['text/plain'] : ['image/png', 'image/jpeg', 'image/webp']);
  const size = number(ref.size, true);
  if (!size || size > (kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES)) invalid();
  return { id: id(ref.id), name, kind, mediaType, size };
}

function sameRef(a: AttachmentRef, b: AttachmentRef): boolean {
  return a.id === b.id && a.name === b.name && a.kind === b.kind && a.mediaType === b.mediaType && a.size === b.size;
}

function readRecord(value: unknown): AttachmentRecord {
  const record = keys(value, ['id', 'name', 'kind', 'mediaType', 'size', 'data']);
  const { id: recordId, name, kind, mediaType, size } = record;
  const ref = readRef({ id: recordId, name, kind, mediaType, size });
  const data = string(record.data);
  if (ref.kind === 'text') {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data)) invalid();
    const bytes = encoder.encode(data);
    if (bytes.length !== ref.size || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== data) invalid();
  } else {
    const prefix = `data:${ref.mediaType};base64,`;
    if (!data.startsWith(prefix)) invalid();
    const encoded = data.slice(prefix.length);
    if (encoded.length !== Math.ceil(ref.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
    const binary = atob(encoded);
    if (binary.length !== ref.size || btoa(binary) !== encoded) invalid();
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (sniffImageType(bytes) !== ref.mediaType) invalid();
  }
  return { ...ref, data };
}

function readUsage(value: unknown): Usage {
  const raw = keys(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens']);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, number(value)]));
}

function readError(value: unknown): ChatError {
  const raw = keys(value, ['category', 'message', 'retryable', 'retryAt', 'code']);
  return {
    category: choice(raw.category, categories), message: string(raw.message), retryable: boolean(raw.retryable),
    ...(raw.retryAt !== undefined ? { retryAt: number(raw.retryAt) } : {}),
    ...(raw.code !== undefined ? { code: string(raw.code, 100) } : {}),
  };
}

function readExecution(value: unknown, sessionId: string): Execution {
  const raw = keys(value, ['sessionId', 'runId', 'stepId', 'attemptId', 'status', 'startedAt', 'durationMs', 'usage', 'error', 'retryAt', 'retryNumber', 'recovered', 'continuationPending', 'requestSent', 'interruption']);
  if (id(raw.sessionId) !== sessionId) invalid();
  return {
    sessionId, runId: id(raw.runId), stepId: id(raw.stepId), attemptId: id(raw.attemptId),
    status: choice(raw.status, statuses), startedAt: number(raw.startedAt),
    ...(raw.durationMs !== undefined ? { durationMs: number(raw.durationMs) } : {}),
    ...(raw.usage !== undefined ? { usage: readUsage(raw.usage) } : {}),
    ...(raw.error !== undefined ? { error: readError(raw.error) } : {}),
    ...(raw.retryAt !== undefined ? { retryAt: number(raw.retryAt) } : {}),
    ...(raw.retryNumber !== undefined ? { retryNumber: number(raw.retryNumber, true) } : {}),
    ...(raw.recovered !== undefined ? { recovered: boolean(raw.recovered) } : {}),
    ...(raw.continuationPending !== undefined ? { continuationPending: boolean(raw.continuationPending) } : {}),
    ...(raw.requestSent !== undefined ? { requestSent: boolean(raw.requestSent) } : {}),
    ...(raw.interruption !== undefined ? { interruption: choice(raw.interruption, ['user', 'session-switch', 'page-exit', 'reload', 'step-limit'] as const) } : {}),
  };
}

function readTool(value: unknown): ToolInvocation {
  const raw = keys(value, ['toolCallId', 'toolName', 'args', 'state', 'result', 'validation', 'originalName', 'serverId', 'turnCount', 'outcome', 'attemptId']);
  const state = choice(raw.state, ['calling', 'executing', 'needs-approval', 'result']);
  if (state === 'result' && !Object.hasOwn(raw, 'result')) invalid();
  let validation: ToolInvocation['validation'];
  if (raw.validation !== undefined) {
    const v = keys(raw.validation, ['valid', 'missingFields']);
    validation = { valid: boolean(v.valid), missingFields: array(v.missingFields, 10_000).map(value => string(value)) };
  }
  return {
    toolCallId: id(raw.toolCallId), toolName: id(raw.toolName), args: { ...object(raw.args) }, state,
    ...(Object.hasOwn(raw, 'result') ? { result: raw.result } : {}),
    ...(validation ? { validation } : {}),
    ...(raw.originalName !== undefined ? { originalName: id(raw.originalName) } : {}),
    ...(raw.serverId !== undefined ? { serverId: id(raw.serverId) } : {}),
    ...(raw.turnCount !== undefined ? { turnCount: number(raw.turnCount, true) } : {}),
    ...(raw.outcome !== undefined ? { outcome: choice(raw.outcome, ['success', 'declined', 'error', 'unknown'] as const) } : {}),
    ...(raw.attemptId !== undefined ? { attemptId: id(raw.attemptId) } : {}),
  };
}

function readMessage(value: unknown, sessionId: string): Message {
  const raw = keys(value, ['id', 'role', 'content', 'toolInvocations', 'attachments', 'reasoning', 'reasoningOpen', 'error', 'statusLine', 'execution']);
  const role = choice(raw.role, roles);
  const tools = raw.toolInvocations === undefined ? undefined : array(raw.toolInvocations, 10_000).map(readTool);
  if (tools && (role !== 'assistant' || new Set(tools.map(t => t.toolCallId)).size !== tools.length)) invalid();
  const refs = raw.attachments === undefined ? undefined : array(raw.attachments, MAX_ATTACHMENTS).map(readRef);
  if (refs && ((refs.length > 0 && role !== 'user') || new Set(refs.map(r => r.id)).size !== refs.length)) invalid();
  return {
    id: id(raw.id), role, content: string(raw.content),
    ...(tools ? { toolInvocations: tools } : {}), ...(refs ? { attachments: refs } : {}),
    ...(raw.reasoning !== undefined ? { reasoning: raw.reasoning === null ? null : string(raw.reasoning) } : {}),
    ...(raw.reasoningOpen !== undefined ? { reasoningOpen: boolean(raw.reasoningOpen) } : {}),
    ...(raw.error !== undefined ? { error: string(raw.error) } : {}),
    ...(raw.statusLine !== undefined ? { statusLine: string(raw.statusLine) } : {}),
    ...(raw.execution !== undefined ? { execution: readExecution(raw.execution, sessionId) } : {}),
  };
}

function validate(value: unknown): RecoveryBackup {
  inspectJSON(value);
  const json = JSON.stringify(value);
  byteLimit(json);
  // Detach args/results as well: a caller must not mutate already validated
  // data while image decoding or opening IndexedDB is pending.
  const raw = keys(JSON.parse(json), ['version', 'exportedAt', 'sessions', 'attachments']);
  if (raw.version !== 1 && raw.version !== 2) throw new RecoveryValidationError('UnsupportedRecoveryVersion');
  const exportedAt = string(raw.exportedAt, 30);
  const timestamp = Date.parse(exportedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== exportedAt) invalid();
  const attachments = raw.version === 1 && raw.attachments === undefined ? [] : array(raw.attachments, MAX_RECOVERY_ATTACHMENTS).map(readRecord);
  if (raw.version === 1 && attachments.length) invalid();
  const records = new Map(attachments.map(record => [record.id, record]));
  if (records.size !== attachments.length) invalid();
  const payloadBytes = new Map(attachments.map(record => [record.id, encoder.encode(record.data).length]));
  let expandedBytes = 0;
  let messages = 0;
  const sessionIds = new Set<string>();
  const referenced = new Set<string>();
  const sessions = array(raw.sessions, MAX_RECOVERY_SESSIONS).map(value => {
    const raw = keys(value, ['id', 'messages']);
    const sessionId = id(raw.id);
    if (sessionIds.has(sessionId)) invalid();
    sessionIds.add(sessionId);
    const list = array(raw.messages, MAX_RECOVERY_MESSAGES).map(value => readMessage(value, sessionId));
    if ((messages += list.length) > MAX_RECOVERY_MESSAGES) tooLarge();
    if (new Set(list.map(message => message.id)).size !== list.length) invalid();
    const owned = new Set<string>();
    for (const message of list) {
      for (const ref of message.attachments ?? []) {
        const record = records.get(ref.id);
        if (!record || !sameRef(record, ref)) invalid();
        referenced.add(ref.id);
        if (!owned.has(ref.id)) {
          owned.add(ref.id);
          expandedBytes += payloadBytes.get(ref.id)!;
          if (expandedBytes > MAX_RECOVERY_EXPANDED_BYTES) tooLarge();
        }
      }
    }
    return { id: sessionId, messages: list };
  });
  if (!sessions.length || referenced.size !== records.size) invalid();
  return { version: raw.version, exportedAt, sessions, attachments };
}

async function verifyImages(records: AttachmentRecord[]): Promise<void> {
  for (const record of records) {
    if (record.kind !== 'image') continue;
    let bitmap: ImageBitmap | undefined;
    try {
      const binary = atob(record.data.slice(record.data.indexOf(',') + 1));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      bitmap = await createImageBitmap(new Blob([bytes], { type: record.mediaType }));
      const pixels = bitmap.width * bitmap.height;
      if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 16_000_000) invalid();
    } catch { invalid(); }
    finally { bitmap?.close(); }
  }
}

/** No disk/RAM staging/network side effects, including on malformed JSON. */
export function parseRecovery(text: string): RecoveryBackup {
  try {
    if (typeof text !== 'string') invalid();
    byteLimit(text);
    inspectText(text);
    return validate(JSON.parse(text));
  } catch (error) {
    if (error instanceof RecoveryValidationError) throw error;
    throw new RecoveryValidationError();
  }
}

/**
 * Optional replacement for the existing exporter. Snapshot BEFORE awaiting disk
 * reads; returns a validated object for JSON.stringify(), not a download/string.
 * v1/v2 import also works with the existing exporter, without this helper.
 */
export async function createRecoveryExport(sessions: readonly RecoverySession[]): Promise<RecoveryBackup> {
  const snapshot: RecoverySession[] = JSON.parse(JSON.stringify(sessions.map(({ id, messages }) => ({ id, messages }))));
  const attachments = await exportAttachmentsForSessions(snapshot);
  return validate({ version: 2, exportedAt: new Date().toISOString(), sessions: snapshot, attachments });
}

/**
 * Revalidate at the write boundary, then add recovered copies atomically. Never
 * stage/forget RAM, import settings, attach live MCP bindings or resume work.
 * The same backup remains reusable after failure OR success (new copies).
 * parseRecovery checks structure/signatures synchronously; image decoding and
 * the 16 MP limit are checked here, before any storage writes.
 */
export async function importRecovery(backup: RecoveryBackup): Promise<Session[]> {
  let valid: RecoveryBackup;
  try { valid = validate(backup); }
  catch (error) {
    if (error instanceof RecoveryValidationError) throw error;
    throw new RecoveryValidationError();
  }
  // Decode sequentially and before opening a write transaction. A signature
  // alone cannot prove an image is decodable or enforce the 16 MP pixel limit.
  await verifyImages(valid.attachments);
  const records = new Map(valid.attachments.map(record => [record.id, record]));
  const entries = valid.sessions.map(source => {
    const sessionId = crypto.randomUUID();
    const refs = new Map<string, AttachmentRecord>();
    const executionIds = new Map<string, string>();
    const remap = (domain: string, old: string) => {
      const key = `${domain}:${old}`;
      if (!executionIds.has(key)) executionIds.set(key, crypto.randomUUID());
      return executionIds.get(key)!;
    };
    const messages = source.messages.map(message => {
      const { execution, toolInvocations, attachments, ...rest } = message;
      delete rest.statusLine;
      const pendingTools = toolInvocations?.some(tool => tool.state !== 'result');
      const active = Boolean(pendingTools || message.reasoningOpen || execution && !['complete', 'error', 'cancelled', 'interrupted'].includes(execution.status));
      const tools = toolInvocations?.map(tool => {
        // These fields bind a call to locally configured capabilities. Preserve
        // historical args/results, never those bindings or an approval action.
        const { attemptId, ...rest } = tool;
        delete rest.serverId;
        delete rest.originalName;
        return {
          ...rest, toolCallId: remap('tool', tool.toolCallId),
          ...(attemptId ? { attemptId: remap('attempt', attemptId) } : {}),
          ...(tool.state !== 'result' ? { state: 'result' as const, outcome: tool.state === 'executing' ? 'unknown' as const : 'declined' as const,
            result: { error: 'Recovery interrupted this tool call. It was not resumed.' } } : {}),
        };
      });
      const recoveredExecution: Execution | undefined = execution || active ? {
        ...(execution ?? { sessionId, runId: crypto.randomUUID(), stepId: crypto.randomUUID(), attemptId: crypto.randomUUID(), status: 'interrupted', startedAt: Date.now() }),
        sessionId,
        ...(execution ? { runId: remap('run', execution.runId), stepId: remap('step', execution.stepId), attemptId: remap('attempt', execution.attemptId) } : {}),
        recovered: true, continuationPending: false,
        ...(active ? { status: 'interrupted', interruption: 'reload', error: { category: 'interrupted', message: 'Recovered execution was interrupted. Nothing was resumed.', retryable: false } } : {}),
      } : undefined;
      if (recoveredExecution) { delete recoveredExecution.retryAt; delete recoveredExecution.retryNumber; }
      return {
        ...rest, id: crypto.randomUUID(), reasoningOpen: false,
        ...(tools ? { toolInvocations: tools } : {}),
        ...(recoveredExecution ? { execution: recoveredExecution } : {}),
        ...(attachments ? { attachments: attachments.map(ref => {
          if (!refs.has(ref.id)) refs.set(ref.id, { ...records.get(ref.id)!, id: crypto.randomUUID() });
          const record = refs.get(ref.id)!;
          return { id: record.id, name: record.name, kind: record.kind, mediaType: record.mediaType, size: record.size };
        }) } : {}),
      } satisfies Message;
    });
    const title = messages.find(message => message.role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 70) || 'Recovered chat';
    return { session: { id: sessionId, title, updatedAt: Date.now(), messages }, attachments: [...refs.values()] };
  });
  try { await importSessionsAtomically(entries); }
  catch (error) { throw new RecoveryStorageError(error); }
  return entries.map(({ session }) => session);
}
