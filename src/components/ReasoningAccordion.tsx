"use client";

import React, { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";

type ReasoningAccordionProps = {
  /** Extracted reasoning text. May be null/empty while still streaming. */
  reasoning: string | null;
  /** True while a reasoning block is still streaming (open tag, no close yet). */
  isStreaming?: boolean;
};

/**
 * Collapsible accordion that surfaces the model's hidden "thinking" process.
 * Collapsed by default; expands on click. Uses subtle styling to visually
 * distinguish inner thoughts from the final answer. While a reasoning block is
 * still streaming it shows a live "Thinking…" placeholder instead of empty
 * space.
 */
export default function ReasoningAccordion({ reasoning, isStreaming = false }: ReasoningAccordionProps) {
  const [open, setOpen] = useState(false);

  const hasContent = !!reasoning;

  return (
    <div className="mb-1.5 rounded-xl border border-border/60 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left cursor-pointer hover:bg-muted/60 transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          <Brain className="w-3.5 h-3.5 text-primary" />
          {isStreaming && !hasContent ? "Thinking…" : "Thought process"}
          {isStreaming && hasContent && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary/70 animate-pulse" />
          )}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-200 shrink-0 ${open ? "rotate-180" : ""
            }`}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-2.5 border-t border-border/40 text-[13px] leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {hasContent ? (
            reasoning
          ) : (
            <span className="italic animate-pulse">Thinking…</span>
          )}
        </div>
      )}
    </div>
  );
}
