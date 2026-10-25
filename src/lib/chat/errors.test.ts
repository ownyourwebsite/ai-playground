import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APICallError, NoOutputGeneratedError, RetryError } from 'ai';
import { chatError, classifyError, decodeError, retryDelay } from './errors';

const secret = 'private-fixture-key-and-file-content';
const imageMessage = 'No endpoints found that support image input';

test('provider errors: OpenRouter image 404 survives real SDK wrappers without leaking diagnostics', () => {
  const original = new APICallError({
    message: `Upstream failure ${secret}`, statusCode: 404,
    url: `https://example.invalid/${secret}`,
    requestBodyValues: { image: `data:image/png;base64,${secret}`, key: secret },
    responseHeaders: { authorization: secret },
    responseBody: JSON.stringify({ error: { message: imageMessage, code: 404, metadata: { raw: secret } } }),
  });
  const retry = new RetryError({ message: `Wrapped ${secret}`, reason: 'maxRetriesExceeded', errors: [original] });
  for (const error of [original, retry, new NoOutputGeneratedError({ cause: retry }),
    new Error('Wrapper', { cause: original }), { error: original }, { errors: [original] }]) {
    const classified = classifyError(error);
    assert.deepEqual(classified, chatError('image-incompatible'));
    assert.ok(!JSON.stringify(classified).includes(secret));
    assert.equal(retryDelay(classified, 0, 0), null);
  }
});

test('provider errors: image rejection is distinct from invalid image content and generic 404', () => {
  for (const message of [imageMessage, 'This model does not support image inputs',
    'Image input is not supported', 'Unsupported image modality', 'image_input_not_supported',
    'This model only supports text input', 'Vision is not available for this model',
    'Image inputs are not supported', 'Unsupported input modality: image', 'Does not accept images']) {
    assert.equal(classifyError({ statusCode: 400, message }).category, 'image-incompatible', message);
  }
  for (const error of [{ statusCode: 404 }, { code: 'model_not_found' },
    { message: 'No endpoints found for the requested model' }, { message: 'Model does not exist' },
    { error: { code: 'DeploymentNotFound' } }]) {
    assert.deepEqual(classifyError(error), chatError('model-not-found'));
  }
  for (const message of ['Invalid image data', 'Image too large', 'Unsupported image format',
    'Image URL could not be downloaded', 'Invalid tool schema']) {
    assert.equal(classifyError({ statusCode: 400, message }).category, 'provider');
  }
});

test('provider errors: Responses and other structured streaming error envelopes are recognized', () => {
  for (const error of [{ type: 'error', code: 'unsupported_image', message: imageMessage },
    { type: 'response.failed', code: 'bad_request', message: imageMessage },
    { type: 'response.failed', response: { error: { code: 'bad_request', message: imageMessage } } },
    { data: { error: { message: imageMessage } } }]) {
    assert.deepEqual(classifyError(error, { streaming: true }), chatError('image-incompatible'));
  }
});

test('provider errors: preserve quota/context/auth/rate-limit classification across wrappers', () => {
  for (const [error, category] of [
    [{ statusCode: 402 }, 'quota'], [{ statusCode: 429, message: 'insufficient_quota' }, 'quota'],
    [{ statusCode: 400, message: 'context_length_exceeded' }, 'context'], [{ statusCode: 413 }, 'context'],
    [{ statusCode: 401 }, 'auth'], [{ statusCode: 403 }, 'auth'],
    [{ code: 'invalid_api_key' }, 'auth'], [{ statusCode: 429 }, 'provider-rate-limit'],
  ] as const) {
    assert.equal(classifyError({ cause: error }).category, category);
  }
  const rateLimited = { statusCode: 429, responseHeaders: { 'retry-after': '60' } };
  assert.ok(classifyError(rateLimited).retryAt! >= Date.now() + 59000);
  assert.equal(classifyError(rateLimited).retryable, true);
  assert.equal(classifyError(rateLimited, { streaming: true }).retryable, false);
  for (const statusCode of [500, 502, 503, 504]) {
    assert.deepEqual(classifyError({ statusCode }), chatError('provider'));
  }
});

test('provider errors: ignore echoed requests, unknown raw metadata, excessive nesting and cycles', () => {
  for (const error of [null, undefined, 1, [], secret, new Error(secret),
    { requestBodyValues: { message: imageMessage }, responseBody: JSON.stringify({ input: { message: imageMessage } }) },
    { data: { metadata: { raw: imageMessage } } },
    { responseBody: JSON.stringify({ error: { message: imageMessage }, padding: 'x'.repeat(32768) }) },
  ]) assert.deepEqual(classifyError(error), chatError('provider'));
  const cycle: Record<string, unknown> = { message: secret }; cycle.cause = cycle;
  assert.deepEqual(classifyError(cycle), chatError('provider'));
  let deep: unknown = { message: imageMessage };
  for (let i = 0; i < 100; i++) deep = { cause: deep };
  assert.deepEqual(classifyError(deep), chatError('provider'));
});

test('provider errors: wire decoder rebuilds allow-listed messages, not raw body/base64/key', () => {
  for (const category of ['request', 'tool-schema', 'attachment', 'image-incompatible', 'model-not-found', 'provider'] as const) {
    const decoded = decodeError(JSON.stringify({ category, message: secret, responseBody: secret, code: secret,
      key: secret, data: `data:image/png;base64,${secret}`, retryable: false }));
    assert.deepEqual(decoded, chatError(category));
  }
});

test('provider errors: OpenAI organization verification gets its own actionable message', () => {
  const error = new APICallError({
    message: 'Your organization must be verified to stream this model. Please go to: https://platform.openai.com/settings/organization/general',
    url: 'https://api.openai.com/v1/responses', requestBodyValues: { input: secret }, statusCode: 400, isRetryable: false,
  });
  const classified = classifyError(error);
  assert.deepEqual(classified, chatError('org-verification'));
  assert.ok(classified.message.includes('platform.openai.com/settings/organization/general'));
  assert.ok(!JSON.stringify(classified).includes(secret));
  assert.equal(classifyError({ statusCode: 400, message: 'Unknown parameter: reasoning.summary' }).category, 'provider');
});

test('provider errors: SSRF blocks at connect time map to private-network, even when wrapped', async () => {
  const { SsrfBlockedError } = await import('../ssrf');
  const blocked = new SsrfBlockedError(`Blocked private address for ${secret}`);
  for (const error of [blocked, new TypeError('fetch failed', { cause: blocked }), { cause: { cause: { code: 'EBLOCKED' } } }]) {
    const classified = classifyError(error);
    assert.deepEqual(classified, chatError('private-network'));
    assert.ok(!classified.message.includes(secret));
  }
  assert.equal(classifyError({ code: 'ECONNREFUSED' }).category, 'provider');
});
