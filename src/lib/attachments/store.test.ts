import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory, IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { openDB } from 'idb';
import { deleteSession, getAttachment, getSession, getSettings, saveSession } from '../db';
import type { AttachmentRecord, AttachmentRef, Session } from '../types';
import {
  exportAttachmentsForSessions, forgetSessionAttachments, loadAttachment,
  persistSessionWithAttachments, stageAttachments,
} from './store';

const stagedSessions = new Set<string>();
beforeEach(() => {
  Object.assign(globalThis, { window: {}, indexedDB: new IDBFactory() });
});
afterEach(async () => {
  for (const id of stagedSessions) forgetSessionAttachments(id);
  stagedSessions.clear();
  const original = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    this.close();
    return original.apply(this, args);
  };
  try { await assert.rejects(getSettings(), { name: 'InvalidStateError' }); }
  finally { IDBDatabase.prototype.transaction = original; }
});

const attachment = (id: string): AttachmentRecord => ({
  id, name: `${id}.txt`, kind: 'text', mediaType: 'text/plain', size: 7, data: 'private',
});
const ref = ({ id, name, kind, mediaType, size }: AttachmentRef): AttachmentRef => ({ id, name, kind, mediaType, size });
const snapshot = (id: string, records: AttachmentRef[] = []): Session => ({
  id, title: id, updatedAt: 1,
  messages: [{ id: 'user', role: 'user', content: 'hello', attachments: records }],
});
function stage(id: string, records: AttachmentRecord[]): void {
  stagedSessions.add(id);
  stageAttachments(id, records);
}

test('staging is synchronous, disk-free and immutable even if callers mutate records or loaded values', async () => {
  const record = attachment('ram-only');
  const original = { ...record };
  const open = indexedDB.open;
  indexedDB.open = () => { throw new Error('Staging must not open IndexedDB'); };
  try { assert.equal(stage('ram-session', [record]), undefined); }
  finally { indexedDB.open = open; }
  record.data = 'changed';
  record.name = 'renamed';
  const loaded = await loadAttachment(ref(original));
  assert.deepEqual(loaded, original);
  try { loaded.data = 'mutated result'; } catch { /* Frozen return values are also safe. */ }
  assert.deepEqual(await loadAttachment(ref(original)), original);
  assert.equal(await getAttachment(original.id), undefined);
});

test('staging rejects conflicting content, metadata, ownership and duplicate batches without partial changes', async () => {
  const record = attachment('stage-conflict');
  stage('stage-owner', [record]);
  stage('stage-owner', [{ ...record }]); // Identical re-staging is idempotent.
  assert.throws(() => stage('stage-owner', [{ ...record, data: 'changed' }]));
  assert.throws(() => stage('stage-owner', [{ ...record, name: 'changed' }]));
  assert.throws(() => stage('stage-other', [record]));
  const fresh = attachment('stage-fresh');
  assert.throws(() => stage('stage-owner', [fresh, { ...record, data: 'changed' }]));
  assert.throws(() => stage('stage-owner', [fresh, fresh]));
  await assert.rejects(loadAttachment(ref(fresh)), { message: 'Attachment is unavailable.' });
  assert.deepEqual(await loadAttachment(ref(record)), record);
});

test('only referenced pending files are committed; checkpoints and model restarts reuse one stored payload', async () => {
  const first = attachment('pending-first');
  const second = attachment('pending-second');
  stage('pending-session', [first, second]);
  const session = snapshot('pending-session', [ref(first)]);
  session.messages.push({ ...session.messages[0], id: 'restart' });
  let writes = 0;
  const put = IDBObjectStore.prototype.put;
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'attachments') writes++;
    return put.apply(this, args);
  };
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'attachments') writes++;
    return add.apply(this, args);
  };
  try {
    await persistSessionWithAttachments(session);
    assert.equal(writes, 1);
    assert.equal(await getAttachment(second.id), undefined);
    stage(session.id, [{ ...first }]); // Must retain the committed flag.
    for (let i = 0; i < 4; i++) await persistSessionWithAttachments({ ...session, updatedAt: i + 2 });
    assert.equal(writes, 1);
    await persistSessionWithAttachments(snapshot(session.id, [ref(first), ref(second)]));
    assert.equal(writes, 2);
    await persistSessionWithAttachments(session);
    assert.equal(writes, 2);
  } finally {
    IDBObjectStore.prototype.put = put;
    IDBObjectStore.prototype.add = add;
  }
  assert.deepEqual(await getAttachment(first.id), first);
  assert.deepEqual(await getAttachment(second.id), second);
  assert.deepEqual((await getSession(session.id))?.messages[0].attachments, [ref(first)]);
});

