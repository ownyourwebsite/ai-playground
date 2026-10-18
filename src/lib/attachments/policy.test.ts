import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getImageSupport, sniffImageType, MAX_ATTACHMENTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_REQUEST_BYTES } from './policy';

test('attachment policy: shared limits are stable', () => {
  assert.deepEqual([MAX_ATTACHMENTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, MAX_REQUEST_BYTES],
    [4, 262144, 1048576, 2097152, 4000000]);
});

test('attachment policy: exact official IDs only, no optimistic prefixes or aliases', () => {
  for (const [provider, model] of [
    ['openai', 'gpt-4o'], ['openai', 'gpt-4o-mini-2024-07-18'], ['openai', 'gpt-4.1-2025-04-14'],
    ['anthropic', 'claude-3-haiku-20240307'], ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  ]) assert.equal(getImageSupport(provider, model), 'supported');
  for (const [provider, model] of [
    ['openai', 'gpt-3.5-turbo'], ['openai', 'gpt-4'], ['openai', 'o3-mini'],
    ['anthropic', 'claude-2.1'], ['groq', 'llama-3.3-70b-versatile'], ['groq', 'qwen/qwen3-32b'],
  ]) assert.equal(getImageSupport(provider, model), 'unsupported');
  for (const [provider, model] of [
    ['openai', 'gpt-5.6-luna'], ['anthropic', 'claude-sonnet-5'], ['groq', 'qwen/qwen3.6-27b'],
    ['openai', 'gpt-4o-made-up'], ['openai', 'gpt-4o-2099-01-01'], ['openai', 'GPT-4o'],
    ['openai', ' gpt-4o'], ['openai', 'ft:gpt-4o:custom'], ['openai', 'gpt-4-made-up'],
    ['anthropic', 'claude-3-made-up'], ['openai', ''], ['constructor', 'gpt-4o'], ['__proto__', 'gpt-4o'],
    ['custom', 'gpt-4o'], ['custom', 'gpt-3.5-turbo'], ['ollama', 'llava'], ['ollama', 'gpt-4o'],
  ]) assert.equal(getImageSupport(provider, model), 'unknown', `${provider}/${model}`);
});

test('attachment policy: full PNG/JPEG signatures, no GIF/SVG or partial header', () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(sniffImageType(png), 'image/png');
  for (let length = 0; length < 8; length++) assert.equal(sniffImageType(png.slice(0, length)), undefined);
  const wrong = png.slice(); wrong[7] = 0;
  assert.equal(sniffImageType(wrong), undefined);
  assert.equal(sniffImageType(Uint8Array.from([255, 216, 255])), 'image/jpeg');
  assert.equal(sniffImageType(Uint8Array.from([255, 216, 0])), undefined);
  for (const text of ['GIF89a', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'RIFF0000WAVE', 'PNG']) {
    assert.equal(sniffImageType(new TextEncoder().encode(text)), undefined);
  }
});

test('attachment policy: WebP requires RIFF, WEBP and sane matching little-endian length', () => {
  const bytes = new Uint8Array(24);
  bytes.set([82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);
  assert.equal(sniffImageType(bytes), 'image/webp');
  const offset = new Uint8Array(30); offset.set(bytes, 3);
  assert.equal(sniffImageType(offset.subarray(3, 27)), 'image/webp');
  for (const size of [0, 4, 12, 15, 17, 255]) {
    const bad = bytes.slice(); bad[4] = size;
    assert.equal(sniffImageType(bad), undefined);
  }
  const wrong = bytes.slice(); wrong[8] = 0;
  assert.equal(sniffImageType(wrong), undefined);
  assert.equal(sniffImageType(bytes.slice(0, 12)), undefined);
});
