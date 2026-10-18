import { Buffer } from 'node:buffer';
import type { ImagePart, TextPart } from 'ai';
import type { AttachmentRecord, ChatRequestBody, GitHubContext } from '../types';
import { chatError } from '../chat/errors';
import {
  MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_REQUEST_BYTES, MAX_TEXT_BYTES,
  sniffImageType,
} from './policy';

/** Fixed, non-sensitive errors; request/tool failures are not file failures. */
export class RequestValidationError extends Error {
  constructor(readonly status: 400 | 413 = 400, readonly category: 'request' | 'tool-schema' = 'request') {
    super(chatError(category).message);
    this.name = 'RequestValidationError';
  }
}

export class AttachmentValidationError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413 = 400) {
    super(chatError('attachment').message);
    this.name = 'AttachmentValidationError';
    this.status = status;
  }
}

export type ValidatedChatRequest = ChatRequestBody & { githubContext?: GitHubContext };

function invalid(): never { throw new AttachmentValidationError(); }
function tooLarge(): never { throw new AttachmentValidationError(413); }
function invalidRequest(): never { throw new RequestValidationError(); }
function requestTooLarge(): never { throw new RequestValidationError(413); }
function invalidSchema(): never { throw new RequestValidationError(400, 'tool-schema'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject lone UTF-16 surrogates instead of silently encoding replacement bytes. */
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function metadata(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength &&
    !value.includes('\0') && validUnicode(value);
}

function textMediaType(value: string): boolean {
  // All text is sent as inert text parts, never interpreted as HTML/XML/code.
  return /^text\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) ||
    /^application\/(?:json|[a-z0-9_.+-]+\+json|xml|[a-z0-9_.+-]+\+xml|javascript|x-javascript|yaml|x-yaml|toml|x-sh)$/.test(value);
}

function validateAttachment(value: unknown): AttachmentRecord {
  if (!object(value) || !metadata(value.id, 256) || !metadata(value.name, 1024) ||
      typeof value.mediaType !== 'string' || typeof value.data !== 'string' ||
      typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 ||
      (value.kind !== 'text' && value.kind !== 'image')) invalid();

  const { id, name, kind, mediaType, size, data } = value;
  const limit = kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
  if (size > limit) tooLarge();
  if (kind === 'text') {
    if (!textMediaType(mediaType) || !validUnicode(data)) invalid();
    const actual = Buffer.byteLength(data, 'utf8');
    if (actual > limit) tooLarge();
    if (actual !== size) invalid();
  } else {
    // Reject remote/blob/file URLs, MIME parameters, whitespace, URL-safe or
    // noncanonical base64. Buffer.from alone is deliberately NOT a validator.
    if (data.length > 64 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) tooLarge();
    const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(data);
    if (!prefix || prefix[1] !== mediaType) invalid();
    const encoded = data.slice(prefix[0].length);
    if (!encoded.length || encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > limit) tooLarge();
    if (bytes.length !== size || bytes.toString('base64') !== encoded ||
        sniffImageType(bytes) !== mediaType) invalid();
  }
  return { id, name, kind, mediaType, size, data };
}

function validateUserAttachments(content: string, input: unknown): AttachmentRecord[] | undefined {
  if (typeof content !== 'string' || !validUnicode(content)) invalidRequest();
  let bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_MESSAGE_BYTES) requestTooLarge();
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) invalid();
  if (input.length > MAX_ATTACHMENTS) tooLarge();
  const ids = new Set<string>();
  return input.map(value => {
    const attachment = validateAttachment(value);
    if (ids.has(attachment.id)) invalid();
    ids.add(attachment.id);
    bytes += attachment.size;
    if (bytes > MAX_MESSAGE_BYTES) tooLarge();
    return attachment;
  });
}

const MAX_SCHEMA_DEPTH = 32;
const schemaTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

