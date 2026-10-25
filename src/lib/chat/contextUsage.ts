import type { Message } from '../types';

/**
 * Tokens the conversation occupied in the model's context window at the end of
 * the latest request with provider-reported usage: its input (history, system
 * prompt, tools, cache reads included) plus everything it generated.
 */
export function contextTokens(messages: Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].execution?.usage;
    if (usage?.inputTokens !== undefined) return usage.inputTokens + (usage.outputTokens ?? 0);
  }
  return undefined;
}

/** Compact token count: 950, 12.4k, 200k, 1.2M. */
export function formatTokens(tokens: number): string {
  const compact = (value: number, unit: string) => `${value < 100 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
  if (tokens >= 999_500) return compact(tokens / 1_000_000, 'M');
  if (tokens >= 1000) return compact(tokens / 1000, 'k');
  return String(Math.max(0, Math.round(tokens)));
}
