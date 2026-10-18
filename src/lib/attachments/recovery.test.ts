import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory, IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { openDB } from 'idb';
import { deleteSession, getAttachment, getSession, getSessions, getSettings, saveSession, saveSettings } from '../db';
import type { AttachmentRecord, AttachmentRef, Execution, Message, Session } from '../types';
import { exportAttachmentsForSessions, forgetSessionAttachments, loadAttachment, persistSessionWithAttachments, stageAttachments } from './store';
import {
  createRecoveryExport, importRecovery, MAX_RECOVERY_BYTES, parseRecovery,
  RecoveryStorageError, RecoveryValidationError,
} from './recovery';

const originalBitmap = globalThis.createImageBitmap;
const stagedSessions = new Set<string>();
let decoded = 0;
let closed = 0;
beforeEach(async () => {
  decoded = closed = 0;
  Object.assign(globalThis, {
    window: {}, indexedDB: new IDBFactory(),
    createImageBitmap: async () => {
      decoded++;
      return { width: 1, height: 1, close: () => { closed++; } };
    },
  });
  await getSettings(); // Establish the connection before cleanup/transaction fault injection.
});
afterEach(async () => {
  for (const id of stagedSessions) forgetSessionAttachments(id);
  stagedSessions.clear();
  if (originalBitmap) globalThis.createImageBitmap = originalBitmap;
  else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) { this.close(); return original.apply(this, args); };
  try { await assert.rejects(getSettings(), { name: 'InvalidStateError' }); }
  finally { IDBDatabase.prototype.transaction = original; }
});

const ref = ({ id, name, kind, mediaType, size }: AttachmentRef): AttachmentRef => ({ id, name, kind, mediaType, size });
const text = (id = 'file', data = '\ufeffПривет 🌍\r\n'): AttachmentRecord => ({
  id, name: 'notes.txt', kind: 'text', mediaType: 'text/plain', data, size: new TextEncoder().encode(data).length,
});
const png = (): AttachmentRecord => {
  const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDTkAAAAASUVORK5CYII=';
  return { id: 'image', name: 'photo.png', kind: 'image', mediaType: 'image/png', size: atob(encoded).length, data: `data:image/png;base64,${encoded}` };
};
const backup = (records: AttachmentRecord[] = [text()]) => ({
  version: 2, exportedAt: '2026-10-17T00:00:00.000Z',
  sessions: [{ id: 'source', messages: [{ id: 'user', role: 'user', content: 'Recovered title', attachments: records.map(ref) }] }],
  attachments: records,
});
const parsed = (value: unknown) => parseRecovery(JSON.stringify(value));
const execution = (status: Execution['status'] = 'streaming'): Execution => ({
  sessionId: 'source', runId: 'run', stepId: 'step', attemptId: 'attempt', status, startedAt: 1, retryAt: 9, retryNumber: 2, continuationPending: true,
});

test('current v2 and historical v1 exports parse without disk writes; errors never contain raw JSON', async () => {
  let opens = 0;
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => { opens++; return open(...args); };
  assert.equal(parsed(backup()).attachments[0].data, text().data);
  const v1 = { version: 1, exportedAt: backup().exportedAt, sessions: backup([]).sessions };
  assert.deepEqual(parsed(v1).attachments, []);
  assert.equal(opens, 0);
  for (const value of ['private-file-content{', 'null', '[]', '{"version":99}', JSON.stringify({ ...v1, version: 99 })]) {
    assert.throws(() => parseRecovery(value), (error: unknown) => error instanceof RecoveryValidationError && !error.message.includes('private-file-content'));
  }
});

