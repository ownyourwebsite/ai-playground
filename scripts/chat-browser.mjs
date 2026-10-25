/** Explicit browser runner; not named .test/.spec, so the Node test runner never imports Playwright. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const base = new URL(process.env.CHAT_BROWSER_BASE_URL || 'http://127.0.0.1:3105');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Browser fixtures require a loopback server.');
const { chromium } = process.env.CHAT_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.CHAT_PLAYWRIGHT_MODULE).href) : await import('playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHAT_CHROMIUM_PATH ? { executablePath: process.env.CHAT_CHROMIUM_PATH } : {}),
  env: { PATH: process.env.PATH, ...(process.env.CHAT_BROWSER_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.CHAT_BROWSER_LIBRARY_PATH } : {}) },
});
const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
const finish = { type: 'finish', finishReason: 'stop', messageMetadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
const tool = { type: 'tool-input-available', toolCallId: 'read-1', toolName: 'get_file_contents', input: { owner: 'fixture', repo: 'fixture', path: 'README.md' } };
const writeTool = { type: 'tool-input-available', toolCallId: 'write-1', toolName: 'push_files', input: { owner: 'fixture', repo: 'fixture', branch: 'fixture', message: 'Fixture write', files: [{ path: 'fixture.txt', content: 'fixture' }] } };
const error = (category = 'provider-rate-limit', retryAt) => ({ type: 'error', errorText: JSON.stringify({ category, retryable: category === 'provider-rate-limit', retryAt }) });
const toolSchema = { name: 'get_file_contents', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } }, required: ['owner', 'repo', 'path'] } };
const writeSchema = { name: 'push_files', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, message: { type: 'string' }, files: { type: 'array' } }, required: ['owner', 'repo', 'branch', 'message', 'files'] } };
let passes = 0;
const providerRequests = [];
// Seeded settings carry the current settingsVersion (src/lib/settingsMigration.ts):
// an unversioned record is re-saved on load, which drops non-remembered keys.
// Real route + installed SDK, but only a local synthetic Chat Completions endpoint
// (custom providers speak /chat/completions). The loopback target passes the SSRF
// guard under `next dev`; against `next start` run the app with ALLOW_PRIVATE_NETWORK=1.
const provider = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  providerRequests.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = e => res.write(`data: ${JSON.stringify({ id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...e })}\n\n`);
  emit({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (let i = 0; i < 12 && !res.destroyed; i++) {
    emit({ choices: [{ index: 0, delta: { content: `Live chunk ${i}\n${'Streaming fixture text\n'.repeat(3)}` }, finish_reason: null }] });
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  if (!res.destroyed) {
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    emit({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } });
    res.end('data: [DONE]\n\n');
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

async function fixture(writeMode = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // The development-only badge overlaps the mobile paperclip. Hide just the badge,
  // retaining runtime-error overlays and pageerror reporting (production has neither badge nor handler match).
  await page.addLocatorHandler(page.locator('nextjs-portal').locator('#devtools-indicator'), async badge => {
    await badge.evaluate(element => element.style.setProperty('display', 'none', 'important'));
  });
  const failures = [];
  const diagnostics = [];
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push(message.text()); });
  const state = { models: [], tools: 0, live: false, reply: async () => [finish], mcp: async () => ({ content: [{ type: 'text', text: 'Saved fixture file' }] }) };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/chat') {
      state.models.push(route.request().postDataJSON());
      if (state.live) return route.continue({ headers: { ...route.request().headers(), 'x-custom-base-url': providerBase } });
      const result = await state.reply(state.models.length);
      await route.fulfill({ contentType: 'text/event-stream', body: sse(result) }).catch(() => {});
      return;
    }
    if (url.pathname === '/api/mcp') {
      const rpc = route.request().postDataJSON().body;
      diagnostics.push(`MCP ${rpc.method}`);
      let result = {};
      if (rpc.method === 'tools/list') result = { tools: writeMode ? [writeSchema] : [toolSchema] };
      if (rpc.method === 'tools/call') { state.tools++; result = await state.mcp(); }
      return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result } }).catch(() => {});
    }
    await route.continue();
  });
  await page.goto(base.href);
  await page.getByPlaceholder('Ask anything...').waitFor();
  await page.evaluate(async writeMode => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('ai-workspace');
      r.onupgradeneeded = () => {
        for (const name of ['sessions', 'prompts', 'skills', 'mcpServers', 'settings']) {
          const store = r.result.createObjectStore(name, { keyPath: 'id' });
          if (name === 'sessions') store.createIndex('updatedAt', 'updatedAt');
        }
        const attachments = r.result.createObjectStore('attachments', { keyPath: 'id' });
        attachments.createIndex('sessionId', 'sessionId');
        attachments.createIndex('sessionRef', ['sessionId', 'id', 'name', 'kind', 'mediaType', 'size']);
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(['settings', 'sessions'], 'readwrite');
    tx.objectStore('settings').put({ id: 'default', settingsVersion: 1, customKey: 'fixture-not-a-real-key', customBaseUrl: 'https://fixture.invalid/v1', customModel: 'fixture', githubPat: 'fixture-not-a-real-pat', githubWriteMode: writeMode, rememberKeys: false, defaultModel: 'custom', systemPrompt: 'Fixture' });
    tx.objectStore('sessions').put({ id: 'history', title: 'Long fixture history', updatedAt: 1, messages: Array.from({ length: 45 }, (_, i) => ({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', content: `History ${i}\n${'Preserved text\n'.repeat(5)}` })) });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, writeMode);
  await page.reload();
  try { await page.getByText('connected (1 tools)', { exact: false }).waitFor(); }
  catch (error) {
    console.error('Fixture setup failed', failures, diagnostics, (await page.locator('body').innerText()).slice(-5000));
    throw error;
  }
  return { page, context, state, failures, diagnostics };
}
async function send(page, text) { const input = page.getByPlaceholder('Ask anything...'); await input.fill(text); await input.press('Enter'); }
async function visibility(page, hidden) {
  await page.evaluate(hidden => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
async function saved(page) {
  return page.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('ai-workspace'); r.onsuccess = () => resolve(r.result); });
    const sessions = await new Promise(resolve => { const r = db.transaction('sessions').objectStore('sessions').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return sessions;
  });
}
async function until(read, predicate = Boolean, label = 'observable fixture condition') {
  const deadline = Date.now() + 15000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}
const waitSaved = (page, predicate) => until(() => saved(page), predicate, 'committed IndexedDB snapshot');
const idle = page => page.getByTitle('Stop generating').waitFor({ state: 'hidden' });
const sessionRow = (page, title) => page.locator('aside').getByText(title, { exact: true }).locator('../..');
async function attachmentRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('ai-workspace'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const records = await new Promise(resolve => { const r = db.transaction('attachments').objectStore('attachments').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return records;
  });
}
const textFile = (name = 'notes.md', text = '# Local file\nПривет 🌍\n<script>not executed</script>') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const attachmentNoticeKey = 'ai-workspace:attachment-notice:v1';
async function imageFile(page, { name = 'pixel.png', width = 240, height = 120 } = {}) {
  const data = await page.evaluate(({ width, height }) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); context.fillStyle = '#557799'; context.fillRect(0, 0, width, height); return canvas.toDataURL('image/png'); }, { width, height });
  return { name, mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64') };
}
async function composerScreenshot(page, name) {
  if (!process.env.CHAT_BROWSER_SCREENSHOT_DIR) return;
  await mkdir(process.env.CHAT_BROWSER_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.CHAT_BROWSER_SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

function recoveryFixture(record = { id: 'backup-file', name: 'restored.txt', kind: 'text', mediaType: 'text/plain', size: 16, data: 'Restored payload' }) {
  const { id, name, kind, mediaType, size } = record;
  const ref = { id, name, kind, mediaType, size };
  return { version: 2, exportedAt: '2026-10-01T00:00:00.000Z', attachments: [record], sessions: [
    { id: 'backup-chat', messages: [
      { id: 'backup-user', role: 'user', content: 'Restored chat fixture', attachments: [ref] },
      { id: 'backup-assistant', role: 'assistant', content: 'Retained partial answer', reasoningOpen: true,
        execution: { sessionId: 'backup-chat', runId: 'backup-run', stepId: 'backup-step', attemptId: 'backup-attempt', status: 'tools', startedAt: 1 },
        toolInvocations: [{ toolCallId: 'backup-tool', toolName: 'get_file_contents', originalName: 'get_file_contents', serverId: 'github', args: {}, state: 'executing' }] },
    ] },
    { id: 'backup-second', messages: [{ id: 'backup-user-2', role: 'user', content: 'Second restored fixture' }] },
  ] };
}
const recoveryFile = (value = recoveryFixture()) => ({ name: 'recovery.json', mimeType: 'application/octet-stream', buffer: Buffer.from(JSON.stringify(value)) });
async function openRestore(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Configuration Settings', exact: true }).getByRole('button', { name: 'Restore backup', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore backup', exact: true });
  await dialog.waitFor();
  return dialog;
}
async function storedSettings(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ai-workspace'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const result = await new Promise((resolve, reject) => { const request = db.transaction('settings').objectStore('settings').get('default'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return result;
  });
}

// Gate acknowledgements of real native IndexedDB requests, not app code or source strings.
// Native transactions still commit; the application sees delayed success or QuotaExceededError.
async function storageControls(page) {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const control = window.chatStorage = { rules: [], pending: [], writes: [], fail: false };
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name !== 'sessions') return put.call(this, value, ...args);
      const snapshot = structuredClone(value);
      control.writes.push(snapshot);
      if (control.fail) throw new DOMException('Fixture storage unavailable', 'QuotaExceededError');
      const last = snapshot.messages.at(-1);
      const rule = control.rules.find(r => !r.used &&
        (!r.status || last?.execution?.status === r.status) &&
        (!r.outcome || last?.toolInvocations?.[0]?.outcome === r.outcome) &&
        (!r.attempts || snapshot.messages.filter(m => m.execution).length === r.attempts));
      const request = put.call(this, value, ...args);
      if (rule) {
        rule.used = true;
        const gate = { name: rule.name, snapshot, ready: false, callbacks: [] };
        control.pending.push(gate);
        const add = request.addEventListener.bind(request);
        request.addEventListener = (type, listener, options) => add(type, type === 'success' ? event => {
          gate.ready = true;
          gate.callbacks.push(() => listener.call(request, event));
        } : listener, options);
      }
      return request;
    };
  });
  return {
    hold: rule => page.evaluate(rule => { window.chatStorage.rules.push(rule); }, rule),
    wait: name => page.waitForFunction(name => window.chatStorage.pending.some(p => p.name === name && p.ready), name),
    release: name => page.evaluate(name => {
      const gate = window.chatStorage.pending.find(p => p.name === name && p.ready);
      if (!gate) throw new Error(`Storage gate not reached: ${name}`);
      gate.callbacks.splice(0).forEach(callback => callback());
    }, name),
    fail: value => page.evaluate(value => { window.chatStorage.fail = value; }, value),
  };
}
async function scenario(name, run, { writeMode = false } = {}) {
  if (process.env.CHAT_BROWSER_FILTER && !new RegExp(process.env.CHAT_BROWSER_FILTER).test(name)) return;
  const f = await fixture(writeMode);
  try { await run(f); assert.deepEqual(f.failures, []); console.log(`PASS ${name}`); passes++; }
  catch (e) { console.error(`FAIL ${name}\n${(await f.page.locator('main').innerText()).slice(-4000)}`); throw e; }
  finally { await f.context.close(); }
}

try {
  console.log(`Browser ${browser.version()} · ${base.origin} · ${process.env.CHAT_BROWSER_MODE || 'unspecified mode'}`);
  await scenario('StrictMode approval/double click → one MCP + one continuation; links and session usage survive reload', async ({ page, state }) => {
    state.reply = async count => count === 1 ? [tool, finish] : [{ type: 'text-delta', delta: '[Hugging Face Course](https://huggingface.co/learn) — done' }, finish];
    await send(page, 'Read fixture repository');
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    assert.equal(await page.getByText('No MCP tool was called.', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Confirm & Run' }).evaluate(button => { button.click(); button.click(); });
    const link = page.getByRole('link', { name: 'Hugging Face Course' });
    await link.waitFor();
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(state.tools, 1); assert.equal(state.models.length, 2);
    assert.equal(state.models[1].messages.at(-1).toolInvocations[0].result.content[0].text, 'Saved fixture file');
    await page.waitForFunction(() => document.body.innerText.includes('Last request: input 10 / output 5 / total 15'));
    let sessions = await waitSaved(page, sessions => sessions.some(s => s.title === 'Read fixture repository' && s.messages.at(-1)?.execution?.status === 'complete'));
    const session = sessions.find(s => s.title === 'Read fixture repository');
    assert.equal(session.messages.filter(m => m.execution).reduce((s, m) => s + (m.execution.usage?.totalTokens || 0), 0), 30);
    await page.reload();
    await page.getByText('Read fixture repository', { exact: true }).first().click();
    await link.waitFor();
    sessions = await saved(page);
    assert.equal(state.tools, 1); assert.equal(state.models.length, 2);
    assert.equal(sessions.find(s => s.id === session.id).messages.length, session.messages.length);
  });
  await scenario('decline is explicit and continues once without MCP', async ({ page, state }) => {
    state.reply = async count => count === 1 ? [tool, finish] : [{ type: 'text-delta', delta: 'Decline acknowledged' }, finish];
    await send(page, 'Decline fixture');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByText('Decline acknowledged', { exact: true }).waitFor();
    assert.equal(state.tools, 0); assert.equal(state.models.length, 2);
    assert.equal(state.models[1].messages.at(-1).toolInvocations[0].outcome, 'declined');
  });
  await scenario('model error preserves MCP checkpoint; manual retry repeats model only', async ({ page, state }) => {
    state.reply = async count => count === 1 ? [tool, finish] : count === 2 ? [error('quota')] : [{ type: 'text-delta', delta: 'Recovered checkpoint' }, finish];
    await send(page, 'Checkpoint fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await page.locator('main').getByRole('alert').waitFor();
    await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
    await page.getByText('Recovered checkpoint', { exact: true }).waitFor();
    assert.equal(state.tools, 1); assert.equal(state.models.length, 3);
    assert.deepEqual(state.models[2].messages, state.models[1].messages);
    await page.getByRole('button', { name: 'Start turn again', exact: true }).click();
    await page.getByText('Start This Turn Again?', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await until(() => state.models.length, count => count === 4, 'restart model request');
    await idle(page);
    assert.equal(state.models.length, 4);
    assert.equal(state.tools, 1);
  });
  await scenario('short provider limit is observable then recovers; long wait never auto resumes; Stop cancels timer', async ({ page, state }) => {
    state.reply = async count => count === 1 ? [error()] : [{ type: 'text-delta', delta: 'After short wait' }, finish];
    await send(page, 'Retry fixture');
    await page.getByText(/Retry 1\/2 in/).waitFor();
    await page.getByText('After short wait', { exact: true }).waitFor();
    await idle(page);
    assert.equal(state.models.length, 2);
    state.reply = async () => [error('provider-rate-limit', Date.now() + 60000)];
    await send(page, 'Long wait fixture');
    await page.locator('main').getByRole('alert').waitFor();
    await idle(page);
    const calls = state.models.length;
    await page.waitForTimeout(1800);
    assert.equal(state.models.length, calls);
    state.reply = async () => [error()];
    await send(page, 'Stop timer fixture');
    await page.getByText(/Retry 1\/2 in/).waitFor();
    await page.getByTitle('Stop generating').click();
    const stopped = state.models.length;
    await page.waitForTimeout(1300);
    assert.equal(state.models.length, stopped);
  });
  await scenario('partial text and terminal error remain; late model response is isolated across session switch', async ({ page, state }) => {
    state.reply = async () => [{ type: 'text-delta', delta: 'Preserved partial response' }, error('quota'), finish];
    await send(page, 'Partial fixture');
    await page.locator('main').getByRole('alert').waitFor();
    await page.getByText('Preserved partial response', { exact: true }).waitFor();
    let release;
    state.reply = async () => new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
    await page.getByText('Waiting for model…', { exact: true }).waitFor();
    await until(() => release, Boolean, 'pending model fixture entered');
    await page.getByText('Long fixture history', { exact: true }).click();
    release([{ type: 'text-delta', delta: 'LATE MUST NOT APPEAR' }, finish]);
    await page.waitForTimeout(400);
    assert.equal(await page.getByText('LATE MUST NOT APPEAR', { exact: true }).count(), 0);
    await page.getByText('Partial fixture', { exact: true }).click();
    await page.getByText('Preserved partial response', { exact: true }).waitFor();
  });
  await scenario('Stop during MCP preserves unknown outcome and prevents late continuation and blind tool retry', async ({ page, state }) => {
    state.reply = async () => [tool, finish];
    let release;
    state.mcp = async () => new Promise(resolve => { release = resolve; });
    await send(page, 'Stop MCP fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await page.getByText('Executing...', { exact: true }).waitFor();
    await until(() => release, Boolean, 'pending MCP fixture entered');
    await page.getByTitle('Stop generating').click();
    await page.getByText('Outcome unknown — verify remotely', { exact: true }).waitFor();
    release({ content: [{ type: 'text', text: 'late tool result' }] });
    await page.waitForTimeout(400);
    assert.equal(state.tools, 1); assert.equal(state.models.length, 1);
    await page.reload();
    await page.getByText('Stop MCP fixture', { exact: true }).first().click();
    await page.getByText('Outcome unknown — verify remotely', { exact: true }).waitFor();
    assert.equal(state.models.length, 1);
  });
  await scenario('scroll history stays put during response, reasoning and approvals; keyboard/touch/latest/reduced motion', async ({ page, state }) => {
    await page.getByText('Long fixture history', { exact: true }).click();
    const history = page.getByLabel('Chat history');
    await history.focus();
    await history.press('Home');
    await page.waitForTimeout(100);
    let release;
    state.reply = async () => new Promise(resolve => { release = resolve; });
    await send(page, 'Scroll fixture');
    await until(() => release, Boolean, 'scroll model fixture entered');
    const before = await history.evaluate(node => node.scrollTop);
    release([{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'Reasoning fixture' }, { type: 'reasoning-end', id: 'r' }, tool, finish]);
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    assert.equal(await history.evaluate(node => node.scrollTop), before);
    await history.dispatchEvent('touchstart');
    await page.getByRole('button', { name: /Latest messages/ }).click();
    assert.ok(await history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 48));
    await history.focus(); await history.press('PageUp');
    await page.getByRole('button', { name: /Latest messages/ }).waitFor();
  });
  await scenario('actual SDK streaming follows bottom only; scrolling up stops token follow; provider usage is persisted', async ({ page, state }) => {
    await page.getByText('Long fixture history', { exact: true }).click();
    const history = page.getByLabel('Chat history');
    await history.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(100);
    state.live = true;
    await send(page, 'Live streaming fixture');
    await page.waitForFunction(() => document.querySelector('[aria-label="Chat history"]')?.textContent.includes('Live chunk 1'));
    assert.ok(await history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 48));
    await history.hover();
    await page.mouse.wheel(0, -650);
    await page.waitForTimeout(100);
    const before = await history.evaluate(node => node.scrollTop);
    await page.waitForFunction(() => document.querySelector('[aria-label="Chat history"]')?.textContent.includes('Live chunk 11'));
    assert.equal(await history.evaluate(node => node.scrollTop), before);
    await page.waitForFunction(() => document.body.innerText.includes('Last request: input 20 / output 8 / total 28'));
    await page.getByRole('button', { name: /Latest messages/ }).click();
    assert.ok(await history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 48));
    const sessions = await waitSaved(page, sessions => sessions.find(s => s.id === 'history')?.messages.at(-1)?.execution?.usage?.totalTokens === 28);
    assert.equal(sessions.find(s => s.id === 'history').messages.at(-1).execution.usage.totalTokens, 28);
    assert.equal(state.models.length, 1);
  });

  await scenario('regression ownership: delayed approval-save + Deny keeps composer and next model owned', async ({ page, state }) => {
    const storage = await storageControls(page);
    await storage.hold({ name: 'approval', status: 'approval' });
    await storage.hold({ name: 'denial', outcome: 'declined' });
    let continuation;
    state.reply = async count => count === 1 ? [tool, finish] : new Promise(resolve => { continuation = resolve; });
    await send(page, 'Ownership fixture'); await storage.wait('approval');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await storage.release('approval'); await storage.wait('denial');
    await send(page, 'Second must remain unsent');
    assert.equal(await page.getByPlaceholder('Ask anything...').inputValue(), 'Second must remain unsent');
    assert.equal(await page.getByLabel('Chat history').getByText('Second must remain unsent', { exact: true }).count(), 0);
    await storage.release('denial'); await until(() => continuation);
    await send(page, 'Third must remain unsent');
    assert.equal(await page.getByPlaceholder('Ask anything...').inputValue(), 'Third must remain unsent');
    assert.equal(state.models.length, 2); assert.equal(state.tools, 0);
    continuation([{ type: 'text-delta', delta: 'Owned continuation' }, finish]);
    await page.getByText('Owned continuation', { exact: true }).waitFor(); await idle(page);
    await page.getByPlaceholder('Ask anything...').press('Enter');
    await until(() => state.models.length, count => count === 3);
    continuation([finish]); await idle(page);
    const sessions = await waitSaved(page, sessions => sessions.some(s => s.title === 'Ownership fixture' && s.messages.at(-1)?.execution?.status === 'complete'));
    assert.equal(sessions.find(s => s.title === 'Ownership fixture').messages.filter(m => m.role === 'user').length, 2);
  });

  await scenario('regression dirty storage: no dead end, known write retained across temporary chats, export and save recovery', async ({ page, state }) => {
    const storage = await storageControls(page);
    state.reply = async count => count === 1 ? [writeTool, finish] : [{ type: 'text-delta', delta: 'Recovered known tool result' }, finish];
    state.mcp = async () => { await storage.fail(true); return { content: [{ type: 'text', text: 'Confirmed remote write success' }] }; };
    await send(page, 'Dirty storage fixture'); await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await page.getByText('Success', { exact: true }).waitFor();
    await page.getByText('Recovered known tool result', { exact: true }).waitFor();
    await idle(page);
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Confirmed remote write success', { exact: false }).waitFor();
    await page.locator('main').getByRole('alert').first().waitFor();
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await send(page, 'Another temporary chat'); await idle(page);
    await page.getByText(/2 chat\(s\) are kept in this tab only/).waitFor();
    await sessionRow(page, 'Long fixture history').click();
    await page.getByLabel('Chat history').getByText(/History 0/).waitFor();
    await sessionRow(page, 'Dirty storage fixture').click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Confirmed remote write success', { exact: false }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download unsaved chats', exact: true }).click();
    const download = await downloadPromise;
    let exported = ''; for await (const chunk of await download.createReadStream()) exported += chunk;
    const recovery = JSON.parse(exported);
    assert.ok(recovery.sessions.some(s => s.messages.some(m => m.toolInvocations?.[0]?.outcome === 'success')));
    assert.ok(!exported.includes('fixture-not-a-real-key'));
    assert.equal(state.models.length, 3); assert.equal(state.tools, 1);
    await storage.fail(false); await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor({ state: 'hidden' });
    await sessionRow(page, 'Long fixture history').click();
    await page.getByLabel('Chat history').getByText(/History 0/).waitFor();
    await sessionRow(page, 'Dirty storage fixture').click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Confirmed remote write success', { exact: false }).waitFor();
    await page.reload(); await sessionRow(page, 'Dirty storage fixture').click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Confirmed remote write success', { exact: false }).waitFor();
    await page.getByText('Recovered known tool result', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models.length, 3); assert.equal(state.tools, 1);
    assert.equal(state.models[1].messages.at(-1).toolInvocations[0].outcome, 'success');
    assert.equal(state.models[1].messages.at(-1).toolInvocations[0].toolName, 'push_files');
  }, { writeMode: true });

  await scenario('hidden tab: approval never executes itself and confirmed MCP write completes exactly once in background', async ({ page, state }) => {
    state.reply = async count => count === 1 ? [writeTool, finish] : [{ type: 'text-delta', delta: 'Background write confirmed' }, finish];
    await send(page, 'Background write fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    await visibility(page, true); await page.waitForTimeout(100);
    assert.equal(state.tools, 0);
    await visibility(page, false);
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    let release;
    state.mcp = async () => new Promise(resolve => { release = resolve; });
    await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await until(() => release);
    await visibility(page, true);
    release({ content: [{ type: 'text', text: 'Known background success' }] });
    await page.getByText('Background write confirmed', { exact: true }).waitFor(); await idle(page);
    await visibility(page, false);
    assert.equal(state.tools, 1); assert.equal(state.models.length, 2);
    assert.equal(await page.getByText('Outcome unknown — verify remotely', { exact: true }).count(), 0);
    const sessions = await waitSaved(page, sessions => sessions.some(s => s.title === 'Background write fixture' && s.messages.at(-1)?.execution?.status === 'complete'));
    assert.equal(sessions.find(s => s.title === 'Background write fixture').messages[1].toolInvocations[0].outcome, 'success');
  }, { writeMode: true });

  await scenario('hidden tab: actual SDK text streaming finishes instead of being interrupted', async ({ page, state }) => {
    state.live = true;
    await send(page, 'Hidden streaming fixture');
    await page.waitForFunction(() => document.body.innerText.includes('Live chunk 1'));
    await visibility(page, true);
    await page.waitForFunction(() => document.body.innerText.includes('Live chunk 11'));
    await idle(page); await visibility(page, false);
    assert.equal(await page.getByText(/Interrupted\. No automatic resume/).count(), 0);
    assert.equal(state.models.length, 1);
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Hidden streaming fixture' && s.messages.at(-1)?.execution?.status === 'complete'));
  });

  await scenario('reload: pending approval survives without tool execution or automatic model request', async ({ page, state }) => {
    state.reply = async () => [writeTool, finish];
    await send(page, 'Reload approval fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Reload approval fixture' && s.messages.at(-1)?.execution?.status === 'approval'));
    await page.reload(); await sessionRow(page, 'Reload approval fixture').click();
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    assert.equal(state.tools, 0); assert.equal(state.models.length, 1);
  }, { writeMode: true });

  await scenario('short chat: touch/wheel and large collapsed tool arguments never show Latest messages or consume history height', async ({ page, state }) => {
    state.reply = async () => [{ ...writeTool, input: { ...writeTool.input, files: [{ path: 'fixture.txt', content: 'hidden arguments\n'.repeat(2000) }] } }, finish];
    await send(page, 'Short chat fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).waitFor();
    const history = page.getByLabel('Chat history');
    assert.ok(await history.evaluate(node => node.scrollHeight <= node.clientHeight));
    const before = await history.evaluate(node => node.clientHeight);
    await history.dispatchEvent('touchstart'); await history.dispatchEvent('touchmove');
    await history.dispatchEvent('wheel', { deltaY: -100 });
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: /Latest messages/ }).count(), 0);
    assert.equal(await history.evaluate(node => node.clientHeight), before);
  }, { writeMode: true });

  await scenario('chat actions: short chats stay usable, long chats show actions only at bottom without overlay or layout jumps', async ({ page, state }) => {
    state.reply = async () => [{ type: 'text-delta', delta: 'Short answer' }, finish];
    await send(page, 'Short actions fixture'); await idle(page);
    const history = page.getByLabel('Chat history');
    const actions = page.getByRole('toolbar', { name: 'Chat actions' });
    await actions.waitFor();
    assert.ok(await history.evaluate(node => node.scrollHeight <= node.clientHeight));
    assert.equal(await actions.getByRole('button', { name: 'Retry model step', exact: true }).getAttribute('class'),
      await actions.getByRole('button', { name: 'Start turn again', exact: true }).getAttribute('class'));
    assert.ok(await actions.evaluate(node => !!node.closest('[aria-label="Chat history"]')));
    await sessionRow(page, 'Long fixture history').click();
    await page.getByLabel('Chat history').getByText(/History 44/).waitFor();
    await page.getByRole('button', { name: /Latest messages/ }).click().catch(() => {});
    await history.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await actions.waitFor();
    const before = await history.evaluate(node => ({ viewport: node.clientHeight, content: node.scrollHeight }));
    await history.evaluate(node => { node.scrollTop -= 15; });
    await actions.waitFor({ state: 'hidden' });
    await history.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: /Latest messages/ }).waitFor();
    assert.equal(await actions.count(), 0, 'hidden actions must not be keyboard-accessible');
    assert.deepEqual(await history.evaluate(node => ({ viewport: node.clientHeight, content: node.scrollHeight })), before);
    await page.getByRole('button', { name: /Latest messages/ }).click();
    await actions.waitFor();
    assert.ok(await history.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight <= 2));
  });

  await scenario('missing provider: Enter and Send explain configuration in a translucent popup without losing draft', async ({ page, state }) => {
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('ai-workspace'); request.onsuccess = () => resolve(request.result); });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'default', settingsVersion: 1, rememberKeys: true, systemPrompt: '' });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
    });
    await page.reload();
    await page.getByRole('button', { name: 'Choose a Provider', exact: true }).waitFor();
    await send(page, 'Keep my draft');
    await page.getByText('Choose a provider to send a message.', { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('Ask anything...').inputValue(), 'Keep my draft');
    assert.equal(state.models.length, 0);
    const hint = page.locator('#provider-hint');
    assert.ok(await hint.evaluate(node => getComputedStyle(node).backdropFilter.includes('blur')));
    await page.getByRole('button', { name: 'Send message', exact: true }).click({ force: true });
    await page.getByRole('button', { name: 'Configure provider', exact: true }).click();
    await page.getByText('Configuration Settings', { exact: true }).waitFor();
  });

  await scenario('settings: failed save stays visible; retry persists custom model and remembered GitHub key across reload', async ({ page, state }) => {
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.failSettings = true;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.name === 'settings' && window.failSettings) throw new DOMException('Fixture settings write failed', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Configuration Settings' });
    await dialog.getByPlaceholder('custom-model-name').fill('my-persisted-model');
    await dialog.locator('#rememberKeys').check();
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await dialog.getByRole('alert').getByText(/could not be saved/).waitFor();
    assert.equal(await dialog.getByPlaceholder('custom-model-name').inputValue(), 'my-persisted-model');
    await page.evaluate(() => { window.failSettings = false; });
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: 'Custom (my-persisted-model)', exact: true }).waitFor();
    await page.getByText('connected (1 tools)', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
    assert.equal(await page.getByPlaceholder('ghp_...').inputValue(), 'fixture-not-a-real-pat');
    await sessionRow(page, 'Long fixture history').click();
    await page.getByLabel('Chat history').getByText(/History 0/).waitFor();
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('settings: failed hydration does not clear persisted data or block saved chats; retry restores provider and MCP', async ({ page, state }) => {
    await page.addInitScript(() => {
      const get = IDBObjectStore.prototype.get;
      window.failSettingsRead = true;
      IDBObjectStore.prototype.get = function(...args) {
        if (this.name === 'settings' && window.failSettingsRead) throw new DOMException('Fixture read failed', 'UnknownError');
        return get.apply(this, args);
      };
    });
    await page.reload();
    await page.getByText(/Settings could not be loaded/).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Configuration Settings' });
    await dialog.getByPlaceholder('Set system instructions...').fill('Explicit edit during read failure');
    await dialog.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await dialog.getByText(/Retry loading before saving/).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await sessionRow(page, 'Long fixture history').click();
    await page.getByLabel('Chat history').getByText(/History 0/).waitFor();
    await page.evaluate(() => { window.failSettingsRead = false; });
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('button', { name: 'Custom (fixture)', exact: true }).waitFor();
    await page.getByText('connected (1 tools)', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
    assert.equal(await page.getByPlaceholder('ghp_...').inputValue(), 'fixture-not-a-real-pat');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.getByPlaceholder('Set system instructions...').inputValue(), 'Explicit edit during read failure');
    assert.equal(state.models.length, 0);
  });

  await scenario('unknown write: missing acknowledgement never becomes success and model Retry/restart cannot replay it', async ({ page, state }) => {
    state.reply = async () => [writeTool, finish];
    state.mcp = async () => undefined;
    await send(page, 'Unknown write fixture');
    await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await page.getByText('Outcome unknown — verify remotely', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.tools, 1); assert.equal(state.models.length, 1);
    assert.equal(await page.getByRole('button', { name: 'Retry model step', exact: true }).last().isDisabled(), true);
    await page.getByRole('button', { name: 'Start turn again', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(state.tools, 1); assert.equal(state.models.length, 1);
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    state.reply = async () => [{ type: 'text-delta', delta: 'New chat still works' }, finish];
    await send(page, 'Separate safe message');
    await page.getByText('New chat still works', { exact: true }).waitFor();
    assert.equal(state.tools, 1);
  }, { writeMode: true });

  await scenario('regression retry deadline: sleep during initial retry save never sends a late automatic model', async ({ page, state }) => {
    const storage = await storageControls(page);
    await storage.hold({ name: 'retry-start', status: 'waiting', attempts: 2 });
    state.reply = async count => count === 1 ? [error()] : [{ type: 'text-delta', delta: 'MUST NOT AUTO REQUEST' }, finish];
    await send(page, 'Late retry fixture'); await storage.wait('retry-start');
    await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 61000; });
    await storage.release('retry-start'); await idle(page);
    assert.equal(state.models.length, 1);
    const sessions = await waitSaved(page, sessions => sessions.some(s => s.title === 'Late retry fixture' && s.messages.at(-1)?.execution?.status === 'error'));
    assert.equal(sessions.find(s => s.title === 'Late retry fixture').messages.at(-1).execution.requestSent, false);
    await page.reload(); await sessionRow(page, 'Late retry fixture').click();
    await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
    await page.getByText('MUST NOT AUTO REQUEST', { exact: true }).waitFor();
    assert.equal(state.models.length, 2, 'explicit manual continuation still works');
  });

  for (const reload of [false, true]) {
    await scenario(`regression pending-model: Stop during successful MCP save, model-only Retry ${reload ? 'after reload' : 'without reload'}`, async ({ page, state }) => {
      const storage = await storageControls(page);
      await storage.hold({ name: 'result', outcome: 'success' });
      state.reply = async count => count === 1 ? [writeTool, finish] : [{ type: 'text-delta', delta: 'Continued saved results' }, finish];
      await send(page, 'Pending model fixture'); await page.getByRole('button', { name: 'Confirm & Run' }).click();
      await storage.wait('result'); await page.getByTitle('Stop generating').click();
      await storage.release('result'); await idle(page);
      await waitSaved(page, sessions => sessions.some(s => s.title === 'Pending model fixture' && s.messages.at(-1)?.execution?.status === 'cancelled'));
      if (reload) { await page.reload(); await sessionRow(page, 'Pending model fixture').click(); }
      await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
      await page.getByText('Continued saved results', { exact: true }).waitFor(); await idle(page);
      assert.equal(state.models.length, 2); assert.equal(state.tools, 1);
      assert.equal(state.models[1].messages.at(-1).toolInvocations[0].result.content[0].text, 'Saved fixture file');
      assert.equal(state.models[1].messages.at(-1).toolInvocations[0].toolName, 'push_files');
    }, { writeMode: true });
  }

  await scenario('regression deleted session: actual Sidebar delete then immediate reload does not resurrect IndexedDB entry', async ({ page, state }) => {
    state.reply = async () => [{ type: 'text-delta', delta: 'Delete then reload answer' }, finish];
    await send(page, 'Immediate deletion fixture'); await idle(page);
    const before = await waitSaved(page, sessions => sessions.some(s => s.title === 'Immediate deletion fixture' && s.messages.at(-1)?.execution?.status === 'complete'));
    const target = before.find(s => s.title === 'Immediate deletion fixture');
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Immediate deletion fixture').getByTitle('Delete Session').click();
    await sessionRow(page, 'Immediate deletion fixture').waitFor({ state: 'hidden' });
    await page.reload(); await page.getByText('connected (1 tools)', { exact: false }).waitFor();
    const after = await saved(page);
    assert.equal(after.some(s => s.id === target.id), false, 'deleted entry must not be recreated by pagehide');
    assert.deepEqual(after.find(s => s.id === 'history'), before.find(s => s.id === 'history'));
    assert.equal(state.models.length, 1);
  });

  await scenario('regression deletion: Sidebar active delete drains save before delete and pagehide/reload cannot resurrect', async ({ page, state }) => {
    const storage = await storageControls(page);
    await storage.hold({ name: 'final', status: 'complete' });
    state.reply = async () => [{ type: 'text-delta', delta: 'Deletion answer' }, finish];
    await send(page, 'Delete active fixture'); await storage.wait('final');
    const before = await saved(page); const target = before.find(s => s.title === 'Delete active fixture');
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Delete active fixture').getByTitle('Delete Session').click();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await storage.release('final');
    await waitSaved(page, sessions => !sessions.some(s => s.id === target.id));
    await sessionRow(page, 'Delete active fixture').waitFor({ state: 'hidden' });
    await page.reload();
    const after = await saved(page);
    assert.equal(after.some(s => s.id === target.id), false);
    assert.deepEqual(after.find(s => s.id === 'history'), before.find(s => s.id === 'history'));
    assert.equal(state.models.length, 1);
  });

  await scenario('regression inactive deletion/error: unrelated active response survives, failed delete is visible and recoverable', async ({ page, state }) => {
    let release;
    state.reply = async () => new Promise(resolve => { release = resolve; });
    await send(page, 'Unaffected active fixture'); await until(() => release);
    const before = await saved(page);
    await page.evaluate(() => {
      const remove = IDBObjectStore.prototype.delete;
      window.failChatDelete = true;
      IDBObjectStore.prototype.delete = function(...args) {
        if (this.name === 'sessions' && window.failChatDelete) throw new DOMException('Fixture delete failed', 'QuotaExceededError');
        return remove.apply(this, args);
      };
    });
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Long fixture history').getByTitle('Delete Session').click();
    await page.getByRole('alert', { name: 'Local storage', exact: true }).getByText('Session could not be deleted. Its data is retained. Retry deletion after storage recovers.', { exact: true }).waitFor();
    assert.ok((await saved(page)).some(s => s.id === 'history'));
    release([{ type: 'text-delta', delta: 'Unaffected response completes' }, finish]);
    await page.getByText('Unaffected response completes', { exact: true }).waitFor(); await idle(page);
    await page.evaluate(() => { window.failChatDelete = false; });
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Long fixture history').getByTitle('Delete Session').click();
    await waitSaved(page, sessions => !sessions.some(s => s.id === 'history'));
    assert.equal(state.models.length, 1);
    await page.reload(); await sessionRow(page, 'Unaffected active fixture').click();
    await page.getByText('Unaffected response completes', { exact: true }).waitFor();
    assert.ok((await saved(page)).some(s => s.id === before.find(s => s.title === 'Unaffected active fixture').id));
  });

  await scenario('regression delete during MCP: late write response and cleanup cannot save a detached session', async ({ page, state }) => {
    let release;
    state.reply = async () => [writeTool, finish];
    state.mcp = async () => new Promise(resolve => { release = resolve; });
    await send(page, 'Delete executing fixture'); await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await until(() => release);
    const before = await saved(page), target = before.find(s => s.title === 'Delete executing fixture');
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Delete executing fixture').getByTitle('Delete Session').click();
    await sessionRow(page, 'Delete executing fixture').waitFor({ state: 'hidden' });
    release({ content: [{ type: 'text', text: 'Late deleted write success' }] });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.reload(); await page.getByText('connected (1 tools)', { exact: false }).waitFor();
    const after = await saved(page);
    assert.equal(after.some(s => s.id === target.id), false);
    assert.deepEqual(after.find(s => s.id === 'history'), before.find(s => s.id === 'history'));
    assert.equal(state.models.length, 1); assert.equal(state.tools, 1);
  }, { writeMode: true });

  await scenario('regression active delete failure retains confirmed write result, reattaches and permits model-only recovery', async ({ page, state }) => {
    const storage = await storageControls(page);
    await storage.hold({ name: 'write-result', outcome: 'success' });
    state.reply = async count => count === 1 ? [writeTool, finish] : [{ type: 'text-delta', delta: 'Continued after failed deletion' }, finish];
    await send(page, 'Failed active deletion'); await page.getByRole('button', { name: 'Confirm & Run' }).click();
    await storage.wait('write-result');
    await page.evaluate(() => {
      const remove = IDBObjectStore.prototype.delete;
      window.failChatDelete = true;
      IDBObjectStore.prototype.delete = function(...args) {
        if (this.name === 'sessions' && window.failChatDelete) throw new DOMException('Fixture delete failed', 'QuotaExceededError');
        return remove.apply(this, args);
      };
    });
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'Failed active deletion').getByTitle('Delete Session').click();
    await storage.release('write-result');
    await page.getByRole('alert', { name: 'Local storage', exact: true }).getByText('Session could not be deleted. Its data is retained. Retry deletion after storage recovers.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
    await page.getByText('Continued after failed deletion', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models.length, 2); assert.equal(state.tools, 1);
    assert.equal(state.models[1].messages.at(-1).toolInvocations[0].outcome, 'success');
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Failed active deletion' && s.messages.at(-1)?.execution?.status === 'complete'));
    await page.reload(); await sessionRow(page, 'Failed active deletion').click();
    await page.getByText('Continued after failed deletion', { exact: true }).waitFor();
  }, { writeMode: true });
  await scenario('attachments notice: first click explains privacy without shifting the composer; confirmation opens picker and survives reload', async ({ page, state }) => {
    const add = page.getByRole('button', { name: 'Add attachments', exact: true });
    const help = page.getByRole('dialog', { name: 'Attachments & privacy', exact: true });
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    let pickers = 0;
    page.on('filechooser', () => pickers++);
    const before = await message.boundingBox();
    assert.equal(await page.getByText(/Files stay local until you send/).isVisible(), false);
    await add.click();
    await help.waitFor();
    assert.equal(pickers, 0);
    assert.deepEqual(await message.boundingBox(), before);
    assert.equal(await help.getByText(/go through this app to the selected provider with conversation history/).isVisible(), true);
    assert.equal(await help.getByText('API charges/quotas may apply.', { exact: true }).isVisible(), true);
    assert.equal(await help.getByText('Up to 4 files per message', { exact: true }).isVisible(), true);
    const helpBox = await help.boundingBox(); const addBox = await add.boundingBox();
    assert.ok(helpBox && addBox && helpBox.y + helpBox.height <= addBox.y);
    const first = page.waitForEvent('filechooser');
    await help.getByRole('button', { name: 'Got it, choose files', exact: true }).click();
    await (await first).setFiles([]);
    await help.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), attachmentNoticeKey), '1');
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
    await page.reload();
    const next = page.waitForEvent('filechooser'); await add.click(); await (await next).setFiles([]);
    assert.equal(await help.count(), 0);
    assert.equal(pickers, 2);
    await page.getByRole('button', { name: 'Attachment information', exact: true }).click();
    await help.waitFor();
    await help.getByRole('button', { name: 'Got it', exact: true }).click();
    await help.waitFor({ state: 'hidden' });
    assert.equal(pickers, 2);
    await page.evaluate(key => localStorage.removeItem(key), attachmentNoticeKey);
    await add.click(); await help.waitFor();
    assert.equal(pickers, 2);
  });

  await scenario('attachments notice: Escape, outside click, close and cancel never acknowledge; keyboard focus stays in the dialog', async ({ page, state }) => {
    const add = page.getByRole('button', { name: 'Add attachments', exact: true });
    const help = page.getByRole('dialog', { name: 'Attachments & privacy', exact: true });
    const confirm = help.getByRole('button', { name: 'Got it, choose files', exact: true });
    let pickers = 0; page.on('filechooser', () => pickers++);
    await add.focus(); await page.keyboard.press('Enter'); await help.waitFor();
    assert.equal(await confirm.evaluate(button => document.activeElement === button), true);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await help.evaluate(card => card.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape'); await help.waitFor({ state: 'hidden' });
    assert.equal(await add.evaluate(button => document.activeElement === button), true);
    await add.click(); await help.waitFor();
    await help.getByRole('button', { name: 'Not now', exact: true }).click();
    await help.waitFor({ state: 'hidden' });
    await add.click(); await help.waitFor();
    await help.getByRole('button', { name: 'Close attachment information', exact: true }).click();
    await help.waitFor({ state: 'hidden' });
    await add.click(); await help.waitFor();
    await page.mouse.click(1400, 100); await help.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), attachmentNoticeKey), null);
    await page.reload(); await add.click(); await help.waitFor();
    assert.equal(pickers, 0); assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('attachments notice: blocked storage falls back to tab memory without blocking picker or image input', async ({ page, state }) => {
    await page.evaluate(key => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) {
        if (name === key) throw new DOMException('Fixture blocked notice storage', 'QuotaExceededError');
        return set.call(this, name, value);
      };
    }, attachmentNoticeKey);
    const add = page.getByRole('button', { name: 'Add attachments', exact: true });
    const help = page.getByRole('dialog', { name: 'Attachments & privacy', exact: true });
    await add.click(); await help.waitFor();
    const first = page.waitForEvent('filechooser');
    await help.getByRole('button', { name: 'Got it, choose files', exact: true }).click();
    await (await first).setFiles(await imageFile(page));
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    await page.getByLabel('Image support hint', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Try sending images to this model anyway', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), attachmentNoticeKey), null);
    const next = page.waitForEvent('filechooser'); await add.click(); await (await next).setFiles([]);
    assert.equal(await help.count(), 0);
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
    await page.reload(); await add.click(); await help.waitFor();
  });

  await scenario('attachments notice mobile: centered compact dialog, no overflow, dismissal and persistent confirmation', async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    const add = page.getByRole('button', { name: 'Add attachments', exact: true });
    const info = page.getByRole('button', { name: 'Attachment information', exact: true });
    const help = page.getByRole('dialog', { name: 'Attachments & privacy', exact: true });
    const before = await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox();
    await info.click(); await help.waitFor();
    const box = await help.boundingBox();
    assert.ok(box && box.x >= 16 && box.x + box.width <= 374 && box.y >= 16 && box.y + box.height <= 828);
    assert.ok(Math.abs(box.y + box.height / 2 - 422) < 2);
    assert.deepEqual(await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox(), before);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await help.getByRole('button', { name: 'Not now', exact: true }).click();
    await help.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), attachmentNoticeKey), null);
    await add.click(); await help.waitFor();
    const picker = page.waitForEvent('filechooser');
    await help.getByRole('button', { name: 'Got it, choose files', exact: true }).click();
    await (await picker).setFiles(textFile('mobile-notice.txt', 'Chosen after notice'));
    await page.getByRole('button', { name: 'Preview mobile-notice.txt', exact: true }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), attachmentNoticeKey), '1');
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('attachments text: local preview/removal, file-only send, metadata history, reload and isolated deletion', async ({ page, state }) => {
    const file = textFile();
    const input = page.getByLabel('Attach files', { exact: true });
    await input.setInputFiles(file);
    const draft = page.getByLabel('Draft attachments', { exact: true });
    await draft.getByRole('button', { name: 'Preview notes.md', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'notes.md', exact: true });
    await preview.getByText(/Привет 🌍/).waitFor();
    assert.equal(state.models.length, 0);
    await preview.getByRole('button', { name: 'Close attachment preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    await draft.getByRole('button', { name: 'Remove notes.md', exact: true }).click();
    await draft.waitFor({ state: 'hidden' });
    await input.setInputFiles(file);
    await draft.waitFor();
    state.reply = async () => [{ type: 'text-delta', delta: 'Text attachment received' }, finish];
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Text attachment received', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models[0].messages[0].content, '');
    assert.equal(state.models[0].messages[0].attachments[0].data, file.buffer.toString());
    const sessions = await waitSaved(page, sessions => sessions.some(s => s.title === 'notes.md' && s.messages.at(-1)?.execution?.status === 'complete'));
    const target = sessions.find(s => s.title === 'notes.md');
    assert.equal('data' in target.messages[0].attachments[0], false);
    const records = await attachmentRecords(page);
    assert.equal(records.length, 1); assert.equal(records[0].data, file.buffer.toString());
    await send(page, 'Follow up about the same file'); await idle(page);
    assert.equal(state.models[1].messages[0].attachments[0].id, records[0].id);
    assert.equal((await attachmentRecords(page)).length, 1);
    await page.reload(); await sessionRow(page, 'notes.md').click();
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview notes.md', exact: true }).click();
    await page.getByLabel('Chat history').getByText(/Привет 🌍/).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await sessionRow(page, 'notes.md').getByTitle('Delete Session').click();
    await sessionRow(page, 'notes.md').waitFor({ state: 'hidden' });
    assert.equal((await attachmentRecords(page)).length, 0);
    assert.ok((await saved(page)).some(s => s.id === 'history'));
  });

  await scenario('attachments composer: one to four equal compact tiles stay inside one horizontal row on desktop, tablet and narrow mobile', async ({ page, state, diagnostics }) => {
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height }); await page.reload();
      await page.getByRole('button', { name: 'Custom (fixture)', exact: true }).waitFor();
      const composer = page.getByRole('group', { name: 'Message composer', exact: true });
      const message = composer.getByRole('textbox', { name: 'Message', exact: true });
      await message.fill('Keep this draft while previewing files');
      const emptyBox = await composer.boundingBox();
      const files = [
        await imageFile(page, { name: 'landscape.png', width: 640, height: 320 }),
        textFile('long-context-file-name-that-must-not-stretch-the-composer.txt', 'Local context\nПривет 🌍'),
        await imageFile(page, { name: 'portrait.png', width: 180, height: 640 }),
        textFile('facts.json', '{"local":true}'),
      ];
      const draft = composer.getByRole('list', { name: 'Draft attachments', exact: true });
      let firstWidth; let firstHeight;
      for (const [index, file] of files.entries()) {
        await page.getByLabel('Attach files', { exact: true }).setInputFiles(file);
        await draft.getByRole('button', { name: `Preview ${file.name}`, exact: true }).waitFor();
        await until(() => composer.getByLabel('Attachment count', { exact: true }).innerText(), text => text.startsWith(`${index + 1}/4`));
        const boxes = await draft.evaluate(list => Array.from(list.children, item => {
          const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
        const composerBox = await composer.boundingBox(); const inputBox = await message.boundingBox();
        assert.equal(boxes.length, index + 1);
        if (!index) { firstWidth = boxes[0].width; firstHeight = composerBox.height; }
        assert.ok(Math.abs(composerBox.height - firstHeight) < 1, `${width}px: adding files must not add rows or composer height`);
        assert.ok(composerBox.height <= emptyBox.height + 112, `${width}px: attachment row must stay compact`);
        for (const [position, box] of boxes.entries()) {
          assert.ok(Math.abs(box.width - firstWidth) < 1 && Math.abs(box.width - box.height) < 1, `${width}px: identical square slots for one or four files`);
          assert.ok(box.width <= 100 && box.width >= 58, `${width}px: bounded, readable tile width`);
          assert.ok(Math.abs(box.y - boxes[0].y) < 1, `${width}px: files must stay in one horizontal row`);
          assert.ok(box.x >= composerBox.x + 8 && box.x + box.width < composerBox.x + composerBox.width - 7);
          assert.ok(box.y >= composerBox.y + 8 && box.y + box.height <= inputBox.y + 1, 'files are above, never over, the text field');
          if (position) assert.ok(box.x >= boxes[position - 1].x + boxes[position - 1].width + 7);
        }
        if (!index) await composerScreenshot(page, `composer-${width}-one-file`);
      }
      assert.equal(await composer.getByRole('button', { name: 'Add attachments', exact: true }).isDisabled(), true);
      assert.equal(await message.inputValue(), 'Keep this draft while previewing files');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await composerScreenshot(page, `composer-${width}-four-files`);
      await page.emulateMedia({ colorScheme: 'dark' });
      await until(() => page.locator('html').getAttribute('class'), value => value?.includes('dark'));
      await composerScreenshot(page, `composer-${width}-four-files-dark`);
      assert.equal((await composer.boundingBox()).height, firstHeight, 'theme changes do not change composer geometry');
      await page.emulateMedia({ colorScheme: 'light' });
      await draft.getByRole('button', { name: 'Remove portrait.png', exact: true }).click();
      assert.equal(await composer.getByRole('button', { name: 'Add attachments', exact: true }).isEnabled(), true);
      await until(() => composer.getByLabel('Attachment count', { exact: true }).innerText(), text => text.startsWith('3/4'));
      for (const name of ['landscape.png', files[1].name, 'facts.json']) await draft.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
      await draft.waitFor({ state: 'hidden' });
      assert.equal(await composer.getByLabel('Attachment count', { exact: true }).count(), 0);
      assert.equal((await composer.boundingBox()).height, emptyBox.height);
      assert.equal(await message.inputValue(), 'Keep this draft while previewing files');
    }
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
    assert.ok(!diagnostics.some(text => /data:image\/|base64,|has either width or height modified/.test(text)));
  });

  await scenario('attachments composer preview: accessible local dialogs preserve draft size, text, focus and all selected files', async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    const files = [await imageFile(page), textFile('notes.md', '<script>not executed</script>\nПривет 🌍\n' + 'Preview line\n'.repeat(250))];
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(files);
    const composer = page.getByRole('group', { name: 'Message composer', exact: true });
    const draft = composer.getByRole('list', { name: 'Draft attachments', exact: true });
    await draft.getByRole('button', { name: 'Preview notes.md', exact: true }).waitFor();
    await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent text');
    const before = await composer.boundingBox();
    const imageTrigger = draft.getByRole('button', { name: 'Preview pixel.png', exact: true });
    await imageTrigger.click();
    let dialog = page.getByRole('dialog', { name: 'pixel.png', exact: true });
    await dialog.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 16 && bounds.x + bounds.width <= 374 && bounds.y >= 16 && bounds.y + bounds.height <= 828);
    assert.deepEqual(await composer.boundingBox(), before);
    assert.equal(await dialog.getByRole('button', { name: 'Close attachment preview', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close attachment preview', exact: true }).evaluate(node => node === document.activeElement), true, 'image dialog keeps keyboard focus inside');
    await composerScreenshot(page, 'composer-mobile-image-dialog');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await imageTrigger.evaluate(node => node === document.activeElement), true, 'Escape restores focus to the preview trigger');
    const textTrigger = draft.getByRole('button', { name: 'Preview notes.md', exact: true }); await textTrigger.click();
    dialog = page.getByRole('dialog', { name: 'notes.md', exact: true });
    await dialog.getByText(/Привет 🌍/).waitFor();
    assert.equal((await dialog.getByLabel('Text file preview', { exact: true }).innerText()).length, 2000);
    assert.equal(await dialog.locator('script').count(), 0);
    await dialog.getByText('Preview: first 2,000 characters. The full text is sent.', { exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByLabel('Text file preview', { exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close attachment preview', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByLabel('Text file preview', { exact: true }).evaluate(node => node === document.activeElement), true, 'text dialog wraps focus in both directions');
    assert.deepEqual(await composer.boundingBox(), before);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await composerScreenshot(page, 'composer-mobile-text-dialog');
    await dialog.getByRole('button', { name: 'Close attachment preview', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await textTrigger.evaluate(node => node === document.activeElement), true);
    await imageTrigger.click(); dialog = page.getByRole('dialog', { name: 'pixel.png', exact: true }); await dialog.waitFor();
    await page.mouse.click(4, 4); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await draft.getByRole('listitem').count(), 2);
    assert.equal(await composer.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Unsent text');
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('attachments validation: bad formats/UTF-8/signatures, size/count limits preserve existing draft without sending', async ({ page, state }) => {
    const input = page.getByLabel('Attach files', { exact: true });
    await input.setInputFiles(textFile('keep.txt', 'Keep this file'));
    const draft = page.getByLabel('Draft attachments');
    await draft.getByRole('button', { name: 'Preview keep.txt', exact: true }).waitFor();
    for (const [file, message] of [
      [textFile('bad.pdf', '%PDF'), /Unsupported format/],
      [textFile('bad.txt', 'x'.repeat(256 * 1024 + 1)), /256 KiB/],
      [{ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([255, 254, 0]) }, /UTF-8/],
      [{ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') }, /do not match/],
    ]) {
      await input.setInputFiles(file);
      await page.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await draft.getByRole('button', { name: 'Preview keep.txt', exact: true }).count(), 1);
    }
    await input.setInputFiles(Array.from({ length: 4 }, (_, i) => textFile(`extra-${i}.txt`, 'extra')));
    await page.getByRole('alert').filter({ hasText: /at most 4/ }).waitFor();
    assert.equal(await draft.getByRole('button', { name: /^Preview / }).count(), 1);
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('attachments images: unknown support never gates send, continuation, retry, restart or reloaded history; blob preview is private', async ({ page, state, diagnostics }) => {
    const image = await imageFile(page);
    await page.getByLabel('Attach files', { exact: true }).setInputFiles([image, textFile('context.txt', 'Image context')]);
    const preview = page.getByRole('img', { name: 'Preview of pixel.png', exact: true });
    await preview.waitFor();
    await until(() => preview.evaluate(node => node.complete && node.naturalWidth > 0));
    const dimensions = await preview.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight, src: node.getAttribute('src'), fit: getComputedStyle(node).objectFit }));
    assert.ok(dimensions.src.startsWith('blob:'));
    assert.equal(dimensions.fit, 'contain'); assert.ok(Math.abs(dimensions.width / dimensions.height - 2) < 0.02);
    await page.getByLabel('Image support hint', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Try sending images to this model anyway', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Dismiss image support hint', exact: true }).click();
    assert.equal(state.models.length, 0);
    state.reply = async count => count === 1 ? [tool, finish] : count === 2 ? [error('quota')] : [{ type: 'text-delta', delta: 'Image attachment received' }, finish];
    await send(page, 'Describe the attached image');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /quota/i }).waitFor();
    await idle(page);
    await page.getByRole('button', { name: 'Retry model step', exact: true }).last().click();
    await page.getByText('Image attachment received', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models.length, 3); assert.equal(state.tools, 0);
    const files = state.models[0].messages[0].attachments;
    assert.equal(files.length, 2);
    assert.equal(files[0].data, `data:image/png;base64,${image.buffer.toString('base64')}`);
    assert.equal(files[1].data, 'Image context');
    assert.ok(state.models.every(model => !Object.hasOwn(model, 'imageSupportAcknowledged')));
    assert.ok(state.models.every(model => model.messages[0].attachments[0].data === files[0].data));
    await page.getByRole('button', { name: 'Start turn again', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await until(() => state.models.length, count => count === 4); await idle(page);
    await page.getByText('Attachment contents are redacted here and in this Copy button.', { exact: false }).waitFor();
    assert.equal(await page.getByTitle('Snippet export does not yet include attachments.', { exact: true }).isDisabled(), true);
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Describe the attached image' && s.messages.at(-1)?.execution?.status === 'complete'));
    await page.reload(); await sessionRow(page, 'Describe the attached image').click();
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview pixel.png', exact: true }).first().click();
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Image support hint', { exact: true }).count(), 0, 'dismissal survives reload for this endpoint/model');
    await send(page, 'Images must stay in this history');
    await until(() => state.models.length, count => count === 5); await idle(page);
    assert.equal(state.models[4].messages[0].attachments[0].data, files[0].data);
    assert.ok(!diagnostics.some(text => /data:image\/|base64,|has either width or height modified/.test(text)), 'no image payload or aspect warning in browser diagnostics');
  });

  await scenario('attachments images: known text-only model is advisory; provider refusal is explicit and a separate text chat still works', async ({ page, state }) => {
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('ai-workspace'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'default', settingsVersion: 1, groqKey: 'fake-groq-key', groqModel: 'openai/gpt-oss-20b', defaultModel: 'groq', rememberKeys: true, systemPrompt: '' });
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    });
    await page.reload();
    await page.getByRole('button', { name: 'Groq (openai/gpt-oss-20b)', exact: true }).waitFor();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(await imageFile(page));
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    await page.getByLabel('Image support hint', { exact: true }).getByText(/listed as text-only/).waitFor();
    state.reply = async () => [error('image-incompatible')];
    await send(page, 'Do not discard this picture');
    await page.getByRole('alert').filter({ hasText: /image/i }).waitFor(); await idle(page);
    assert.equal(state.models.length, 1);
    assert.ok(state.models[0].messages[0].attachments[0].data.startsWith('data:image/png;base64,'));
    assert.equal(await page.getByLabel('Message attachments').count(), 1);
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Do not discard this picture' && s.messages.at(-1)?.execution?.status === 'error'));
    await page.reload(); await sessionRow(page, 'Do not discard this picture').click();
    await send(page, 'Historical pictures still reach the provider'); await idle(page);
    assert.equal(state.models.length, 2); assert.ok(state.models[1].messages[0].attachments[0].data);
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    state.reply = async () => [{ type: 'text-delta', delta: 'Separate text answer' }, finish];
    await send(page, 'Plain text after refusal'); await page.getByText('Separate text answer', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models.length, 3); assert.equal(state.models[2].messages[0].attachments, undefined);
  });

  await scenario('attachments real route: installed SDK sends full text and image data to a local Chat Completions provider', async ({ page, state }) => {
    const image = await imageFile(page);
    const before = providerRequests.length;
    state.live = true;
    await page.getByLabel('Attach files', { exact: true }).setInputFiles([image, textFile('facts.json', '{"local":true}')]);
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    await send(page, 'Local multimodal end-to-end');
    await page.getByLabel('Chat history').getByText(/Live chunk 11/).waitFor(); await idle(page);
    assert.equal(providerRequests.length, before + 1);
    const upstream = providerRequests.at(-1);
    const parts = upstream.messages.filter(item => item.role === 'user').flatMap(item => typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content);
    assert.ok(parts.some(part => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${image.buffer.toString('base64')}`));
    assert.ok(parts.some(part => part.type === 'text' && part.text === '{"local":true}'));
    assert.ok(parts.some(part => part.type === 'text' && part.text === 'Local multimodal end-to-end'));
    assert.equal(upstream.stream_options?.include_usage, true);
  });

  await scenario('attachments verified model: no compatibility hint is needed and all image bytes are retained', async ({ page, state }) => {
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('ai-workspace'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'default', settingsVersion: 1, openAiKey: 'fake-openai-key', openAiModel: 'gpt-4.1', defaultModel: 'openai', rememberKeys: true, systemPrompt: '' });
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    });
    await page.reload();
    await page.getByRole('button', { name: 'OpenAI (gpt-4.1)', exact: true }).waitFor();
    const image = await imageFile(page);
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(image);
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Image support hint', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Try sending images to this model anyway', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(page);
    assert.equal(state.models.length, 1);
    assert.equal(state.models[0].messages[0].attachments[0].data, `data:image/png;base64,${image.buffer.toString('base64')}`);
  });

  await scenario('attachments dirty storage: generation continues, recovery includes full payload, retry saves exactly one record', async ({ page, state }) => {
    const storage = await storageControls(page); await storage.fail(true);
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(textFile('recovery.txt', 'Unsaved file content'));
    await page.getByLabel('Draft attachments').getByRole('button', { name: 'Preview recovery.txt', exact: true }).waitFor();
    state.reply = async () => [{ type: 'text-delta', delta: 'Temporary file answer' }, finish];
    await send(page, 'Unsaved file fixture');
    await page.getByText('Temporary file answer', { exact: true }).waitFor(); await idle(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download unsaved chats', exact: true }).click();
    const download = await downloadPromise;
    let json = ''; for await (const chunk of await download.createReadStream()) json += chunk;
    const recovery = JSON.parse(json);
    assert.equal(recovery.version, 2);
    assert.equal(recovery.attachments[0].data, 'Unsaved file content');
    assert.equal(recovery.sessions[0].messages[0].attachments[0].id, recovery.attachments[0].id);
    assert.equal('data' in recovery.sessions[0].messages[0].attachments[0], false);
    await storage.fail(false);
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await attachmentRecords(page)).length, 1);
    await page.reload(); await sessionRow(page, 'Unsaved file fixture').click();
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview recovery.txt', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Unsaved file content', { exact: true }).waitFor();
    assert.equal(state.models.length, 1); assert.equal(state.tools, 0);
  });

  await scenario('attachments missing payload: later history cannot silently send an incomplete question to the provider', async ({ page, state }) => {
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(textFile('missing.txt', 'Original file'));
    await page.getByLabel('Draft attachments').getByRole('button', { name: 'Preview missing.txt', exact: true }).waitFor();
    await send(page, 'Missing file fixture'); await idle(page);
    await waitSaved(page, sessions => sessions.some(s => s.title === 'Missing file fixture' && s.messages.at(-1)?.execution?.status === 'complete'));
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('ai-workspace'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('attachments', 'readwrite'); tx.objectStore('attachments').clear();
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    });
    await page.reload(); await sessionRow(page, 'Missing file fixture').click();
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview missing.txt', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /Attachment unavailable/ }).waitFor();
    await send(page, 'This question still needs the file'); await idle(page);
    await page.getByRole('alert').filter({ hasText: /An attachment is unavailable in local storage/ }).waitFor();
    assert.equal(state.models.length, 1);
    let downloads = 0; page.on('download', () => downloads++);
    await page.getByRole('button', { name: 'Download unsaved chats', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /No incomplete download was created/ }).waitFor();
    assert.equal(downloads, 0);
    assert.ok(!(await page.getByRole('alert').allTextContents()).join(' ').includes('Original file'));
  });

  await scenario('attachments mobile: composer, local previews and compact dismissible hint stay usable without overflow', async ({ page, state, diagnostics }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.getByRole('button', { name: 'Custom (fixture)', exact: true }).waitFor();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles([await imageFile(page), textFile('mobile.txt', 'Mobile attachment')]);
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    const hint = page.getByLabel('Image support hint', { exact: true }); await hint.waitFor();
    assert.ok((await hint.boundingBox()).height < 84);
    assert.ok(await hint.evaluate(node => getComputedStyle(node).backdropFilter.includes('blur')));
    const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
    const box = await sendButton.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (process.env.CHAT_BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.CHAT_BROWSER_SCREENSHOT });
    state.reply = async () => [{ type: 'text-delta', delta: 'Mobile files received' }, finish];
    await send(page, 'Mobile message');
    await page.getByText('Mobile files received', { exact: true }).waitFor(); await idle(page);
    assert.equal(state.models[0].messages[0].attachments.length, 2);
    assert.ok(!diagnostics.some(text => /data:image\/|base64,|has either width or height modified/.test(text)));
  });

  await scenario('attachments image hint: dismissal belongs only to endpoint/model, excludes URL credentials and keys, survives reload', async ({ page, state }) => {
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('ai-workspace'); request.onsuccess = () => resolve(request.result); });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'default', settingsVersion: 1, customKey: 'synthetic-hint-key', customBaseUrl: 'https://user:synthetic-url-password@fixture.invalid/v1?api_key=synthetic-query-secret', customModel: 'fixture', defaultModel: 'custom', rememberKeys: true, systemPrompt: '' });
      await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    });
    await page.reload(); await page.getByRole('button', { name: 'Custom (fixture)', exact: true }).waitFor();
    const image = await imageFile(page);
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(image);
    const hint = page.getByLabel('Image support hint', { exact: true }); await hint.waitFor();
    await page.getByRole('button', { name: 'Dismiss image support hint', exact: true }).click();
    const preferences = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ai-workspace:image-hint:')));
    assert.equal(preferences.length, 1);
    assert.ok(!preferences[0].includes('synthetic-') && !preferences[0].includes('user:'));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    let settings = page.getByRole('dialog', { name: 'Configuration Settings', exact: true });
    await settings.getByPlaceholder('sk-...', { exact: true }).fill('changed-key-not-an-identity');
    await settings.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await settings.waitFor({ state: 'hidden' }); assert.equal(await hint.count(), 0);
    await page.reload(); await page.getByRole('button', { name: 'Custom (fixture)', exact: true }).waitFor();
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(image);
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor(); assert.equal(await hint.count(), 0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'Configuration Settings', exact: true });
    await settings.getByPlaceholder('custom-model-name').fill('fixture-next');
    await settings.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await settings.waitFor({ state: 'hidden' }); await hint.waitFor();
    await page.getByRole('button', { name: 'Dismiss image support hint', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByPlaceholder('https://api.openai.com/v1', { exact: true }).fill('https://other-fixture.invalid/v1');
    await settings.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await settings.waitFor({ state: 'hidden' }); await hint.waitFor();
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('attachments private preview: thumbnail/expanded/removal revoke blob URLs without aspect or payload diagnostics', async ({ page, state, diagnostics }) => {
    await page.evaluate(() => {
      const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
      window.previewUrls = { created: [], revoked: [] };
      URL.createObjectURL = blob => { const url = create(blob); window.previewUrls.created.push(url); return url; };
      URL.revokeObjectURL = url => { window.previewUrls.revoked.push(url); revoke(url); };
    });
    await page.getByLabel('Attach files', { exact: true }).setInputFiles(await imageFile(page));
    const draft = page.getByLabel('Draft attachments', { exact: true });
    const image = draft.getByRole('img', { name: 'Preview of pixel.png', exact: true }); await image.waitFor();
    const thumbnail = await image.getAttribute('src'); assert.ok(thumbnail.startsWith('blob:'));
    await draft.getByRole('button', { name: 'Preview pixel.png', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'pixel.png', exact: true });
    const expanded = dialog.getByRole('img', { name: 'Preview of pixel.png', exact: true }); await expanded.waitFor();
    const expandedUrl = await expanded.getAttribute('src'); assert.ok(expandedUrl !== thumbnail && expandedUrl.startsWith('blob:'));
    await dialog.getByRole('button', { name: 'Close attachment preview', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await until(() => page.evaluate(() => window.previewUrls.revoked), urls => urls.includes(expandedUrl));
    assert.equal(await image.getAttribute('src'), thumbnail, 'closing the dialog retains the compact thumbnail');
    await draft.getByRole('button', { name: 'Remove pixel.png', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
    await until(() => page.evaluate(() => window.previewUrls), value => value.created.length === value.revoked.length);
    assert.ok(!diagnostics.some(text => /data:image\/|base64,|has either width or height modified/.test(text)));
    assert.equal(state.models.length, 0);
  });

  await scenario('recovery UI: 32 MiB guard before read, safe file errors, preview and Cancel write nothing and preserve Settings draft', async ({ page, state }) => {
    const original = await saved(page); const settingsBefore = await storedSettings(page);
    await page.evaluate(() => { const read = File.prototype.text; window.recoveryReads = 0; File.prototype.text = function() { window.recoveryReads++; return window.failRecoveryRead ? Promise.reject(new Error('private raw read error')) : read.call(this); }; });
    const dialog = await openRestore(page);
    const input = dialog.getByLabel('Choose recovery backup', { exact: true });
    await input.setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(32 * 1024 * 1024 + 1, ' ') });
    await dialog.getByRole('alert').getByText(/Backup file problem \(RecoveryTooLarge\)/).waitFor();
    assert.equal(await page.evaluate(() => window.recoveryReads), 0);
    await input.setInputFiles({ name: 'bad.json', mimeType: '', buffer: Buffer.from('{secret-file-content: data:image/private}') });
    await dialog.getByRole('alert').getByText(/InvalidRecovery/).waitFor();
    assert.ok(!(await dialog.innerText()).includes('secret-file-content'));
    await page.evaluate(() => { window.failRecoveryRead = true; });
    await input.setInputFiles(recoveryFile());
    await dialog.getByRole('alert').getByText(/RecoveryReadFailed/).waitFor();
    assert.ok(!(await dialog.innerText()).includes('private raw read error'));
    await page.evaluate(() => { window.failRecoveryRead = false; });
    await input.setInputFiles(recoveryFile());
    const preview = dialog.getByRole('region', { name: 'Backup preview', exact: true }); await preview.waitFor();
    assert.deepEqual(await preview.locator('dd').allTextContents(), ['2', '3', '1']);
    assert.equal(await input.inputValue(), '');
    assert.deepEqual(await saved(page), original); assert.deepEqual(await storedSettings(page), settingsBefore);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const settings = page.getByRole('dialog', { name: 'Configuration Settings', exact: true });
    await settings.getByPlaceholder('custom-model-name').fill('Unsaved settings form draft');
    await settings.getByRole('button', { name: 'Restore backup', exact: true }).click(); await dialog.waitFor();
    await input.setInputFiles(recoveryFile()); await preview.waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await settings.getByPlaceholder('custom-model-name').inputValue(), 'Unsaved settings form draft');
    assert.deepEqual(await saved(page), original); assert.equal((await attachmentRecords(page)).length, 0);
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('recovery UI: import merges copies beside RAM-only run/draft/settings; only View restored chat switches and nothing resumes', async ({ page, state }) => {
    const image = await imageFile(page);
    const backup = recoveryFixture();
    const record = { id: 'backup-image', name: image.name, kind: 'image', mediaType: 'image/png', size: image.buffer.length, data: `data:image/png;base64,${image.buffer.toString('base64')}` };
    backup.attachments.push(record);
    backup.sessions[0].messages[0].attachments.push({ id: record.id, name: record.name, kind: record.kind, mediaType: record.mediaType, size: record.size });
    const original = await saved(page); const settingsBefore = await storedSettings(page);
    const storage = await storageControls(page); await storage.fail(true);
    let release; state.reply = async () => new Promise(resolve => { release = resolve; });
    await send(page, 'Current RAM chat fixture'); await until(() => release);
    await page.getByLabel('Message', { exact: true }).fill('Keep current composer draft');
    await page.getByRole('alert', { name: 'Local storage', exact: true }).getByRole('button', { name: 'Restore backup', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore backup', exact: true }); await dialog.waitFor();
    await dialog.getByLabel('Choose recovery backup', { exact: true }).setInputFiles(recoveryFile(backup));
    await dialog.getByRole('button', { name: 'Import 2 chats', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dialog.getByRole('status').getByText('Restored 2 chats as new copies.', { exact: true }).waitFor();
    assert.equal(state.models.length, 1); assert.equal(state.tools, 0);
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Keep current composer draft');
    assert.ok((await page.getByLabel('Chat history').innerText()).includes('Current RAM chat fixture'));
    assert.ok(!(await page.getByLabel('Chat history').innerText()).includes('Restored chat fixture'));
    assert.equal(await page.getByTitle('Stop generating', { exact: true }).count(), 1, 'import did not stop the current run');
    assert.equal(await sessionRow(page, 'Current RAM chat fixture').count(), 1, 'RAM-only chat is still in the sidebar');
    const copies = await saved(page); assert.equal(copies.length, original.length + 2);
    assert.deepEqual(copies.find(session => session.id === 'history'), original.find(session => session.id === 'history'));
    assert.deepEqual(await storedSettings(page), settingsBefore);
    const restored = copies.find(session => session.title === 'Restored chat fixture');
    assert.notEqual(restored.id, 'backup-chat');
    assert.equal(restored.messages[1].execution.status, 'interrupted');
    assert.equal(restored.messages[1].toolInvocations[0].state, 'result');
    assert.equal(restored.messages[1].toolInvocations[0].serverId, undefined);
    await dialog.getByRole('button', { name: 'View restored chat', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Restored chat fixture', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm & Run', exact: true }).count(), 0);
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview pixel.png', exact: true }).click();
    await page.getByRole('img', { name: 'Preview of pixel.png', exact: true }).waitFor();
    await page.getByLabel('Message attachments').getByRole('button', { name: 'Preview restored.txt', exact: true }).click();
    await page.getByLabel('Chat history').getByText('Restored payload', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'Keep current composer draft');
    release([{ type: 'text-delta', delta: 'LATE OLD RESPONSE' }, finish]); await page.waitForTimeout(100);
    assert.equal(await page.getByText('LATE OLD RESPONSE', { exact: true }).count(), 0);
    assert.equal(state.models.length, 1); assert.equal(state.tools, 0);
  });

  await scenario('recovery UI: asynchronous saving disables duplicates/Escape; atomic storage failure is safe and same-file retry works', async ({ page, state }) => {
    const image = await imageFile(page);
    const backup = recoveryFixture({ id: 'backup-image', name: image.name, kind: 'image', mediaType: 'image/png', size: image.buffer.length, data: `data:image/png;base64,${image.buffer.toString('base64')}` });
    const original = await saved(page);
    await page.evaluate(() => {
      const decode = window.createImageBitmap; const add = IDBObjectStore.prototype.add;
      let release; const gate = new Promise(resolve => { release = resolve; });
      window.recoverySave = { fail: true, release };
      window.createImageBitmap = async (...args) => { await gate; return decode(...args); };
      IDBObjectStore.prototype.add = function(value, ...args) {
        if (this.name === 'sessions' && value.title === 'Second restored fixture' && window.recoverySave.fail) throw new DOMException('secret raw storage payload', 'QuotaExceededError');
        return add.call(this, value, ...args);
      };
    });
    const dialog = await openRestore(page);
    const input = dialog.getByLabel('Choose recovery backup', { exact: true });
    const file = recoveryFile(backup); await input.setInputFiles(file);
    await dialog.getByRole('button', { name: 'Import 2 chats', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dialog.getByText('Saving restored copies… Keep this tab open.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Choose another file', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
    await page.evaluate(() => window.recoverySave.release());
    await dialog.getByRole('alert').getByText('Local storage problem (QuotaExceededError)', { exact: true }).waitFor();
    assert.ok(!(await dialog.innerText()).includes('secret raw storage payload'));
    assert.deepEqual(await saved(page), original); assert.equal((await attachmentRecords(page)).length, 0);
    assert.equal(await input.inputValue(), '');
    await page.evaluate(() => { window.recoverySave.fail = false; });
    await input.setInputFiles(file);
    await dialog.getByRole('button', { name: 'Import 2 chats', exact: true }).click();
    await dialog.getByText('Restored 2 chats as new copies.', { exact: true }).waitFor();
    assert.equal((await saved(page)).length, original.length + 2); assert.equal((await attachmentRecords(page)).length, 1);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.models.length, 0); assert.equal(state.tools, 0);
  });

  await scenario('recovery UI mobile: bounded dialog, focus and Cancel remain reachable without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    const dialog = await openRestore(page);
    await dialog.getByLabel('Choose recovery backup', { exact: true }).setInputFiles(recoveryFile());
    await dialog.getByRole('button', { name: 'Import 2 chats', exact: true }).waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 16 && box.x + box.width <= 374 && box.y >= 16 && box.y + box.height <= 828);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true); }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('dialog', { name: 'Configuration Settings', exact: true }).isVisible(), true);
  });

  await scenario('storage retry UI: chat saving success never hides pending settings; safe codes, blocked-tab advice and final success feedback', async ({ page, state }) => {
    const storage = await storageControls(page); await storage.fail(true);
    state.reply = async () => [{ type: 'text-delta', delta: 'Answer retained in RAM' }, finish];
    await send(page, 'Saving feedback fixture'); await idle(page);
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('status').getByText(/Retry finished\. Some local data is still unsaved/).waitFor();
    await page.getByRole('alert', { name: 'Local storage', exact: true }).getByText(/Local saving is unavailable \(QuotaExceededError\)/).waitFor();
    assert.equal(await page.getByText('Pending chats and settings saved locally.', { exact: true }).count(), 0);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put; window.failSettingsSave = true;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.name === 'settings' && window.failSettingsSave) throw new DOMException('not safe to display raw', 'StorageBlockedError');
        return put.apply(this, args);
      };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Configuration Settings', exact: true });
    await settings.getByPlaceholder('custom-model-name').fill('Retained model setting');
    await settings.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await settings.getByRole('alert').waitFor(); await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await storage.fail(false); await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('status').getByText(/Retry finished\. Some local data is still unsaved/).waitFor();
    const warning = page.getByRole('alert', { name: 'Local storage', exact: true });
    await warning.getByText(/Close other tabs or windows using this address/).waitFor();
    assert.ok(!(await warning.innerText()).includes('not safe to display raw'));
    assert.equal(await page.getByText('Pending chats and settings saved locally.', { exact: true }).count(), 0);
    await page.evaluate(() => { window.failSettingsSave = false; });
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByRole('status').getByText('Pending chats and settings saved locally.', { exact: true }).waitFor();
    await warning.waitFor({ state: 'hidden' }); assert.equal(state.models.length, 1);
  });

  console.log(`${passes}/${passes} browser scenarios passed`);
} finally {
  await browser.close();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
}