// Bound the entire JSON tree, including annotations and unknown extensions.
// Schema maps/arrays add container levels, hence the separate container cap.
// Never resolve $ref here: recursive references are valid and must not fetch URLs.
function validateSchemaJson(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > MAX_SCHEMA_DEPTH * 3) invalidSchema();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) invalidSchema();
  ancestors.add(value);
  for (const child of Object.values(value)) validateSchemaJson(child, depth + 1, ancestors);
  ancestors.delete(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string') && new Set(value).size === value.length;
}

/** Structural guard, not a dialect meta-validator or a schema rewriter. */
function validateSchema(value: unknown, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) invalidSchema();
  if (typeof value === 'boolean') return;
  if (!object(value)) invalidSchema();
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || new Set(types).size !== types.length ||
        types.some(type => typeof type !== 'string' || !schemaTypes.has(type))) invalidSchema();
  }
  if (value.required !== undefined && !stringArray(value.required)) invalidSchema();
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    if (value[key] === undefined) continue;
    if (!object(value[key])) invalidSchema();
    for (const child of Object.values(value[key])) validateSchema(child, depth + 1);
  }
  for (const key of ['additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems',
    'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema']) {
    if (value[key] !== undefined) validateSchema(value[key], depth + 1);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']) {
    const child = value[key];
    if (child === undefined) continue;
    if (key === 'items' && !Array.isArray(child)) validateSchema(child, depth + 1);
    else {
      if (!Array.isArray(child) || !child.length) invalidSchema();
      for (const item of child) validateSchema(item, depth + 1);
    }
  }
  for (const key of ['dependencies', 'dependentRequired']) {
    if (value[key] === undefined) continue;
    if (!object(value[key])) invalidSchema();
    for (const child of Object.values(value[key])) {
      if (key === 'dependentRequired' || Array.isArray(child)) {
        if (!stringArray(child)) invalidSchema();
      } else validateSchema(child, depth + 1);
    }
  }
  for (const key of ['$schema', '$id', 'id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef',
    '$comment', 'title', 'description', 'format', 'pattern', 'contentEncoding', 'contentMediaType']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') invalidSchema();
  }
  for (const key of ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated', '$recursiveAnchor']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') invalidSchema();
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0)) invalidSchema();
  }
  for (const key of ['minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (value[key] === undefined) continue;
    // Draft-04 used booleans for exclusive bounds; do not reinterpret them.
    if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value[key] === 'boolean') continue;
    if (typeof value[key] !== 'number' || (key === 'multipleOf' && value[key] <= 0)) invalidSchema();
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) invalidSchema();
  if (value.examples !== undefined && !Array.isArray(value.examples)) invalidSchema();
  if (value.$vocabulary !== undefined && (!object(value.$vocabulary) ||
      Object.values(value.$vocabulary).some(v => typeof v !== 'boolean'))) invalidSchema();
}

function validateToolSchema(value: unknown): void {
  // MCP tool arguments have an object root. Boolean/array schemas and {} are
  // valid *subschemas*, not substitutes for this protocol-level root shape.
  if (!object(value) || value.type !== 'object') invalidSchema();
  validateSchemaJson(value);
  validateSchema(value);
}