test('imports new copies, preserves originals/settings, deduplicates repeated refs and remaps shared refs per session', async () => {
  const record = text();
  const original: Session = { id: 'source', title: 'original', updatedAt: 1, messages: [{ id: 'user', role: 'user', content: 'original', attachments: [ref(record)] }] };
  await saveSession(original, [record]);
  const settings = { id: 'default' as const, rememberKeys: true, customKey: 'synthetic-key', systemPrompt: 'retained' };
  await saveSettings(settings);
  const raw = backup([record, png()]);
  raw.sessions[0].messages.push({ ...raw.sessions[0].messages[0], id: 'again' });
  raw.sessions.push({ id: 'other', messages: [{ ...raw.sessions[0].messages[0] }] });
  const value = parsed(raw);
  const before = JSON.stringify(value);
  const recovered = await importRecovery(value);
  assert.equal(decoded, 1);
  assert.equal(closed, 1);
  assert.equal(JSON.stringify(value), before);
  assert.equal(recovered.length, 2);
  assert.deepEqual(await getSession(original.id), original);
  assert.deepEqual(await getSettings(), settings);
  const ids = recovered.map(s => s.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every(id => !['source', 'other'].includes(id)));
  assert.equal(new Set(recovered.flatMap(s => s.messages.map(m => m.id))).size, 3);
  const a = recovered[0].messages[0].attachments!;
  const b = recovered[1].messages[0].attachments!;
  assert.deepEqual(recovered[0].messages[1].attachments, a);
  assert.notEqual(a[0].id, b[0].id);
  assert.notEqual(a[0].id, record.id);
  assert.equal((await getAttachment(a[0].id))?.data, record.data);
  assert.equal((await getAttachment(b[0].id))?.data, record.data);
  assert.equal('data' in a[0], false);
  for (const session of recovered) {
    assert.deepEqual(await getSession(session.id), session);
    await persistSessionWithAttachments(session);
  }
  await deleteSession(recovered[0].id);
  assert.equal(await getAttachment(a[0].id), undefined);
  assert.equal((await getAttachment(b[0].id))?.data, record.data);
  assert.deepEqual(await getAttachment(record.id), record);
  const again = await importRecovery(value);
  assert.ok(again.every(s => !ids.includes(s.id)));
});

test('all active execution states and pending approvals become inert interrupted history without model/tool calls', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('network must not be called'); });
  for (const status of ['waiting', 'streaming', 'approval', 'tools', 'pending-model', 'retry-wait'] as const) {
    const raw = backup([]);
    const message: Message = {
      id: 'assistant', role: 'assistant', content: 'partial', reasoning: 'thinking', reasoningOpen: true, statusLine: 'active', execution: execution(status),
      toolInvocations: ['calling', 'executing', 'needs-approval'].map((state, i) => ({
        toolCallId: `call-${i}`, toolName: 'write', args: { nested: { value: 'preserved' } }, state: state as 'calling', serverId: 'local-server', originalName: 'write', attemptId: 'attempt',
      })),
    };
    raw.sessions[0].messages.push(message as never);
    const [session] = await importRecovery(parsed(raw));
    const saved = session.messages[1];
    assert.equal(saved.execution?.status, 'interrupted');
    assert.equal(saved.execution?.sessionId, session.id);
    assert.equal(saved.execution?.recovered, true);
    assert.equal(saved.execution?.continuationPending, false);
    assert.equal(saved.execution?.retryAt, undefined);
    assert.equal(saved.execution?.retryNumber, undefined);
    assert.notEqual(saved.execution?.attemptId, 'attempt');
    assert.equal(saved.reasoningOpen, false);
    assert.equal(saved.statusLine, undefined);
    assert.equal(saved.content, 'partial');
    for (const tool of saved.toolInvocations!) {
      assert.equal(tool.state, 'result');
      assert.equal(tool.serverId, undefined);
      assert.equal(tool.originalName, undefined);
      assert.equal(tool.attemptId, saved.execution?.attemptId);
      assert.deepEqual(tool.args, { nested: { value: 'preserved' } });
    }
    assert.deepEqual(saved.toolInvocations!.map(t => t.outcome), ['declined', 'unknown', 'declined']);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('completed historical results/usage and legacy reasoning are retained, but no live continuation survives', async () => {
  const raw = backup([]);
  raw.sessions[0].messages.push({
    id: 'assistant', role: 'assistant', content: 'done', execution: { ...execution('complete'), usage: { totalTokens: 12 } },
    toolInvocations: [{ toolCallId: 'call', toolName: 'read', state: 'result', args: {}, result: { content: ['historical'] }, outcome: 'success' }],
  } as never);
  raw.sessions[0].messages.push({ id: 'legacy', role: 'assistant', content: '', reasoning: 'partial legacy', reasoningOpen: true } as never);
  const [session] = await importRecovery(parsed(raw));
  assert.equal(session.messages[1].execution?.status, 'complete');
  assert.equal(session.messages[1].execution?.continuationPending, false);
  assert.deepEqual(session.messages[1].execution?.usage, { totalTokens: 12 });
  assert.deepEqual(session.messages[1].toolInvocations?.[0].result, { content: ['historical'] });
  assert.equal(session.messages[2].execution?.status, 'interrupted');
  assert.equal(session.messages[2].reasoning, 'partial legacy');
});

test('late quota/transaction failure rolls back the WHOLE backup, keeps staged RAM and permits retry/export', async () => {
  await saveSettings({ id: 'default', rememberKeys: false, systemPrompt: 'kept' });
  const record = text();
  stageAttachments('source', [record]); stagedSessions.add('source');
  const raw = backup();
  raw.sessions.push({ id: 'other', messages: [{ ...raw.sessions[0].messages[0] }] });
  const value = parsed(raw);
  const add = IDBObjectStore.prototype.add;
  let sessions = 0;
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'sessions' && ++sessions === 2) throw new DOMException('private quota detail', 'QuotaExceededError');
    return add.apply(this, args);
  };
  try {
    await assert.rejects(importRecovery(value), (error: unknown) => error instanceof RecoveryStorageError && error.code === 'QuotaExceededError' && !error.message.includes('private'));
  } finally { IDBObjectStore.prototype.add = add; }
  assert.deepEqual(await getSessions(), []);
  const db = await openDB('ai-workspace');
  try { assert.equal(await db.count('attachments'), 0); } finally { db.close(); }
  assert.deepEqual(await loadAttachment(ref(record)), record);
  assert.deepEqual(await exportAttachmentsForSessions(value.sessions), [record]);
  const exported = await createRecoveryExport(value.sessions);
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.attachments, [record]);
  assert.equal((await importRecovery(value)).length, 2);
  assert.deepEqual(await loadAttachment(ref(record)), record);
  assert.equal((await getSettings())?.systemPrompt, 'kept');
});

