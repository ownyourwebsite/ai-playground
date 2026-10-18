import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBDatabase, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import {
  deleteSession, getAttachment, getMcpServers, getPrompts, getSession,
  getSettings, getSkills, saveSettings, getSessions, saveSession, importSessionsAtomically,
} from './db';
import type { AttachmentRecord, AttachmentRef, Session } from './types';

beforeEach(() => {
  Object.assign(globalThis, { window: {}, indexedDB: new IDBFactory() });
});

afterEach(async () => {
  // Invalidate the module's cached connection through the same public failure
  // path as a browser closing it. Every test gets its own IndexedDB factory.
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

test('a failed open is retried, writes await transaction commit and a closed database can be reopened', async () => {
  const factory = new IDBFactory();
  Object.assign(globalThis, { window: {}, indexedDB: factory });
  const open = factory.open.bind(factory);
  let opens = 0;
  factory.open = (...args) => {
    opens++;
    if (opens === 1) throw new DOMException('Private browser detail', 'SecurityError');
    return open(...args);
  };
  await assert.rejects(getSettings(), { name: 'SecurityError' });
  // openDB can also fail synchronously; both paths must permit recovery.
  await saveSettings({ id: 'default', rememberKeys: true, systemPrompt: 'retained', customModel: 'my-model' });
  assert.equal((await getSettings())?.customModel, 'my-model');
  assert.equal(opens, 3); // Failed open, current-version discovery, then v4.
  await saveSession({ id: 's', title: 'Kept', messages: [{ id: 'u', role: 'user', content: 'hello' }], updatedAt: 1 });
  assert.equal((await getSessions())[0].messages[0].content, 'hello');
  // A real connection close causes the next transaction to fail once and reset
  // the cached connection; the following retry opens a fresh one.
  const originalTransaction = IDBDatabase.prototype.transaction;
  let close = true;
  IDBDatabase.prototype.transaction = function (...args) {
    if (close) { close = false; this.close(); }
    return originalTransaction.apply(this, args);
  };
  try { await assert.rejects(getSettings(), { name: 'InvalidStateError' }); }
  finally { IDBDatabase.prototype.transaction = originalTransaction; }
  assert.equal((await getSettings())?.systemPrompt, 'retained');
});

test('v2 upgrades to v4 without changing history, settings, prompts, skills or MCP servers', async () => {
  const old = await openDB('ai-workspace', 2, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt');
      for (const name of ['settings', 'prompts', 'skills', 'mcpServers']) {
        db.createObjectStore(name, { keyPath: 'id' });
      }
    },
  });
  const session = snapshot('legacy');
  const settings = { id: 'default', systemPrompt: 'retained', rememberKeys: false };
  const prompt = { id: 'prompt', title: 'Prompt', content: 'retained' };
  const skill = { id: 'skill', name: 'Skill', icon: 'code', description: '', instructions: 'retained', useGithubMcp: false, createdAt: 1 };
  const server = { id: 'mcp', name: 'MCP', description: '', url: 'https://example.com/mcp' };
  for (const [name, value] of [['sessions', session], ['settings', settings], ['prompts', prompt], ['skills', skill], ['mcpServers', server]] as const) {
    await old.put(name, value);
  }
  old.close();

  assert.deepEqual(await getSessions(), [session]);
  assert.deepEqual(await getSettings(), settings);
  assert.deepEqual(await getPrompts(), [prompt]);
  assert.deepEqual(await getSkills(), [skill]);
  assert.deepEqual(await getMcpServers(), [server]);
  const upgraded = await openDB('ai-workspace');
  try {
    assert.equal(upgraded.version, 4);
    const store = upgraded.transaction('attachments').store;
    assert.equal(store.keyPath, 'id');
    assert.equal(store.index('sessionId').keyPath, 'sessionId');
    assert.deepEqual(store.index('sessionRef').keyPath, ['sessionId', 'id', 'name', 'kind', 'mediaType', 'size']);
    assert.equal(await store.count(), 0);
  } finally { upgraded.close(); }
});

