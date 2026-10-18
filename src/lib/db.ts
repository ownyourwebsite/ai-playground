import { openDB, unwrap, DBSchema, IDBPDatabase, IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb';
import { Session, Prompt, McpServerConfig, AppSettings, Skill, AttachmentRecord, AttachmentRef } from './types';

interface AppDB extends DBSchema {
  sessions: {
    key: string;
    value: Session;
    indexes: { 'updatedAt': number };
  };
  attachments: {
    key: string;
    value: AttachmentRecord & { sessionId: string };
    indexes: {
      'sessionId': string;
      // This small covering index verifies both ownership and metadata using
      // getKey, without cloning multi-MB values on every token checkpoint.
      'sessionRef': [string, string, string, string, string, number];
    };
  };
  prompts: {
    key: string;
    value: Prompt;
  };
  skills: {
    key: string;
    value: Skill;
  };
  mcpServers: {
    key: string;
    value: McpServerConfig;
  };
  settings: {
    key: string;
    value: AppSettings;
  };
}

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;
const STORAGE_TIMEOUT_MS = 4000;
const SCHEMA_VERSION = 4;
const STORES = ['sessions', 'attachments', 'prompts', 'skills', 'mcpServers', 'settings'] as const;
const INDEXES = {
  sessions: { updatedAt: 'updatedAt' },
  attachments: { sessionId: 'sessionId', sessionRef: ['sessionId', 'id', 'name', 'kind', 'mediaType', 'size'] },
};

function deadline<T>(operation: Promise<T>, expire: () => void = () => {}, timeoutMs = STORAGE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expire(); reject(new DOMException('Local storage did not respond', 'TimeoutError')); }, timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function schemaError(): DOMException {
  return new DOMException('Local storage structure is unavailable', 'StorageSchemaError');
}

/** Only indexes may be replaced. Never rebuild/delete an existing object store. */
function checkSchema(db: IDBDatabase, tx: IDBTransaction, repair: boolean): boolean {
  let healthy = true;
  for (const name of STORES) {
    if (!db.objectStoreNames.contains(name)) {
      healthy = false;
      if (!repair) continue;
      db.createObjectStore(name, { keyPath: 'id' });
    }
    const store = tx.objectStore(name);
    // An unfamiliar primary-key layout cannot be repaired without moving user
    // data. Fail closed and leave it intact for a later migration/recovery.
    if (store.keyPath !== 'id' || store.autoIncrement) throw schemaError();
    const indexes: Record<string, string | string[]> = name === 'sessions' ? INDEXES.sessions : name === 'attachments' ? INDEXES.attachments : {};
    for (const [indexName, keyPath] of Object.entries(indexes)) {
      const index = store.indexNames.contains(indexName) ? store.index(indexName) : undefined;
      if (index && JSON.stringify(index.keyPath) === JSON.stringify(keyPath) && !index.unique && !index.multiEntry) continue;
      healthy = false;
      if (repair) {
        if (index) store.deleteIndex(indexName);
        store.createIndex(indexName, keyPath);
      }
    }
  }
  return healthy;
}

function getDB() {
  if (typeof window === 'undefined') return null; // Don't open DB on server
  if (!dbPromise) {
    let expired = false;
    let blocked = false;
    let connection: IDBPDatabase<AppDB> | undefined;
    const invalidate = () => { if (dbPromise === pending) dbPromise = null; };
    const open = async (version?: number): Promise<IDBPDatabase<AppDB>> => {
      let upgradeError: unknown;
      const opened = openDB<AppDB>('ai-workspace', version, {
        upgrade(db, _oldVersion, _newVersion, tx) {
          void tx.done.catch(() => {});
          // A blocked IDB open cannot be cancelled. Do not allow an expired
          // request to migrate anything when another tab eventually closes.
          if (expired) { tx.abort(); return; }
          try { checkSchema(unwrap(db), unwrap(tx), true); }
          catch (error) { upgradeError = error; tx.abort(); }
        },
        blocked() { blocked = true; },
        blocking() { void opened.then(db => db.close()); invalidate(); },
        terminated: invalidate,
      });
      let db: IDBPDatabase<AppDB>;
      try { db = await opened; }
      catch (error) { throw upgradeError ?? error; }
      if (expired) { db.close(); throw new DOMException('Opening expired', 'TimeoutError'); }
      connection = db;
      blocked = false;
      return db;
    };
    const initialize = async () => {
      // Discover the actual version, including healthy v4+ databases. Opening
      // with a fixed lower version would permanently fail with VersionError.
      let db = await open();
      const names = STORES.filter(name => db.objectStoreNames.contains(name));
      let healthy = false;
      if (names.length) {
        const tx = db.transaction(names, 'readonly');
        void tx.done.catch(() => {});
        healthy = checkSchema(unwrap(db), unwrap(tx), false);
        await tx.done;
      }
      if (!healthy || db.version < SCHEMA_VERSION) {
        const version = Math.max(SCHEMA_VERSION, db.version + 1);
        db.close();
        db = await open(version);
        const tx = db.transaction([...STORES], 'readonly');
        void tx.done.catch(() => {});
        if (!checkSchema(unwrap(db), unwrap(tx), false)) throw schemaError();
        await tx.done;
      }
      return db;
    };
    const pending = deadline(initialize(), () => { expired = true; connection?.close(); }).catch(error => {
      // A failed open must be retried, not cached forever.
      connection?.close();
      invalidate();
      if (blocked && (error as Error)?.name === 'TimeoutError') {
        throw new DOMException('Local storage upgrade is blocked by another tab', 'StorageBlockedError');
      }
      throw error;
    });
    dbPromise = pending;
  }
  return dbPromise;
}

async function transaction<Names extends StoreNames<AppDB>[], T>(names: Names, mode: 'readonly' | 'readwrite', action: (tx: IDBPTransaction<AppDB, Names, 'readwrite'>) => Promise<T>, timeoutMs = STORAGE_TIMEOUT_MS, certainCommit = false): Promise<T> {
  const db = await getDB();
  if (!db) throw new DOMException('Browser storage is unavailable', 'InvalidStateError');
  const tx = (() => {
    try { return db.transaction(names, mode, certainCommit ? { durability: 'strict' } : undefined); }
    catch (error) { db.close(); dbPromise = null; throw error; }
  })();
  const abort = () => { try { tx.abort(); } catch { /* Already settled. */ } };
  // Observe tx.done even if a request or a synchronous action fails first.
  void tx.done.catch(() => {});
  // 'readonly' is enforced by IndexedDB; this cast permits one typed helper for
  // both modes without weakening keys or values to any.
  const operation = (async () => {
    try {
      const value = await action(tx as IDBPTransaction<AppDB, Names, 'readwrite'>);
      await tx.done;
      return value;
    } catch (error) {
      // Request successes are not commits. Even an application validation error
      // after a successful write must roll the entire transaction back.
      abort();
      throw error;
    }
  })();
  try {
    if (certainCommit) {
      // A recovery deadline requests an abort, but MUST await its actual
      // outcome. If commit won the race, report success rather than claiming a
      // failed/empty import after durable writes. Never guess from a timer.
      const timer = setTimeout(abort, timeoutMs);
      try { return await operation; }
      finally { clearTimeout(timer); }
    }
    return await deadline(operation, abort, timeoutMs);
  } catch (error) {
    abort();
    if (['InvalidStateError', 'UnknownError', 'TimeoutError'].includes((error as Error)?.name)) {
      db.close(); dbPromise = null;
    }
    throw error;
  }
}

async function access<Name extends StoreNames<AppDB>, T>(name: Name, mode: 'readonly' | 'readwrite', action: (store: IDBPObjectStore<AppDB, [Name], Name, 'readwrite'>) => Promise<T>): Promise<T> {
  return transaction<[Name], T>([name], mode, tx => action(tx.objectStore(name)));
}

function attachmentRef(value: AttachmentRef): AttachmentRef {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' ||
      !['text', 'image'].includes(value.kind) || typeof value.mediaType !== 'string' ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error('Invalid attachment metadata.');
  }
  const { id, name, kind, mediaType, size } = value;
  return { id, name, kind, mediaType, size };
}

