import type { ChatError } from '../types';

const messages: Record<ChatError['category'], string> = {
  'app-rate-limit': 'Application request limit reached. Your conversation is retained in this tab.',
  'redis-unavailable': 'Application rate-limit service is unavailable. Your conversation is retained in this tab.',
  'provider-rate-limit': 'Provider temporarily limited requests. Received text and tool results are retained.',
  quota: 'Provider quota or balance exhausted. Check your provider account.',
  context: 'Model context limit exceeded. Use a model with a larger context or start a separate chat.',
  auth: 'Provider authentication failed. Check the configured key and permissions.',
  provider: 'Provider request failed. Received text and tool results are retained.',
  network: 'Connection lost. Any partial response is preserved.',
  timeout: 'Request timed out. Any partial response is preserved.',
  interrupted: 'The response stream ended before completion. Received text is retained; no tool was replayed.',
  'response-limit': 'The model reached its response length limit. The partial answer is retained.',
  'content-filter': 'The provider stopped this response because of its content policy.',
  protocol: 'The provider returned an incomplete or unsupported stream format. Received text is retained.',
  mcp: 'MCP outcome is unknown. Verify the remote result before any new write.',
  storage: 'Local saving is unavailable. Conversations are kept in this tab only until saving recovers.',
  attachment: 'An attachment is missing, invalid, or exceeds the file or message limits. Check the files before sending again.',
  request: 'The chat request is malformed or exceeds the request limits. Check the message structure and request size.',
  'tool-schema': 'A tool input schema is malformed or too deeply nested. MCP tools require an object root schema. Check or reconnect the tool server.',
  'image-incompatible': 'The provider has no endpoint that supports image input for this model or rejects its image modality. Choose an image-capable model; images in conversation history are also sent.',
  'model-not-found': 'The requested model or provider endpoint was not found or is unavailable. Check the model ID, provider base URL and model access.',
};
export function chatError(category: ChatError['category'], retryable = false, retryAt?: number): ChatError {
  return { category, message: messages[category], retryable, ...(retryAt ? { retryAt } : {}) };
}
export function retryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const date = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect only bounded diagnostic fields, never serialize an entire SDK error.
 * SDK wrappers use cause/lastError/errors; stream adapters also emit plain
 * objects with error/data/response.error. Request values, headers (except the
 * retry hint), URLs, metadata/raw bodies and file payloads are not traversed.
 */
function providerSignals(error: unknown) {
  const text: string[] = [];
  const statuses = new Set<number>();
  const seen = new Set<object>();
  let retryAt: number | undefined;
  let visited = 0;
  function visit(value: unknown, depth = 0): void {
    if (typeof value !== 'string' && !record(value)) return;
    if (depth > 8 || ++visited > 32) return;
    if (typeof value === 'string') {
      text.push(value.slice(0, 8192).toLowerCase());
      return;
    }
    if (!record(value) || seen.has(value)) return;
    seen.add(value);
    for (const key of ['message', 'code', 'type', 'name']) {
      if (typeof value[key] === 'string') text.push(value[key].slice(0, 8192).toLowerCase());
    }
    for (const key of ['statusCode', 'status', 'code']) {
      const status = value[key];
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) statuses.add(status);
    }
    if (record(value.responseHeaders)) {
      const header = value.responseHeaders['retry-after'] ?? value.responseHeaders['Retry-After'];
      if (typeof header === 'string') retryAt ??= retryAfter(header);
    }
    for (const key of ['cause', 'lastError', 'error', 'data']) visit(value[key], depth + 1);
    if (record(value.response)) visit(value.response.error, depth + 1);
    if (Array.isArray(value.errors)) {
      for (const child of value.errors.slice(-4).reverse()) visit(child, depth + 1);
    }
    if (typeof value.responseBody === 'string' && value.responseBody.length <= 32768) {
      // JSON error envelopes can include an echoed request: inspect only the
      // diagnostic allow-list, not arbitrary strings in the parsed body.
      try { visit(JSON.parse(value.responseBody), depth + 1); } catch { /* Not an error envelope. */ }
    }
  }
  visit(error);
  return { text: text.join('\n'), statuses, retryAt };
}

function imageIncompatible(text: string): boolean {
  // Format/decoding failures say nothing about the model's image modality.
  // Check each diagnostic separately so an echoed payload cannot join phrases.
  return text.split('\n').some(line => {
    if (/no endpoints? found.{0,160}support.{0,60}image|image[_ -](?:input[_ -])?(?:not[_ -]supported|unsupported)/.test(line)) return true;
    if (/(?:image|vision).{0,40}(?:format|mime|encoding|base64)|unsupported[_ -]image[_ -](?:format|type)|image[_ -](?:parse|decode)/.test(line)) return false;
    return [
      /(?:does not|do not|doesn't|cannot|can't).{0,40}(?:support|accept).{0,60}(?:image|vision)/,
      /(?:images?|vision)(?:[ _-](?:inputs?|modality|content))?(?: is| are)?[ _-](?:not[ _-]supported|unsupported|not[ _-]available)/,
      /unsupported[ _-](?:image|vision)(?:[ _-](?:input|modality|content))?(?:\b|$)/,
      /unsupported.{0,30}(?:input[ _-])?modalit(?:y|ies).{0,40}(?:image|vision)/,
      /(?:model|endpoint).{0,80}only.{0,30}(?:support|accept).{0,30}text.{0,30}(?:input|modality)/,
    ].some(pattern => pattern.test(line));
  });
}

/** Raw upstream diagnostics are classification input only, never output/logs. */
export function classifyError(error: unknown, options: { streaming?: boolean } = {}): ChatError {
  const { text, statuses, retryAt } = providerSignals(error);
  if (/insufficient_quota|quota_exceeded|exceeded.{0,40}quota|\bcredits?\b|\bbalance\b|\bbilling\b|payment required/.test(text) || statuses.has(402)) return chatError('quota');
  if (/context_length|context window|too many tokens|maximum context/.test(text) || statuses.has(413)) return chatError('context');
  if (/api[ _]key.{0,30}(missing|invalid)|invalid_api_key|authentication|unauthorized/.test(text) || statuses.has(401) || statuses.has(403)) return chatError('auth');
  // Match modality rejection, not a corrupt/oversized image or an unrelated
  // 404 merely containing an echoed image. Image incompatibility wins over 404.
  if (imageIncompatible(text)) {
    return chatError('image-incompatible');
  }
  if (statuses.has(404) || /model_not_found|deploymentnotfound|no endpoints? found|(?:model|endpoint|deployment)[^\n]{0,100}(?:not found|does not exist|not available)|unknown model/.test(text)) {
    return chatError('model-not-found');
  }
  // Existing pre-response rate-limit retries remain available, but a stream
  // error (even before visible text) or 5xx may follow a billed generation.
  if (statuses.has(429)) return chatError('provider-rate-limit', !options.streaming, retryAt);
  return chatError('provider');
}
export function decodeError(value: unknown): ChatError {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && Object.hasOwn(messages, parsed.category)) {
      return chatError(parsed.category, parsed.retryable === true, typeof parsed.retryAt === 'number' && Number.isFinite(parsed.retryAt) ? parsed.retryAt : undefined);
    }
  } catch { /* Never expose unknown upstream text. */ }
  return chatError('provider');
}
export function retryDelay(error: ChatError, count: number, waited: number, now = Date.now()): number | null {
  if (!error.retryable || count >= 2) return null;
  const delay = Math.max(1000 * 2 ** count, (error.retryAt ?? now) - now);
  return waited + delay <= 15000 ? delay : null;
}
