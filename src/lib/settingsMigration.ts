import type { AppSettings } from "./types";
import { DEFAULT_MODELS } from "./providers";

/** Bump when adding a migration step; stored settings below it are migrated once, then stamped. */
export const SETTINGS_VERSION = 1;

// Model ids that no longer exist (as of Oct 2026). Live ids such as gpt-4o stay as the user left them.
const RETIRED_MODELS: Record<string, string> = {
  "o1-preview": DEFAULT_MODELS.openai,
  "o1-mini": DEFAULT_MODELS.openai,
  "claude-3-5-sonnet-latest": DEFAULT_MODELS.anthropic,
  "claude-3-5-haiku-latest": DEFAULT_MODELS.anthropic,
  "claude-3-opus-latest": DEFAULT_MODELS.anthropic,
  "llama-3.3-70b-versatile": DEFAULT_MODELS.groq,
  "llama-3.1-8b-instant": DEFAULT_MODELS.groq,
  "llama-3.1-70b-versatile": DEFAULT_MODELS.groq,
  "mixtral-8x7b-32768": DEFAULT_MODELS.groq,
  "qwen/qwen3.6-27b": DEFAULT_MODELS.groq,
};

const MODEL_FIELDS = ["openAiModel", "anthropicModel", "groqModel", "ollamaModel", "customModel"] as const;

/**
 * One-time migration of stored settings. Runs only when the stored version is older
 * than SETTINGS_VERSION, so a model the user picks afterwards is never rewritten.
 * Settings from a newer app version are returned untouched. `changed` means the
 * result differs from the input and must be persisted.
 */
export function migrateSettings(settings: AppSettings): { settings: AppSettings; changed: boolean } {
  const version = settings.settingsVersion ?? 0;
  if (!Number.isFinite(version) || version >= SETTINGS_VERSION) return { settings, changed: false };
  const migrated: AppSettings = { ...settings, settingsVersion: SETTINGS_VERSION };
  for (const field of MODEL_FIELDS) {
    const value = settings[field];
    if (value && Object.hasOwn(RETIRED_MODELS, value)) migrated[field] = RETIRED_MODELS[value];
  }
  return { settings: migrated, changed: true };
}
