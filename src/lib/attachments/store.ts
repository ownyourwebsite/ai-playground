import { getAttachment, saveSession } from '../db';
import type { AttachmentRecord, AttachmentRef, Message, Session } from '../types';

type StagedAttachment = {
  sessionId: string;
  record: AttachmentRecord;
  persisted: boolean;
  uncertain?: boolean;
};

// Only explicitly staged files stay in memory. Loading historical files never
// populates this map, so browsing history cannot retain every payload in RAM.
const staged = new Map<string, StagedAttachment>();
// Session IDs are UUIDs, not reusable slots. Small tombstones prevent stale
// checkpoints and late completions from recreating a deleted session's state.
const forgotten = new Set<string>();

function unavailable(): Error {
  // Never include filenames, IDs, raw file content or storage error messages.
  return new Error('Attachment is unavailable.');
}

function sameRef(first: AttachmentRef, second: AttachmentRef): boolean {
  return first.id === second.id && first.name === second.name && first.kind === second.kind &&
    first.mediaType === second.mediaType && first.size === second.size;
}

function copyRef(value: AttachmentRef): AttachmentRef {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' ||
      !['text', 'image'].includes(value.kind) || typeof value.mediaType !== 'string' ||
      !Number.isSafeInteger(value.size) || value.size < 0) throw unavailable();
  const { id, name, kind, mediaType, size } = value;
  return { id, name, kind, mediaType, size };
}

function immutableRecord(value: AttachmentRecord): AttachmentRecord {
  const ref = copyRef(value);
  if (typeof value.data !== 'string') throw unavailable();
  return Object.freeze({ ...ref, data: value.data });
}

function collectRefs(sessions: Array<{ messages: Message[] }>): Map<string, AttachmentRef> {
  const refs = new Map<string, AttachmentRef>();
  for (const session of sessions) {
    for (const message of session.messages) {
      for (const value of message.attachments ?? []) {
        const ref = copyRef(value);
        const existing = refs.get(ref.id);
        if (existing && !sameRef(existing, ref)) throw unavailable();
        refs.set(ref.id, ref);
      }
    }
  }
  return refs;
}

/** Synchronous, all-or-nothing staging before an accepted engine submit. */
export function stageAttachments(sessionId: string, records: AttachmentRecord[]): void {
  if (typeof sessionId !== 'string' || !sessionId || forgotten.has(sessionId)) throw unavailable();
  const pending = new Map<string, StagedAttachment>();
  for (const value of records) {
    const record = immutableRecord(value);
    if (pending.has(record.id)) throw unavailable();
    const existing = staged.get(record.id);
    if (existing && (existing.sessionId !== sessionId || !sameRef(existing.record, record) || existing.record.data !== record.data)) {
      throw unavailable();
    }
    // Identical re-staging preserves the committed flag instead of making an
    // immutable stored ID look like a pending/new payload again.
    pending.set(record.id, existing ?? { sessionId, record, persisted: false });
  }
  for (const [id, entry] of pending) staged.set(id, entry);
}

export async function loadAttachment(ref: AttachmentRef): Promise<AttachmentRecord> {
  try {
    const expected = copyRef(ref);
    const record = staged.get(expected.id)?.record ?? await getAttachment(expected.id);
    if (!record || !sameRef(record, expected)) throw unavailable();
    return immutableRecord(record);
  } catch {
    // DB failures are also safe for callers to display, without leaking causes.
    throw unavailable();
  }
}

/** Engine persist hook; engine serializes checkpoints within each session. */
export async function persistSessionWithAttachments(session: Session): Promise<void> {
  if (forgotten.has(session.id)) throw unavailable();
  const pending: StagedAttachment[] = [];
  for (const ref of collectRefs([session]).values()) {
    const entry = staged.get(ref.id);
    if (!entry) continue; // The DB must verify every historical ref atomically.
    if (entry.sessionId !== session.id || !sameRef(entry.record, ref)) throw unavailable();
    if (!entry.persisted) pending.push(entry);
  }
  // A deadline can expire AFTER the native transaction committed but before its
  // completion acknowledgement reached the app. Reconcile only those uncertain
  // records once; never overwrite immutable IDs or rewrite payloads per token.
  const newRecords: AttachmentRecord[] = [];
  for (const entry of pending) {
    const stored = entry.uncertain ? await getAttachment(entry.record.id) : undefined;
    if (stored) {
      if (!sameRef(stored, entry.record) || stored.data !== entry.record.data) throw unavailable();
      // saveSession still atomically verifies the session owner/metadata.
    } else newRecords.push(entry.record);
  }
  try { await saveSession(session, newRecords); }
  catch (error) {
    for (const entry of pending) entry.uncertain = true;
    throw error;
  }
  for (const entry of pending) {
    if (!forgotten.has(session.id) && staged.get(entry.record.id) === entry) { entry.persisted = true; entry.uncertain = false; }
  }
}

/** Call only after a successful, write-drained session deletion. */
export function forgetSessionAttachments(sessionId: string): void {
  forgotten.add(sessionId);
  for (const [id, entry] of staged) {
    if (entry.sessionId === sessionId) staged.delete(id);
  }
}

export async function exportAttachmentsForSessions(sessions: Array<{ messages: Message[] }>): Promise<AttachmentRecord[]> {
  return Promise.all([...collectRefs(sessions).values()].map(ref => loadAttachment(ref)));
}
