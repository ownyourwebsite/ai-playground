import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from './route';

function setup(t: TestContext) {
  const saved = { ...process.env };
  for (const name of ['RATE_LIMIT_REQUIRED', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
}

const call = (query: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost/api/models${query}`, { headers }));

async function expectError(res: Response, status: number, error: string) {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error });
}

test('models route: success returns normalised models, no-store, forwards key only as header', async (t) => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: [{ id: 'llama-3.3-70b', active: true, context_window: 131072 }, { id: 'whisper-large-v3' }] }));
  const res = await call('?provider=groq', { 'x-groq-key': 'gsk-secret' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { models: [{ id: 'llama-3.3-70b', contextWindow: 131072 }] });
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.ok(!url.includes('gsk-secret'));
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer gsk-secret');
});

test('models route: missing credentials and bad provider', async (t) => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('no network'));
  await expectError(await call('?provider=openai'), 400, 'missing-credentials');
  await expectError(await call('?provider=anthropic', { 'x-openai-key': 'wrong-header' }), 400, 'missing-credentials');
  await expectError(await call('?provider=custom', { 'x-custom-key': 'k' }), 400, 'missing-credentials');
  await expectError(await call('?provider=ollama'), 400, 'missing-credentials');
  await expectError(await call('?provider=nope', { 'x-openai-key': 'k' }), 400, 'bad-provider');
  await expectError(await call(''), 400, 'bad-provider');
  assert.equal(fetch.mock.callCount(), 0);
});

test('models route: upstream 401 is auth, 500 and network failure are upstream, bodies are not echoed', async (t) => {
  setup(t);
  const respond = { current: (): Response | never => new Response('leak', { status: 401 }) };
  t.mock.method(globalThis, 'fetch', async () => respond.current());
  await expectError(await call('?provider=openai', { 'x-openai-key': 'k' }), 401, 'auth');
  respond.current = () => new Response('leak sk-secret', { status: 500 });
  await expectError(await call('?provider=openai', { 'x-openai-key': 'k' }), 502, 'upstream');
  respond.current = () => { throw new DOMException('timed out', 'TimeoutError'); };
  await expectError(await call('?provider=anthropic', { 'x-anthropic-key': 'k' }), 502, 'upstream');
});

test('models route: private user-supplied URLs are blocked by the SSRF guard without fetching', async (t) => {
  setup(t);
  if (process.env.ALLOW_PRIVATE_MCP === '1') return t.skip('private targets allowed in this environment');
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('no plain fetch'));
  await expectError(await call('?provider=ollama', { 'x-ollama-url': 'http://127.0.0.1:11434' }), 400, 'blocked-url');
  await expectError(await call('?provider=custom', { 'x-custom-base-url': 'https://10.0.0.5/v1' }), 400, 'blocked-url');
  await expectError(await call('?provider=custom', { 'x-custom-base-url': 'https://localhost/v1' }), 400, 'blocked-url');
  assert.equal(fetch.mock.callCount(), 0);
});

test('models route: rate limit applies first', async (t) => {
  setup(t);
  process.env.RATE_LIMIT_REQUIRED = '1';
  t.mock.method(console, 'warn', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('no network'));
  const res = await call('?provider=openai', { 'x-openai-key': 'k' });
  assert.equal(res.status, 503);
  assert.equal(fetch.mock.callCount(), 0);
});