test('native commit abort and deadline do not leave partial imported data; retry is reusable', async t => {
  const value = parsed(backup());
  await getSettings();
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args) {
    const request = add.apply(this, args);
    if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(importRecovery(value), { name: 'RecoveryStorageError', code: 'AbortError' }); }
  finally { IDBObjectStore.prototype.add = add; }
  assert.deepEqual(await getSessions(), []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transaction = IDBDatabase.prototype.transaction;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (args[1] === 'readwrite') start();
    return tx;
  };
  try {
    const pending = importRecovery(value);
    const rejected = assert.rejects(pending, { name: 'RecoveryStorageError', code: 'AbortError' });
    await started;
    t.mock.timers.tick(60_000);
    await rejected;
  } finally { t.mock.timers.reset(); IDBDatabase.prototype.transaction = transaction; }
  const db = await openDB('ai-workspace');
  try { assert.equal(await db.count('attachments'), 0); assert.equal(await db.count('sessions'), 0); } finally { db.close(); }
  assert.equal((await importRecovery(value)).length, 1);
});

test('commit acknowledgement delayed beyond the import deadline is still reported as success', async t => {
  await getSettings();
  const dispatch = IDBTransaction.prototype.dispatchEvent;
  let delayed!: () => void;
  const committed = new Promise<void>(resolve => { delayed = resolve; });
  let completion: (() => void) | undefined;
  IDBTransaction.prototype.dispatchEvent = function (event) {
    if (event.type === 'complete' && this.mode === 'readwrite') {
      completion = () => { dispatch.call(this, event); };
      delayed();
      return true;
    }
    return dispatch.call(this, event);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = importRecovery(parsed(backup()));
    await committed;
    t.mock.timers.tick(60_000);
    completion!();
    assert.equal((await pending).length, 1);
  } finally { t.mock.timers.reset(); IDBTransaction.prototype.dispatchEvent = dispatch; }
  assert.equal((await getSessions()).length, 1);
});

