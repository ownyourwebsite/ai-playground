import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../types';
import { contextTokens, formatTokens } from './contextUsage';

const assistant = (id: string, usage?: { inputTokens?: number; outputTokens?: number }): Message =>
  ({ id, role: 'assistant', content: '', ...(usage ? { execution: { attemptId: id, usage } } : {}) }) as Message;

test('context tokens: latest reported request counts input plus generated output', () => {
  assert.equal(contextTokens([]), undefined);
  assert.equal(contextTokens([{ id: 'u', role: 'user', content: 'Hi' } as Message, assistant('a')]), undefined);
  assert.equal(contextTokens([assistant('a', { inputTokens: 100, outputTokens: 20 }), assistant('b', { inputTokens: 300, outputTokens: 40 })]), 340);
  assert.equal(contextTokens([assistant('a', { inputTokens: 100 })]), 100, 'missing output counts as zero');
});

test('context tokens: a failed latest attempt falls back to the last known usage', () => {
  assert.equal(contextTokens([assistant('a', { inputTokens: 500, outputTokens: 50 }), assistant('b'), assistant('c', { outputTokens: 9 })]), 550);
});

test('format tokens: compact, rounded and never negative', () => {
  assert.deepEqual([0, 950, 999, 1000, 1234, 12_400, 99_960, 200_000, 999_499, 999_500, 1_234_567, 10_000_000].map(formatTokens),
    ['0', '950', '999', '1k', '1.2k', '12.4k', '100k', '200k', '999k', '1M', '1.2M', '10M']);
  assert.equal(formatTokens(-5), '0');
});