test('a failed commit keeps RAM recovery and pending state; retry commits and later checkpoints do not rewrite', async () => {
  const record = attachment('retry');
  const session = snapshot('retry-session', [ref(record)]);
  stage(session.id, [record]);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(persistSessionWithAttachments(session), { name: 'AbortError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
  assert.deepEqual(await loadAttachment(ref(record)), record);
  assert.deepEqual(await exportAttachmentsForSessions([session]), [record]);
  await persistSessionWithAttachments(session);
  // The DB rejects any attempt to supply an already persisted ID. Success here
  // proves that commit, not request success/failure, controls the pending flag.
  await persistSessionWithAttachments({ ...session, updatedAt: 2 });
  assert.deepEqual(await getAttachment(record.id), record);
});

test('historical payloads load from disk without an unbounded RAM cache', async () => {
  const record = attachment('historical');
  const session = snapshot('historical-session', [ref(record)]);
  await saveSession(session, [record]);
  assert.deepEqual(await loadAttachment(ref(record)), record);
  await deleteSession(session.id);
  await assert.rejects(loadAttachment(ref(record)), { message: 'Attachment is unavailable.' });
});

test('lost commit acknowledgement reconciles exact existing bytes and retries without rewriting an immutable payload', async () => {
  const record = attachment('lost-ack');
  const session = snapshot('lost-ack-session', [ref(record)]);
  stage(session.id, [record]);
  const addListener = IDBTransaction.prototype.addEventListener;
  IDBTransaction.prototype.addEventListener = function (...args: Parameters<typeof addListener>) {
    const [type, listener, options] = args;
    if (type === 'complete' && this.mode === 'readwrite' && Array.from(this.objectStoreNames).includes('attachments')) return;
    return addListener.call(this, type, listener, options);
  };
  try { await assert.rejects(persistSessionWithAttachments(session), { name: 'TimeoutError' }); }
  finally { IDBTransaction.prototype.addEventListener = addListener; }
  assert.deepEqual(await getAttachment(record.id), record, 'native transaction committed despite missing acknowledgement');
  let writes = 0;
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args) { if (this.name === 'attachments') writes++; return add.apply(this, args); };
  try {
    await persistSessionWithAttachments({ ...session, updatedAt: 2 });
    await persistSessionWithAttachments({ ...session, updatedAt: 3 });
    assert.equal(writes, 0);
  } finally { IDBObjectStore.prototype.add = add; }
  assert.equal((await getSession(session.id))?.updatedAt, 3);
});

test('missing or mismatched RAM/disk payloads throw a fixed safe error without private content', async () => {
  const ram = attachment('metadata-ram');
  const disk = attachment('metadata-disk');
  stage('metadata-session', [ram]);
  await saveSession(snapshot('metadata-disk-session', [ref(disk)]), [disk]);
  for (const record of [ram, disk]) {
    for (const changed of [
      { name: 'private filename' }, { kind: 'image' as const },
      { mediaType: 'private/type' }, { size: 1234 },
    ]) {
      await assert.rejects(loadAttachment({ ...ref(record), ...changed }), { message: 'Attachment is unavailable.' });
    }
  }
  await assert.rejects(loadAttachment(ref(attachment('private missing id'))), { message: 'Attachment is unavailable.' });
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...args) {
    if (this.name === 'attachments') throw new DOMException('secret raw storage content', 'SecurityError');
    return get.apply(this, args);
  };
  try { await assert.rejects(loadAttachment(ref(disk)), { message: 'Attachment is unavailable.' }); }
  finally { IDBObjectStore.prototype.get = get; }
});

