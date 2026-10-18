"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { FileText, ImageIcon, X } from 'lucide-react';
import type { AttachmentRecord, AttachmentRef } from '@/lib/types';
import { formatFileSize } from '@/lib/attachments/client';
import { loadAttachment } from '@/lib/attachments/store';

type AttachmentCardProps = {
  attachment: AttachmentRef;
  record?: AttachmentRecord;
  onRemove?: () => void;
  variant?: 'message' | 'draft';
};

export default function AttachmentCard(props: AttachmentCardProps) {
  const { id, name, kind, mediaType, size } = props.attachment;
  // A changed reference must never display the previous file's cached preview.
  return <LocalAttachmentCard key={JSON.stringify([id, name, kind, mediaType, size])} {...props} />;
}

function LocalAttachmentCard({ attachment, record, onRemove, variant = 'message' }: AttachmentCardProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<AttachmentRecord>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || record || loaded) return;
    let stale = false;
    void loadAttachment(attachment).then(value => { if (!stale) setLoaded(value); }, () => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [attachment, open, record, loaded]);
  const data = record || loaded;
  const Icon = attachment.kind === 'image' ? ImageIcon : FileText;

  if (variant === 'draft' && record) return (
    <div className="relative min-w-0">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Preview ${attachment.name}`}
        title={`${attachment.name} · ${formatFileSize(attachment.size)}`}
        className="flex aspect-square w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-background/70 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-background focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 cursor-pointer">
        <span className="flex min-h-0 w-full flex-1 items-center justify-center bg-muted/30 px-2 pt-2 pb-1">
          {record.kind === 'image' ? <PrivateImagePreview record={record} expanded={false} className="max-h-full rounded-sm" /> : <FileText className="h-6 w-6 shrink-0 text-primary/70" aria-hidden="true" />}
        </span>
        <span className="block w-full min-w-0 px-2 py-1.5">
          <span className="block truncate text-[10px] sm:text-[11px] font-medium leading-tight">{attachment.name}</span>
          <span className="mt-0.5 block truncate text-[9px] sm:text-[10px] leading-tight text-muted-foreground">{formatFileSize(attachment.size)}</span>
        </span>
      </button>
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`}
        className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 cursor-pointer"><X className="h-3 w-3" aria-hidden="true" /></button>}
      {open && <DraftAttachmentPreview record={record} onClose={() => setOpen(false)} />}
    </div>
  );

  return (
    <div className="rounded-xl border border-current/15 bg-background/10 text-inherit min-w-0 max-w-full overflow-hidden">
      <div className="flex items-center gap-2 p-2.5">
        <Icon className="w-4 h-4 shrink-0 opacity-70" aria-hidden="true" />
        <button type="button" onClick={() => { if (!open) setFailed(false); setOpen(value => !value); }} aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Preview'} ${attachment.name}`}
          className="flex-1 min-w-0 text-left cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-offset-2">
          <span className="block text-xs font-medium truncate" title={attachment.name}>{attachment.name}</span>
          <span className="block text-[10px] opacity-70">{formatFileSize(attachment.size)} · {attachment.kind === 'text' ? 'Text' : 'Image'} · {open ? 'Hide preview' : 'Preview'}</span>
        </button>
        {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${attachment.name}`} className="p-1 rounded-md hover:bg-muted/60 cursor-pointer shrink-0"><X className="w-3.5 h-3.5" /></button>}
      </div>
      {record?.kind === 'image' && !open && <div className="px-2.5 pb-2.5"><PrivateImagePreview record={record} expanded={false} /></div>}
      {open && <div className="border-t border-current/10 p-2.5">
        {failed ? <p role="alert" className="text-xs">Attachment unavailable in local storage. Restore a backup or reattach the original file in a new chat. Files are never silently omitted.</p> : !data ? <p role="status" className="text-xs opacity-70">Loading local preview…</p> : data.kind === 'image' ? (
          <PrivateImagePreview record={data} expanded />
        ) : <><pre className="text-xs whitespace-pre-wrap break-words font-mono max-h-40 overflow-auto">{data.data.slice(0, 2000)}</pre>{data.data.length > 2000 && <p className="text-[10px] mt-2 opacity-70">Preview: first 2,000 characters. The full text is sent.</p>}</>}
      </div>}
    </div>
  );
}

function DraftAttachmentPreview({ record, onClose }: { record: AttachmentRecord; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    dialog.current?.showModal();
    closeButton.current?.focus({ preventScroll: true });
    // Removing the dialog on unmount closes it; avoid a spurious close event in StrictMode.
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClose={onClose}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
        const first = targets[0]; const last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
      }}
      className="fixed inset-0 m-auto w-[calc(100vw-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-border bg-background p-4 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="break-words text-sm font-semibold">{record.name}</h2>
          <p id={`${id}-description`} className="mt-1 text-xs text-muted-foreground">{formatFileSize(record.size)} · Local preview · Not sent yet</p>
        </div>
        <button ref={closeButton} type="button" aria-label="Close attachment preview" onClick={() => dialog.current?.close()}
          className="shrink-0 rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary cursor-pointer"><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 p-3">
        {record.kind === 'image' ? <PrivateImagePreview record={record} expanded className="mx-auto max-h-[min(60dvh,36rem)] rounded-lg" /> : <>
          <pre tabIndex={0} aria-label="Text file preview" className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed font-mono focus-visible:outline-2 focus-visible:outline-primary">{record.data.slice(0, 2000)}</pre>
          {record.data.length > 2000 && <p className="mt-3 text-[10px] text-muted-foreground">Preview: first 2,000 characters. The full text is sent.</p>}
        </>}
      </div>
    </dialog>
  );
}

function PrivateImagePreview({ record, expanded, className }: { record: AttachmentRecord; expanded: boolean; className?: string }) {
  const [preview, setPreview] = useState<{ source: AttachmentRecord; url?: string; failed?: boolean }>();
  useEffect(() => {
    let stale = false;
    let url: string | undefined;
    void Promise.resolve().then(() => {
      if (stale) return;
      const prefix = `data:${record.mediaType};base64,`;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(record.mediaType) || !record.data.startsWith(prefix)) throw new Error('Invalid local image');
      const binary = atob(record.data.slice(prefix.length));
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: record.mediaType }));
      setPreview({ source: record, url });
    }).catch(() => { if (!stale) setPreview({ source: record, failed: true }); });
    return () => { stale = true; if (url) URL.revokeObjectURL(url); };
  }, [record]);
  const current = preview?.source === record ? preview : undefined;
  if (current?.failed) return <span role="status" className="text-xs opacity-70">Image preview is unavailable. The file is retained.</span>;
  if (!current?.url) return <span role="status" className="text-xs opacity-70">Loading local preview…</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Private browser-local previews cannot be optimized or sent to Next.js.
    <img src={current.url} alt={`Preview of ${record.name}`} decoding="async"
      onError={() => setPreview(previous => previous && previous.url === current.url ? { ...previous, failed: true } : previous)}
      className={`block h-auto w-auto max-w-full object-contain ${className ?? `rounded-md ${expanded ? 'max-h-60' : 'max-h-20'}`}`} />
  );
}
