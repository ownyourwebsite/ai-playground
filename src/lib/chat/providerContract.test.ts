// Provider wire contracts: each test drives the real POST handler and asserts the
// exact upstream request (URL, auth, JSON body) plus what reaches the UI stream.
// All upstreams are fixtures: a replaced globalThis.fetch (openai, anthropic, groq)
// or a loopback server (custom, ollama). No real network, no real keys.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { POST } from '../../app/api/chat/route';
import { DEFAULT_MODELS } from '../providers';
import type { Provider } from '../types';

const PROVIDERS: Provider[] = ['openai', 'anthropic', 'groq', 'ollama', 'custom'];
const FIXTURE_KEY = 'fixture-secret-key';
const KEY_HEADER: Partial<Record<Provider, string>> = {
  openai: 'x-openai-key', anthropic: 'x-anthropic-key', groq: 'x-groq-key', custom: 'x-custom-key',
};
const UPSTREAM_URL: Partial<Record<Provider, string>> = {
  openai: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Upstream = { url: string; headers: Record<string, string>; auth?: string; body: Json };

function setup(t: TestContext, privateNetwork: boolean) {
  const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RATE_LIMIT_REQUIRED', 'RATE_LIMIT_FAIL_OPEN',
    'RATE_LIMIT_CHAT_PER_MINUTE', 'RATE_LIMIT_IP_HEADER', 'VERCEL', 'ALLOW_PRIVATE_NETWORK', 'ALLOW_PRIVATE_MCP'];
  const old = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  if (privateNetwork) process.env.ALLOW_PRIVATE_NETWORK = '1';
  t.after(() => { for (const [key, value] of old) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  t.mock.method(console, 'warn', () => {});
}

/** Records one upstream request; secrets are split out of the header map. */
function record(url: string, rawHeaders: Record<string, string>, rawBody: string): Upstream {
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const auth = headers.authorization ?? headers['x-api-key'];
  delete headers.authorization;
  delete headers['x-api-key'];
  return { url, headers, auth, body: JSON.parse(rawBody) };
}

/* ---- Minimal valid streaming payloads in each wire format ---- */

const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');

function openaiReply({ summary }: { summary?: string } = {}): string {
  const events: unknown[] = [{ type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'fixture' } }];
  if (summary) events.push(
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: null } },
    { type: 'response.reasoning_summary_part.added', item_id: 'rs_fixture', summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', summary_index: 0, delta: summary },
    { type: 'response.reasoning_summary_part.done', item_id: 'rs_fixture', summary_index: 0 },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: null,
      summary: [{ type: 'summary_text', text: summary }] } },
  );
  const index = summary ? 1 : 0;
  events.push(
    { type: 'response.output_item.added', output_index: index, item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: index, content_index: 0, delta: 'Fixture answer' },
    { type: 'response.output_item.done', output_index: index, item: { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Fixture answer', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_fixture', created_at: 1, model: 'fixture', status: 'completed', output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
  );
  return sse(events);
}

function anthropicReply({ thinking }: { thinking?: string } = {}): string {
  const events: unknown[] = [{ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  let index = 0;
  if (thinking) {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } },
      { type: 'content_block_stop', index },
    );
    index++;
  }
  events.push(
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Fixture answer' } },
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  );
  return events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function chatReply({ reasoning }: { reasoning?: string } = {}): string {
  const chunk = { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
  const events: unknown[] = [];
  if (reasoning) events.push({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', reasoning }, finish_reason: null }] });
  events.push(
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture answer' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
  );
  return sse(events) + 'data: [DONE]\n\n';
}

const DEFAULT_REPLY: Record<Provider, () => string> = {
  openai: openaiReply, anthropic: anthropicReply, groq: chatReply, ollama: chatReply, custom: chatReply,
};

/* ---- Harness ---- */

type Sent = { status: number; raw: string; events: Json[] };

/** Installs the fixture upstream for `provider`; `send` posts to the real handler. */
async function harness(t: TestContext, provider: Provider, reply?: string) {
  const local = provider === 'ollama' || provider === 'custom';
  setup(t, local);
  const calls: Upstream[] = [];
  const payload = reply ?? DEFAULT_REPLY[provider]();
  const headers: Record<string, string> = {};
  let base = '';
  if (local) {
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const flat = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      calls.push(record(req.url!, flat, raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(payload);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (provider === 'custom') {
      headers['x-custom-base-url'] = `${base}/v1`;
      headers['x-custom-key'] = FIXTURE_KEY;
    }
  } else {
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), UPSTREAM_URL[provider], 'unexpected upstream URL');
      calls.push(record(String(url), init?.headers as Record<string, string>, String(init?.body)));
      return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    headers[KEY_HEADER[provider]!] = FIXTURE_KEY;
  }
  const send = async (body: Json = {}): Promise<Sent> => {
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ provider, model: '', systemPrompt: '', enabledTools: [],
        messages: [{ role: 'user', content: 'Fixture question' }],
        ...(provider === 'ollama' ? { ollamaUrl: `${base}/api` } : {}), ...body }),
    }));
    const raw = await response.text();
    const events = raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    return { status: response.status, raw, events };
  };
  return { calls, send, base };
}

