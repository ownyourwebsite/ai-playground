"use client";

import React from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownProps = {
  /** Untrusted, possibly incomplete CommonMark/GFM from the model. */
  text: string;
};

function httpUrl(value: string): string | undefined {
  // No relative URLs, protocol-relative URLs or implicit protocol repairs.
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    if (protocol === "https:" || protocol === "http:") return value;
  } catch {
    // Incomplete streaming URLs and malformed destinations remain plain text.
  }
  return undefined;
}

// Strip resource URLs as well as unsafe navigation URLs before creating React
// elements. In particular, React 19 must never see an image to preload.
const urlTransform: UrlTransform = (value, key) =>
  key === "href" ? httpUrl(value) : undefined;

const components: Components = {
  a: ({ href, title, children }) => href ? (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline decoration-blue-400/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-blue-400"
    >
      {children}
    </a>
  ) : <span>{children}</span>,
  // Never forward src, srcSet or other props from an untrusted image node.
  img: ({ alt }) => <span className="text-muted-foreground">{alt || "Изображение"}</span>,
  code: ({ className, children }) => (
    <code className={`${className ?? ""} rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      className="my-4 max-w-full overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted p-4 font-mono text-[13px] leading-6 [overflow-wrap:normal] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[length:inherit]"
      tabIndex={0}
      role="region"
      aria-label="Блок кода"
    >
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-border pl-4 text-muted-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div
      className="my-4 max-w-full overflow-x-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      tabIndex={0}
      role="region"
      aria-label="Таблица"
    >
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      disabled
      aria-label={checked ? "Выполненная задача" : "Невыполненная задача"}
      className="mr-2 align-middle accent-blue-600"
    />
  ),
};

/**
 * Standard parsing also handles incomplete streamed Markdown without repairs.
 * Keep raw HTML disabled: no rehype-raw, MDX evaluation or HTML injection.
 */
export default function Markdown({ text }: MarkdownProps) {
  return (
    <div className={[
      "min-w-0 max-w-full whitespace-normal leading-relaxed [overflow-wrap:anywhere]",
      "[&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-3",
      "[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-bold",
      "[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold",
      "[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold",
      "[&_h4]:mb-2 [&_h4]:mt-4 [&_h4]:text-base [&_h4]:font-semibold",
      "[&_h5]:mb-2 [&_h5]:mt-4 [&_h5]:font-semibold",
      "[&_h6]:mb-2 [&_h6]:mt-4 [&_h6]:font-semibold [&_h6]:text-muted-foreground",
      "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
      "[&_li]:my-1 [&_li>ul]:my-1 [&_li>ol]:my-1 [&_.task-list-item]:list-none",
      "[&_strong]:font-semibold [&_em]:italic [&_del]:line-through [&_hr]:my-6 [&_hr]:border-border",
      "[&_th]:border-b [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold",
      "[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_tbody>tr:last-child>td]:border-b-0",
    ].join(" ")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform} skipHtml>
        {text ?? ""}
      </ReactMarkdown>
    </div>
  );
}
