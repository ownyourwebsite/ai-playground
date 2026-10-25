import type { Provider } from "./types";

/**
 * Model id used when the user has not chosen one. Provider catalogs change
 * often, so this is only a starting point: the settings modal suggests the
 * live list from each provider's models endpoint (see /api/models), and a
 * retired id surfaces as a "model not found" error instead of failing silently.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-sonnet-5",
  groq: "qwen/qwen3.8-27b",
  ollama: "llama3",
  custom: "custom",
};