const textOf = (sent: Sent) => sent.events.filter(e => e.type === 'text-delta').map(e => e.delta).join('');
const reasoningOf = (sent: Sent) => sent.events.filter(e => e.type === 'reasoning-delta').map(e => e.delta).join('');
function assertCleanStream(sent: Sent) {
  assert.equal(sent.status, 200);
  assert.ok(!sent.events.some(e => e.type === 'error'), sent.raw);
  assert.equal(textOf(sent), 'Fixture answer');
}
function assertReasoningParts(sent: Sent, expected: string) {
  assertCleanStream(sent);
  const types = sent.events.map(e => e.type);
  assert.ok(types.includes('reasoning-start'), 'reasoning-start missing');
  assert.ok(types.includes('reasoning-end'), 'reasoning-end missing');
  assert.equal(reasoningOf(sent), expected);
  assert.ok(types.indexOf('reasoning-start') < types.indexOf('text-delta'), 'reasoning precedes the answer');
  assert.ok(!textOf(sent).includes(expected), 'reasoning never leaks into visible text');
}

/* ---- OpenAI (Responses API) ---- */

test('openai: default model goes to /v1/responses with store:false and medium reasoning summary', async (t) => {
  const { calls, send } = await harness(t, 'openai');
  assertCleanStream(await send());
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.auth, `Bearer ${FIXTURE_KEY}`);
  assert.equal(call.body.model, DEFAULT_MODELS.openai);
  assert.equal(call.body.model, 'gpt-5.6-luna');
  assert.equal(call.body.store, false);
  assert.deepEqual(call.body.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(call.body.stream, true);
  assert.equal(call.body.previous_response_id, undefined);
  assert.ok(!JSON.stringify(call.headers).includes(FIXTURE_KEY));
});

test('openai: non-reasoning gpt-4o gets no reasoning field but store stays false', async (t) => {
  const { calls, send } = await harness(t, 'openai');
  assertCleanStream(await send({ model: 'gpt-4o' }));
  assert.equal(calls[0].body.model, 'gpt-4o');
  assert.equal(calls[0].body.store, false);
  assert.ok(!('reasoning' in calls[0].body), JSON.stringify(calls[0].body.reasoning));
});

test('openai: streamed reasoning summary reaches the UI stream as reasoning parts', async (t) => {
  const { send } = await harness(t, 'openai', openaiReply({ summary: 'Weighing the options' }));
  assertReasoningParts(await send(), 'Weighing the options');
});

/* ---- Anthropic (Messages API) ---- */

test('anthropic: default model goes to /v1/messages with adaptive summarized thinking and medium effort', async (t) => {
  const { calls, send } = await harness(t, 'anthropic');
  assertCleanStream(await send());
  const [call] = calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.auth, FIXTURE_KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, DEFAULT_MODELS.anthropic);
  assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(call.body.output_config, { effort: 'medium' });
});

test('anthropic: adaptive thinking and effort are sent only for Opus/Sonnet 4.6+ and gen-5 ids', async (t) => {
  const { calls, send } = await harness(t, 'anthropic');
  const supported = ['claude-sonnet-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-5'];
  const legacy = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-3-5-sonnet-latest'];
  for (const model of [...supported, ...legacy]) assertCleanStream(await send({ model }));
  assert.equal(calls.length, supported.length + legacy.length, 'one upstream call per request, no retries');
  for (const call of calls) {
    if (supported.includes(call.body.model)) {
      assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' }, call.body.model);
      assert.deepEqual(call.body.output_config, { effort: 'medium' }, call.body.model);
    } else {
      assert.ok(!('thinking' in call.body), call.body.model);
      assert.ok(!('output_config' in call.body), call.body.model);
    }
  }
});

