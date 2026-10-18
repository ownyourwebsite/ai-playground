import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatExecution, recoverMessages, summarizeUsage, providerHistory } from './execution';
import { classifyError, retryDelay } from './errors';
import { canRetryTool } from './toolSafety';
import type { AttachmentRef, Message } from '../types';

const stream = (...events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
const finish = { type: 'finish', finishReason: 'stop', messageMetadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: { cacheReadTokens: 4 }, outputTokenDetails: { reasoningTokens: 2 } } } };
const user: Message = { id: 'u', role: 'user', content: 'Read' };
function setup() {
  const checkpoints: Message[][] = [];
  const engine = new ChatExecution({ publish() {}, async persist(messages) { checkpoints.push(structuredClone(messages)); } });
  engine.reset('s', [user]);
  return { engine, checkpoints };
}

test('attachment-only turns survive provider history, retry, restart and recovery without copying payloads', async () => {
  const { engine, checkpoints } = setup();
  engine.reset('files', []);
  const attachments: AttachmentRef[] = [{ id: 'file', name: 'source.ts', kind: 'text', mediaType: 'text/plain', size: 12 }];
  let calls = 0;
  const request = async (_signal: AbortSignal, history: Message[]) => {
    assert.deepEqual(history.findLast(m => m.role === 'user')?.attachments, attachments);
    calls++;
    return calls === 1 ? Response.json({ error: { category: 'attachment' } }, { status: 400 }) : stream(finish);
  };
  assert.equal(engine.submit('', request, attachments), true);
  assert.equal(engine.submit('', request, attachments), false);
  for (let i = 0; engine.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(engine.messages.at(-1)?.execution?.error?.category, 'attachment');
  await engine.retry(request);
  await engine.restart(request);
  await engine.flush();
  assert.equal(calls, 3);
  const turns = engine.messages.filter(m => m.role === 'user');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].attachments, turns[0].attachments);
  assert.equal(turns[1].attachments?.[0].id, 'file');
  assert.equal('data' in turns[0].attachments![0], false);
  assert.deepEqual(recoverMessages(engine.messages).filter(m => m.role === 'user').map(m => ({ id: m.id, content: m.content, attachments: m.attachments })),
    turns.map(m => ({ id: m.id, content: m.content, attachments: m.attachments })));
  assert.ok(checkpoints.some(messages => messages.some(m => m.attachments?.length)));
});

