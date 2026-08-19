"use client";

import React, { ReactNode } from "react";

type MarkdownProps = {
  /** Plain text that may contain inline markdown (bold, italic, code). */
  text: string;
};

/**
 * Inline markdown tokens, bold checked first so `**text**` wins over `*text*`.
 * Non-greedy so streaming (unclosed) markers render literally without flashing.
 * Capture groups:
 *   1. `**x**` whole   2. x       3. `__x__` whole   4. x
 *   5. `*x*` whole     6. x       7. `_x_` whole     8. x
 *   9. `` `x` `` whole 10. x
 *
 * NOTE: this is a factory, not a module-level regex. `renderInline` recurses
 * into matched inner text; a shared global `/g` regex would clobber `lastIndex`
 * across calls and loop forever. A fresh regex per call keeps recursion safe.
 */
function createInlineRe(): RegExp {
  return /(\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`(.+?)`)/g;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  const inlineRe = createInlineRe();

  let match: RegExpExecArray | null;
  while ((match = inlineRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [full, , boldInner, , boldUnderInner, , italicInner, , italicUnderInner, , codeInner] = match;

    if (boldInner !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${key}`}>{renderInline(boldInner, `${keyPrefix}-${key}`)}</strong>);
    } else if (boldUnderInner !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${key}`}>{renderInline(boldUnderInner, `${keyPrefix}-${key}`)}</strong>);
    } else if (italicInner !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${key}`}>{renderInline(italicInner, `${keyPrefix}-${key}`)}</em>);
    } else if (italicUnderInner !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${key}`}>{renderInline(italicUnderInner, `${keyPrefix}-${key}`)}</em>);
    } else if (codeInner !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-${key}`}
          className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-[13px]"
        >
          {codeInner}
        </code>
      );
    }

    lastIndex = match.index + full.length;
    key++;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/**
 * Renders inline markdown (bold `**…**`, italic `*…*`, inline code `` `…` ``)
 * while preserving whitespace/newlines via the parent's `whitespace-pre-wrap`.
 * All text is escaped by construction (only matched spans become elements), so
 * this is safe against injection from untrusted model output.
 */
export default function Markdown({ text }: MarkdownProps) {
  return <>{renderInline(text ?? "", "md")}</>;
}
