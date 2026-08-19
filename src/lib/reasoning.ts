/**
 * Utilities for detecting, parsing and separating LLM "thinking" / reasoning
 * blocks from the final response text.
 *
 * Reasoning is commonly emitted inside tags such as `<think>...</think>` or
 * `<thought>...</thought>`. Some providers expose it on a dedicated field
 * (e.g. `reasoning` / `reasoning_content`). This module handles both cases and
 * is resilient to partially-streamed (unclosed) tags.
 */

export type ReasoningParseResult = {
  /** Extracted reasoning text, or `null` when none was found. */
  reasoning: string | null;
  /** The original text with any reasoning blocks removed. */
  cleanText: string;
  /**
   * True while a reasoning tag has opened but not yet closed (still streaming).
   * Lets the UI show a live "Thinking…" indicator even before any content has
   * arrived, instead of a jarring empty gap.
   */
  isOpen: boolean;
};

// Ordered from most specific to least; the earliest opening tag wins.
// Longer variants (e.g. `<thinking>`) are matched before their prefixes
// (`<think`) so closing tags like `</thinking>` resolve correctly instead of
// leaving the block permanently "open" and swallowing the final answer.
const REASONING_TAGS: { open: string; close: string }[] = [
  { open: "<thinking", close: "</thinking>" },
  { open: "<reasoning", close: "</reasoning>" },
  { open: "<thought", close: "</thought>" },
  { open: "<think", close: "</think>" },
];

/**
 * Parse reasoning from a message string.
 *
 * When `providedReasoning` is non-empty (a dedicated API field such as
 * `reasoning` / `reasoning_content`) it takes precedence and `text` is treated
 * as already-clean.
 *
 * Streaming resilience: if an opening tag is present but its closing tag has
 * not arrived yet, everything from the content start is treated as (partial)
 * reasoning, removed from `cleanText`, and flagged via `isOpen` so the UI can
 * update live as tokens stream in.
 */
export function parseReasoning(
  text: string,
  providedReasoning?: string | null
): ReasoningParseResult {
  const sourceText = text ?? "";

  if (providedReasoning && providedReasoning.trim().length > 0) {
    return { reasoning: providedReasoning, cleanText: sourceText, isOpen: false };
  }

  // Find the earliest opening tag across all supported tag names.
  let bestStart = -1;
  let bestTag: { open: string; close: string } | null = null;

  for (const tag of REASONING_TAGS) {
    const idx = sourceText.indexOf(tag.open);
    if (idx !== -1 && (bestStart === -1 || idx < bestStart)) {
      bestStart = idx;
      bestTag = tag;
    }
  }

  if (!bestTag) {
    return { reasoning: null, cleanText: sourceText, isOpen: false };
  }

  // Content starts right after the opening tag's `>` (or right after the tag
  // name if the `>` hasn't streamed in yet).
  const openEnd = sourceText.indexOf(">", bestStart);
  const contentStart = openEnd === -1 ? bestStart + bestTag.open.length : openEnd + 1;
  const closeIdx = sourceText.indexOf(bestTag.close, contentStart);

  let reasoning: string | null;
  let cleanText: string;
  let isOpen: boolean;

  if (closeIdx !== -1) {
    reasoning = sourceText.slice(contentStart, closeIdx).trim();
    cleanText = sourceText.slice(0, bestStart) + sourceText.slice(closeIdx + bestTag.close.length);
    isOpen = false;
  } else {
    // Unclosed tag — still streaming. Keep the partial reasoning and strip it
    // from the visible answer text.
    reasoning = sourceText.slice(contentStart).trim();
    cleanText = sourceText.slice(0, bestStart);
    isOpen = true;
  }

  if (!reasoning) {
    reasoning = null;
  }

  return { reasoning, cleanText, isOpen };
}

/**
 * Removes the first reasoning opening tag from a string. Used as a fallback when
 * a reasoning tag opened but never closed (so we can surface the text as a
 * normal answer instead of hiding it behind the accordion).
 */
export function stripOpenReasoningTag(text: string): string {
  const source = text ?? "";
  for (const tag of REASONING_TAGS) {
    const idx = source.indexOf(tag.open);
    if (idx !== -1) {
      const openEnd = source.indexOf(">", idx);
      if (openEnd !== -1) {
        return source.slice(0, idx) + source.slice(openEnd + 1);
      }
      return source.slice(0, idx) + source.slice(idx + tag.open.length);
    }
  }
  return source;
}
