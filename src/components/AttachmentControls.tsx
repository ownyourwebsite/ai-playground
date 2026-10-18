"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Info, Paperclip, X } from "lucide-react";

// Version the notice independently from settings and image-model consent.
const NOTICE_KEY = "ai-workspace:attachment-notice:v1";

export default function AttachmentControls({ disabled, onChoose }: { disabled: boolean; onChoose: () => void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const acknowledgedInTab = useRef(false);
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<"attach" | "info">("attach");
  const id = useId();

  const positionHelp = useCallback(() => {
    const card = dialog.current;
    const trigger = anchor.current;
    if (!card?.open || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = card.getBoundingClientRect().width;
    const height = card.getBoundingClientRect().height;
    card.style.setProperty("--attachment-help-left", `${Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16))}px`);
    card.style.setProperty("--attachment-help-top", `${Math.max(16, bounds.top - height - 12)}px`);
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionHelp);
    return () => window.removeEventListener("resize", positionHelp);
  }, [open, positionHelp]);

  const showHelp = (nextIntent: "attach" | "info") => {
    setIntent(nextIntent);
    dialog.current?.showModal();
    positionHelp();
    confirm.current?.focus({ preventScroll: true });
    setOpen(true);
  };

  const choose = () => {
    let acknowledged = acknowledgedInTab.current;
    try { acknowledged ||= window.localStorage.getItem(NOTICE_KEY) === "1"; }
    catch { /* Storage may be blocked; a confirmation still lasts for this tab. */ }
    if (acknowledged) onChoose();
    else showHelp("attach");
  };

  const acknowledge = () => {
    try { window.localStorage.setItem(NOTICE_KEY, "1"); }
    catch { acknowledgedInTab.current = true; /* Never block selection when storage is unavailable. */ }
    dialog.current?.close();
    // Keep the native file picker in the confirmation button's user activation.
    if (intent === "attach") onChoose();
  };

  return (
    <div ref={anchor} className="flex items-center gap-0.5">
      <button type="button" onClick={choose} aria-label="Add attachments" aria-haspopup="dialog" aria-expanded={open && intent === "attach"}
        aria-controls={id} disabled={disabled} title="Attach UTF-8 text/source files or PNG, JPEG, WebP images"
        className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
        <Paperclip className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => showHelp("info")} aria-label="Attachment information" aria-haspopup="dialog"
        aria-expanded={open && intent === "info"} aria-controls={id} title="Attachment privacy, limits and costs"
        className="p-1.5 rounded-full text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors cursor-pointer">
        <Info className="w-3.5 h-3.5" />
      </button>
      <dialog ref={dialog} id={id} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        onClose={() => setOpen(false)}
        onKeyDown={event => {
          if (event.key !== "Tab") return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClick={event => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            event.currentTarget.close();
          }
        }}
        className="fixed inset-0 m-auto w-[calc(100vw-2rem)] max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-border/80 bg-background/95 p-4 text-foreground shadow-2xl backdrop-blur-xl backdrop:bg-black/35 sm:inset-auto sm:m-0 sm:left-[var(--attachment-help-left)] sm:top-[var(--attachment-help-top)] sm:backdrop:bg-transparent">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold"><Paperclip className="w-4 h-4 text-primary" />Attachments &amp; privacy</h2>
          <button type="button" aria-label="Close attachment information" onClick={() => dialog.current?.close()}
            className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div id={`${id}-description`} className="space-y-3 text-xs leading-relaxed text-muted-foreground">
          <p>Files stay local until you send. Then their full text/images go through this app to the selected provider with conversation history.</p>
          <div className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 space-y-0.5">
            <p className="font-medium text-foreground">Up to 4 files per message</p>
            <p>Text: 256 KiB/file · Images: 1 MiB/file</p>
            <p>2 MiB total per message</p>
          </div>
          <p>API charges/quotas may apply.</p>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={() => dialog.current?.close()} className="px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer">Not now</button>
          <button ref={confirm} type="button" onClick={acknowledge} disabled={intent === "attach" && disabled}
            className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            {intent === "attach" ? "Got it, choose files" : "Got it"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
