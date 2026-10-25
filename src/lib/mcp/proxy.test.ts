import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleMcpProxy, parseSseEvents, readJsonBodyLimited, findRpcResponse,
  MAX_REQUEST_BYTES, UPSTREAM_TIMEOUT_MS, TOOL_CALL_TIMEOUT_MS,
  type ProxyDeps,
} from './proxy';
import { POST } from '../../app/api/mcp/route';

type Upstream = { status?: number; headers?: Record<string, string>; bodyText?: string; truncated?: boolean };
type Seen = { url: string; opts: Parameters<ProxyDeps['fetchUpstream']>[1] };

function run(rpc: unknown, upstream: Upstream | Error, extra: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  const deps: ProxyDeps = {
    assertUrlIsPublic: async (u) => new URL(u),
    fetchUpstream: async (url, opts) => {
      seen.push({ url, opts });
      if (upstream instanceof Error) throw upstream;
      return { status: 200, headers: {}, bodyText: '', truncated: false, ...upstream };
    },
  };
  const req = new Request('http://localhost/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://mcp.example/mcp', headers: {}, body: rpc, ...extra }),
  });
  return { seen, response: handleMcpProxy(req, deps) };
}

const sse = (...msgs: unknown[]) => msgs.map(m => `data: ${JSON.stringify(m)}\n\n`).join('');

test('parseSseEvents joins multi-line data and strips one leading space', () => {
  assert.deepEqual(parseSseEvents('data: {"a":\ndata:  1}\n\n'), ['{"a":\n 1}']);
  assert.deepEqual(parseSseEvents('data:x\n\ndata\n\n'), ['x', '']);
});

test('parseSseEvents handles CRLF, LF and CR terminators', () => {
  assert.deepEqual(parseSseEvents('data: a\r\n\r\ndata: b\r\n\r\n'), ['a', 'b']);
  assert.deepEqual(parseSseEvents('data: a\rdata: b\r\rdata: c\r\r'), ['a\nb', 'c']);
  assert.deepEqual(parseSseEvents('data: a\n\ndata: b\n\n'), ['a', 'b']);
});

test('parseSseEvents ignores comments and other fields', () => {
  const text = ': keepalive\nevent: message\nid: 7\nretry: 100\ndata: x\n: mid\n\n: only comment\n\n';
  assert.deepEqual(parseSseEvents(text), ['x']);
});

test('parseSseEvents keeps a final event without a trailing blank line', () => {
  assert.deepEqual(parseSseEvents('data: a\n\ndata: b'), ['a', 'b']);
});