test('anthropic: a streamed thinking_delta reaches the UI stream as reasoning parts', async (t) => {
  const { send } = await harness(t, 'anthropic', anthropicReply({ thinking: 'Considering the request' }));
  assertReasoningParts(await send({ model: 'claude-sonnet-5' }), 'Considering the request');
});

/* ---- Groq (Chat Completions) ---- */

const groqTool = { name: 'lookup', description: 'Fixture tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };

test('groq: Qwen3 requests parsed reasoning, no reasoning_effort, with and without tools', async (t) => {
  const { calls, send } = await harness(t, 'groq');
  assertCleanStream(await send({ model: 'qwen/qwen3.8-27b' }));
  assertCleanStream(await send({ model: 'qwen/qwen3.8-27b', enabledTools: [groqTool] }));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(call.auth, `Bearer ${FIXTURE_KEY}`);
    assert.equal(call.body.model, 'qwen/qwen3.8-27b');
    assert.equal(call.body.reasoning_format, 'parsed', 'tools must not switch Qwen to raw');
    assert.ok(!('reasoning_effort' in call.body));
  }
  assert.equal(calls[0].body.tools, undefined);
  assert.equal(calls[1].body.tools?.[0]?.function?.name, 'lookup');
});

test('groq: non-Qwen models (gpt-oss) send no reasoning_format or reasoning_effort', async (t) => {
  const { calls, send } = await harness(t, 'groq');
  assertCleanStream(await send({ model: 'openai/gpt-oss-20b' }));
  assertCleanStream(await send({ model: 'openai/gpt-oss-20b', enabledTools: [groqTool] }));
  for (const call of calls) {
    assert.ok(!('reasoning_format' in call.body));
    assert.ok(!('reasoning_effort' in call.body));
  }
});

test('groq: a delta.reasoning chunk reaches the UI stream as reasoning parts', async (t) => {
  const { send } = await harness(t, 'groq', chatReply({ reasoning: 'Thinking it through' }));
  assertReasoningParts(await send({ model: 'qwen/qwen3.8-27b' }), 'Thinking it through');
});

/* ---- Custom and Ollama (Chat Completions) ---- */

test('custom: posts to <base>/chat/completions (never /responses) with the Bearer key and model id', async (t) => {
  const { calls, send } = await harness(t, 'custom');
  assertCleanStream(await send({ model: 'vendor/model-x' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].auth, `Bearer ${FIXTURE_KEY}`);
  assert.equal(calls[0].body.model, 'vendor/model-x');
  assert.equal(calls[0].body.stream, true);
  for (const field of ['store', 'reasoning', 'reasoning_effort', 'reasoning_format', 'previous_response_id', 'input']) {
    assert.ok(!(field in calls[0].body), field);
  }
});

test('custom: the base URL path is kept verbatim and only /chat/completions is appended', async (t) => {
  const { calls, send, base } = await harness(t, 'custom');
  assertCleanStream(await send()); // harness base ends in /v1
  const bare = await POST(new Request('http://localhost/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-custom-key': FIXTURE_KEY, 'x-custom-base-url': `${base}/custom/api` },
    body: JSON.stringify({ provider: 'custom', model: 'm', messages: [{ role: 'user', content: 'Fixture question' }] }) }));
  await bare.text();
  assert.deepEqual(calls.map(c => c.url), ['/v1/chat/completions', '/custom/api/chat/completions']);
});

test('ollama: both host and /api style URLs resolve to <host>/v1/chat/completions with the placeholder key', async (t) => {
  const { calls, send, base } = await harness(t, 'ollama');
  for (const ollamaUrl of [base, `${base}/`, `${base}/api`, `${base}/api/`, `${base}/v1`, `${base}/v1/`]) {
    assertCleanStream(await send({ model: 'llama3.2', ollamaUrl }));
  }
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.auth, 'Bearer ollama');
    assert.equal(call.body.model, 'llama3.2');
    assert.ok(!('reasoning_format' in call.body) && !('reasoning' in call.body));
  }
});

/* ---- Cross-provider contracts ---- */

test('default model is used when the model field is empty (every provider)', async (t) => {
  for (const provider of PROVIDERS) {
    await t.test(provider, async (sub) => {
      const { calls, send } = await harness(sub, provider);
      assertCleanStream(await send({ model: '' }));
      assert.equal(calls[0].body.model, DEFAULT_MODELS[provider]);
    });
  }
});

