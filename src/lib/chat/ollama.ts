/** Ollama's native /api URL is not the OpenAI-compatible chat endpoint. */
export function normalizeOllamaBaseUrl(value = 'http://127.0.0.1:11434/api'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Ollama endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Ollama endpoint.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -4);
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}