test('file validation rejects invalid metadata, refs, duplicates, binary text and mismatched data/mime', () => {
  const cases: Array<(value: ReturnType<typeof backup>) => void> = [
    b => { b.sessions.push(b.sessions[0]); },
    b => { b.sessions[0].messages.push(b.sessions[0].messages[0]); },
    b => { b.attachments.push(b.attachments[0]); },
    b => { b.attachments = []; },
    b => { b.attachments.push(text('orphan')); },
    b => { b.sessions[0].messages[0].attachments[0].id = 'unknown'; },
    b => { b.sessions[0].messages[0].attachments.push(b.sessions[0].messages[0].attachments[0]); },
    b => { b.sessions[0].messages[0].attachments[0].size++; },
    b => { b.attachments[0].data += 'x'; },
    b => { b.attachments[0].data = '\u0000'.repeat(b.attachments[0].size); },
    b => { b.attachments[0].data = '\ud800'; b.attachments[0].size = 3; b.sessions[0].messages[0].attachments[0].size = 3; },
    b => { b.attachments[0].mediaType = 'text/html'; },
    b => { b.attachments[0].name = 'bad\nname'; },
    b => { b.exportedAt = '2026-02-30T00:00:00.000Z'; },
    b => { b.sessions[0].messages[0].role = 'assistant'; },
    b => { (b as unknown as Record<string, unknown>).settings = { key: 'private-file-content' }; },
    b => { b.sessions[0].messages.push({ id: 'a', role: 'assistant', content: '', execution: { ...execution(), sessionId: 'unknown' } } as never); },
    b => { b.sessions[0].messages.push({ id: 'a', role: 'assistant', content: '', toolInvocations: [{ toolCallId: 't', toolName: 't', args: [], state: 'calling' }] } as never); },
  ];
  for (const change of cases) {
    const b = backup(); change(b);
    assert.throws(() => parsed(b), RecoveryValidationError);
  }
  for (const patch of [
    { data: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { data: png().data + ' ' },
    { data: png().data.replace('iVBOR', 'aVBOR') },
    { mediaType: 'image/jpeg' },
    { size: png().size + 1 },
    { data: `data:image/png;base64,${'A'.repeat(Math.ceil(png().size / 3) * 4)}` },
  ]) {
    const record = { ...png(), ...patch };
    assert.throws(() => parsed(backup([record])), RecoveryValidationError);
  }
});

test('prototype keys, hostile programmatic objects, excessive depth and post-parse mutation are rejected safely', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = backup([]);
    raw.sessions[0].messages.push(JSON.parse(`{"id":"a","role":"assistant","content":"","toolInvocations":[{"toolCallId":"t","toolName":"t","state":"result","args":{},"result":{"${key}":{"polluted":true}}}]}`));
    assert.throws(() => parsed(raw), RecoveryValidationError);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  }
  const deep = backup([]) as unknown as Record<string, unknown>;
  let value: Record<string, unknown> = deep;
  for (let i = 0; i < 70; i++) { value.extra = {}; value = value.extra as Record<string, unknown>; }
  assert.throws(() => parsed(deep), { name: 'RecoveryValidationError', code: 'RecoveryTooLarge' });
  const valid = parsed(backup());
  valid.attachments[0].data = 'mutated';
  await assert.rejects(importRecovery(valid), RecoveryValidationError);
  const getter = Object.defineProperty({}, 'sessions', { enumerable: true, get() { throw new Error('private-getter'); } });
  await assert.rejects(importRecovery(getter as never), RecoveryValidationError);
  assert.deepEqual(await getSessions(), []);
});

test('32 MiB UTF-8 backup cap does not impose a single API request limit on a saved conversation', async () => {
  const raw = backup([]);
  raw.sessions[0].messages[0].content = 'long history '.repeat(450_000);
  assert.ok(raw.sessions[0].messages[0].content.length > 4_000_000);
  const [session] = await importRecovery(parsed(raw));
  assert.equal(session.messages[0].content, raw.sessions[0].messages[0].content);
  const oversized = JSON.stringify(backup([])) + ' '.repeat(MAX_RECOVERY_BYTES);
  assert.throws(() => parseRecovery(oversized), { name: 'RecoveryValidationError', code: 'RecoveryTooLarge' });
  raw.sessions[0].messages[0].content = 'я'.repeat(MAX_RECOVERY_BYTES / 2);
  assert.throws(() => parsed(raw), { name: 'RecoveryValidationError', code: 'RecoveryTooLarge' });
});

test('image decode rejection and pixel limits occur before any DB open/write and close bitmaps', async () => {
  const open = indexedDB.open.bind(indexedDB);
  let opens = 0;
  indexedDB.open = (...args) => { opens++; return open(...args); };
  Object.assign(globalThis, { createImageBitmap: async () => { throw new Error('private decoder failure'); } });
  await assert.rejects(importRecovery(parsed(backup([png()]))), RecoveryValidationError);
  Object.assign(globalThis, { createImageBitmap: async () => ({ width: 5000, height: 5000, close: () => { closed++; } }) });
  await assert.rejects(importRecovery(parsed(backup([png()]))), RecoveryValidationError);
  assert.equal(closed, 1);
  assert.equal(opens, 0);
});

