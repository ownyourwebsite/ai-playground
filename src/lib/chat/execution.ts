import type { AttachmentRef, ChatError, Execution, Message, ToolInvocation, Usage } from '../types';
import { parseReasoning, stripOpenReasoningTag } from '../reasoning';
import { chatError, decodeError, retryAfter, retryDelay } from './errors';
import { storageErrorCode } from '../storageErrors';

export type ModelRequest = (signal: AbortSignal, history: Message[], attemptId: string) => Promise<Response>;
type Hooks = {
  publish: (messages: Message[], busy: boolean) => void;
  persist: (messages: Message[], sessionId: string) => Promise<void>;
  storage?: (error: ChatError | undefined, unsaved: number) => void;
  prepareTool?: (call: ToolInvocation, history: Message[]) => ToolInvocation;
  visible?: () => boolean;
};
const terminal = new Set(['error', 'cancelled', 'interrupted']);
const id = () => crypto.randomUUID();
type Operation = { generation: number; kind: 'model' | 'approval' | 'tools'; messageId?: string };
const TOOL_ERROR_LIMIT = 4000;
export function toolErrorText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  const text = (Array.isArray(content) ? content : [])
    .map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
  if (!text) return 'MCP reported a tool error without details.';
  return text.length > TOOL_ERROR_LIMIT ? `${text.slice(0, TOOL_ERROR_LIMIT)}… [truncated]` : text;
}
export function canContinueModel(message: Message | undefined) {
  if (!message?.execution || !terminal.has(message.execution.status)) return false;
  return !message.toolInvocations?.length || (message.execution.continuationPending === true &&
    message.toolInvocations.every(t => t.state === 'result' && t.result !== undefined && ['success', 'declined'].includes(t.outcome ?? '')));
}
export function providerHistory(messages: Message[]): Message[] {
  return messages.filter(m => m.id !== 'welcome')
    .map(m => ({ ...m,
      content: m.execution && terminal.has(m.execution.status) ? '' : m.content,
      toolInvocations: m.toolInvocations?.filter(t => t.state === 'result' && t.result !== undefined) }))
    .filter(m => m.content.trim() || m.attachments?.length || m.toolInvocations?.length);
}
export function recoverMessages(messages: Message[]): Message[] {
  return messages.map(m => {
    const legacyStorageStop = m.execution?.error?.category === 'storage';
    const unfinished = m.execution && (legacyStorageStop || !['complete', 'error', 'cancelled', 'interrupted', 'approval'].includes(m.execution.status));
    const parsed = !m.execution && m.reasoningOpen && !m.content ? { content: m.reasoning || '', reasoning: null } : {};
    return {
      ...m, ...parsed, statusLine: undefined, reasoningOpen: false,
      ...(unfinished ? { execution: { ...m.execution!, status: 'interrupted' as const, interruption: 'reload' as const, error: legacyStorageStop ? undefined : chatError('interrupted'),
        // A crash after the initial checkpoint cannot prove whether a request was sent.
        requestSent: m.execution!.status === 'waiting' ? undefined : m.execution!.requestSent } } : {}),
      toolInvocations: m.toolInvocations?.filter(t => t.toolCallId && t.toolName).map(t =>
        t.state === 'executing' || t.state === 'calling'
          ? { ...t, state: 'result' as const, outcome: t.state === 'executing' ? 'unknown' as const : 'declined' as const,
            result: { error: t.state === 'executing' ? chatError('mcp').message : 'Model stream interrupted before approval. Nothing was executed.' } } : t),
    };
  });
}
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const valid = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  return {
    inputTokens: valid(u.inputTokens), outputTokens: valid(u.outputTokens), totalTokens: valid(u.totalTokens),
    cachedTokens: valid((u.inputTokenDetails as Record<string, unknown>)?.cacheReadTokens),
    reasoningTokens: valid((u.outputTokenDetails as Record<string, unknown>)?.reasoningTokens),
  };
}
export function summarizeUsage(messages: Message[]) {
  const attempts = [...new Map(messages.filter(m => m.execution && m.execution.requestSent !== false).map(m => [m.execution!.attemptId, m.execution!])).values()];
  const known = attempts.filter(a => a.usage?.totalTokens !== undefined);
  return {
    total: known.length ? known.reduce((sum, a) => sum + a.usage!.totalTokens!, 0) : undefined,
    incomplete: attempts.some(a => a.usage?.totalTokens === undefined) || messages.some(m => m.role === 'assistant' && m.id !== 'welcome' && !m.execution),
    pending: messages.some(m => m.execution && ['waiting', 'streaming', 'retry-wait'].includes(m.execution.status)),
    last: attempts.at(-1),
  };
}