const toolInvocation = { toolCallId: 'call_fixture', toolName: 'github_get_file_contents', args: { path: 'README.md' }, state: 'result', result: { ok: true } };
const SECRET_THOUGHT = 'SECRET-EARLIER-THOUGHT';
// The extra reasoning-carrying fields mimic what a client could persist; none may reach the provider.
const history = [
  { role: 'user', content: 'Read the file' },
  { role: 'assistant', content: 'Calling the tool', reasoning: SECRET_THOUGHT, parts: [{ type: 'reasoning', text: SECRET_THOUGHT }],
    toolInvocations: [toolInvocation, { toolCallId: 'call_pending', toolName: 'github_get_file_contents', args: {}, state: 'needs-approval' }] },
  { role: 'user', content: 'Continue' },
];

test('history: a resolved tool call and result use each provider tool shape, with no reasoning replay', async (t) => {
  for (const provider of PROVIDERS) {
    await t.test(provider, async (sub) => {
      const { calls, send } = await harness(sub, provider);
      assertCleanStream(await send({ messages: history })); // default model per provider
      const { body } = calls[0];
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(SECRET_THOUGHT), 'earlier reasoning must not be replayed');
      assert.ok(!serialized.includes('call_pending'), 'unresolved calls are dropped');
      assert.ok(!serialized.includes('item_reference'));
      assert.equal(body.previous_response_id, undefined);
      if (provider === 'openai') {
        assert.equal(body.store, false);
        assert.deepEqual(body.input.filter((item: Json) => item.type), [
          { type: 'function_call', call_id: 'call_fixture', name: 'github_get_file_contents', arguments: '{"path":"README.md"}' },
          { type: 'function_call_output', call_id: 'call_fixture', output: '{"ok":true}' },
        ]);
        assert.ok(!body.input.some((item: Json) => item.type === 'reasoning'));
      } else if (provider === 'anthropic') {
        const assistant = body.messages.find((m: Json) => m.role === 'assistant');
        assert.deepEqual(assistant.content, [
          { type: 'text', text: 'Calling the tool' },
          { type: 'tool_use', id: 'call_fixture', name: 'github_get_file_contents', input: { path: 'README.md' } },
        ]);
        const result = body.messages.find((m: Json) => m.content.some((c: Json) => c.type === 'tool_result'));
        assert.deepEqual(result.content[0], { type: 'tool_result', tool_use_id: 'call_fixture', content: '{"ok":true}' });
        assert.ok(!body.messages.some((m: Json) => m.content.some((c: Json) => c.type === 'thinking' || c.type === 'redacted_thinking')));
      } else {
        const assistant = body.messages.find((m: Json) => m.role === 'assistant');
        assert.deepEqual(assistant.tool_calls, [
          { id: 'call_fixture', type: 'function', function: { name: 'github_get_file_contents', arguments: '{"path":"README.md"}' } },
        ]);
        assert.ok(!('reasoning' in assistant) && !('reasoning_content' in assistant));
        const tool = body.messages.find((m: Json) => m.role === 'tool');
        assert.deepEqual(tool, { role: 'tool', tool_call_id: 'call_fixture', content: '{"ok":true}' });
      }
    });
  }
});

test('MCP tool names with provider-safe characters pass through unchanged and keep the README hint', async (t) => {
  const enabledTools = [
    { name: 'github_get_file_contents', originalName: 'get_file_contents', serverId: 'github', description: 'Read a file',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
    { name: 'github_list_issues', originalName: 'list_issues', serverId: 'github', description: 'List issues',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: [] } },
  ];
  for (const provider of PROVIDERS) {
    await t.test(provider, async (sub) => {
      const { calls, send } = await harness(sub, provider);
      assertCleanStream(await send({ enabledTools, githubContext: { owner: 'octo', repo: 'hello' } }));
      const tools = (calls[0].body.tools as Json[]).map(tool => tool.function ?? tool);
      assert.deepEqual(tools.map(tool => tool.name), ['github_get_file_contents', 'github_list_issues']);
      assert.match(tools[0].description, /^Read a file/);
      assert.match(tools[0].description, /owner=octo, repo=hello/);
      assert.match(tools[0].description, /For the repository README, path is README\.md\./);
      assert.match(tools[1].description, /owner=octo, repo=hello/);
      assert.ok(!tools[1].description.includes('README.md'), 'the README hint is only for get_file_contents');
    });
  }
});
