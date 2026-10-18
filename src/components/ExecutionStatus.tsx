"use client";

import { useEffect, useState } from 'react';
import type { Message } from '@/lib/types';
import { canContinueModel } from '@/lib/chat/execution';

export default function ExecutionStatus({ message, onRetry, busy }: { message: Message; onRetry: () => void; busy: boolean }) {
  const e = message.execution;
  const [now, setNow] = useState(0);
  useEffect(() => {
    const deadline = e?.retryAt ?? e?.error?.retryAt;
    if (!deadline || e?.recovered || e?.status === 'complete') return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= deadline) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [e?.retryAt, e?.error?.retryAt, e?.recovered, e?.status]);
  if (!e || e.status === 'complete') return null;
  const wait = Math.max(0, Math.ceil(((e.retryAt ?? e.error?.retryAt ?? 0) - (now || e.startedAt)) / 1000));
  if (e.recovered) return <details className="mt-2 text-xs text-muted-foreground"><summary>Recovered after retry</summary>{e.error?.message}</details>;
  let label = '';
  if (e.status === 'waiting') label = 'Waiting for model…';
  if (e.status === 'pending-model') label = 'Tool results received. Saving before model continuation…';
  if (e.status === 'streaming' && !message.content && !message.reasoning && !message.reasoningOpen && !message.toolInvocations?.length) label = 'Working…';
  if (e.status === 'retry-wait') label = `${e.error?.message} Retry ${e.retryNumber}/2 in ${wait}s. Stop is available.`;
  const unknownTool = message.toolInvocations?.some(tool => tool.outcome === 'unknown');
  if (e.status === 'cancelled') label = unknownTool
    ? 'Stopped by you while a tool was running. The remote action may still have completed. Verify it before repeating.'
    : 'Stopped by you. Received text is retained; pending approvals were not executed.';
  if (e.status === 'interrupted') {
    const reasons = {
      user: 'The request was interrupted.',
      'session-switch': 'Paused when you switched chats.',
      'page-exit': 'The page was closed or reloaded before completion.',
      reload: 'An unfinished request was recovered after reloading. It was not automatically resumed.',
      'step-limit': 'The safety limit of 10 tool rounds was reached. Send a new message to continue.',
    };
    label = reasons[e.interruption ?? 'reload'];
    if (unknownTool) label += ' A tool may have completed remotely; verify it before repeating.';
  }
  if (e.status === 'error') label = e.error?.message ?? 'Stopped after an error. Received text is retained.';
  const retry = canContinueModel(message);
  return <div className="text-xs mt-2" role={e.status === 'error' ? 'alert' : 'status'}>
    <span className={e.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{label}</span>
    {retry && <button type="button" disabled={busy || wait > 0} onClick={onRetry} className="block mt-2 border rounded-md px-3 py-1 disabled:opacity-50 cursor-pointer">
      {wait > 0 ? `Retry available in ${wait}s` : 'Retry model step'}
    </button>}
  </div>;
}