test('session and payload commit together; messages persist only allow-listed metadata', async () => {
  const record = attachment('atomic');
  // Structural typing permits a record where a ref is expected. Do not leak
  // data or arbitrary fields into frequent session checkpoints.
  const session = snapshot('owner', [{ ...record, sessionId: 'not-message-metadata' } as AttachmentRecord]);
  session.messages.push({ id: 'restart', role: 'user', content: 'restart', attachments: [ref(record)] });
  await saveSession(session, [record]);
  const saved = await getSession(session.id);
  assert.deepEqual(saved?.messages.map(message => message.attachments), [[ref(record)], [ref(record)]]);
  assert.equal((session.messages[0].attachments?.[0] as AttachmentRecord).data, record.data);
  assert.deepEqual(await getAttachment(record.id), record);
  const db = await openDB('ai-workspace');
  try {
    assert.equal(await db.count('attachments'), 1);
    assert.equal((await db.get('attachments', record.id)).sessionId, session.id);
  } finally { db.close(); }
});

test('checkpoints use key-only checks, never re-read or rewrite attachment payloads', async () => {
  const record = { ...attachment('large'), data: 'x'.repeat(1024 * 1024), size: 1024 * 1024 };
  const session = snapshot('checkpoints', [ref(record)]);
  let writes = 0;
  let keyReads = 0;
  const put = IDBObjectStore.prototype.put;
  const add = IDBObjectStore.prototype.add;
  const get = IDBObjectStore.prototype.get;
  const indexGet = IDBIndex.prototype.get;
  const getKey = IDBObjectStore.prototype.getKey;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'attachments') writes++;
    return put.apply(this, args);
  };
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'attachments') writes++;
    return add.apply(this, args);
  };
  try {
    await saveSession(session, [record]);
    IDBObjectStore.prototype.get = function (...args) {
      assert.notEqual(this.name, 'attachments', 'checkpoint fetched a payload');
      return get.apply(this, args);
    };
    IDBIndex.prototype.get = function (...args) {
      assert.notEqual(this.objectStore.name, 'attachments', 'checkpoint fetched an indexed payload');
      return indexGet.apply(this, args);
    };
    IDBObjectStore.prototype.getKey = function (...args) {
      if (this.name === 'attachments') keyReads++;
      return getKey.apply(this, args);
    };
    for (let i = 0; i < 4; i++) await saveSession({ ...session, updatedAt: i + 2 });
    assert.equal(writes, 1);
    assert.ok(keyReads >= 4);
  } finally {
    IDBObjectStore.prototype.put = put;
    IDBObjectStore.prototype.add = add;
    IDBObjectStore.prototype.get = get;
    IDBIndex.prototype.get = indexGet;
    IDBObjectStore.prototype.getKey = getKey;
  }
  assert.deepEqual(await getAttachment(record.id), record);
});

test('missing, duplicate, unreferenced and mismatched supplied records cannot become durable', async () => {
  const record = attachment('invalid');
  const session = snapshot('invalid-session', [ref(record)]);
  await saveSession(snapshot(session.id));
  const original = await getSession(session.id);
  for (const [next, records] of [
    [session, []],
    [session, [record, record]],
    [snapshot(session.id), [record]],
    [session, [{ ...record, size: record.size + 1 }]],
    [session, [{ ...record, data: undefined } as unknown as AttachmentRecord]],
    [snapshot(session.id, [ref(record), { ...ref(record), name: 'conflict' }]), [record]],
  ] as Array<[Session, AttachmentRecord[]]>) {
    await assert.rejects(saveSession(next, records));
    assert.deepEqual(await getSession(session.id), original);
    assert.equal(await getAttachment(record.id), undefined);
  }
});

test('attachment IDs are immutable and cannot be referenced or replaced by another session', async () => {
  const record = attachment('immutable');
  const owner = snapshot('first', [ref(record)]);
  await saveSession(owner, [record]);
  for (const records of [[record], [{ ...record, data: 'replacement' }]]) {
    await assert.rejects(saveSession({ ...owner, title: 'changed' }, records));
  }
  await assert.rejects(saveSession(snapshot('second', [ref(record)])));
  await assert.rejects(saveSession(snapshot('second', [ref(record)]), [record]));
  await assert.rejects(saveSession(snapshot(owner.id, [{ ...ref(record), name: 'renamed' }])));
  assert.deepEqual(await getSession(owner.id), owner);
  assert.equal(await getSession('second'), undefined);
  assert.deepEqual(await getAttachment(record.id), record);
});

test('concurrent saves of the same ID cannot overwrite a committed immutable payload', async () => {
  const record = attachment('concurrent');
  const first = snapshot('concurrent-owner', [ref(record)]);
  const second = { ...first, title: 'must not overwrite' };
  const outcomes = await Promise.allSettled([
    saveSession(first, [record]),
    saveSession(second, [{ ...record, data: 'replacement' }]),
  ]);
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(await getSession(first.id), first);
  assert.deepEqual(await getAttachment(record.id), record);
});