/** Single synchronous owner. React receives snapshots, never effectful updaters. */
export class ChatExecution {
  messages: Message[] = [];
  sessionId = '';
  busy = false;
  storageError?: ChatError;
  private generation = 0;
  private operation?: Operation;
  private controllers = new Set<AbortController>();
  private continuations = new Set<string>();
  private detachedSessions = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private snapshots = new Map<string, Message[]>();
  private unsaved = new Map<string, Message[]>();
  private failedSaves = new Map<string, ChatError>();
  private inFlightSaves = new Map<string, Promise<void>>();
  private partialSave?: ReturnType<typeof setTimeout>;
  constructor(private hooks: Hooks, private timeouts = { requestMs: 120000, idleMs: 45000 }) {}
  ensureSession() { if (!this.sessionId) this.sessionId = id(); return this.sessionId; }
  snapshot(sessionId: string) { return this.snapshots.get(sessionId); }
  get hasUnsavedChanges() { return this.unsaved.size > 0 || this.partialSave !== undefined; }
  exportUnsaved() {
    return [...this.unsaved].filter(([sessionId]) => !this.isDetached(sessionId)).map(([sessionId, messages]) => ({ id: sessionId, messages: sessionId === this.sessionId ? this.messages : messages }));
  }
  setToolResolver(resolver: NonNullable<Hooks['prepareTool']>) { this.hooks.prepareTool = resolver; }
  async flush() {
    // stop/result saves may be enqueued while the previous checkpoint is awaited.
    let pending;
    do { pending = this.saveQueue; await pending; } while (pending !== this.saveQueue);
  }
  async prepareSwitch() {
    // A switch must not wait on a broken/slow disk. checkpoint captures RAM
    // synchronously; queued disk writes cannot overwrite another session.
    this.stop('interrupted', 'session-switch');
  }
  async save() {
    await this.checkpoint();
    for (const [sessionId, snapshot] of this.unsaved) {
      if (sessionId !== this.sessionId) await this.persistSnapshot(sessionId, snapshot);
    }
    return !this.storageError;
  }
  isDetached(sessionId: string) { return this.detachedSessions.has(sessionId); }
  async detach(sessionId: string) {
    // Synchronous tombstone BEFORE any await, including queued hooks not yet called.
    this.detachedSessions.add(sessionId);
    if (sessionId === this.sessionId) this.stop('interrupted', 'session-switch');
    // Switching is now nonblocking, so an inactive session may still have its
    // own write in flight. Drain that write, not unrelated active-session saves.
    await this.inFlightSaves.get(sessionId)?.catch(() => {});
  }
  reattach(sessionId: string) { this.detachedSessions.delete(sessionId); }
  forget(sessionId: string) {
    this.snapshots.delete(sessionId); this.unsaved.delete(sessionId); this.failedSaves.delete(sessionId);
    this.reportStorage();
  }
  reset(sessionId: string, messages: Message[]) {
    this.invalidate();
    this.sessionId = sessionId;
    this.messages = recoverMessages(messages);
    this.reportStorage();
    this.publish();
  }
  private invalidate() {
    clearTimeout(this.partialSave); this.partialSave = undefined;
    this.generation++;
    this.controllers.forEach(c => c.abort());
    this.controllers.clear();
    this.operation = undefined;
    this.busy = false;
  }
  private reserve(kind: Operation['kind'], messageId?: string): Operation {
    const owner = { generation: this.generation, kind, messageId };
    this.operation = owner;
    this.busy = true;
    return owner;
  }
  private owns(owner: Operation) { return this.operation === owner && owner.generation === this.generation; }
  private release(owner: Operation) {
    if (!this.owns(owner)) return;
    this.operation = undefined; this.busy = false; this.publish();
  }
  private toolOwner(messageId: string) {
    if (this.isDetached(this.sessionId)) return;
    if (this.operation?.messageId === messageId && this.operation.kind === 'tools') return this.operation;
    if (this.operation && !(this.operation.kind === 'approval' && this.operation.messageId === messageId)) return;
    return this.reserve('tools', messageId);
  }
  private reportStorage() {
    this.storageError = this.failedSaves.values().next().value;
    this.hooks.storage?.(this.storageError, this.unsaved.size);
  }
  private publish() { this.hooks.publish(this.messages, this.busy); }
  private patch(messageId: string, patch: Partial<Message>) {
    this.messages = this.messages.map(m => m.id === messageId ? { ...m, ...patch } : m);
    this.publish();
  }
  private execution(messageId: string, patch: Partial<Execution>) {
    const m = this.messages.find(m => m.id === messageId);
    if (m?.execution) this.patch(messageId, { execution: { ...m.execution, ...patch } });
  }
  private checkpoint() {
    clearTimeout(this.partialSave); this.partialSave = undefined;
    if (!this.sessionId || this.isDetached(this.sessionId)) return Promise.resolve();
    const snapshot = structuredClone(this.messages);
    const sessionId = this.sessionId;
    this.snapshots.set(sessionId, snapshot);
    this.unsaved.set(sessionId, snapshot);
    return this.persistSnapshot(sessionId, snapshot);
  }
  private persistSnapshot(sessionId: string, snapshot: Message[]) {
    const task = this.saveQueue.catch(() => {}).then(async () => {
      // Coalesce obsolete queued snapshots. Never keep an unbounded token queue.
      if (this.isDetached(sessionId) || this.snapshots.get(sessionId) !== snapshot) return;
      const write = Promise.resolve().then(() => {
        if (!this.isDetached(sessionId)) return this.hooks.persist(snapshot, sessionId);
      });
      this.inFlightSaves.set(sessionId, write);
      try {
        await write;
        if (!this.isDetached(sessionId) && this.unsaved.get(sessionId) === snapshot) {
          this.unsaved.delete(sessionId); this.failedSaves.delete(sessionId);
        }
      } catch (error) {
        this.failedSaves.set(sessionId, { ...chatError('storage'), code: storageErrorCode(error) });
      } finally {
        if (this.inFlightSaves.get(sessionId) === write) this.inFlightSaves.delete(sessionId);
      }
      this.reportStorage();
    });
    this.saveQueue = task;
    return task;
  }
  private scheduleCheckpoint() {
    if (!this.partialSave) this.partialSave = setTimeout(() => { void this.checkpoint(); }, 800);
  }
  stop(reason: 'cancelled' | 'interrupted' = 'cancelled', interruption: Execution['interruption'] = 'user') {
    this.invalidate();
    this.messages = this.messages.map(m => {
      const active = m.execution && ['waiting', 'streaming', 'retry-wait', 'tools', 'approval', 'pending-model'].includes(m.execution.status);
      return { ...m, reasoningOpen: false, statusLine: undefined,
        ...(active && !(reason === 'interrupted' && m.execution!.status === 'approval') ? { execution: { ...m.execution!, status: reason, interruption, error: undefined } } : {}),
        toolInvocations: m.toolInvocations?.map(t => t.state !== 'result' && !(reason === 'interrupted' && t.state === 'needs-approval') ? {
          ...t, state: 'result' as const, outcome: t.state === 'executing' ? 'unknown' as const : 'declined' as const,
          result: { error: t.state === 'executing' ? chatError('mcp').message : 'Cancelled before execution.' },
        } : t),
      };
    });
    this.publish();
    void this.checkpoint().catch(() => {});
  }
  submit(content: string, request: ModelRequest, attachments: AttachmentRef[] = []) {
    if ((!content.trim() && !attachments.length) || this.operation || this.busy || this.isDetached(this.sessionId) ||
      this.messages.some(m => m.toolInvocations?.some(t => t.state !== 'result'))) return false;
    const owner = this.reserve('model');
    this.messages = [...this.messages.filter(m => m.id !== 'welcome'), { id: id(), role: 'user', content,
      ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) }];
    // The reservation is already visible to synchronous/reentrant event handlers.
    this.publish();
    void this.run(request, undefined, owner);
    return true;
  }
  async retry(request: ModelRequest) {
    const last = this.messages.at(-1);
    if (this.busy || !last?.execution || !canContinueModel(last)) return;
    if ((last.execution.error?.retryAt ?? last.execution.retryAt ?? 0) > Date.now()) return;
    const owner = this.reserve('model');
    if (last.execution.continuationPending) this.execution(last.id, { status: 'complete', continuationPending: false, error: undefined });
    await this.run(request, { runId: last.execution.runId, ...(last.toolInvocations?.length ? {} : { stepId: last.execution.stepId }) }, owner);
  }
  async restart(request: ModelRequest) {
    const last = this.messages.at(-1)?.execution;
    if ((last?.error?.retryAt ?? last?.retryAt ?? 0) > Date.now()) return;
    if (this.messages.some(m => m.execution?.runId === last?.runId && m.toolInvocations?.some(t => t.outcome === 'unknown'))) return;
    const userMessage = this.messages.findLast(m => m.role === 'user');
    if (!userMessage || (!userMessage.content.trim() && !userMessage.attachments?.length) || this.operation || this.busy || this.isDetached(this.sessionId) ||
      this.messages.some(m => m.toolInvocations?.some(t => t.state !== 'result'))) return;
    const owner = this.reserve('model');
    this.messages = [...this.messages.filter(m => m.id !== 'welcome'), { id: id(), role: 'user', content: userMessage.content,
      ...(userMessage.attachments?.length ? { attachments: structuredClone(userMessage.attachments) } : {}) }];
    this.publish();
    await this.run(request, undefined, owner);
  }
  async start(request: ModelRequest, continuation?: { runId: string; stepId?: string }) {
    if (this.operation || this.busy || this.isDetached(this.sessionId)) return;
    await this.run(request, continuation, this.reserve('model'));
  }
  private async run(request: ModelRequest, continuation: { runId: string; stepId?: string } | undefined, owner: Operation) {
    const current = () => this.owns(owner);
    const runId = continuation?.runId ?? id();
    const stepId = continuation?.stepId ?? id();
    const history = providerHistory(this.messages);
    let retries = 0;
    let waited = 0;
    let retryDeadline: number | undefined;
    let retryDue: number | undefined;
    let retryFailure: ChatError | undefined;
    try {
      while (current()) {
        const attemptId = id();
        const messageId = id();
        const controller = new AbortController();
        this.controllers.add(controller);
        const startedAt = Date.now();
        this.messages = [...this.messages, { id: messageId, role: 'assistant', content: '', execution: {
          sessionId: this.sessionId, runId, stepId, attemptId, status: 'waiting', startedAt, requestSent: false,
        } }];
        this.publish();
        let content = '', reasoning = '', hasContent = false, finished = false, reasoningOpen = false;
        let failure: ChatError | undefined;
        let retryExpired = false;
        let calls: ToolInvocation[] = [];
        let usage: Usage | undefined;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => { failure = chatError('timeout'); controller.abort(); }, this.timeouts.requestMs);
        const refreshIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(() => { failure = chatError('timeout'); controller.abort(); }, this.timeouts.idleMs);
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          await this.checkpoint();
          if (!current()) return;
          // Storage/hibernation may consume the budget AFTER the timer check. This
          // is the final gate immediately before sending any automatic request.
          if (retries > 0 && (Date.now() > retryDeadline! || Date.now() > retryDue! + 1000 || this.hooks.visible?.() === false)) {
            retryExpired = true;
            throw retryFailure;
          }
          if (controller.signal.aborted) throw failure ?? chatError('timeout');
          refreshIdle();
          // No publish/callback/await between the final gate and request dispatch.
          this.messages = this.messages.map(m => m.id === messageId ? { ...m, execution: { ...m.execution!, requestSent: true } } : m);
          const response = await request(controller.signal, history, attemptId);
          if (!current()) { await response.body?.cancel(); return; }
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            failure = response.status === 429 ? chatError('app-rate-limit', true, retryAfter(response.headers.get('retry-after'))) :
              response.status === 503 ? chatError('redis-unavailable', true, retryAfter(response.headers.get('retry-after'))) : decodeError(body.error);
            throw failure;
          }
          reader = response.body?.getReader();
          if (!reader) throw chatError('network');
          const decoder = new TextDecoder();
          let buffer = '';
          const event = (line: string) => {
            if (!current() || failure || finished || !line.startsWith('data:')) return;
            const raw = line.slice(5).trim();
            if (raw === '[DONE]') return;
            let e;
            try { e = JSON.parse(raw); }
            catch { failure = chatError('protocol'); return; }
            if (!e || typeof e.type !== 'string') { failure = chatError('protocol'); return; }
            if (e.type === 'error') { failure = decodeError(e.errorText); return; }
            if (e.type === 'abort') { failure = chatError('interrupted'); return; }
            if (e.type === 'finish') {
              usage = normalizeUsage(e.messageMetadata?.usage);
              if (!['stop', 'tool-calls'].includes(e.finishReason)) {
                failure = chatError(e.finishReason === 'length' ? 'response-limit' : e.finishReason === 'content-filter' ? 'content-filter' : 'protocol'); return;
              }
              finished = true;
              return;
            }
            if (e.type === 'text-delta') { content += e.delta ?? ''; hasContent = true; }
            if (e.type.startsWith('reasoning-')) {
              reasoning += e.delta ?? ''; hasContent = true;
              if (e.type === 'reasoning-start') reasoningOpen = true;
              if (e.type === 'reasoning-end') reasoningOpen = false;
            }
            if (e.type.startsWith('tool-input')) hasContent = true;
            if (e.type === 'tool-input-error') { failure = chatError('provider'); return; }
            if (e.type === 'tool-input-available' && !calls.some(t => t.toolCallId === e.toolCallId)) {
              calls = [...calls, { toolCallId: e.toolCallId, toolName: e.toolName, args: e.input ?? {}, state: 'calling' }];
            }
            const parsed = parseReasoning(content);
            this.patch(messageId, { content: parsed.cleanText, reasoning: [parsed.reasoning, reasoning].filter(Boolean).join('\n\n'),
              reasoningOpen: parsed.isOpen || reasoningOpen, toolInvocations: calls });
            this.execution(messageId, { status: 'streaming' });
          };
          while (current() && !failure && !finished) {
            const { done, value } = await reader.read();
            if (!current()) return;
            if (done) { if (buffer.trim()) event(buffer); break; }
            refreshIdle();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) event(line);
            // Streaming cannot depend on disk latency or copy the whole chat per token.
            this.scheduleCheckpoint();
          }
          if (!finished && !failure) failure = chatError('interrupted');
        } catch (error) {
          failure ??= (error as ChatError)?.category ? decodeError(error) : chatError('network');
        } finally {
          clearTimeout(timeout); clearTimeout(idle);
          await reader?.cancel().catch(() => {});
          this.controllers.delete(controller);
        }
        if (!current()) return;
        const parsed = parseReasoning(content);
        this.patch(messageId, { content: parsed.isOpen ? stripOpenReasoningTag(content) : parsed.cleanText, reasoningOpen: false });
        this.execution(messageId, { durationMs: Date.now() - startedAt, usage });
        if (!failure) {
          calls = calls.map(call => this.hooks.prepareTool?.(call, history) ?? { ...call, state: 'needs-approval' });
          this.patch(messageId, { toolInvocations: calls });
          const invalidTool = calls.some(t => t.outcome === 'error');
          // Transfer before approval publication. The old model finally has no
          // authority over tools/denial checkpoints that begin during this save.
          const approvalOwner = !invalidTool && calls.some(t => t.state === 'needs-approval') ? this.reserve('approval', messageId) : undefined;
          this.execution(messageId, { status: invalidTool ? 'error' : calls.some(t => t.state === 'needs-approval') ? 'approval' : 'complete', error: invalidTool ? chatError('mcp') : undefined });
          this.messages = this.messages.map(m => m.execution?.stepId === stepId && m.id !== messageId ? { ...m, execution: { ...m.execution, recovered: true } } : m);
          try { await this.checkpoint(); } finally { if (approvalOwner) this.release(approvalOwner); }
          return;
        }
        // Unfinished tool inputs are never approved after an errored model attempt.
        this.patch(messageId, { toolInvocations: undefined });
        const delay = retryExpired || hasContent || this.hooks.visible?.() === false ? null : retryDelay(failure, retries, waited);
        const waitStarted = Date.now();
        if (delay !== null) retryDeadline ??= waitStarted + 15000;
        const due = delay === null ? failure.retryAt : waitStarted + delay;
        this.execution(messageId, { status: delay === null ? 'error' : 'retry-wait', error: failure,
          retryAt: due, retryNumber: retries + 1 });
        await this.checkpoint();
        if (!current()) return;
        if (delay === null) return;
        if (Date.now() > due! + 1000 || Date.now() > retryDeadline! || this.hooks.visible?.() === false) {
          this.execution(messageId, { status: 'error' });
          await this.checkpoint(); return;
        }
        const waiter = new AbortController();
        this.controllers.add(waiter);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.max(0, due! - Date.now()));
          waiter.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        this.controllers.delete(waiter);
        if (!current()) return;
        if (Date.now() > due! + 1000 || Date.now() > retryDeadline! || this.hooks.visible?.() === false) {
          this.execution(messageId, { status: 'error' });
          await this.checkpoint(); return;
        }
        this.execution(messageId, { status: 'error' });
        retryDue = due; retryFailure = failure;
        waited += Date.now() - waitStarted; retries++;
      }
    } catch {
      if (current()) {
        const last = this.messages.at(-1);
        if (last) this.execution(last.id, { status: 'error', error: chatError('storage') });
      }
    } finally {
      this.release(owner);
    }
  }
  async approve(messageId: string, toolId: string, execute: (call: ToolInvocation, signal: AbortSignal) => Promise<unknown>, request: ModelRequest) {
    const m = this.messages.find(m => m.id === messageId);
    const call = m?.toolInvocations?.find(t => t.toolCallId === toolId);
    if (!call || call.state !== 'needs-approval') return;
    const owner = this.toolOwner(messageId);
    if (!owner) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.busy = true;
    this.setTool(messageId, toolId, { state: 'executing', attemptId: id() });
    this.execution(messageId, { status: 'tools' });
    let sent = false;
    try {
      await this.checkpoint();
      if (!this.owns(owner)) return;
      sent = true;
      const result = await execute(call, controller.signal);
      if (!this.owns(owner)) return;
      // A tool-reported error is a known outcome: the model gets the text and the turn continues
      // (further calls still need approval). Only transport failures are 'unknown' (see catch).
      const failed = !!(result as { isError?: boolean })?.isError;
      this.setTool(messageId, toolId, { state: 'result', result: failed ? { error: toolErrorText(result) } : result, outcome: 'success' });
    } catch {
      if (!this.owns(owner)) return;
      this.setTool(messageId, toolId, sent ? { state: 'result', outcome: 'unknown', result: { error: chatError('mcp').message } } : { state: 'needs-approval' });
      if (!sent) { this.execution(messageId, { status: 'error', error: chatError('storage') }); this.release(owner); return; }
    } finally { this.controllers.delete(controller); }
    if (!this.owns(owner)) return;
    await this.afterTools(messageId, request, owner);
  }
  private setTool(messageId: string, toolId: string, patch: Partial<ToolInvocation>) {
    const message = this.messages.find(m => m.id === messageId);
    this.patch(messageId, { toolInvocations: message?.toolInvocations?.map(t => t.toolCallId === toolId ? { ...t, ...patch } : t) });
  }
  async decline(messageId: string, toolId: string, request: ModelRequest) {
    const call = this.messages.find(m => m.id === messageId)?.toolInvocations?.find(t => t.toolCallId === toolId);
    if (call?.state !== 'needs-approval') return;
    const owner = this.toolOwner(messageId);
    if (!owner) return;
    this.setTool(messageId, toolId, { state: 'result', outcome: 'declined', result: { error: 'User declined tool execution. Do not request this action again.' } });
    await this.afterTools(messageId, request, owner);
  }
  requestToolRetry(messageId: string, toolId: string, safe: (call: ToolInvocation) => boolean) {
    if (this.busy || this.isDetached(this.sessionId) || this.messages.at(-1)?.id !== messageId) return;
    const call = this.messages.find(m => m.id === messageId)?.toolInvocations?.find(t => t.toolCallId === toolId);
    if (!call || !safe(call)) return;
    const owner = this.reserve('approval', messageId);
    this.setTool(messageId, toolId, { state: 'needs-approval', outcome: undefined, result: undefined });
    this.execution(messageId, { status: 'approval', error: undefined });
    void this.checkpoint().catch(() => { if (this.owns(owner)) this.execution(messageId, { status: 'error', error: chatError('storage') }); })
      .finally(() => this.release(owner));
  }
  private async afterTools(messageId: string, request: ModelRequest, owner: Operation) {
    if (!this.owns(owner)) return;
    const message = this.messages.find(m => m.id === messageId)!;
    const calls = message.toolInvocations ?? [];
    const all = calls.length > 0 && calls.every(t => t.state === 'result');
    const failed = calls.some(t => t.outcome === 'unknown' || t.outcome === 'error');
    // Reserve the inter-step checkpoint too: user submission cannot overtake continuation.
    this.execution(messageId, { status: failed ? 'error' : all ? 'pending-model' : calls.some(t => t.state === 'executing') ? 'tools' : 'approval',
      continuationPending: all && !failed, error: failed ? chatError('mcp') : undefined });
    const checkpointMessage = this.messages.find(m => m.id === messageId);
    try { await this.checkpoint(); } catch {
      if (this.owns(owner)) {
        this.stop('interrupted');
        this.execution(messageId, { status: 'error', error: chatError('storage') });
      }
      return;
    }
    // A parallel tool/decline may have produced a newer checkpoint under the same
    // tool owner. Only its latest snapshot can release or hand off the lock.
    if (!this.owns(owner) || checkpointMessage !== this.messages.find(m => m.id === messageId)) return;
    if (!all || failed) { if (!calls.some(t => t.state === 'executing')) this.release(owner); return; }
    if (this.continuations.has(messageId)) return;
    this.continuations.add(messageId);
    if (this.messages.filter(m => m.execution?.runId === message.execution?.runId && m.toolInvocations?.length).length >= 10) {
      this.execution(messageId, { status: 'interrupted', interruption: 'step-limit', continuationPending: false, error: chatError('interrupted') });
      try { await this.checkpoint(); } finally { this.release(owner); } return;
    }
    const modelOwner = this.reserve('model');
    this.execution(messageId, { status: 'complete', continuationPending: false });
    await this.run(request, { runId: message.execution?.runId ?? id() }, modelOwner);
  }
}
