import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAtBottom, isAwayFromLatest } from './useChatScroll';

test('only real offscreen content can show Latest messages; short chats and bottom rounding cannot', () => {
  assert.equal(isAwayFromLatest({ scrollHeight: 200, clientHeight: 500, scrollTop: 0 }), false);
  assert.equal(isAwayFromLatest({ scrollHeight: 500, clientHeight: 500, scrollTop: 0 }), false);
  assert.equal(isAwayFromLatest({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }), false);
  assert.equal(isAwayFromLatest({ scrollHeight: 1000, clientHeight: 500, scrollTop: 499.4 }), false);
  assert.equal(isAwayFromLatest({ scrollHeight: 1000, clientHeight: 500, scrollTop: 200 }), true);
});

test('chat actions require the actual bottom, but remain available in non-scrollable chats', () => {
  assert.equal(isAtBottom({ scrollHeight: 200, clientHeight: 500, scrollTop: 0 }), true);
  assert.equal(isAtBottom({ scrollHeight: 500, clientHeight: 500, scrollTop: 0 }), true);
  assert.equal(isAtBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 499.4 }), true);
  assert.equal(isAtBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 490 }), false);
  assert.equal(isAtBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 0 }), false);
});