test('synchronous model lock rejects duplicate starts; late response cannot erase terminal cancellation', async () => {
  const { engine } = setup();
  let resolve!: (r: Response) => void;
  let calls = 0;
  const request = async () => { calls++; return new Promise<Response>(r => { resolve = r; }); };
  const first = engine.start(request);
  await engine.start(request);
  await new Promise(r => setTimeout(r, 0));
  engine.stop();
  resolve(stream({ type: 'text-delta', delta: 'late' }, finish));
  await first;
  assert.equal(calls, 1);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'cancelled');
  assert.equal(engine.messages.at(-1)?.content, '');
});
test('parallel approvals and double clicks checkpoint results before exactly one continuation', async () => {
  const { engine, checkpoints } = setup();
  let calls = 0;
  const request = async () => ++calls === 1 ? stream(
    { type: 'tool-input-available', toolCallId: 'a', toolName: 'read', input: {} },
    { type: 'tool-input-available', toolCallId: 'b', toolName: 'read', input: {} }, finish,
  ) : stream({ type: 'text-delta', delta: 'done' }, finish);
  await engine.start(request);
  const id = engine.messages.at(-1)!.id;
  let tools = 0;
  const execute = async () => { tools++; return { content: [{ type: 'text', text: 'file' }] }; };
  await Promise.all([engine.approve(id, 'a', execute, request), engine.approve(id, 'a', execute, request), engine.approve(id, 'b', execute, request)]);
  assert.equal(tools, 2);
  assert.equal(calls, 2);
  assert.ok(checkpoints.some(ms => ms.at(-1)?.toolInvocations?.every(t => t.state === 'result')));
});
test('stream error preserves partial text, suppresses later finish and approvals; manual retry excludes failed output', async () => {
  const { engine } = setup();
  await engine.start(async () => stream({ type: 'text-delta', delta: 'partial' }, { type: 'error', errorText: 'secret upstream' }, { type: 'text-delta', delta: 'late overwrite' }, finish));
  assert.equal(engine.messages.at(-1)?.content, 'partial');
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
  assert.ok(!JSON.stringify(engine.messages).includes('secret upstream'));
  let history: Message[] = [];
  await engine.retry(async (_signal, messages) => { history = messages; return stream(finish); });
  assert.equal(history.length, 1);
  assert.equal(engine.messages.length, 3);
});
test('EOF without finish is interrupted; session reset ignores late events', async () => {
  const { engine } = setup();
  await engine.start(async () => stream({ type: 'text-delta', delta: 'partial' }));
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
  let resolve!: (r: Response) => void;
  const pending = engine.retry(async () => new Promise<Response>(r => { resolve = r; }));
  await new Promise(r => setTimeout(r, 0));
  engine.reset('other', []);
  resolve(stream(finish));
  await pending;
  assert.deepEqual(engine.messages, []);
});
test('usage is deduplicated per attempt, totals exclude cache/reasoning detail and legacy stays unknown', async () => {
  const { engine } = setup();
  await engine.start(async () => stream(finish, finish));
  assert.equal(summarizeUsage(engine.messages).total, 15);
  const restored = recoverMessages(JSON.parse(JSON.stringify(engine.messages)));
  assert.equal(summarizeUsage(restored).total, 15);
  assert.equal(summarizeUsage([{ id: 'old', role: 'assistant', content: 'old' }]).incomplete, true);
});
test('reload never resurrects a write; provider history has complete tool pairs only', () => {
  const messages: Message[] = [{ id: 'a', role: 'assistant', content: '', toolInvocations: [{ toolCallId: 't', toolName: 'write', args: {}, state: 'executing' }] }];
  const recovered = recoverMessages(messages);
  assert.equal(recovered[0].toolInvocations![0].outcome, 'unknown');
  assert.equal(providerHistory(messages)[0]?.toolInvocations?.length ?? 0, 0);
});
test('retry policy separates quota/context/auth, honors large Retry-After and caps retries', () => {
  assert.equal(classifyError({ statusCode: 429, message: 'insufficient_quota' }).category, 'quota');
  assert.equal(classifyError({ statusCode: 429 }).category, 'provider-rate-limit');
  assert.equal(classifyError({ statusCode: 400, message: 'context_length_exceeded' }).category, 'context');
  assert.equal(classifyError({ statusCode: 401 }).category, 'auth');
  assert.equal(retryDelay(classifyError({ statusCode: 429, responseHeaders: { 'retry-after': '60' } }), 0, 0), null);
  assert.equal(retryDelay(classifyError({ statusCode: 429 }), 2, 0), null);
});

