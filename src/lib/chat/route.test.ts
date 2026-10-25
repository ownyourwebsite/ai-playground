import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { POST } from '../../app/api/chat/route';

test('installed ai6 route forwards safe real usage, disables hidden retries and classifies rate limit without leaking upstream', async () => {
  const old = { ...process.env };
  for (const name of ['RATE_LIMIT_REQUIRED', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
  process.env.ALLOW_PRIVATE_NETWORK = '1'; // loopback fixture server
  let calls = 0;
  let fail = false;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    if (fail) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: { message: 'secret-key=fixture-sensitive', type: 'rate_limit_error' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    const events = [
      { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture answer' }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } },
    ];
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const request = () => new Request('http://localhost/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-custom-key': 'fixture-key', 'x-custom-base-url': `http://127.0.0.1:${address.port}/v1` }, body: JSON.stringify({ provider: 'custom', model: 'fixture', systemPrompt: '', messages: [{ role: 'user', content: 'Fixture' }], enabledTools: [] }) });
  try {
    const response = await POST(request());
    const text = await response.text();
    const events = text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    const finish = events.find(e => e.type === 'finish');
    assert.equal(finish.messageMetadata.usage.totalTokens, 28);
    assert.equal(finish.messageMetadata.usage.inputTokenDetails.cacheReadTokens, 4);
    assert.equal(finish.messageMetadata.usage.outputTokenDetails.reasoningTokens, 2);
    assert.equal(calls, 1);
    fail = true;
    const failed = await (await POST(request())).text();
    assert.ok(failed.includes('provider-rate-limit'));
    assert.ok(!failed.includes('fixture-sensitive'));
    assert.equal(calls, 2, 'maxRetries=0: one provider call per browser attempt');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
  }
});