test('findRpcResponse matches id strictly and skips requests/notifications', () => {
  const msgs = [
    { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
    { jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' },
    { jsonrpc: '2.0', id: '1', result: { n: 'string' } },
    { jsonrpc: '2.0', id: 1, result: { n: 'number' } },
  ];
  assert.deepEqual(findRpcResponse(msgs, 1), msgs[3]);
  assert.deepEqual(findRpcResponse(msgs, '1'), msgs[2]);
  assert.equal(findRpcResponse(msgs, 2), undefined);
});

test('proxy picks the matching response from an SSE stream', async () => {
  const { response } = run(
    { jsonrpc: '2.0', id: 'req-1', method: 'tools/call', params: {} },
    {
      bodyText: ': hi\r\n\r\n' + sse(
        { jsonrpc: '2.0', method: 'notifications/message', params: {} },
        { jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' },
        { jsonrpc: '2.0', id: 'other', result: { wrong: true } },
      ) + 'data: {"jsonrpc":"2.0","id":"req-1",\r\ndata: "result":{"ok":true}}\r\n\r\n',
    },
  );
  const res = await response;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 'req-1', result: { ok: true } });
});

test('proxy treats numeric and string ids as different', async () => {
  const stream = sse({ jsonrpc: '2.0', id: '1', result: { from: 'string' } }, { jsonrpc: '2.0', id: 1, result: { from: 'number' } });
  const num = await run({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bodyText: stream }).response;
  assert.equal((await num.json()).result.from, 'number');
  const str = await run({ jsonrpc: '2.0', id: '1', method: 'tools/list' }, { bodyText: stream }).response;
  assert.equal((await str.json()).result.from, 'string');
});

test('proxy returns 502 when no SSE response matches the request id', async () => {
  const res = await run(
    { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    { bodyText: sse({ jsonrpc: '2.0', id: 6, result: {} }, { jsonrpc: '2.0', method: 'notifications/x' }) },
  ).response;
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no response matching/);
});

test('proxy still passes plain JSON and upstream JSON-RPC errors through', async () => {
  const ok = await run({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bodyText: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' }).response;
  assert.deepEqual((await ok.json()).result, { tools: [] });
  const err = await run(
    { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    { status: 400, bodyText: '{"error":{"code":-32602,"message":"bad"}}' },
  ).response;
  assert.equal(err.status, 400);
  assert.equal((await err.json()).error.message, 'bad');
});

test('proxy keeps non-2xx non-JSON bodies as raw', async () => {
  const res = await run({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { status: 500, bodyText: '<html>oops</html>' }).response;
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { raw: '<html>oops</html>' });
});

test('notifications get a body-less 202 and never wait for a response', async () => {
  for (const upstream of [{ status: 202 }, { status: 200, bodyText: sse({ jsonrpc: '2.0', id: 1, result: {} }) }, { status: 200, bodyText: '{}' }]) {
    const res = await run({ jsonrpc: '2.0', method: 'notifications/initialized' }, upstream).response;
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  }
});

test('202, 204, 205 and empty bodies are body-less and keep mcp-session-id', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  for (const [status, bodyText] of [[202, ''], [202, 'Accepted'], [204, ''], [205, ''], [200, ''], [200, '  \n']] as const) {
    const res = await run(rpc, { status, bodyText, headers: { 'mcp-session-id': 'sess-1' } }).response;
    assert.equal(res.status, status, `${status}`);
    assert.equal(res.body, null);
    assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
  }
  const injected = await run(rpc, { status: 204, headers: { 'mcp-session-id': 'a\r\nb' } }).response;
  assert.equal(injected.headers.get('mcp-session-id'), null);
});

test('session id is forwarded on JSON responses too', async () => {
  const res = await run({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { bodyText: '{"result":{}}', headers: { 'mcp-session-id': 's2' } }).response;
  assert.equal(res.headers.get('mcp-session-id'), 's2');
});

test('tools/call gets 60s, other methods 15s', async () => {
  const call = run({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, { bodyText: '{}' });
  await call.response;
  assert.equal(call.seen[0].opts?.timeoutMs, TOOL_CALL_TIMEOUT_MS);
  assert.equal(TOOL_CALL_TIMEOUT_MS, 60000);
  for (const method of ['initialize', 'tools/list', 'server/discover']) {
    const r = run({ jsonrpc: '2.0', id: 1, method }, { bodyText: '{}' });
    await r.response;
    assert.equal(r.seen[0].opts?.timeoutMs, UPSTREAM_TIMEOUT_MS);
  }
});

test('timeout error reports the per-method timeout', async () => {
  const res = await run({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, new Error('Gateway timeout')).response;
  assert.equal(res.status, 504);
  assert.match((await res.json()).error, /60000ms/);
});

test('oversized request bodies are rejected with 413 by Content-Length', async () => {
  const body = JSON.stringify({ url: 'https://mcp.example/mcp', body: 'x'.repeat(MAX_REQUEST_BYTES) });
  const result = await readJsonBodyLimited(new Request('http://localhost/', {
    method: 'POST', body, headers: { 'content-length': String(body.length) },
  }));
  assert.deepEqual(result, { ok: false, status: 413, error: 'Request body too large' });
});

test('oversized streamed bodies are rejected with 413 and reading stops early', async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const req = new Request('http://localhost/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  const deps: ProxyDeps = { assertUrlIsPublic: async (u) => new URL(u), fetchUpstream: async () => assert.fail('must not reach upstream') };
  const res = await handleMcpProxy(req, deps);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'Request body too large');
  assert.equal(cancelled, true);
  assert.ok(pulled < 20, `pulled ${pulled} chunks`);
});

test('bodies at the limit and invalid JSON are handled', async () => {
  const edge = '"' + 'a'.repeat(MAX_REQUEST_BYTES - 2) + '"';
  assert.equal(edge.length, MAX_REQUEST_BYTES);
  assert.deepEqual(await readJsonBodyLimited(new Request('http://localhost/', { method: 'POST', body: edge })), { ok: true, value: 'a'.repeat(MAX_REQUEST_BYTES - 2) });
  const bad = await readJsonBodyLimited(new Request('http://localhost/', { method: 'POST', body: '{nope' }));
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.status, 400);
});

test('POST route enforces the body limit and delegates to the proxy', async () => {
  const old = { ...process.env };
  for (const name of ['RATE_LIMIT_REQUIRED', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
  try {
    const body = JSON.stringify({ url: 'https://mcp.example/mcp', body: 'x'.repeat(MAX_REQUEST_BYTES) });
    const big = await POST(new Request('http://localhost/api/mcp', { method: 'POST', body, headers: { 'content-length': String(body.length) } }) as never);
    assert.equal(big.status, 413);
    const missing = await POST(new Request('http://localhost/api/mcp', { method: 'POST', body: '{}' }) as never);
    assert.equal(missing.status, 400);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
  }
});
