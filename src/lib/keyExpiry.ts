import { AppSettings } from "./types";

/**
 * Remembered secret keys (stored locally in IndexedDB when "Remember keys on
 * this device" is on) are given a rolling 30-day expiry as basic hygiene — if a
 * user stops opening the app, their keys stop being persisted after a month.
 */
export const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The AppSettings fields that hold remembered secret keys. */
export const KEY_FIELDS = ["openAiKey", "anthropicKey", "groqKey", "customKey", "githubPat"] as const;
export type SecretKeyField = (typeof KEY_FIELDS)[number];

/**
 * Remove any remembered secret keys whose 30-day expiry has passed.
 *
 * Backwards compatibility: a stored key WITHOUT an expiry entry (data saved
 * before this feature existed) is left intact — we never suddenly delete a
 * user's keys. Such a key simply gets an expiry stamped the next time it is
 * saved via {@link refreshKeyExpirations}.
 *
 * @returns the cleaned settings plus the list of secret fields that were dropped.
 */
export function cleanExpiredKeys(settings: AppSettings): { settings: AppSettings; dropped: SecretKeyField[] } {
  const now = Date.now();
  const sourceExpirations = settings.keyExpirations;
  const expirations = { ...(sourceExpirations ?? {}) };
  const cleaned: AppSettings = { ...settings };
  const dropped: SecretKeyField[] = [];

  for (const field of KEY_FIELDS) {
    const expiry = expirations[field];
    const stored = (cleaned as Record<string, unknown>)[field];
    if (stored && typeof expiry === "number" && expiry <= now) {
      (cleaned as Record<string, unknown>)[field] = undefined;
      delete expirations[field];
      dropped.push(field);
    }
  }

  // Only (re)attach keyExpirations when it already existed or entries dropped,
  // so untouched pre-feature settings keep their original shape.
  if (dropped.length > 0 || sourceExpirations !== undefined) {
    cleaned.keyExpirations = expirations;
  }

  return { settings: cleaned, dropped };
}

/**
 * Stamp (or refresh) the 30-day expiry for each listed secret field that has a
 * stored value. When a listed field's value is falsy (empty/cleared), its
 * expiry entry is removed and the secret is defensively cleared too.
 */
export function refreshKeyExpirations(settings: AppSettings, fields: SecretKeyField[]): AppSettings {
  const now = Date.now();
  const updated: AppSettings = { ...settings };
  const expirations = { ...(settings.keyExpirations ?? {}) };

  for (const field of fields) {
    const value = (updated as Record<string, unknown>)[field];
    if (value) {
      expirations[field] = now + KEY_TTL_MS;
    } else {
      delete expirations[field];
      (updated as Record<string, unknown>)[field] = undefined;
    }
  }

  return { ...updated, keyExpirations: expirations };
}
