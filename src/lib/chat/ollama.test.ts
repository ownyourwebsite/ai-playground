import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOllamaBaseUrl } from './ollama';

test('Ollama endpoint: native /api, root and explicit /v1 normalize to chat-compatible base', () => {
  assert.equal(normalizeOllamaBaseUrl(), 'http://127.0.0.1:11434/v1');
  for (const path of ['', '/', '///', '/api', '/api/', '/v1', '/v1/']) {
    assert.equal(normalizeOllamaBaseUrl(`http://localhost:11434${path}`), 'http://localhost:11434/v1');
  }
  for (const path of ['/proxy', '/proxy/', '/proxy/api', '/proxy/api/', '/proxy/v1/']) {
    assert.equal(normalizeOllamaBaseUrl(`https://example.com${path}`), 'https://example.com/proxy/v1');
  }
  assert.equal(normalizeOllamaBaseUrl('http://[::1]:11434/api'), 'http://[::1]:11434/v1');
});

test('Ollama endpoint: no credentials, query/fragment or non-http transports', () => {
  for (const value of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://example.com', 'https://user:secret@example.com/api',
    'http://localhost/api?secret=1', 'http://localhost/api#secret']) {
    assert.throws(() => normalizeOllamaBaseUrl(value), { message: 'Invalid Ollama endpoint.' });
  }
});