test('an exception after inserting a payload aborts the entire multi-store save', async () => {
  const record = attachment('rollback');
  const session = snapshot('rollback-session', [ref(record)]);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'sessions') throw new DOMException('private detail', 'DataCloneError');
    return put.apply(this, args);
  };
  try { await assert.rejects(saveSession(session, [record]), { name: 'DataCloneError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
  await saveSession(session, [record]);
  assert.deepEqual(await getAttachment(record.id), record);
});

test('multi-store deletion also aborts on its four-second deadline and can be retried', async t => {
  const record = attachment('delete-timeout');
  const session = snapshot('delete-timeout-session', [ref(record)]);
  await saveSession(session, [record]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = deleteSession(session.id);
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(4000);
    await assert.rejects(pending, { name: 'TimeoutError' });
  } finally { t.mock.timers.reset(); }
  assert.deepEqual(await getSession(session.id), session);
  assert.deepEqual(await getAttachment(record.id), record);
  await deleteSession(session.id);
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
});

test('a request success is not reported as durable before the transaction commits', async () => {
  const record = attachment('commit-failure');
  const session = snapshot('commit-failure-session', [ref(record)]);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (this.name === 'sessions') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(saveSession(session, [record]), { name: 'AbortError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
});

test('deletion removes all owned payloads via the index, including refs removed from the snapshot', async () => {
  const first = attachment('delete-first');
  const removed = attachment('delete-removed');
  const other = attachment('delete-other');
  await saveSession(snapshot('delete-me', [ref(first), ref(removed)]), [first, removed]);
  await saveSession(snapshot('delete-me', [ref(first)]));
  const kept = snapshot('keep-me', [ref(other)]);
  await saveSession(kept, [other]);
  const getAllKeys = IDBIndex.prototype.getAllKeys;
  let indexed = false;
  IDBIndex.prototype.getAllKeys = function (...args) {
    if (this.objectStore.name === 'attachments' && this.name === 'sessionId') indexed = true;
    return getAllKeys.apply(this, args);
  };
  try { await deleteSession('delete-me'); }
  finally { IDBIndex.prototype.getAllKeys = getAllKeys; }
  assert.equal(indexed, true);
  assert.equal(await getSession('delete-me'), undefined);
  assert.equal(await getAttachment(first.id), undefined);
  assert.equal(await getAttachment(removed.id), undefined);
  assert.deepEqual(await getSession(kept.id), kept);
  assert.deepEqual(await getAttachment(other.id), other);
  await deleteSession('absent');
  assert.deepEqual(await getAttachment(other.id), other);
});

test('a deletion failure rolls back both the session and any earlier payload deletion', async () => {
  const first = attachment('rollback-delete-1');
  const second = attachment('rollback-delete-2');
  const session = snapshot('rollback-delete', [ref(first), ref(second)]);
  await saveSession(session, [first, second]);
  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (...args) {
    if (this.name === 'attachments' && args[0] === second.id) throw new DOMException('private detail', 'UnknownError');
    return remove.apply(this, args);
  };
  try { await assert.rejects(deleteSession(session.id), { name: 'UnknownError' }); }
  finally { IDBObjectStore.prototype.delete = remove; }
  assert.deepEqual(await getSession(session.id), session);
  assert.deepEqual(await getAttachment(first.id), first);
  assert.deepEqual(await getAttachment(second.id), second);
  await deleteSession(session.id);
  assert.equal(await getSession(session.id), undefined);
});

test('multi-store saves retain the four-second deadline, abort and reopen after timeout', async t => {
  await getSettings();
  const record = attachment('timeout');
  const session = snapshot('timeout-session', [ref(record)]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = saveSession(session, [record]);
    // Let getDB resolve and start the transaction, but do not let IndexedDB's
    // queued request task run before the deadline expires.
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(4000);
    await assert.rejects(pending, { name: 'TimeoutError' });
  } finally { t.mock.timers.reset(); }
  assert.equal(await getSession(session.id), undefined);
  assert.equal(await getAttachment(record.id), undefined);
  await saveSession(session, [record]);
  assert.deepEqual(await getAttachment(record.id), record);
});

const refKeyPath = ['sessionId', 'id', 'name', 'kind', 'mediaType', 'size'];

for (const version of [2, 3, 4, 7]) {
  for (const layout of ['owner-only', 'no-indexes', 'wrong-indexes'] as const) {
    test(`v${version} ${layout}: repairs schema, preserves all stores and retries immutable attachment checkpoints`, async () => {
      const record = attachment(`legacy-${version}-${layout}`);
      const session = snapshot('legacy-owner', [ref(record)]);
      const values = {
        sessions: session,
        settings: { id: 'default', rememberKeys: true, systemPrompt: 'retained', customKey: 'synthetic-secret' },
        prompts: { id: 'p', title: 'retained', content: 'retained' },
        skills: { id: 'skill', name: 'retained', icon: 'code', description: '', instructions: 'retained', createdAt: 1 },
        mcpServers: { id: 'mcp', name: 'retained', url: 'https://example.invalid', description: '' },
        attachments: { ...record, sessionId: session.id },
      };
      const fixture = await openDB('ai-workspace', version, {
        upgrade(db) {
          for (const name of Object.keys(values)) {
            const store = db.createObjectStore(name, { keyPath: 'id' });
            if (name === 'sessions' && layout !== 'no-indexes') {
              store.createIndex('updatedAt', layout === 'wrong-indexes' ? 'title' : 'updatedAt', { unique: layout === 'wrong-indexes' });
            }
            if (name === 'attachments') {
              if (layout === 'owner-only') store.createIndex('sessionId', 'sessionId');
              if (layout === 'wrong-indexes') {
                store.createIndex('sessionId', 'name', { unique: true });
                store.createIndex('sessionRef', ['sessionId', 'id'], { unique: true });
              }
            }
          }
          db.createObjectStore('future-data', { keyPath: 'id' });
        },
      });
      for (const [name, value] of Object.entries(values)) await fixture.put(name, value);
      await fixture.put('future-data', { id: 'unknown', retained: true });
      fixture.close();
      await saveSession({ ...session, title: 'recovered', updatedAt: 2 });
      await saveSession({ ...session, title: 'retry', updatedAt: 3 });
      assert.equal((await getSession(session.id))?.title, 'retry');
      assert.deepEqual(await getAttachment(record.id), record);
      assert.deepEqual(await getSettings(), values.settings);
      assert.deepEqual(await getPrompts(), [values.prompts]);
      assert.deepEqual(await getSkills(), [values.skills]);
      assert.deepEqual(await getMcpServers(), [values.mcpServers]);
      const db = await openDB('ai-workspace');
      try {
        assert.equal(db.version, Math.max(4, version + 1));
        assert.deepEqual(await db.getAll('future-data'), [{ id: 'unknown', retained: true }]);
        const store = db.transaction('attachments').store;
        assert.deepEqual(store.index('sessionRef').keyPath, refKeyPath);
        assert.equal(store.index('sessionRef').unique, false);
        assert.equal(store.index('sessionId').keyPath, 'sessionId');
        assert.equal(store.index('sessionId').unique, false);
        assert.equal(await store.count(), 1);
      } finally { db.close(); }
    });
  }
}

test('a healthy newer schema is opened without downgrade or schema changes; versionchange closes cached connections', async () => {
  await saveSession(snapshot('kept'));
  const upgraded = await openDB('ai-workspace', 8, { upgrade(db) { db.createObjectStore('future', { keyPath: 'id' }); } });
  await upgraded.put('future', { id: 'kept', value: 'retained' });
  upgraded.close();
  assert.deepEqual(await getSession('kept'), snapshot('kept'));
  await saveSession(snapshot('after-versionchange'));
  const db = await openDB('ai-workspace');
  try {
    assert.equal(db.version, 8);
    assert.deepEqual(await db.getAll('future'), [{ id: 'kept', value: 'retained' }]);
  } finally { db.close(); }
});

test('wrong multiEntry indexes are repaired without removing stored records', async () => {
  const old = await openDB('ai-workspace', 3, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt', { multiEntry: true });
      const files = db.createObjectStore('attachments', { keyPath: 'id' });
      files.createIndex('sessionId', 'sessionId', { multiEntry: true });
      files.createIndex('sessionRef', 'sessionId', { multiEntry: true });
    },
  });
  await old.put('sessions', snapshot('kept'));
  old.close();
  assert.deepEqual(await getSession('kept'), snapshot('kept'));
  const db = await openDB('ai-workspace');
  try {
    assert.equal(db.transaction('sessions').store.index('updatedAt').multiEntry, false);
    assert.equal(db.transaction('attachments').store.index('sessionId').multiEntry, false);
  } finally { db.close(); }
});

test('unfamiliar primary keys fail safely without deleting/rebuilding a store or database', async () => {
  const old = await openDB('ai-workspace', 3, {
    upgrade(db) { db.createObjectStore('sessions', { keyPath: 'legacyId' }); },
  });
  await old.put('sessions', { legacyId: 'kept', private: 'retained' });
  old.close();
  await assert.rejects(getSessions(), { name: 'StorageSchemaError' });
  await assert.rejects(getSessions(), { name: 'StorageSchemaError' });
  const db = await openDB('ai-workspace');
  try {
    assert.equal(db.version, 3);
    assert.deepEqual(await db.getAll('sessions'), [{ legacyId: 'kept', private: 'retained' }]);
  } finally { db.close(); }
});

test('blocked upgrade expires safely, does not migrate later, and retry opens the repaired structure', async t => {
  const old = await openDB('ai-workspace', 3, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    },
  });
  await old.put('sessions', snapshot('blocked-kept'));
  const open = indexedDB.open.bind(indexedDB);
  let notice!: () => void;
  const blocked = new Promise<void>(resolve => { notice = resolve; });
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener('blocked', notice);
    return request;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = saveSession(snapshot('not-written'));
    const rejected = assert.rejects(pending, { name: 'StorageBlockedError' });
    await blocked;
    t.mock.timers.tick(4000);
    await rejected;
  } finally { t.mock.timers.reset(); old.close(); indexedDB.open = open; }
  const unchanged = await openDB('ai-workspace');
  assert.equal(unchanged.version, 3, 'expired upgrade must abort when unblocked');
  assert.equal(await unchanged.get('sessions', 'not-written'), undefined);
  assert.deepEqual(await unchanged.get('sessions', 'blocked-kept'), snapshot('blocked-kept'));
  unchanged.close();
  await saveSession(snapshot('retried'));
  assert.deepEqual(await getSession('retried'), snapshot('retried'));
});