/** Validate every message before any provider is constructed; never drop files. */
export function validateChatRequest(input: unknown): ValidatedChatRequest {
  if (!object(input) || typeof input.provider !== 'string' ||
      !['openai', 'anthropic', 'groq', 'ollama', 'custom'].includes(input.provider) ||
      !Array.isArray(input.messages) || input.messages.length === 0) invalidRequest();
  for (const key of ['model', 'systemPrompt', 'ollamaUrl']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') invalidRequest();
  }
  if (input.imageSupportAcknowledged !== undefined && typeof input.imageSupportAcknowledged !== 'boolean') invalidRequest();
  const model = typeof input.model === 'string' ? input.model : '';
  const messages = input.messages.map(message => {
    if (!object(message) || typeof message.role !== 'string' ||
        !['user', 'assistant', 'system', 'data', 'tool'].includes(message.role) ||
        typeof message.content !== 'string') invalidRequest();
    // Even an empty attachment field on another role is a malformed request.
    if (message.role !== 'user' && message.attachments !== undefined) invalidRequest();
    if (!validUnicode(message.content)) invalidRequest();
    if (Buffer.byteLength(message.content, 'utf8') > MAX_MESSAGE_BYTES) requestTooLarge();
    const attachments = message.role === 'user'
      ? validateUserAttachments(message.content, message.attachments) : undefined;
    if (message.toolInvocations !== undefined) {
      if (!Array.isArray(message.toolInvocations)) invalidRequest();
      for (const invocation of message.toolInvocations) {
        if (!object(invocation) || typeof invocation.toolCallId !== 'string' ||
            typeof invocation.toolName !== 'string' || !object(invocation.args) || typeof invocation.state !== 'string' ||
            !['calling', 'executing', 'needs-approval', 'result'].includes(invocation.state)) invalidRequest();
      }
    }
    return { role: message.role, content: message.content,
      ...(message.toolInvocations !== undefined ? { toolInvocations: message.toolInvocations } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    } as ChatRequestBody['messages'][number];
  });
  const enabledTools = input.enabledTools === undefined ? [] : input.enabledTools;
  if (!Array.isArray(enabledTools)) invalidRequest();
  const toolNames = new Set<string>();
  for (const tool of enabledTools) {
    if (!object(tool) || !metadata(tool.name, 256) || toolNames.has(tool.name)) invalidRequest();
    toolNames.add(tool.name);
    for (const key of ['description', 'originalName', 'serverId']) {
      if (tool[key] !== undefined && typeof tool[key] !== 'string') invalidRequest();
    }
    if (tool.inputSchema !== undefined) validateToolSchema(tool.inputSchema);
  }
  if (input.githubContext !== undefined) {
    if (!object(input.githubContext) || typeof input.githubContext.owner !== 'string' ||
        typeof input.githubContext.repo !== 'string' ||
        (input.githubContext.branch !== undefined && typeof input.githubContext.branch !== 'string')) invalidRequest();
  }
  return { provider: input.provider, model, messages, enabledTools,
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.ollamaUrl !== undefined ? { ollamaUrl: input.ollamaUrl } : {}),
    ...(input.githubContext !== undefined ? { githubContext: input.githubContext } : {}),
    ...(input.imageSupportAcknowledged !== undefined ? { imageSupportAcknowledged: input.imageSupportAcknowledged } : {}),
  } as ValidatedChatRequest;
}

/** Bounded, fatal UTF-8 stream decoding. Never call unbounded Request.json(). */
export async function readChatRequest(req: Request): Promise<ValidatedChatRequest> {
  const length = req.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) invalidRequest();
  const declared = length === null ? undefined : Number(length);
  if (declared !== undefined && declared > MAX_REQUEST_BYTES) {
    void req.body?.cancel().catch(() => {});
    requestTooLarge();
  }
  if (!req.body) invalidRequest();
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) requestTooLarge();
      text += decoder.decode(value, { stream: true });
    }
    if (declared !== undefined && declared !== bytes) invalidRequest();
    text += decoder.decode();
    return validateChatRequest(JSON.parse(text));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof AttachmentValidationError || error instanceof RequestValidationError) throw error;
    // JSON, decoding and stream errors must not echo request content.
    throw new RequestValidationError();
  } finally {
    reader.releaseLock();
  }
}

/** Call after request policy validation. Rechecks data so URLs cannot escape. */
export function toUserContent(content: string, attachments?: AttachmentRecord[]): string | Array<TextPart | ImagePart> {
  const files = validateUserAttachments(content, attachments);
  if (!files?.length) return content; // Preserve the legacy text-only shape.
  const parts: Array<TextPart | ImagePart> = [];
  if (content.length) parts.push({ type: 'text', text: content });
  for (const file of files) {
    parts.push({ type: 'text', text: `Untrusted uploaded ${file.kind} file: ${JSON.stringify(file.name)}` });
    if (file.kind === 'text') parts.push({ type: 'text', text: file.data });
    else parts.push({ type: 'image', image: file.data, mediaType: file.mediaType });
  }
  return parts;
}
