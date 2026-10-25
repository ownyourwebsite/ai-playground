// Provider-safe tool names. OpenAI/Anthropic/Groq accept only [a-zA-Z0-9_-]{1,64}, unique per request.
const VALID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_LENGTH = 64;
const HASH_LENGTH = 6;

type ServerTools = { id: string; name: string; tools: Array<{ name: string }> };

/** FNV-1a (32-bit) as a fixed-width base36 string. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 36 ** HASH_LENGTH).toString(36).padStart(HASH_LENGTH, '0');
}

const sanitize = (value: string, fallback: string) =>
  value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;

const withHash = (base: string, serverId: string, toolName: string, salt: number) =>
  `${base.slice(0, MAX_LENGTH - HASH_LENGTH - 1)}_${shortHash(`${serverId}\0${toolName}${salt ? `\0${salt}` : ''}`)}`;

const keyOf = (serverId: string, toolName: string) => JSON.stringify([serverId, toolName]);

/**
 * Assigns each (server, tool) a valid, unique provider-facing name and returns a lookup
 * `(serverId, originalToolName) => name`. Deterministic. A name depends only on its own
 * server/tool, except that colliding names are all disambiguated with a hash of
 * serverId + original name, so server order never changes a name.
 * One server (or one with tools): valid names stay unchanged; several: `<server>_<tool>`.
 */
export function assignToolNames(servers: ServerTools[]): (serverId: string, toolName: string) => string {
  const prefixed = servers.filter(s => s.tools.length > 0).length > 1;
  const seen = new Set<string>();
  const entries: Array<{ serverId: string; toolName: string; base: string; order: number }> = [];
  for (const server of servers) {
    const prefix = sanitize(server.name, 'server').toLowerCase();
    for (const tool of server.tools) {
      const key = keyOf(server.id, tool.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const base = prefixed ? `${prefix}_${sanitize(tool.name, 'tool')}`
        : VALID.test(tool.name) ? tool.name : sanitize(tool.name, 'tool');
      entries.push({ serverId: server.id, toolName: tool.name, base, order: entries.length });
    }
  }
  const counts = new Map<string, number>();
  for (const { base } of entries) counts.set(base, (counts.get(base) ?? 0) + 1);

  const names = new Map<string, string>();
  const used = new Set<string>();
  const pending = [];
  for (const entry of entries) {
    if (counts.get(entry.base) === 1 && entry.base.length <= MAX_LENGTH) {
      names.set(keyOf(entry.serverId, entry.toolName), entry.base);
      used.add(entry.base);
    } else pending.push(entry);
  }
  // Rare hash/name clashes resolve in a fixed order, independent of server order.
  pending.sort((a, b) => a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : a.order - b.order);
  for (const { serverId, toolName, base } of pending) {
    let salt = 0, name = withHash(base, serverId, toolName, salt);
    while (used.has(name)) name = withHash(base, serverId, toolName, ++salt);
    used.add(name);
    names.set(keyOf(serverId, toolName), name);
  }
  return (serverId, toolName) => names.get(keyOf(serverId, toolName)) ?? toolName;
}