function sessionRefKey(sessionId: string, ref: AttachmentRef): AppDB['attachments']['indexes']['sessionRef'] {
  return [sessionId, ref.id, ref.name, ref.kind, ref.mediaType, ref.size];
}

function sameRef(first: AttachmentRef, second: AttachmentRef): boolean {
  return first.id === second.id && first.name === second.name && first.kind === second.kind &&
    first.mediaType === second.mediaType && first.size === second.size;
}

export async function getSessions(): Promise<Session[]> {
  return access('sessions', 'readonly', store => store.index('updatedAt').getAll());
}

export async function getSession(id: string): Promise<Session | undefined> {
  return access('sessions', 'readonly', store => store.get(id));
}

export async function getAttachment(id: string): Promise<AttachmentRecord | undefined> {
  const record = await access('attachments', 'readonly', store => store.get(id));
  if (!record) return undefined;
  return { ...attachmentRef(record), data: record.data };
}

function prepareSession(session: Session, attachments: readonly AttachmentRecord[]) {
  const refs = new Map<string, AttachmentRef>();
  const messages = session.messages.map(message => {
    if (!message.attachments) return message;
    const metadata = message.attachments.map(value => {
      const ref = attachmentRef(value);
      const existing = refs.get(ref.id);
      if (existing && !sameRef(existing, ref)) throw new Error('Conflicting attachment metadata.');
      refs.set(ref.id, ref);
      return ref;
    });
    // Never persist data (or arbitrary extra properties) on Message refs, even
    // if a structurally compatible AttachmentRecord was passed by a caller.
    return { ...message, attachments: metadata };
  });
  const records = new Map<string, AttachmentRecord>();
  for (const value of attachments) {
    const ref = attachmentRef(value);
    const expected = refs.get(ref.id);
    if (records.has(ref.id) || !expected || !sameRef(expected, ref) || typeof value.data !== 'string') {
      throw new Error('Invalid attachment payload set.');
    }
    records.set(ref.id, { ...ref, data: value.data });
  }
  if (typeof session.id !== 'string' || !session.id) throw new Error('Invalid attachment owner.');
  return { snapshot: { ...session, messages }, refs, records };
}