test('atomic import is add-only and rolls back all earlier sessions/payloads on a later ID collision', async () => {
  const kept = snapshot('existing');
  await saveSession(kept);
  const record = attachment('import-rollback');
  await assert.rejects(importSessionsAtomically([
    { session: snapshot('new', [ref(record)]), attachments: [record] },
    { session: { ...kept, title: 'overwrite' }, attachments: [] },
  ]), { name: 'ConstraintError' });
  assert.deepEqual(await getSessions(), [kept]);
  assert.equal(await getAttachment(record.id), undefined);
  await importSessionsAtomically([{ session: snapshot('new', [ref(record)]), attachments: [record] }]);
  assert.deepEqual(await getAttachment(record.id), record);
});

test('an index-repair failure rolls back schema/version and all existing data, then a retry succeeds', async () => {
  const record = attachment('migration-rollback');
  const session = snapshot('migration-rollback-owner', [ref(record)]);
  const old = await openDB('ai-workspace', 3, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('updatedAt', 'updatedAt');
      const files = db.createObjectStore('attachments', { keyPath: 'id' });
      files.createIndex('sessionId', 'name');
    },
  });
  await old.put('sessions', session);
  await old.put('attachments', { ...record, sessionId: session.id });
  old.close();
  const createIndex = IDBObjectStore.prototype.createIndex;
  IDBObjectStore.prototype.createIndex = function (...args) {
    if (args[0] === 'sessionRef') throw new DOMException('private upgrade detail', 'QuotaExceededError');
    return createIndex.apply(this, args);
  };
  try { await assert.rejects(saveSession({ ...session, title: 'must not be saved' }), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.createIndex = createIndex; }
  const unchanged = await openDB('ai-workspace');
  try {
    assert.equal(unchanged.version, 3);
    assert.deepEqual(await unchanged.get('sessions', session.id), session);
    assert.deepEqual(await unchanged.get('attachments', record.id), { ...record, sessionId: session.id });
    const files = unchanged.transaction('attachments').store;
    assert.equal(files.index('sessionId').keyPath, 'name');
    assert.equal(files.indexNames.contains('sessionRef'), false);
  } finally { unchanged.close(); }
  await saveSession({ ...session, title: 'retry succeeded' });
  assert.equal((await getSession(session.id))?.title, 'retry succeeded');
  assert.deepEqual(await getAttachment(record.id), record);
});