test('visible short autoretry has one owner and reports recovery, failed usage remains unknown', async () => {
  const { engine } = setup();
  let calls = 0;
  const waiting = engine.start(async () => ++calls === 1 ? stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }) : stream(finish));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(engine.messages.at(-1)?.execution?.status, 'retry-wait');
  await waiting;
  assert.equal(calls, 2);
  assert.equal(engine.messages[1].execution?.recovered, true);
  assert.equal(summarizeUsage(engine.messages).total, 15);
  assert.equal(summarizeUsage(engine.messages).incomplete, true);
});
test('Stop aborts retry timer; background or overdue wait never starts another request', async () => {
  const { engine } = setup();
  let calls = 0;
  const pending = engine.start(async () => { calls++; return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }); });
  await new Promise(r => setTimeout(r, 20));
  engine.stop();
  await pending;
  assert.equal(calls, 1);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'cancelled');
  let visible = true;
  const background = new ChatExecution({ publish() {}, async persist() {}, visible: () => visible });
  background.reset('s', [user]);
  const request = background.start(async () => { calls++; return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }); });
  await new Promise(r => setTimeout(r, 20));
  visible = false;
  await request;
  assert.equal(calls, 2);
  assert.equal(background.messages.at(-1)?.execution?.status, 'error');
});
test('large Retry-After is terminal/manual and cannot be bypassed with Retry', async () => {
  const { engine } = setup();
  let calls = 0;
  const request = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); };
  await engine.start(request);
  assert.equal(engine.messages.at(-1)?.execution?.error?.category, 'app-rate-limit');
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
  await engine.retry(request);
  assert.equal(calls, 1);
});
test('decline once resumes with denial, successful tools survive failed model retry without replay', async () => {
  const { engine } = setup();
  let calls = 0;
  let tools = 0;
  const history: Message[][] = [];
  const request = async (_signal: AbortSignal, messages: Message[]) => {
    history.push(messages); calls++;
    if (calls === 1) return stream({ type: 'tool-input-available', toolCallId: 'a', toolName: 'read', input: {} }, { type: 'tool-input-available', toolCallId: 'b', toolName: 'write', input: {} }, finish);
    if (calls === 2) return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429, responseHeaders: { 'retry-after': '60' } })) });
    return stream(finish);
  };
  await engine.start(request);
  const toolMessageId = engine.messages.at(-1)!.id;
  await engine.approve(toolMessageId, 'a', async () => { tools++; return { content: [{ type: 'text', text: 'file' }] }; }, request);
  await Promise.all([engine.decline(toolMessageId, 'b', request), engine.decline(toolMessageId, 'b', request)]);
  assert.equal(calls, 2);
  assert.equal(tools, 1);
  assert.equal(history[1].at(-1)?.toolInvocations?.length, 2);
  assert.equal(history[1].at(-1)?.toolInvocations?.[1].outcome, 'declined');
});
test('Stop during a write preserves unknown outcome, ignores result and blocks continuation', async () => {
  const { engine } = setup();
  let calls = 0;
  const request = async () => { calls++; return stream({ type: 'tool-input-available', toolCallId: 'a', toolName: 'write', input: {} }, finish); };
  await engine.start(request);
  const messageId = engine.messages.at(-1)!.id;
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const pending = engine.approve(messageId, 'a', async (_call, s) => { signal = s; return new Promise(r => { resolve = r; }); }, request);
  await new Promise(r => setTimeout(r, 0));
  engine.stop();
  resolve({ success: true });
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(engine.messages.at(-1)?.toolInvocations?.[0].outcome, 'unknown');
});
test('tool retry trusts official endpoint and reviewed read allow-list, never remote name alone', () => {
  const server = { id: 'github', name: 'GitHub', description: '', url: 'https://api.githubcopilot.com/mcp', preset: 'github' as const, status: 'connected' as const };
  const call = { toolCallId: 't', toolName: 'get_file_contents', args: {}, state: 'result' as const, outcome: 'unknown' as const };
  assert.equal(canRetryTool(call, server), true);
  assert.equal(canRetryTool({ ...call, toolName: 'push_files' }, server), false);
  assert.equal(canRetryTool(call, { ...server, url: 'https://untrusted.example/mcp' }), false);
});