test('a missing historical attachment never produces a falsely successful checkpoint or export', async () => {
  const existing = attachment('mixed-existing');
  const missing = attachment('mixed-missing');
  const session = snapshot('mixed-session', [ref(existing), ref(missing)]);
  stage(session.id, [existing]);
  await assert.rejects(persistSessionWithAttachments(session));
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(existing.id), undefined);
  await assert.rejects(exportAttachmentsForSessions([session]), { message: 'Attachment is unavailable.' });
  assert.deepEqual(await loadAttachment(ref(existing)), existing);
});

test('recovery export resolves all unique text/image refs from RAM and disk and rejects conflicting refs', async () => {
  const disk = attachment('export-disk');
  const ram = { ...attachment('export-image'), kind: 'image' as const, mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=', size: 8 };
  const historical = snapshot('export-history', [ref(disk)]);
  await saveSession(historical, [disk]);
  stage('export-current', [ram]);
  const current = snapshot('export-current', [ref(ram), ref(disk)]);
  assert.deepEqual(await exportAttachmentsForSessions([historical, current, current]), [disk, ram]);
  await assert.rejects(exportAttachmentsForSessions([
    historical, snapshot('conflict', [{ ...ref(disk), size: 1 }]),
  ]), { message: 'Attachment is unavailable.' });
  assert.deepEqual(await exportAttachmentsForSessions([]), []);
});

test('staged files remain isolated by session; forgetting one session does not clear another', async () => {
  const first = attachment('isolated-first');
  const second = attachment('isolated-second');
  stage('isolated-a', [first]);
  stage('isolated-b', [second]);
  await assert.rejects(persistSessionWithAttachments(snapshot('isolated-b', [ref(first)])));
  assert.equal(await getSession('isolated-b'), undefined);
  await persistSessionWithAttachments(snapshot('isolated-b', [ref(second)]));
  forgetSessionAttachments('isolated-a');
  await assert.rejects(loadAttachment(ref(first)), { message: 'Attachment is unavailable.' });
  assert.deepEqual(await loadAttachment(ref(second)), second);
  await persistSessionWithAttachments(snapshot('isolated-b', [ref(second)]));
});

test('forgetting after deletion cannot resurrect RAM on a late save completion or allow a stale checkpoint', async () => {
  const record = attachment('forgotten');
  const session = snapshot('forgotten-session', [ref(record)]);
  stage(session.id, [record]);
  const pending = persistSessionWithAttachments(session);
  // Production lifecycle drains writes before delete/forget. Exercise an even
  // later completion here to ensure it cannot put removed entries back in RAM.
  forgetSessionAttachments(session.id);
  await pending;
  await deleteSession(session.id);
  await assert.rejects(loadAttachment(ref(record)), { message: 'Attachment is unavailable.' });
  assert.throws(() => stageAttachments(session.id, [record]));
  await assert.rejects(persistSessionWithAttachments(session));
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
});

test('retry saving a RAM snapshot on intermediate v3 repairs missing sessionRef and preserves staged/historical payloads', async () => {
  const historical = attachment('migration-history');
  const fresh = attachment('migration-staged');
  const owner = 'migration-owner';
  const old = await openDB('ai-workspace', 3, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('settings', { keyPath: 'id' });
      db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    },
  });
  await old.put('sessions', snapshot(owner, [ref(historical)]));
  await old.put('attachments', { ...historical, sessionId: owner });
  await old.put('settings', { id: 'default', systemPrompt: 'retained', rememberKeys: false });
  old.close();
  stage(owner, [fresh]);
  const session = snapshot(owner, [ref(historical), ref(fresh)]);
  await persistSessionWithAttachments(session);
  await persistSessionWithAttachments({ ...session, title: 'completed answer' });
  assert.equal((await getSession(owner))?.title, 'completed answer');
  assert.deepEqual(await getAttachment(historical.id), historical);
  assert.deepEqual(await getAttachment(fresh.id), fresh);
  assert.deepEqual(await loadAttachment(ref(fresh)), fresh);
  assert.equal((await getSettings())?.systemPrompt, 'retained');
});