export async function saveSession(session: Session, attachments: AttachmentRecord[] = []): Promise<void> {
  const { snapshot, refs, records } = prepareSession(session, attachments);
  if (!refs.size) {
    await access('sessions', 'readwrite', store => store.put(snapshot));
    return;
  }
  await transaction(['sessions', 'attachments'], 'readwrite', async tx => {
    const store = tx.objectStore('attachments');
    for (const ref of refs.values()) {
      const existing = await store.getKey(ref.id);
      const record = records.get(ref.id);
      if (record) {
        // UUIDs identify immutable payloads. Even an identical supplied payload
        // must not replace an existing one; checkpoints supply only new IDs.
        if (existing !== undefined) throw new Error('Attachment already exists.');
        await store.add({ ...record, sessionId: session.id });
      } else if (existing === undefined || await store.index('sessionRef').getKey(sessionRefKey(session.id, ref)) !== ref.id) {
        throw new Error('Attachment is unavailable for this session.');
      }
    }
    await tx.objectStore('sessions').put(snapshot);
  });
}

/**
 * Add-only recovery boundary: every payload must be supplied, no existing IDs
 * are reused, and ALL sessions/payloads commit in one transaction. Deliberately
 * independent of staged RAM. The larger backup gets a 60s (not token-save) deadline.
 */
export async function importSessionsAtomically(entries: ReadonlyArray<{ session: Session; attachments: readonly AttachmentRecord[] }>): Promise<void> {
  const prepared = entries.map(({ session, attachments }) => prepareSession(session, attachments));
  const sessions = new Set<string>();
  const attachments = new Set<string>();
  for (const { snapshot, refs, records } of prepared) {
    if (sessions.has(snapshot.id) || refs.size !== records.size) throw new Error('Invalid recovery payload set.');
    sessions.add(snapshot.id);
    for (const id of records.keys()) {
      if (attachments.has(id)) throw new Error('Invalid recovery payload set.');
      attachments.add(id);
    }
  }
  if (!prepared.length) return;
  await transaction(['sessions', 'attachments'], 'readwrite', async tx => {
    for (const { snapshot, records } of prepared) {
      for (const record of records.values()) {
        await tx.objectStore('attachments').add({ ...record, sessionId: snapshot.id });
      }
      // Never put(): even an improbable generated-ID collision must roll back.
      await tx.objectStore('sessions').add(snapshot);
    }
  }, 60_000, true);
}

export async function deleteSession(id: string): Promise<void> {
  await transaction(['sessions', 'attachments'], 'readwrite', async tx => {
    await tx.objectStore('sessions').delete(id);
    const store = tx.objectStore('attachments');
    // Key-only lookup also removes payloads no longer present in the latest
    // snapshot, without ever loading their contents or touching another chat.
    const keys = await store.index('sessionId').getAllKeys(id);
    for (const key of keys) await store.delete(key);
  });
}

export async function getPrompts(): Promise<Prompt[]> {
  return access('prompts', 'readonly', store => store.getAll());
}

export async function savePrompt(prompt: Prompt): Promise<void> {
  await access('prompts', 'readwrite', store => store.put(prompt));
}

export async function getSkills(): Promise<Skill[]> {
  return access('skills', 'readonly', store => store.getAll());
}

export async function saveSkill(skill: Skill): Promise<void> {
  await access('skills', 'readwrite', store => store.put(skill));
}

export async function deleteSkill(id: string): Promise<void> {
  await access('skills', 'readwrite', store => store.delete(id));
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  return access('mcpServers', 'readonly', store => store.getAll());
}

export async function saveMcpServer(server: McpServerConfig): Promise<void> {
  await access('mcpServers', 'readwrite', store => store.put(server));
}

export async function deleteMcpServer(id: string): Promise<void> {
  await access('mcpServers', 'readwrite', store => store.delete(id));
}

export async function getSettings(): Promise<AppSettings | undefined> {
  return access('settings', 'readonly', store => store.get('default'));
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await access('settings', 'readwrite', store => store.put(settings));
}
