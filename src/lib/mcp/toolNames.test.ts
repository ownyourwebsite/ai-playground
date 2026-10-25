import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignToolNames } from './toolNames';

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;
const server = (id: string, name: string, ...tools: string[]) => ({ id, name, tools: tools.map(t => ({ name: t })) });
const all = (servers: ReturnType<typeof server>[]) => {
  const name = assignToolNames(servers);
  return servers.flatMap(s => s.tools.map(t => name(s.id, t.name)));
};
const assertSafe = (names: string[]) => {
  for (const n of names) assert.match(n, VALID);
  assert.equal(new Set(names).size, names.length, 'names are unique');
};

test('a single server with valid unique names keeps them unchanged', () => {
  const name = assignToolNames([server('github', 'GitHub Integration', 'create_issue', 'get-file_v2', 'a'.repeat(64))]);
  assert.equal(name('github', 'create_issue'), 'create_issue');
  assert.equal(name('github', 'get-file_v2'), 'get-file_v2');
  assert.equal(name('github', 'a'.repeat(64)), 'a'.repeat(64));
});

test('a lone server with tools still keeps names when other connected servers have none', () => {
  const name = assignToolNames([server('a', 'A', 'read'), server('b', 'B')]);
  assert.equal(name('a', 'read'), 'read');
});

test('a single server sanitizes invalid names and hashes only on collision or length', () => {
  const names = all([server('s', 'S', 'search code', 'search.code', 'ok', 'файл', 'x'.repeat(100))]);
  assertSafe(names);
  assert.equal(names[2], 'ok');
  assert.match(names[0], /^search_code_[0-9a-z]{6}$/);
  assert.match(names[1], /^search_code_[0-9a-z]{6}$/);
  assert.notEqual(names[0], names[1]);
  assert.equal(names[3], 'tool', 'a name with no valid characters still gets a valid name');
  assert.equal(names[4].length, 64);
  assert.match(names[4], /^x{57}_[0-9a-z]{6}$/);
});

test('several servers use <sanitized server>_<tool> and stay readable', () => {
  const name = assignToolNames([server('1', 'GitHub Integration', 'create_issue'), server('2', 'My  Tavily/Search', 'search')]);
  assert.equal(name('1', 'create_issue'), 'github_integration_create_issue');
  assert.equal(name('2', 'search'), 'my_tavily_search_search');
});

test('the same tool on two servers is disambiguated', () => {
  const names = all([server('1', 'Alpha', 'search'), server('2', 'Beta', 'search')]);
  assert.deepEqual(names, ['alpha_search', 'beta_search']);
});

test('servers whose names sanitize identically get distinct, stable hashed names', () => {
  const servers = [server('id-1', 'My Server', 'run'), server('id-2', 'my_server', 'run'), server('id-3', 'Мой сервер', 'run'), server('id-4', '日本', 'run')];
  const names = all(servers);
  assertSafe(names);
  assert.ok(names[0].startsWith('my_server_run_') && names[1].startsWith('my_server_run_'));
  assert.ok(names[2].startsWith('server_run_') && names[3].startsWith('server_run_'));
  assert.deepEqual(all(servers), names, 'deterministic');
});

test('names do not depend on the order of servers or tools', () => {
  const a = server('1', 'Same', 'dup', 'x'), b = server('2', 'same', 'dup', 'y'), c = server('3', 'Other', 'dup');
  const forward = assignToolNames([a, b, c]), reversed = assignToolNames([c, b, { ...a, tools: [...a.tools].reverse() }]);
  for (const [s, t] of [['1', 'dup'], ['1', 'x'], ['2', 'dup'], ['2', 'y'], ['3', 'dup']]) assert.equal(forward(s, t), reversed(s, t), `${s}/${t}`);
  assert.equal(forward('3', 'dup'), 'other_dup');
});

test('long names are truncated to 64 chars with a hash and stay unique', () => {
  const long = 'q'.repeat(80);
  const names = all([server('1', 'Server', `${long}a`, `${long}b`, 'short'), server('2', 'Other', 'short')]);
  assertSafe(names);
  assert.ok(names.every(n => n.length <= 64));
  assert.equal(names[2], 'server_short');
  assert.match(names[0], /^server_q{50}_[0-9a-z]{6}$/);
});

test('a long server name cannot push a name over the limit', () => {
  const names = all([server('1', 'S'.repeat(200), 'tool'), server('2', 'T'.repeat(200), 'tool')]);
  assertSafe(names);
  assert.ok(names.every(n => n.length === 64));
});

test('a hashed name never collides with a literal tool name that looks like one', () => {
  const probe = assignToolNames([server('1', 'A', 'dup', 'dup!')]);
  const hashed = probe('1', 'dup');
  const names = all([server('1', 'A', 'dup', 'dup!', hashed)]);
  assertSafe(names);
  assert.equal(names[2], hashed, 'a unique valid literal name wins over generated ones');
});

test('duplicate tool names within one server collapse to a single valid name', () => {
  const name = assignToolNames([server('1', 'A', 'x', 'x', 'y')]);
  assert.equal(name('1', 'x'), 'x');
  assert.equal(name('1', 'y'), 'y');
});

test('unknown lookups fall back to the original name; empty input is fine', () => {
  assert.equal(assignToolNames([])('x', 'tool'), 'tool');
  assert.equal(assignToolNames([server('1', 'A', 'a')])('2', 'b'), 'b');
});

test('pathological input stays valid and unique', () => {
  const tools = Array.from({ length: 200 }, (_, i) => `t ${i % 7}.${'é'.repeat(i % 3)}`);
  const servers = Array.from({ length: 5 }, (_, i) => server(`s${i}`, `srv ${i % 2}`, ...tools));
  const names = all(servers);
  assert.equal(new Set(names).size, new Set(servers.flatMap(s => [...new Set(s.tools.map(t => t.name))].map(t => `${s.id}${t}`))).size);
  for (const n of names) assert.match(n, VALID);
});
