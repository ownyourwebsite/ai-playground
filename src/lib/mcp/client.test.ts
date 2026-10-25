import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, clearMcpSession, initializeMcp, listMcpTools } from './client';

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

type Sent = { method: string; params: { cursor?: string; protocolVersion?: string; _meta: { protocolVersion?: string } }; headers: Record<string, string> };

// Stubs the /api/mcp proxy; `handler` gets each wrapped JSON-RPC request.
async function withProxy(handler: (sent: Sent) => Response | { result: unknown }, run: (sent: Sent[]) => Promise<void>) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = async (_input, init) => {
    const wrapped = JSON.parse(String(init?.body));
    const s: Sent = { method: wrapped.body.method, params: wrapped.body.params, headers: wrapped.headers };
    sent.push(s);
    const out = handler(s);
    return out instanceof Response ? out : Response.json(out);
  };
  try { await run(sent); } finally { globalThis.fetch = original; }
}

test('requests after initialize use the negotiated protocolVersion', async () => {
  const url = 'https://negotiate.example/mcp';
  clearMcpSession(url);
  await withProxy(
    ({ method }) => ({ result: method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] } }),
    async (sent) => {
      try {
        await initializeMcp(url, {});
        await listMcpTools(url, {});
        const init = sent.find(s => s.method === 'initialize')!;
        assert.equal(init.headers['mcp-protocol-version'], '2025-11-25');
        assert.equal(init.params.protocolVersion, '2025-11-25');
        for (const name of ['notifications/initialized', 'tools/list']) {
          const req = sent.find(s => s.method === name)!;
          assert.equal(req.headers['mcp-protocol-version'], '2025-06-18', name);
        }
        assert.equal(sent.find(s => s.method === 'tools/list')!.params._meta.protocolVersion, '2025-06-18');
        await callMcpTool(url, {}, 'x', {});
        const call = sent.find(s => s.method === 'tools/call')!;
        assert.equal(call.headers['mcp-protocol-version'], '2025-06-18');
        assert.equal(call.params._meta.protocolVersion, '2025-06-18');
      } finally { clearMcpSession(url); }
    }
  );
});

test('a malformed negotiated protocolVersion falls back to the offered one', async () => {
  const url = 'https://negotiate-bad.example/mcp';
  clearMcpSession(url);
  await withProxy(
    ({ method }) => ({ result: method === 'initialize' ? { protocolVersion: 'bogus' } : { tools: [] } }),
    async (sent) => {
      try {
        await listMcpTools(url, {});
        assert.equal(sent.find(s => s.method === 'tools/list')!.headers['mcp-protocol-version'], '2025-11-25');
      } finally { clearMcpSession(url); }
    }
  );
});

test('tools/list follows nextCursor, dedupes by name and caps pages', async () => {
  const url = 'https://pages.example/mcp';
  clearMcpSession(url);
  const pages: Record<string, unknown> = {
    undefined: { tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'c1' },
    c1: { tools: [{ name: 'b', description: 'dup' }, { name: 'c' }], nextCursor: 'c2' },
    c2: { tools: [{ name: 'd' }] },
  };
  await withProxy(
    ({ method, params }) => ({ result: method === 'tools/list' ? pages[String(params.cursor)] : {} }),
    async (sent) => {
      try {
        const tools = await listMcpTools(url, {});
        assert.deepEqual(tools.map(t => t.name), ['a', 'b', 'c', 'd']);
        assert.equal(tools.find(t => t.name === 'b')!.description, undefined);
        const lists = sent.filter(s => s.method === 'tools/list');
        assert.deepEqual(lists.map(s => s.params.cursor), [undefined, 'c1', 'c2']);
      } finally { clearMcpSession(url); }
    }
  );

  const endless = 'https://endless.example/mcp';
  clearMcpSession(endless);
  let n = 0;
  await withProxy(
    ({ method }) => ({ result: method === 'tools/list' ? { tools: [{ name: `t${n}` }], nextCursor: `c${++n}` } : {} }),
    async (sent) => {
      try {
        const tools = await listMcpTools(endless, {});
        assert.equal(sent.filter(s => s.method === 'tools/list').length, 20);
        assert.equal(tools.length, 20);
      } finally { clearMcpSession(endless); }
    }
  );
});

test('tools/list stops when the server repeats the cursor', async () => {
  const url = 'https://loop.example/mcp';
  clearMcpSession(url);
  await withProxy(
    ({ method }) => ({ result: method === 'tools/list' ? { tools: [{ name: 'a' }], nextCursor: 'same' } : {} }),
    async (sent) => {
      try {
        await listMcpTools(url, {});
        assert.equal(sent.filter(s => s.method === 'tools/list').length, 2);
      } finally { clearMcpSession(url); }
    }
  );
});

test('initialize rejected as unknown method falls back to the stateless transport', async () => {
  const url = 'https://stateless.example/mcp';
  clearMcpSession(url);
  await withProxy(
    ({ method }) => method === 'initialize'
      ? Response.json({ error: { code: -32601, message: 'Method not found' } })
      : { result: { tools: [{ name: 'a' }] } },
    async (sent) => {
      try {
        const tools = await listMcpTools(url, {});
        assert.deepEqual(tools.map(t => t.name), ['a']);
        const list = sent.filter(s => s.method === 'tools/list').at(-1)!;
        assert.equal(list.headers['mcp-protocol-version'], '2026-07-28');
      } finally { clearMcpSession(url); }
    }
  );
});

test('unrelated initialize failures do not trigger the stateless fallback', async () => {
  for (const [status, message] of [[400, 'invalid session'], [401, 'Unauthorized'], [406, 'Not Acceptable'], [500, 'boom']] as const) {
    const url = `https://nofallback-${status}.example/mcp`;
    clearMcpSession(url);
    await withProxy(
      () => Response.json({ error: message }, { status }),
      async (sent) => {
        try {
          await assert.rejects(initializeMcp(url, {}), new RegExp(`Proxy error ${status}`));
          await assert.rejects(listMcpTools(url, {}));
          assert.ok(sent.every(s => s.method === 'initialize'), `${status}: only initialize was sent`);
        } finally { clearMcpSession(url); }
      }
    );
  }
});

test('a failing request after a successful initialize is not retried statelessly', async () => {
  const url = 'https://after-init.example/mcp';
  clearMcpSession(url);
  await withProxy(
    ({ method }) => method === 'tools/list'
      ? Response.json({ error: 'Not Found' }, { status: 404 })
      : { result: {} },
    async (sent) => {
      try {
        await assert.rejects(listMcpTools(url, {}), /404/);
        assert.equal(sent.filter(s => s.method === 'tools/list').length, 1);
      } finally { clearMcpSession(url); }
    }
  );
});