test('expanded per-session shared attachments are bounded even when source JSON is small', () => {
  const record = text('shared', 'x'.repeat(256 * 1024));
  const raw = backup([record]);
  raw.sessions = Array.from({ length: 257 }, (_, i) => ({ id: `s-${i}`, messages: raw.sessions[0].messages }));
  assert.ok(JSON.stringify(raw).length < MAX_RECOVERY_BYTES);
  assert.throws(() => parsed(raw), { name: 'RecoveryValidationError', code: 'RecoveryTooLarge' });
});

test('duplicate JSON object keys (including escaped keys) and excessive raw nesting are rejected before import', () => {
  const json = JSON.stringify(backup());
  for (const malicious of [
    json.replace('"version":2', '"version":1,"version":2'),
    json.replace('"version":2', '"version":1,"\\u0076ersion":2'),
    json.replace('"data":', '"data":"private-file-content","data":'),
    '['.repeat(100_000) + '0' + ']'.repeat(100_000),
  ]) assert.throws(() => parseRecovery(malicious), RecoveryValidationError);
  const unusual = backup([]);
  unusual.sessions[0].messages[0].content = 'quotes " { brackets [] } backslash \\ and escaped \\\"';
  assert.equal(parseRecovery(JSON.stringify(unusual)).sessions[0].messages[0].content, unusual.sessions[0].messages[0].content);
});

test('mutation during image decoding cannot change the validated snapshot; ID collisions never overwrite data', async t => {
  const raw = backup([text(), png()]);
  raw.sessions[0].messages.push({ id: 'a', role: 'assistant', content: 'kept', toolInvocations: [
    { toolCallId: 't', toolName: 'read', args: { nested: { kept: true } }, state: 'result', result: { kept: true } },
  ] } as never);
  const value = parsed(raw);
  let finish!: () => void;
  Object.assign(globalThis, { createImageBitmap: () => new Promise(resolve => {
    finish = () => resolve({ width: 1, height: 1, close() {} });
  }) });
  const pending = importRecovery(value);
  value.sessions[0].messages[1].toolInvocations![0].args.nested = { replaced: true };
  value.sessions[0].messages[1].content = 'changed';
  value.attachments[0].data = 'changed';
  finish();
  const [saved] = await pending;
  assert.equal(saved.messages[1].content, 'kept');
  assert.deepEqual(saved.messages[1].toolInvocations?.[0].args, { nested: { kept: true } });
  assert.deepEqual(await getSession(saved.id), saved);
  assert.equal((await getAttachment(saved.messages[0].attachments![0].id))?.data, text().data);
  const settings = await getSettings();
  const sessions = await getSessions();
  t.mock.method(globalThis.crypto, 'randomUUID', () => saved.id as `${string}-${string}-${string}-${string}-${string}`);
  await assert.rejects(importRecovery(parsed(backup([]))), RecoveryStorageError);
  assert.deepEqual(await getSessions(), sessions);
  assert.deepEqual(await getSettings(), settings);
});

test('v1 imports without attachments and file size bounds/canonical base64 apply independently of backup size', async () => {
  const raw = backup([]);
  const [session] = await importRecovery(parsed({ version: 1, exportedAt: raw.exportedAt, sessions: raw.sessions }));
  assert.equal(session.messages[0].content, 'Recovered title');
  for (const record of [text('large', 'x'.repeat(256 * 1024 + 1)), { ...png(), size: 1024 * 1024 + 1 }, { ...text(), size: 0 }]) {
    assert.throws(() => parsed(backup([record])), RecoveryValidationError);
  }
  const maxImage = new Uint8Array(1024 * 1024);
  maxImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let binary = '';
  for (let offset = 0; offset < maxImage.length; offset += 8192) binary += String.fromCharCode(...maxImage.subarray(offset, offset + 8192));
  const image = { ...png(), size: maxImage.length, data: `data:image/png;base64,${btoa(binary)}` };
  assert.equal(parsed(backup([image])).attachments[0].size, maxImage.length);
  // Invalid padding bits can decode to the same bytes: require canonical base64.
  const canonical = { ...png(), size: 8, data: 'data:image/png;base64,iVBORw0KGgo=' };
  assert.equal(parsed(backup([canonical])).attachments[0].size, 8);
  assert.throws(() => parsed(backup([{ ...canonical, data: 'data:image/png;base64,iVBORw0KGgp=' }])), RecoveryValidationError);
});
