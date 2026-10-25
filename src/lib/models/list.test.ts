import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelsError, listModels, normalizeModels, type ModelsDeps } from './list';
import { SsrfBlockedError } from '../ssrf';

type Call = { url: string; headers: Record<string, string>; guarded: boolean; signal?: AbortSignal };

function deps(respond: (call: Call) => { status?: number; body?: unknown; text?: string; truncated?: boolean } | Error) {
  const calls: Call[] = [];
  const answer = (url: string, headers: Record<string, string>, guarded: boolean, signal?: AbortSignal) => {
    const call = { url, headers, guarded, signal };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.body ?? {}), truncated: r.truncated ?? false };
  };
  const d: ModelsDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const r = answer(String(url), init.headers as Record<string, string>, false, init.signal ?? undefined);
      return new Response(r.text, { status: r.status });
    }) as unknown as typeof fetch,
    guardedFetch: (async (url: string, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
      const r = answer(url, opts.headers ?? {}, true, opts.signal);
      return { status: r.status, headers: {}, bodyText: r.text, truncated: r.truncated };
    }) as unknown as ModelsDeps['guardedFetch'],
  };
  return { d, calls };
}

async function code(promise: Promise<unknown>) {
  try { await promise; } catch (e) { assert.ok(e instanceof ModelsError); return e.code; }
  assert.fail('expected rejection');
}

