import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, clearMcpSession } from './client';

test('tools/call transport error never replays a remote write', async () => {
  const original = globalThis.fetch;
  const url = 'https://stub.example/mcp';
  clearMcpSession(url);
  let writes = 0;
  globalThis.fetch = async (_input, init) => {
    const method = JSON.parse(String(init?.body)).body.method;
    if (method === 'tools/call') { writes++; return Response.json({ error: 'invalid session' }, { status: 400 }); }
    return Response.json({ result: {} });
  };
  try {
    await assert.rejects(callMcpTool(url, {}, 'write', {}));
    assert.equal(writes, 1);
  } finally { globalThis.fetch = original; clearMcpSession(url); }
});
test('MCP call forwards cancellation and rejects missing result as unknown', async () => {
  const original = globalThis.fetch;
  const url = 'https://stub2.example/mcp';
  clearMcpSession(url);
  const controller = new AbortController();
  let seen!: AbortSignal;
  globalThis.fetch = async (_input, init) => {
    const method = JSON.parse(String(init?.body)).body.method;
    if (method === 'tools/call') { seen = init!.signal!; controller.abort(); return new Response(''); }
    return Response.json({ result: {} });
  };
  try {
    await assert.rejects(callMcpTool(url, {}, 'write', {}, controller.signal));
    assert.equal(seen.aborted, true);
  } finally { globalThis.fetch = original; clearMcpSession(url); }
});