test('request and stream idle deadlines are separate terminal cancellations and preserve partial output', async () => {
  const first = new ChatExecution({ publish() {}, async persist() {} }, { requestMs: 20, idleMs: 100 });
  first.reset('s', [user]);
  let receivedSignal!: AbortSignal;
  await first.start(async signal => {
    receivedSignal = signal;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Abort', 'AbortError')), { once: true }));
  });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(first.messages.at(-1)?.execution?.error?.category, 'timeout');
  const idle = new ChatExecution({ publish() {}, async persist() {} }, { requestMs: 200, idleMs: 20 });
  idle.reset('s', [user]);
  await idle.start(async signal => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"partial idle"}\n\n'));
      signal.addEventListener('abort', () => controller.error(new DOMException('Abort', 'AbortError')), { once: true });
    },
  })));
  assert.equal(idle.messages.at(-1)?.content, 'partial idle');
  assert.equal(idle.messages.at(-1)?.execution?.error?.category, 'timeout');
  assert.equal(idle.messages.length, 2);
});
test('maximum two autoretries, Redis 503 is not quota, finish length usage stays in ledger', async () => {
  const { engine } = setup();
  let count = 0;
  await engine.start(async () => { count++; return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }); });
  assert.equal(count, 3);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
  const { engine: redis } = setup();
  await redis.start(async () => new Response('{}', { status: 503, headers: { 'Retry-After': '60' } }));
  assert.equal(redis.messages.at(-1)?.execution?.error?.category, 'redis-unavailable');
  const { engine: length } = setup();
  await length.start(async () => stream({ type: 'text-delta', delta: 'partial' }, { ...finish, finishReason: 'length' }));
  assert.equal(length.messages.at(-1)?.execution?.status, 'error');
  assert.equal(summarizeUsage(length.messages).total, 15);
  const { engine: unknownFinish } = setup();
  await unknownFinish.start(async () => stream({ type: 'text-delta', delta: 'partial EOF' }, { type: 'finish', finishReason: 'other' }));
  assert.equal(unknownFinish.messages.at(-1)?.execution?.status, 'error');
  assert.equal(unknownFinish.messages.at(-1)?.content, 'partial EOF');
});
test('late concurrent tool success cannot erase another tool error or start a model', async () => {
  const { engine } = setup();
  let models = 0;
  const request = async () => { models++; return stream(toolEvent('a'), toolEvent('b'), finish); };
  const toolEvent = (toolCallId: string) => ({ type: 'tool-input-available', toolCallId, toolName: 'write', input: {} });
  await engine.start(request);
  const messageId = engine.messages.at(-1)!.id;
  let complete!: (result: unknown) => void;
  const pending = engine.approve(messageId, 'b', async () => new Promise(r => { complete = r; }), request);
  await engine.approve(messageId, 'a', async () => { throw new Error('private upstream'); }, request);
  complete({ success: true }); await pending;
  assert.equal(models, 1);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
  assert.equal(engine.messages.at(-1)?.toolInvocations?.[0].outcome, 'unknown');
});
test('explicit restart preserves the old turn and creates a new run, but never bypasses Retry-After', async () => {
  const { engine } = setup();
  const request = async () => stream({ type: 'text-delta', delta: 'answer' }, finish);
  await engine.start(request);
  const firstRun = engine.messages.at(-1)?.execution?.runId;
  await engine.restart(request);
  assert.equal(engine.messages.length, 4);
  assert.equal(engine.messages[1].content, 'answer');
  assert.notEqual(engine.messages.at(-1)?.execution?.runId, firstRun);
  const { engine: limited } = setup();
  await limited.start(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }));
  await limited.restart(request);
  assert.equal(limited.messages.length, 2);
});
test('sleep while persisting retry checkpoint cannot reset the retry deadline and resurrect a request', async t => {
  const now = Date.now();
  const engine = new ChatExecution({ publish() {}, async persist(messages) {
    if (messages.at(-1)?.execution?.status === 'retry-wait') t.mock.method(Date, 'now', () => now + 60000);
  } });
  engine.reset('s', [user]);
  let calls = 0;
  await engine.start(async () => { calls++; return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }); });
  assert.equal(calls, 1);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
});
test('successful MCP checkpoint reserves the next model step against a new user turn', async () => {
  let release!: () => void;
  const engine = new ChatExecution({ publish() {}, async persist(messages) {
    if (messages.at(-1)?.toolInvocations?.[0].outcome === 'success') await new Promise<void>(r => { release = r; });
  } });
  engine.reset('s', [user]);
  let calls = 0;
  const request = async () => ++calls === 1 ? stream({ type: 'tool-input-available', toolCallId: 'a', toolName: 'read', input: {} }, finish) : stream(finish);
  await engine.start(request);
  const approval = engine.approve(engine.messages.at(-1)!.id, 'a', async () => ({ file: 'saved' }), request);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(engine.submit('must not overtake', request), false);
  release(); await approval;
  assert.equal(calls, 2);
  assert.equal(engine.messages.filter(m => m.role === 'user').length, 1);
});
test('two MCP rounds accumulate all model steps in one run with unique steps/attempts and cache/reasoning not double counted', async () => {
  const { engine } = setup();
  let requests = 0;
  const request = async () => ++requests < 3 ? stream({ type: 'tool-input-available', toolCallId: `read-${requests}`, toolName: 'read', input: {} }, finish) : stream(finish);
  await engine.start(request);
  await engine.approve(engine.messages.at(-1)!.id, 'read-1', async () => ({ file: 'a' }), request);
  await engine.approve(engine.messages.at(-1)!.id, 'read-2', async () => ({ file: 'b' }), request);
  const attempts = engine.messages.filter(m => m.execution).map(m => m.execution!);
  assert.equal(requests, 3);
  assert.equal(new Set(attempts.map(a => a.runId)).size, 1);
  assert.equal(new Set(attempts.map(a => a.stepId)).size, 3);
  assert.equal(new Set(attempts.map(a => a.attemptId)).size, 3);
  assert.equal(summarizeUsage(engine.messages).total, 45);
  assert.equal(summarizeUsage(engine.messages).last?.usage?.cachedTokens, 4);
  assert.equal(summarizeUsage(engine.messages).last?.usage?.reasoningTokens, 2);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const toolEvent = (toolCallId = 'write') => ({ type: 'tool-input-available', toolCallId, toolName: 'write', input: {} });

test('approval-save → Deny owns the handoff; old model finally cannot unlock its pending checkpoint', async t => {
  const approvalSave = deferred(), approvalStarted = deferred(), denialSave = deferred(), denialStarted = deferred();
  const response = deferred<Response>(), requestStarted = deferred();
  const engine = new ChatExecution({ publish() {}, async persist(messages) {
    const last = messages.at(-1);
    if (last?.execution?.status === 'approval') { approvalStarted.resolve(); await approvalSave.promise; }
    if (last?.toolInvocations?.[0].outcome === 'declined') { denialStarted.resolve(); await denialSave.promise; }
  } });
  t.after(() => { engine.stop(); approvalSave.resolve(); denialSave.resolve(); response.resolve(stream(finish)); });
  engine.reset('s', [user]);
  let models = 0;
  const request = async () => {
    if (++models === 1) return stream(toolEvent(), finish);
    requestStarted.resolve(); return response.promise;
  };
  const first = engine.start(request);
  await approvalStarted.promise;
  const denial = engine.decline(engine.messages.at(-1)!.id, 'write', request);
  approvalSave.resolve(); await first; await denialStarted.promise;
  assert.equal(engine.busy, true, 'the denial checkpoint still owns the inter-step lock');
  assert.equal(engine.submit('must stay in composer', request), false);
  denialSave.resolve(); await requestStarted.promise;
  assert.equal(engine.submit('third must stay in composer too', request), false);
  assert.equal(models, 2);
  assert.equal(engine.messages.filter(m => m.role === 'user').length, 1);
  response.resolve(stream(finish)); await denial;
});

test('user admission reserves the model before publishing; synchronous re-entry cannot accept a second user', async () => {
  const response = deferred<Response>(), requested = deferred();
  let reentered = false, accepted = true, models = 0;
  const engine = new ChatExecution({ publish(messages) {
    if (!reentered && messages.some(m => m.content === 'first atomic user')) {
      reentered = true;
      accepted = engine.submit('reentrant user', request);
    }
  }, async persist() {} });
  const request = async () => { models++; requested.resolve(); return response.promise; };
  engine.reset('s', []);
  assert.equal(engine.submit('first atomic user', request), true);
  await requested.promise;
  assert.equal(accepted, false);
  assert.equal(engine.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(models, 1);
  engine.stop(); response.resolve(stream(finish)); await engine.flush();
});

test('dirty storage retains known MCP success, allows continuation and switching, and saves all chats on recovery', async () => {
  let fail = false;
  const checkpoints: Message[][] = [];
  const engine = new ChatExecution({ publish() {}, async persist(messages) {
    if (fail) throw new Error('storage offline');
    checkpoints.push(structuredClone(messages));
  } });
  engine.reset('s', [user]);
  let models = 0, tools = 0;
  const request = async () => ++models === 1 ? stream(toolEvent(), finish) : stream({ type: 'text-delta', delta: 'done' }, finish);
  await engine.start(request);
  await engine.approve(engine.messages.at(-1)!.id, 'write', async () => { tools++; fail = true; return { committed: 'known write' }; }, request);
  await engine.flush();
  assert.equal(engine.storageError?.category, 'storage');
  assert.deepEqual(engine.messages[1].toolInvocations?.[0].result, { committed: 'known write' });
  assert.equal(models, 2); assert.equal(tools, 1);
  await engine.prepareSwitch();
  engine.reset('other', [user]);
  await engine.start(request);
  assert.equal(engine.exportUnsaved().length, 2);
  assert.equal(engine.snapshot('s')?.[1].toolInvocations?.[0].outcome, 'success');
  fail = false;
  assert.equal(await engine.save(), true);
  assert.equal(engine.storageError, undefined);
  assert.equal(engine.exportUnsaved().length, 0);
  assert.ok(checkpoints.some(ms => ms[1].toolInvocations?.[0]?.outcome === 'success'));
  assert.equal(tools, 1, 'storage recovery must never replay the write');
});

for (const reason of ['expired', 'hidden'] as const) {
  test(`autoretry checks ${reason} AFTER the next attempt's initial checkpoint and logs it as unsent`, async t => {
    const now = Date.now();
    let visible = true, models = 0;
    const engine = new ChatExecution({ publish() {}, visible: () => visible, async persist(messages) {
      if (messages.filter(m => m.execution).length === 2 && messages.at(-1)?.execution?.status === 'waiting') {
        if (reason === 'expired') t.mock.method(Date, 'now', () => now + 61000);
        else visible = false;
      }
    } });
    engine.reset('s', [user]);
    await engine.start(async () => { models++; return stream({ type: 'error', errorText: JSON.stringify(classifyError({ statusCode: 429 })) }); });
    assert.equal(models, 1, 'no request is sent after storage latency/sleep or hiding');
    assert.equal(engine.messages.at(-1)?.execution?.status, 'error');
    assert.equal(engine.messages.at(-1)?.execution?.requestSent, false);
    assert.equal(engine.messages[1].execution?.requestSent, true);
  });
}

test('Stop at the successful MCP result checkpoint preserves a pending MODEL continuation, before/after reload', async t => {
  const savedResult = deferred(), resultSaving = deferred();
  let hold = true, models = 0, tools = 0;
  const checkpoints: Message[][] = [];
  const engine = new ChatExecution({ publish() {}, async persist(messages) {
    if (hold && messages.at(-1)?.toolInvocations?.[0].outcome === 'success') {
      resultSaving.resolve(); await savedResult.promise;
    }
    checkpoints.push(structuredClone(messages));
  } });
  t.after(() => { engine.stop(); hold = false; savedResult.resolve(); });
  engine.reset('s', [user]);
  const request = async () => { models++; return stream(toolEvent(), finish); };
  await engine.start(request);
  const approval = engine.approve(engine.messages.at(-1)!.id, 'write', async () => { tools++; return { committed: true }; }, request);
  await resultSaving.promise;
  assert.equal(engine.messages.at(-1)?.execution?.status, 'pending-model');
  engine.stop(); hold = false; savedResult.resolve(); await approval; await engine.flush();
  assert.equal(models, 1);
  assert.equal(engine.messages.at(-1)?.execution?.status, 'cancelled');
  assert.equal(engine.messages.at(-1)?.toolInvocations?.[0].outcome, 'success');
  const snapshot = checkpoints.at(-1)!;
  const continueModel = async (_signal: AbortSignal, history: Message[]) => {
    models++;
    assert.deepEqual(history.at(-1)?.toolInvocations?.[0].result, { committed: true });
    return stream(finish);
  };
  await engine.retry(continueModel);
  assert.equal(models, 2);
  engine.reset('s', snapshot); await engine.retry(continueModel);
  assert.equal(models, 3); assert.equal(tools, 1);
});

test('pending MODEL continuation never accepts unknown/error/unresolved tool results', async () => {
  for (const bad of ['unknown', 'error', 'executing'] as const) {
    const { engine } = setup();
    await engine.start(async () => stream(toolEvent('a'), toolEvent('b'), finish));
    const last = engine.messages.at(-1)!;
    engine.reset('s', [...engine.messages.slice(0, -1), { ...last,
      execution: { ...last.execution!, status: 'interrupted', continuationPending: true },
      toolInvocations: last.toolInvocations!.map((call, i) => ({ ...call,
        state: i && bad === 'executing' ? 'executing' : 'result',
        outcome: i && bad !== 'executing' ? bad : 'success', result: { committed: true },
      })),
    }]);
    let models = 0;
    await engine.retry(async () => { models++; return stream(finish); });
    assert.equal(models, 0, bad);
  }
});

test('detach precedes deletion, waits in-flight saves and suppresses stop/pagehide/late-result checkpoints', async t => {
  const saveStarted = deferred(), saved = deferred(), response = deferred<Response>();
  const writes: string[] = [];
  const engine = new ChatExecution({ publish() {}, async persist(_messages, sessionId) {
    saveStarted.resolve(); await saved.promise; writes.push(sessionId);
  } });
  t.after(() => { engine.stop(); saved.resolve(); response.resolve(stream(finish)); });
  engine.reset('deleted', [user]);
  const pending = engine.start(async () => response.promise);
  await saveStarted.promise;
  let detached = false;
  const deletion = engine.detach('deleted').then(() => { detached = true; writes.push('DELETE'); });
  engine.stop('interrupted');
  assert.equal(detached, false, 'delete must wait for a save already handed to storage');
  saved.resolve(); await deletion;
  engine.stop('interrupted'); response.resolve(stream(finish)); await pending; await engine.flush();
  assert.deepEqual(writes, ['deleted', 'DELETE']);
  engine.reset('unaffected', [user]);
  await engine.start(async () => stream(finish)); await engine.flush();
  assert.ok(writes.slice(2).every(s => s === 'unaffected'));
  assert.ok(writes.length > 2);
});

test('an older stop checkpoint failure is visible but cannot unlock a new model operation', async t => {
  const stoppedSaving = deferred(), stoppedSave = deferred();
  const response = deferred<Response>(), requested = deferred(), storageFailed = deferred();
  const engine = new ChatExecution({ publish() {}, storage(error) { if (error) storageFailed.resolve(); }, async persist(messages) {
    if (messages.at(-1)?.execution?.status === 'cancelled') { stoppedSaving.resolve(); await stoppedSave.promise; }
  } });
  t.after(() => { engine.stop(); stoppedSave.resolve(); response.resolve(stream(finish)); });
  engine.reset('s', [user]);
  await engine.start(async () => stream(finish));
  const first = engine.start(async () => { requested.resolve(); return response.promise; });
  await requested.promise; engine.stop(); await stoppedSaving.promise;
  const next = engine.start(async () => response.promise);
  stoppedSave.reject(new Error('old checkpoint failed'));
  await storageFailed.promise;
  assert.equal(engine.busy, true);
  assert.equal(engine.submit('must not overtake newer request', async () => stream(finish)), false);
  response.resolve(stream(finish)); await first; await next;
  await engine.flush();
  assert.equal(engine.storageError, undefined, 'a newer full checkpoint recovers the older failure');
});

test('unsent retry attempts stay explicit but are not counted as unknown provider usage', async () => {
  const { engine } = setup();
  await engine.start(async () => stream(finish));
  const known = engine.messages.at(-1)!;
  const unsent: Message = { ...known, id: 'unsent', content: '', execution: { ...known.execution!, attemptId: 'unsent-attempt', status: 'error', requestSent: false, usage: undefined } };
  const usage = summarizeUsage([...engine.messages, unsent]);
  assert.equal(usage.total, 15); assert.equal(usage.incomplete, false);
  const uncertain = recoverMessages([{ ...unsent, execution: { ...unsent.execution!, status: 'waiting' } }]);
  assert.equal(uncertain[0].execution?.requestSent, undefined);
  assert.equal(summarizeUsage(uncertain).incomplete, true, 'reload cannot infer no request from a pre-request checkpoint');
});

test('inactive detach never waits for or invalidates an unrelated active checkpoint', async t => {
  const saving = deferred(), saved = deferred();
  const engine = new ChatExecution({ publish() {}, async persist() { saving.resolve(); await saved.promise; } });
  t.after(() => { engine.stop(); saved.resolve(); });
  engine.reset('active', [user]);
  let models = 0;
  const pending = engine.start(async () => { models++; return stream(finish); });
  await saving.promise;
  await engine.detach('inactive');
  assert.equal(engine.busy, true);
  assert.equal(engine.sessionId, 'active');
  saved.resolve(); await pending;
  assert.equal(models, 1);
});

test('active detach retains dirty RAM until deletion is confirmed or cancelled', async () => {
  let fail = false;
  const engine = new ChatExecution({ publish() {}, async persist() { if (fail) throw new Error('offline'); } });
  engine.reset('active', [user]);
  let models = 0;
  const request = async () => ++models === 1 ? stream(toolEvent(), finish) : stream(finish);
  await engine.start(request);
  await engine.approve(engine.messages.at(-1)!.id, 'write', async () => { fail = true; return { committed: true }; }, request);
  await engine.detach('active');
  engine.reattach('active');
  assert.equal(engine.snapshot('active')?.[1].toolInvocations?.[0].outcome, 'success');
  assert.deepEqual(engine.messages[1].toolInvocations?.[0].result, { committed: true });
  fail = false; await engine.save(); await engine.flush();
});

test('switch/reload preserves unapproved tools, never executes them, and records the interruption source', async () => {
  const { engine } = setup();
  let models = 0;
  const request = async () => { models++; return stream(toolEvent(), finish); };
  await engine.start(request);
  await engine.prepareSwitch();
  const snapshot = engine.snapshot('s')!;
  assert.equal(snapshot.at(-1)?.execution?.status, 'approval');
  engine.reset('other', []); engine.reset('s', snapshot);
  assert.equal(engine.messages.at(-1)?.toolInvocations?.[0].state, 'needs-approval');
  assert.equal(models, 1);
  const interrupted = recoverMessages([{ ...user, role: 'assistant', execution: { ...snapshot.at(-1)!.execution!, status: 'streaming' } }]);
  assert.equal(interrupted[0].execution?.interruption, 'reload');
  const legacy = recoverMessages([{ ...snapshot.at(-1)!, execution: { ...snapshot.at(-1)!.execution!, status: 'error', error: { category: 'storage', message: 'Old storage barrier', retryable: false } } }]);
  assert.equal(legacy[0].execution?.error, undefined, 'old persisted storage barriers must not claim the disk is still broken');
});

test('response length, content filter, malformed stream and EOF have distinct errors and retain partial text', async () => {
  for (const [reason, category] of [['length', 'response-limit'], ['content-filter', 'content-filter'], ['other', 'protocol']] as const) {
    const { engine } = setup();
    await engine.start(async () => stream({ type: 'text-delta', delta: 'partial' }, { ...finish, finishReason: reason }));
    assert.equal(engine.messages.at(-1)?.content, 'partial');
    assert.equal(engine.messages.at(-1)?.execution?.error?.category, category);
  }
  const { engine } = setup();
  await engine.start(async () => new Response('data: {"type":"text-delta","delta":"partial"}\n\ndata: {broken}\n\n'));
  assert.equal(engine.messages.at(-1)?.execution?.error?.category, 'protocol');
  assert.equal(engine.messages.at(-1)?.content, 'partial');
  await engine.start(async () => stream({ type: 'text-delta', delta: 'EOF partial' }));
  assert.equal(engine.messages.at(-1)?.execution?.error?.category, 'interrupted');
});

test('temporary storage mode does not stop text generation or accept duplicate tool approvals', async () => {
  let models = 0, tools = 0;
  const engine = new ChatExecution({ publish() {}, async persist() { throw new DOMException('private details', 'QuotaExceededError'); } });
  engine.reset('temp', [user]);
  const request = async () => ++models === 1 ? stream(toolEvent(), finish) : stream({ type: 'text-delta', delta: 'confirmed' }, finish);
  await engine.start(request);
  const messageId = engine.messages.at(-1)!.id;
  await Promise.all([1, 2].map(() => engine.approve(messageId, 'write', async () => { tools++; return { committed: true }; }, request)));
  assert.equal(tools, 1); assert.equal(models, 2);
  assert.equal(engine.messages.at(-1)?.content, 'confirmed');
  assert.equal(engine.storageError?.code, 'QuotaExceededError');
  assert.ok(!JSON.stringify(engine.storageError).includes('private details'));
  assert.equal(engine.hasUnsavedChanges, true);
  assert.equal(engine.submit('a new message', async () => stream(finish)), true);
  await engine.prepareSwitch();
  engine.reset('new', []);
  assert.ok(engine.snapshot('temp')?.some(m => m.content === 'a new message'));
});

test('deleting an inactive session waits for its own in-flight save without stopping the active model', async t => {
  const saving = deferred(), saved = deferred(), response = deferred<Response>();
  const writes: string[] = [];
  const engine = new ChatExecution({ publish() {}, async persist(_messages, sessionId) {
    if (sessionId === 'old') { saving.resolve(); await saved.promise; }
    writes.push(sessionId);
  } });
  t.after(() => { saved.resolve(); response.resolve(stream(finish)); engine.stop(); });
  engine.reset('old', [user]);
  const old = engine.start(async () => stream(finish));
  await saving.promise;
  await engine.prepareSwitch(); engine.reset('new', [user]);
  const current = engine.start(async () => response.promise);
  let deleted = false;
  const deletion = engine.detach('old').then(() => { deleted = true; writes.push('DELETE old'); });
  assert.equal(deleted, false);
  assert.equal(engine.busy, true);
  saved.resolve(); await deletion;
  assert.deepEqual(writes.slice(0, 2), ['old', 'DELETE old']);
  response.resolve(stream(finish)); await Promise.all([old, current]);
  assert.equal(engine.sessionId, 'new');
  assert.equal(engine.messages.at(-1)?.execution?.status, 'complete');
});
