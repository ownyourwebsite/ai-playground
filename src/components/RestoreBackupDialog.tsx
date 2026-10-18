"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { useWorkspace } from '@/context/WorkspaceContext';
import {
  importRecovery, MAX_RECOVERY_BYTES, parseRecovery, RecoveryStorageError, RecoveryValidationError,
  type RecoveryBackup,
} from '@/lib/attachments/recovery';
import { storageErrorCode } from '@/lib/storageErrors';
import type { Session } from '@/lib/types';

type RestoreProblem = { kind: 'file' | 'storage'; message: string; code: string };

/** One local-only flow shared by Settings and the storage alert. */
export default function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const { rememberSession, setActiveSessionId, setIsSettingsOpen } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const operation = useRef({ ticket: 0 });
  // Synchronous ownership also protects against double-clicks before a render.
  const work = useRef<'idle' | 'reading' | 'saving'>('idle');
  const [stage, setStage] = useState<'choose' | 'reading' | 'preview' | 'saving' | 'success'>('choose');
  const [backup, setBackup] = useState<RecoveryBackup>();
  const [restored, setRestored] = useState<Session[]>([]);
  const [problem, setProblem] = useState<RestoreProblem>();
  const id = useId();
  const busy = stage === 'reading' || stage === 'saving';

  useEffect(() => {
    const card = dialog.current;
    const lifetime = operation.current;
    card?.showModal();
    chooseButton.current?.focus({ preventScroll: true });
    // Unmount removes the native dialog. Closing here would emit a close event
    // during StrictMode's effect rehearsal and dismiss the real dialog as well.
    return () => { ++lifetime.ticket; };
  }, []);

  const close = () => {
    if (work.current === 'saving') return;
    ++operation.current.ticket; // A cancelled file read must not publish a late preview.
    dialog.current?.close();
  };

  const selectFile = async (file?: File) => {
    if (!file || work.current !== 'idle') return;
    const ticket = ++operation.current.ticket;
    work.current = 'reading';
    setStage('reading'); setBackup(undefined); setProblem(undefined);
    try {
      // Check bytes before allocating/reading the file; MIME/extension are only picker hints.
      if (file.size > MAX_RECOVERY_BYTES) throw new RecoveryValidationError('RecoveryTooLarge');
      if (!file.size) throw new RecoveryValidationError();
      let text: string;
      try { text = await file.text(); }
      catch {
        if (ticket === operation.current.ticket) {
          setProblem({ kind: 'file', message: 'The backup file could not be read. Select it again.', code: 'RecoveryReadFailed' });
          setStage('choose');
        }
        return;
      }
      if (ticket !== operation.current.ticket) return;
      const parsed = parseRecovery(text);
      setBackup(parsed); setStage('preview');
    } catch (error) {
      if (ticket !== operation.current.ticket) return;
      const safe = error instanceof RecoveryValidationError ? error : new RecoveryValidationError();
      setProblem({ kind: 'file', message: safe.message, code: safe.code });
      setStage('choose');
    } finally { if (ticket === operation.current.ticket) work.current = 'idle'; }
  };

  const confirmImport = async () => {
    if (!backup || work.current !== 'idle') return;
    const ticket = ++operation.current.ticket;
    work.current = 'saving'; setStage('saving'); setProblem(undefined);
    try {
      const copies = await importRecovery(backup);
      // Merge only the committed copies. Never reload settings or replace RAM chats.
      copies.forEach(session => rememberSession(session));
      if (ticket !== operation.current.ticket) return;
      setRestored(copies); setBackup(undefined); setStage('success');
    } catch (error) {
      if (ticket !== operation.current.ticket) return;
      if (error instanceof RecoveryValidationError) {
        setProblem({ kind: 'file', message: error.message, code: error.code });
        setBackup(undefined); setStage('choose');
      } else {
        setProblem({ kind: 'storage',
          message: error instanceof RecoveryStorageError ? error.message : 'Recovery could not be saved. Keep the backup and retry local storage.',
          code: error instanceof RecoveryStorageError ? error.code : storageErrorCode(error),
        });
        setStage('preview');
      }
    } finally { if (ticket === operation.current.ticket) work.current = 'idle'; }
  };

  return (
    <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy}
      onClose={onClose} onCancel={event => { if (work.current === 'saving') event.preventDefault(); else ++operation.current.ticket; }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      className="fixed inset-0 m-auto w-[calc(100vw-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold"><FileUp className="w-4 h-4 text-primary" />Restore backup</h2>
        <button type="button" aria-label="Close restore backup" disabled={stage === 'saving'} onClick={close}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"><X className="w-4 h-4" /></button>
      </div>
      <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
        Restore downloaded chats as new copies. Original chats and current settings stay unchanged; keys are not imported. No models or tools run. Import does not switch chats or stop your current work.
      </p>
      {stage !== 'success' && <>
        <p className="mt-2 text-[11px] text-muted-foreground">Choose a JSON recovery backup (v1 or v2), up to {MAX_RECOVERY_BYTES / (1024 * 1024)} MiB including file contents. The contents, not the file type, are validated.</p>
        <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Choose recovery backup" className="hidden"
          disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void selectFile(file); }} />
        <button ref={chooseButton} type="button" disabled={busy} onClick={() => fileInput.current?.click()}
          className="mt-4 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{backup ? 'Choose another file' : 'Choose backup file'}</button>
      </>}
      {backup && <section aria-label="Backup preview" className="mt-4 rounded-xl border border-border/60 bg-muted/20 p-3">
        <h3 className="text-xs font-semibold mb-2">Backup preview</h3>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div><dt className="text-muted-foreground">Chats</dt><dd className="mt-1 font-semibold">{backup.sessions.length}</dd></div>
          <div><dt className="text-muted-foreground">Messages</dt><dd className="mt-1 font-semibold">{backup.sessions.reduce((sum, session) => sum + session.messages.length, 0)}</dd></div>
          <div><dt className="text-muted-foreground">Attachments</dt><dd className="mt-1 font-semibold">{backup.attachments.length}</dd></div>
        </dl>
        <p className="mt-3 text-[11px] text-muted-foreground">Exported <time dateTime={backup.exportedAt}>{new Date(backup.exportedAt).toLocaleString()}</time>. Nothing is written until you confirm Import.</p>
      </section>}
      {problem && <div role="alert" className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed break-words">
        <p className="font-semibold">{problem.kind === 'file' ? 'Backup file problem' : 'Local storage problem'} ({problem.code})</p>
        <p className="mt-1">{problem.message}</p>
        {problem.code === 'StorageBlockedError' && <p className="mt-1">Close other tabs or windows using this address, then retry. Do not clear site data.</p>}
      </div>}
      {busy && <p role="status" className="mt-4 text-xs text-muted-foreground">{stage === 'reading' ? 'Reading and checking backup locally…' : 'Saving restored copies… Keep this tab open.'}</p>}
      {stage === 'success' && <div role="status" className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs leading-relaxed">
        <p className="font-semibold">Restored {restored.length} chat{restored.length === 1 ? '' : 's'} as new copies.</p>
        <p className="mt-1">Find them in the sidebar. Your current chat and draft have not changed.</p>
      </div>}
      {stage === 'success' && <p className="mt-3 text-[11px] text-muted-foreground">Viewing a restored chat switches chats and stops any current response. Your draft stays in the composer.</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={stage === 'saving'} onClick={close}
          className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{stage === 'success' ? 'Done' : 'Cancel'}</button>
        {backup && <button type="button" disabled={busy} onClick={() => { void confirmImport(); }}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">{stage === 'saving' ? 'Importing…' : `Import ${backup.sessions.length} chat${backup.sessions.length === 1 ? '' : 's'}`}</button>}
        {stage === 'success' && restored[0] && <button type="button" onClick={() => { setActiveSessionId(restored[0].id); setIsSettingsOpen(false); close(); }}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 cursor-pointer">View restored chat</button>}
      </div>
    </dialog>
  );
}