test('normalizeModels trims, drops invalid, dedupes, sorts and caps', () => {
  const long = 'x'.repeat(201);
  const out = normalizeModels([
    { id: ' b ' }, { id: 'a', contextWindow: 0 }, { id: 'b', contextWindow: 8192 }, { id: '' }, { id: '   ' },
    { id: 7 }, { id: long }, { id: 'a', contextWindow: 1.5 }, { id: 'c', contextWindow: '10' },
  ]);
  assert.deepEqual(out, [{ id: 'a' }, { id: 'b', contextWindow: 8192 }, { id: 'c' }]);
  const many = Array.from({ length: 1500 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` }));
  const capped = normalizeModels(many.reverse());
  assert.equal(capped.length, 1000);
  assert.equal(capped[0].id, 'm0000');
});

test('openai: bearer auth, drops non-chat models, no context window', async () => {
  const { d, calls } = deps(() => ({ body: { data: [
    { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' }, { id: 'whisper-1' }, { id: 'gpt-4o-transcribe' },
    { id: 'dall-e-3' }, { id: 'gpt-image-1' }, { id: 'omni-moderation-latest' }, { id: 'davinci-002' }, { id: 'babbage-002' },
    { id: 'gpt-4o-realtime-preview' }, { id: 'gpt-4o-audio-preview' }, { id: 'sora-2' }, { id: 'gpt-4o-search-preview' }, { id: 'o3-mini' },
  ] } }));
  assert.deepEqual(await listModels('openai', { apiKey: ' sk-test ' }, undefined, d), [{ id: 'gpt-4o' }, { id: 'o3-mini' }]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].guarded, false);
});

test('anthropic: x-api-key header, version header and max_input_tokens', async () => {
  const { d, calls } = deps(() => ({ body: { data: [
    { id: 'claude-b', max_input_tokens: 200000 }, { id: 'claude-a' },
  ] } }));
  assert.deepEqual(await listModels('anthropic', { apiKey: 'k' }, undefined, d), [
    { id: 'claude-a' }, { id: 'claude-b', contextWindow: 200000 },
  ]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[0].headers['x-api-key'], 'k');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
});

test('groq: drops inactive and audio models, keeps context_window', async () => {
  const { d, calls } = deps(() => ({ body: { data: [
    { id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 },
    { id: 'old-model', active: false, context_window: 4096 },
    { id: 'whisper-large-v3', active: true }, { id: 'playai-tts', active: true },
    { id: 'canopylabs/orpheus-v1-english', active: true }, { id: 'no-flag', context_window: 8192 },
  ] } }));
  assert.deepEqual(await listModels('groq', { apiKey: 'k' }, undefined, d), [
    { id: 'llama-3.3-70b-versatile', contextWindow: 131072 }, { id: 'no-flag', contextWindow: 8192 },
  ]);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
});

test('ollama: normalised base, guarded fetch, no auth header, no context window', async () => {
  const { d, calls } = deps(() => ({ body: { data: [{ id: 'qwen3:8b' }, { id: 'llama3.2:latest', context_length: 4096 }] } }));
  const out = await listModels('ollama', { baseUrl: 'https://ollama.example:11434/api/' }, undefined, d);
  assert.deepEqual(out, [{ id: 'llama3.2:latest' }, { id: 'qwen3:8b' }]);
  assert.equal(calls[0].url, 'https://ollama.example:11434/v1/models');
  assert.equal(calls[0].guarded, true);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('custom: base/models, optional bearer, context_length then context_window', async () => {
  const { d, calls } = deps(() => ({ body: { data: [
    { id: 'or/a', context_length: 32000 }, { id: 'or/b', context_window: 8000 },
    { id: 'or/c', context_length: -1, context_window: 4000 }, { id: 'or/d', context_length: 'x' },
  ] } }));
  assert.deepEqual(await listModels('custom', { baseUrl: 'https://openrouter.example/api/v1/', apiKey: 'k' }, undefined, d), [
    { id: 'or/a', contextWindow: 32000 }, { id: 'or/b', contextWindow: 8000 },
    { id: 'or/c', contextWindow: 4000 }, { id: 'or/d' },
  ]);
  assert.equal(calls[0].url, 'https://openrouter.example/api/v1/models');
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  await listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, d);
  assert.equal(calls[1].headers.Authorization, undefined);
});

test('missing credentials and unknown provider', async () => {
  const { d, calls } = deps(() => ({ body: { data: [] } }));
  for (const p of ['openai', 'anthropic', 'groq']) assert.equal(await code(listModels(p, { apiKey: '  ' }, undefined, d)), 'missing-credentials');
  assert.equal(await code(listModels('ollama', {}, undefined, d)), 'missing-credentials');
  assert.equal(await code(listModels('custom', { apiKey: 'k' }, undefined, d)), 'missing-credentials');
  assert.equal(await code(listModels('nope', { apiKey: 'k' }, undefined, d)), 'bad-provider');
  assert.equal(calls.length, 0);
});

test('error mapping: 401/403 auth, 5xx/garbage/timeout upstream, never echoes upstream text', async () => {
  for (const status of [401, 403]) {
    assert.equal(await code(listModels('openai', { apiKey: 'k' }, undefined, deps(() => ({ status, text: 'secret-body' })).d)), 'auth');
  }
  assert.equal(await code(listModels('groq', { apiKey: 'k' }, undefined, deps(() => ({ status: 500 })).d)), 'upstream');
  assert.equal(await code(listModels('groq', { apiKey: 'k' }, undefined, deps(() => ({ text: 'not json' })).d)), 'upstream');
  assert.equal(await code(listModels('groq', { apiKey: 'k' }, undefined, deps(() => ({ body: { nope: 1 } })).d)), 'upstream');
  assert.equal(await code(listModels('openai', { apiKey: 'k' }, undefined, deps(() => new DOMException('timed out', 'TimeoutError')).d)), 'upstream');
  assert.equal(await code(listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, deps(() => ({ status: 401 })).d)), 'auth');
  assert.equal(await code(listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, deps(() => new Error('Gateway timeout')).d)), 'upstream');
  assert.equal(await code(listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, deps(() => Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' })).d)), 'upstream');
  assert.equal(await code(listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, deps(() => ({ truncated: true, text: '{"data":[' })).d)), 'upstream');
});

test('SSRF rejections from the guard map to blocked-url', async () => {
  const blocked = Object.assign(new Error('Host resolved to a private address'), { code: 'EBLOCKED' });
  for (const err of [blocked, new SsrfBlockedError('Access to private hosts is restricted'), new SsrfBlockedError('Non-HTTPS URLs are restricted on hosted deployments'), new Error('Invalid URL')]) {
    assert.equal(await code(listModels('custom', { baseUrl: 'https://x.example/v1' }, undefined, deps(() => err).d)), 'blocked-url');
  }
  // Malformed or credential-bearing URLs never reach the network.
  const { d, calls } = deps(() => ({ body: { data: [] } }));
  for (const baseUrl of ['not a url', 'ftp://x.example', 'https://user:pw@x.example/v1', 'https://x.example/v1?token=1']) {
    assert.equal(await code(listModels('custom', { baseUrl }, undefined, d)), 'blocked-url');
  }
  assert.equal(await code(listModels('ollama', { baseUrl: 'https://u:p@x.example' }, undefined, d)), 'blocked-url');
  assert.equal(calls.length, 0);
});

test('public fetch refuses redirects and carries a deadline', async () => {
  const seen: RequestInit[] = [];
  const d: ModelsDeps = {
    fetch: (async (_u: string, init: RequestInit) => { seen.push(init); return Response.json({ data: [] }); }) as unknown as typeof fetch,
    guardedFetch: (() => assert.fail('must not use guarded fetch')) as unknown as ModelsDeps['guardedFetch'],
  };
  const controller = new AbortController();
  await listModels('openai', { apiKey: 'k' }, controller.signal, d);
  assert.equal(seen[0].redirect, 'error');
  assert.equal(seen[0].cache, 'no-store');
  controller.abort();
  assert.equal(seen[0].signal?.aborted, true);
});
