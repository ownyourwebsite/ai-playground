import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { clearModelListCache, contextWindowFor, fetchModelList } from './client';

function setup(t: TestContext, respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  clearModelListCache();
  t.after(clearModelListCache);
  return t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => respond(String(url), init));
}
const ok = (ids: string[]) => Response.json({ models: ids.map(id => ({ id })) });

test('client: sends provider headers only, returns models', async (t) => {
  const fetch = setup(t, () => ok(['a']));
  const out = await fetchModelList('custom', { customBaseUrl: ' https://x.example/v1 ', customKey: 'k', openAiKey: 'unrelated' });
  assert.deepEqual(out, { models: [{ id: 'a' }] });
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, '/api/models?provider=custom');
  assert.deepEqual(init.headers, { 'x-custom-base-url': 'https://x.example/v1', 'x-custom-key': 'k' });
});

test('client: missing credentials short-circuits without a request', async (t) => {
  const fetch = setup(t, () => ok([]));
  assert.deepEqual(await fetchModelList('openai', { anthropicKey: 'k' }), { error: 'missing-credentials' });
  assert.deepEqual(await fetchModelList('ollama', {}), { error: 'missing-credentials' });
  assert.deepEqual(await fetchModelList('custom', { customKey: 'k' }), { error: 'missing-credentials' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('client: caches successes per provider, base URL and key; different key misses', async (t) => {
  const fetch = setup(t, () => ok(['a']));
  await fetchModelList('openai', { openAiKey: 'k1' });
  await fetchModelList('openai', { openAiKey: 'k1' });
  assert.equal(fetch.mock.callCount(), 1);
  await fetchModelList('openai', { openAiKey: 'k2' });
  assert.equal(fetch.mock.callCount(), 2);
  await fetchModelList('custom', { customBaseUrl: 'https://a.example/v1', customKey: 'k1' });
  await fetchModelList('custom', { customBaseUrl: 'https://b.example/v1', customKey: 'k1' });
  assert.equal(fetch.mock.callCount(), 4);
});

test('client: cache expires after 10 minutes', async (t) => {
  const fetch = setup(t, () => ok(['a']));
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  await fetchModelList('groq', { groqKey: 'k' });
  now += 9 * 60_000;
  await fetchModelList('groq', { groqKey: 'k' });
  assert.equal(fetch.mock.callCount(), 1);
  now += 2 * 60_000;
  await fetchModelList('groq', { groqKey: 'k' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('client: failures are not cached and map server codes', async (t) => {
  let status = 401;
  const fetch = setup(t, () => status === 200 ? ok(['a']) : Response.json({ error: status === 401 ? 'auth' : 'weird' }, { status }));
  assert.deepEqual(await fetchModelList('anthropic', { anthropicKey: 'k' }), { error: 'auth' });
  status = 500;
  assert.deepEqual(await fetchModelList('anthropic', { anthropicKey: 'k' }), { error: 'upstream' });
  status = 429;
  assert.deepEqual(await fetchModelList('anthropic', { anthropicKey: 'k' }), { error: 'rate-limited' });
  status = 200;
  assert.deepEqual(await fetchModelList('anthropic', { anthropicKey: 'k' }), { models: [{ id: 'a' }] });
  assert.equal(fetch.mock.callCount(), 4);
});

test('client: network failure is upstream', async (t) => {
  setup(t, () => { throw new TypeError('failed to fetch'); });
  assert.deepEqual(await fetchModelList('groq', { groqKey: 'k' }), { error: 'upstream' });
});

test('client: concurrent calls share one request and an abort only detaches the aborting caller', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = setup(t, async () => { await gate; return ok(['a']); });
  const controller = new AbortController();
  const first = fetchModelList('openai', { openAiKey: 'k' }, controller.signal);
  const second = fetchModelList('openai', { openAiKey: 'k' });
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  assert.deepEqual(await first, { error: 'aborted' });
  release();
  assert.deepEqual(await second, { models: [{ id: 'a' }] });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await fetchModelList('openai', { openAiKey: 'k' }, AbortSignal.abort()), { error: 'aborted' });
});

test('contextWindowFor', () => {
  const models = [{ id: 'a', contextWindow: 1000 }, { id: 'b' }];
  assert.equal(contextWindowFor(models, ' a '), 1000);
  assert.equal(contextWindowFor(models, 'b'), undefined);
  assert.equal(contextWindowFor(models, 'zzz'), undefined);
  assert.equal(contextWindowFor(undefined, 'a'), undefined);
  assert.equal(contextWindowFor(models, ''), undefined);
});
