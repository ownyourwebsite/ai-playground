import { normalizeOllamaBaseUrl } from '@/lib/chat/ollama';
import { SsrfBlockedError, ssrfGuardedFetch } from '@/lib/ssrf';

export const MODEL_PROVIDERS = ['openai', 'anthropic', 'groq', 'ollama', 'custom'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelInfo { id: string; contextWindow?: number }

export type ModelsErrorCode = 'missing-credentials' | 'bad-provider' | 'blocked-url' | 'auth' | 'upstream';

const STATUS: Record<ModelsErrorCode, number> = {
  'missing-credentials': 400, 'bad-provider': 400, 'blocked-url': 400, auth: 401, upstream: 502,
};

export class ModelsError extends Error {
  readonly status: number;
  constructor(readonly code: ModelsErrorCode) {
    super(code);
    this.status = STATUS[code];
  }
}

export interface ModelCreds {
  /** Provider key (optional for ollama and custom). */
  apiKey?: string;
  /** Ollama URL or custom OpenAI-compatible base URL. */
  baseUrl?: string;
}

export interface ModelsDeps {
  fetch: typeof fetch;
  guardedFetch: typeof ssrfGuardedFetch;
}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_ID_LENGTH = 200;

/**
 * OpenAI lists every model it serves. Drop whatever is obviously not a chat
 * model by substring; a stray non-chat id only costs a useless suggestion.
 */
const OPENAI_NON_CHAT = /embedding|tts|whisper|transcribe|dall-e|image|moderation|babbage|davinci|realtime|audio|sora|search|computer-use/i;
const GROQ_AUDIO = /whisper|tts|orpheus|playai/i;

/** Caller abort or the overall deadline, whichever comes first. */
function deadline(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Trim, validate, dedupe (first context window wins), sort and cap. */
export function normalizeModels(entries: Array<{ id: unknown; contextWindow?: unknown }>): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const entry of entries) {
    if (typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (!id || id.length > MAX_ID_LENGTH) continue;
    const contextWindow = positiveInt(entry.contextWindow);
    const existing = byId.get(id);
    if (!existing) byId.set(id, contextWindow ? { id, contextWindow } : { id });
    else if (!existing.contextWindow && contextWindow) existing.contextWindow = contextWindow;
  }
  return [...byId.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_MODELS);
}

function dataArray(json: unknown): Array<Record<string, unknown>> {
  const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new ModelsError('upstream');
  return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ModelsError('upstream'); }
}

function checkStatus(status: number) {
  if (status === 401 || status === 403) throw new ModelsError('auth');
  if (status < 200 || status >= 300) throw new ModelsError('upstream');
}

/** Fixed public hosts: plain fetch. Redirects are refused so keys never leave the host. */
async function publicGet(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, deps: ModelsDeps) {
  try {
    const res = await deps.fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: deadline(signal),
      redirect: 'error',
      cache: 'no-store',
    });
    checkStatus(res.status);
    return parseJson(await res.text());
  } catch (error) {
    throw error instanceof ModelsError ? error : new ModelsError('upstream');
  }
}

/**
 * The guard throws plain Errors for rejected targets; transport errors
 * (timeout, reset, oversize) must stay `upstream`.
 */
function isBlockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof SsrfBlockedError || (error as NodeJS.ErrnoException).code === 'EBLOCKED') return true;
  // URL-shape rejections from assertUrlIsPublic; DNS and connection failures stay 'upstream'.
  return /^(?:Invalid URL|Only HTTP\(S\) URLs are allowed)$/.test(error.message);
}

/** User-supplied hosts: only through the SSRF-guarded client. */
async function guardedGet(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, deps: ModelsDeps) {
  try {
    const res = await deps.guardedFetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: deadline(signal),
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    });
    checkStatus(res.status);
    if (res.truncated) throw new ModelsError('upstream');
    return parseJson(res.bodyText);
  } catch (error) {
    if (error instanceof ModelsError) throw error;
    throw new ModelsError(isBlockedError(error) ? 'blocked-url' : 'upstream');
  }
}

/** Build `<base>/models`; credentials, query and fragment in the base are refused. */
function modelsUrl(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new ModelsError('blocked-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelsError('blocked-url');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url.toString();
}

export async function listModels(
  provider: string,
  creds: ModelCreds,
  signal?: AbortSignal,
  deps: ModelsDeps = { fetch, guardedFetch: ssrfGuardedFetch },
): Promise<ModelInfo[]> {
  const apiKey = creds.apiKey?.trim() ?? '';
  const baseUrl = creds.baseUrl?.trim() ?? '';
  const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

  switch (provider) {
    case 'openai': {
      if (!apiKey) throw new ModelsError('missing-credentials');
      const json = await publicGet('https://api.openai.com/v1/models', bearer(apiKey), signal, deps);
      return normalizeModels(dataArray(json).filter(m => typeof m.id === 'string' && !OPENAI_NON_CHAT.test(m.id)).map(m => ({ id: m.id })));
    }
    case 'anthropic': {
      if (!apiKey) throw new ModelsError('missing-credentials');
      const json = await publicGet(
        'https://api.anthropic.com/v1/models?limit=1000',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal,
        deps,
      );
      return normalizeModels(dataArray(json).map(m => ({ id: m.id, contextWindow: m.max_input_tokens })));
    }
    case 'groq': {
      if (!apiKey) throw new ModelsError('missing-credentials');
      const json = await publicGet('https://api.groq.com/openai/v1/models', bearer(apiKey), signal, deps);
      return normalizeModels(
        dataArray(json)
          .filter(m => m.active !== false && !(typeof m.id === 'string' && GROQ_AUDIO.test(m.id)))
          .map(m => ({ id: m.id, contextWindow: m.context_window })),
      );
    }
    case 'ollama': {
      if (!baseUrl) throw new ModelsError('missing-credentials');
      let base: string;
      try { base = normalizeOllamaBaseUrl(baseUrl); } catch { throw new ModelsError('blocked-url'); }
      // Ollama's runtime limit is num_ctx, which /v1/models does not report.
      return normalizeModels((dataArray(await guardedGet(modelsUrl(base), {}, signal, deps))).map(m => ({ id: m.id })));
    }
    case 'custom': {
      if (!baseUrl) throw new ModelsError('missing-credentials');
      const json = await guardedGet(modelsUrl(baseUrl), bearer(apiKey), signal, deps);
      return normalizeModels(
        dataArray(json).map(m => ({ id: m.id, contextWindow: positiveInt(m.context_length) ?? m.context_window })),
      );
    }
    default:
      throw new ModelsError('bad-provider');
  }
}
