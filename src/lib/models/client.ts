import type { ModelInfo, ModelProvider } from './list';

export type { ModelInfo, ModelProvider };

export type ModelListError = 'missing-credentials' | 'bad-provider' | 'blocked-url' | 'auth' | 'rate-limited' | 'upstream' | 'aborted';
export type ModelListResult = { models: ModelInfo[] } | { error: ModelListError };

/** Subset of AppSettings; for a saved custom provider pass its baseUrl/key as customBaseUrl/customKey. */
export interface ModelListCreds {
  openAiKey?: string;
  anthropicKey?: string;
  groqKey?: string;
  ollamaUrl?: string;
  customKey?: string;
  customBaseUrl?: string;
}

const TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 50;
const SERVER_ERRORS = new Set<ModelListError>(['missing-credentials', 'bad-provider', 'blocked-url', 'auth']);

// Memory only: nothing is persisted and raw keys never become map keys.
const cache = new Map<string, { at: number; models: ModelInfo[] }>();
const inflight = new Map<string, Promise<ModelListResult>>();

export function clearModelListCache() {
  cache.clear();
  inflight.clear();
}

/** Short non-reversible fingerprint so a changed key misses the cache. */
async function fingerprint(secret: string): Promise<string> {
  if (!secret) return '';
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure contexts have no SubtleCrypto: fall back to a cyrb53 hash.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < secret.length; i++) {
    const c = secret.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function requestFor(provider: ModelProvider, creds: ModelListCreds): { headers: Record<string, string>; key: string; base: string } | null {
  const trim = (v?: string) => v?.trim() ?? '';
  switch (provider) {
    case 'openai': { const key = trim(creds.openAiKey); return key ? { headers: { 'x-openai-key': key }, key, base: '' } : null; }
    case 'anthropic': { const key = trim(creds.anthropicKey); return key ? { headers: { 'x-anthropic-key': key }, key, base: '' } : null; }
    case 'groq': { const key = trim(creds.groqKey); return key ? { headers: { 'x-groq-key': key }, key, base: '' } : null; }
    case 'ollama': { const base = trim(creds.ollamaUrl); return base ? { headers: { 'x-ollama-url': base }, key: '', base } : null; }
    case 'custom': {
      const base = trim(creds.customBaseUrl), key = trim(creds.customKey);
      if (!base) return null;
      return { headers: { 'x-custom-base-url': base, ...(key && { 'x-custom-key': key }) }, key, base };
    }
  }
}

async function load(provider: ModelProvider, headers: Record<string, string>): Promise<ModelListResult> {
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { models?: unknown; error?: unknown } | null;
    if (res.ok && body && Array.isArray(body.models)) return { models: body.models as ModelInfo[] };
    if (res.status === 429) return { error: 'rate-limited' };
    const code = body?.error as ModelListError;
    return { error: SERVER_ERRORS.has(code) ? code : 'upstream' };
  } catch {
    return { error: 'upstream' };
  }
}

function withAbort(promise: Promise<ModelListResult>, signal?: AbortSignal): Promise<ModelListResult> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve({ error: 'aborted' });
  return new Promise(resolve => {
    const onAbort = () => resolve({ error: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Live model list for a provider via /api/models. Successes are cached 10 min
 * per provider + base URL + key fingerprint; concurrent calls share one
 * request. A caller's abort only detaches that caller (`{ error: 'aborted' }`).
 */
export async function fetchModelList(provider: ModelProvider, creds: ModelListCreds, signal?: AbortSignal): Promise<ModelListResult> {
  if (signal?.aborted) return { error: 'aborted' };
  const req = requestFor(provider, creds);
  if (!req) return { error: 'missing-credentials' };
  const cacheKey = `${provider}|${req.base}|${await fingerprint(req.key)}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return { models: hit.models };

  let pending = inflight.get(cacheKey);
  if (!pending) {
    pending = load(provider, req.headers).then(result => {
      if ('models' in result) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { at: Date.now(), models: result.models });
        if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      }
      return result;
    }).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, pending);
  }
  return withAbort(pending, signal);
}

export function contextWindowFor(models: ModelInfo[] | undefined, id: string): number | undefined {
  const wanted = id.trim();
  return wanted ? models?.find(m => m.id === wanted)?.contextWindow : undefined;
}
