import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
  SsrfBlockedError,
  createValidatingLookup,
  isPrivateIPAddress,
  isPrivateHostname,
  privateNetworkAllowed,
  ssrfSafeFetch,
  stripBrackets,
  streamingFetch,
} from "./ssrf";

const ENV_KEYS = ["NODE_ENV", "ALLOW_PRIVATE_NETWORK", "ALLOW_PRIVATE_MCP"] as const;
const env = process.env as Record<string, string | undefined>;

/** Runs fn with the policy env vars set to `vars` (others unset), then restores. */
async function withEnv(vars: Record<string, string>, fn: () => unknown | Promise<unknown>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
  for (const k of ENV_KEYS) delete env[k];
  Object.assign(env, vars);
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  }
}

/** Starts a local server; returns its base URL and a closer. */
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("isPrivateIPAddress: IPv4 private and reserved ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "198.18.0.5", // benchmarking
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255",
    "192.0.2.9", // TEST-NET-1
  ]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: public IPv4 addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "172.32.0.1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIPAddress: IPv6 loopback / link-local / unique local", () => {
  for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::abcd", "2001:db8::1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: IPv4-mapped IPv6 bypass is blocked", () => {
  for (const ip of [
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::FFFF:192.168.0.1",
  ]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: zone ids are stripped", () => {
  assert.strictEqual(isPrivateIPAddress("fe80::1%eth0"), true);
  assert.strictEqual(isPrivateIPAddress("::ffff:127.0.0.1%1"), true);
});

test("isPrivateIPAddress: public IPv6 addresses are allowed", () => {
  assert.strictEqual(isPrivateIPAddress("2606:4700:4700::1111"), false);
  assert.strictEqual(isPrivateIPAddress("febf::1"), true); // still link-local
  assert.strictEqual(isPrivateIPAddress("fec0::1"), false); // deprecated site-local, not blocked
});

test("isPrivateIPAddress: invalid input is treated as private", () => {
  assert.strictEqual(isPrivateIPAddress("not-an-ip"), true);
  assert.strictEqual(isPrivateIPAddress("999.999.999.999"), true);
});

test("isPrivateHostname: localhost variants and metadata names", () => {
  assert.strictEqual(isPrivateHostname("localhost"), true);
  assert.strictEqual(isPrivateHostname("api.localhost"), true);
  assert.strictEqual(isPrivateHostname("foo.local"), true);
  assert.strictEqual(isPrivateHostname("service.internal"), true);
  assert.strictEqual(isPrivateHostname("metadata.google.internal"), true);
  assert.strictEqual(isPrivateHostname("LOCALHOST."), true); // FQDN trailing dot
  assert.strictEqual(isPrivateHostname("example.com"), false);
  assert.strictEqual(isPrivateHostname("localhost.example.com"), false);
});

test("stripBrackets: IPv6 literal brackets are removed", () => {
  assert.strictEqual(stripBrackets("[::1]"), "::1");
  assert.strictEqual(stripBrackets("example.com"), "example.com");
});

test("privateNetworkAllowed: policy matrix", async () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "test" }, false],
    [{}, false],
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "production", ALLOW_PRIVATE_NETWORK: "1" }, true],
    [{ NODE_ENV: "production", ALLOW_PRIVATE_MCP: "1" }, true], // deprecated alias
    [{ NODE_ENV: "production", ALLOW_PRIVATE_NETWORK: "0", ALLOW_PRIVATE_MCP: "0" }, false],
    [{ NODE_ENV: "production", ALLOW_PRIVATE_NETWORK: "true" }, false], // only "1"
    [{ NODE_ENV: "development", ALLOW_PRIVATE_NETWORK: "0" }, true],
  ];
  for (const [vars, expected] of cases) {
    await withEnv(vars, () =>
      assert.strictEqual(privateNetworkAllowed(), expected, JSON.stringify(vars))
    );
  }
});

test("isPrivateIPAddress: NAT64 64:ff9b::/96 evaluates the embedded IPv4", () => {
  for (const ip of ["64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ["64:ff9b::808:808", "64:ff9b::8.8.8.8"]) {
    assert.strictEqual(isPrivateIPAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIPAddress: local-use NAT64 64:ff9b:1::/48 is private", () => {
  for (const ip of ["64:ff9b:1::1", "64:ff9b:1::808:808", "64:ff9b:1:ffff::1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: 6to4 2002::/16 evaluates the embedded IPv4", () => {
  for (const ip of ["2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:c0a8:101::1", "2002:0a00:0001::"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ["2002:808:808::1", "2002:0808:0808:1:2:3:4:5"]) {
    assert.strictEqual(isPrivateIPAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIPAddress: Teredo 2001:0::/32 is blocked", () => {
  for (const ip of ["2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:0000:ffff::"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
  assert.strictEqual(isPrivateIPAddress("2001:4860:4860::8888"), false); // not Teredo
});

test("isPrivateIPAddress: IPv4-mapped, compatible, translated, multicast", () => {
  for (const ip of [
    "::ffff:7f00:1", // hex form of 127.0.0.1
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:1",
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::127.0.0.1", // IPv4-compatible
    "::7f00:1",
    "::a00:1",
    "::0",
    "ff02::1", // multicast
    "ff00::",
    "fe80::1",
    "fc00::1",
    "fdff:ffff::1",
    "100::1", // discard-only
  ]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ["::ffff:808:808", "::ffff:8.8.8.8", "::808:808", "2a00:1450:4001::1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), false, `${ip} should be public`);
  }
});

test("createValidatingLookup: drops private resolutions, keeps public ones", async () => {
  const resolverOf = (addrs: Array<{ address: string; family: number }>) =>
    ((_h: string, _o: unknown, cb: (e: null, a: typeof addrs) => void) => cb(null, addrs)) as never;
  const run = (addrs: Array<{ address: string; family: number }>, opts: { all?: boolean; family?: number }) =>
    new Promise<{ err: unknown; res: unknown; family?: number }>((resolve) =>
      createValidatingLookup(resolverOf(addrs))("x.test", opts, (err, res, family) =>
        resolve({ err, res, family })
      )
    );

  const priv = await run([{ address: "127.0.0.1", family: 4 }, { address: "::ffff:7f00:1", family: 6 }], { all: true });
  assert.ok(priv.err instanceof SsrfBlockedError);
  assert.strictEqual((priv.err as SsrfBlockedError).code, "EBLOCKED");

  const mixed = [
    { address: "10.0.0.1", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ];
  const all = await run(mixed, { all: true });
  assert.strictEqual(all.err, null);
  assert.deepStrictEqual(all.res, [{ address: "8.8.8.8", family: 4 }]);

  const single = await run(mixed, {});
  assert.strictEqual(single.res, "8.8.8.8");
  assert.strictEqual(single.family, 4);

  // resolver errors pass through
  const failing = ((_h: string, _o: unknown, cb: (e: Error, a: never[]) => void) =>
    cb(new Error("ENOTFOUND"), [])) as never;
  const failed = await new Promise<unknown>((resolve) =>
    createValidatingLookup(failing)("x.test", { all: true }, (err) => resolve(err))
  );
  assert.match((failed as Error).message, /ENOTFOUND/);
});

test("ssrfSafeFetch: private targets are rejected in production mode", async () => {
  const srv = await listen((_req, res) => res.end("secret"));
  try {
    await withEnv({ NODE_ENV: "production" }, async () => {
      for (const url of [
        srv.base, // http + loopback
        "https://127.0.0.1/",
        "https://localhost/v1",
        "https://[::1]/",
        "https://169.254.169.254/latest/meta-data",
        "https://[64:ff9b::7f00:1]/",
      ]) {
        await assert.rejects(ssrfSafeFetch(url), SsrfBlockedError, url);
      }
      await assert.rejects(ssrfSafeFetch(new URL(srv.base)), SsrfBlockedError);
      await assert.rejects(ssrfSafeFetch(new Request(srv.base)), (e: unknown) => (e as SsrfBlockedError).code === "EBLOCKED");
    });
  } finally {
    await srv.close();
  }
});

test("streamingFetch: connect-time lookup blocks private resolutions (DNS rebinding)", async () => {
  const srv = await listen((_req, res) => res.end("secret"));
  try {
    const port = new URL(srv.base).port;
    const rebind = createValidatingLookup(((_h: string, _o: unknown, cb: (e: null, a: unknown[]) => void) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
    await assert.rejects(
      streamingFetch(`http://rebind.test:${port}/`, undefined, rebind),
      (e: unknown) => e instanceof SsrfBlockedError && e.code === "EBLOCKED"
    );
  } finally {
    await srv.close();
  }
});

test("streamingFetch: body streams before the server ends the response", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const srv = await listen(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    await gate; // hold the response open until the client has seen chunk 1
    res.end("data: two\n\n");
  });
  try {
    const r = await streamingFetch(srv.base);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get("content-type"), "text/event-stream");
    const reader = r.body!.getReader();
    const first = await reader.read();
    assert.strictEqual(new TextDecoder().decode(first.value), "data: one\n\n");
    assert.strictEqual(first.done, false);
    finish();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.strictEqual(rest, "data: two\n\n");
  } finally {
    finish();
    await srv.close();
  }
});

test("ssrfSafeFetch: with private networks allowed it delegates and streams", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const srv = await listen(async (_req, res) => {
    res.write("hello");
    await gate;
    res.end("bye");
  });
  try {
    await withEnv({ NODE_ENV: "production", ALLOW_PRIVATE_NETWORK: "1" }, async () => {
      const r = await ssrfSafeFetch(srv.base);
      const reader = r.body!.getReader();
      assert.strictEqual(new TextDecoder().decode((await reader.read()).value), "hello");
      finish();
      await reader.cancel();
    });
  } finally {
    finish();
    await srv.close();
  }
});

test("streamingFetch: methods, headers, bodies and responses", async () => {
  const seen: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const srv = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, headers: req.headers, body });
      const path = req.url;
      if (path === "/204") return void res.writeHead(204).end();
      if (path === "/gzip") {
        res.writeHead(200, { "content-encoding": "gzip" });
        return void res.end(gzipSync("zipped"));
      }
      if (path === "/redirect") return void res.writeHead(302, { location: "/204" }).end();
      if (path === "/multi") {
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.setHeader("x-multi", ["p", "q"]);
        return void res.end("ok");
      }
      res.end(body);
    });
  });
  try {
    // JSON string body + plain-object headers
    let r = await streamingFetch(srv.base + "/echo", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.strictEqual(await r.text(), '{"a":1}');
    assert.strictEqual(seen.at(-1)!.method, "POST");
    assert.strictEqual(seen.at(-1)!.headers.authorization, "Bearer k");
    assert.strictEqual(seen.at(-1)!.headers["content-length"], "7");

    // array headers + Uint8Array body
    r = await streamingFetch(srv.base + "/echo", {
      method: "PUT",
      headers: [["x-a", "1"], ["content-type", "application/octet-stream"]],
      body: new Uint8Array([104, 105]),
    });
    assert.strictEqual(await r.text(), "hi");
    assert.strictEqual(seen.at(-1)!.headers["x-a"], "1");

    // Headers instance + URLSearchParams body
    r = await streamingFetch(srv.base + "/echo", {
      method: "POST",
      headers: new Headers({ "x-b": "2" }),
      body: new URLSearchParams({ q: "1" }),
    });
    assert.strictEqual(await r.text(), "q=1");
    assert.match(String(seen.at(-1)!.headers["content-type"]), /x-www-form-urlencoded/);

    // Request input
    r = await streamingFetch(new Request(srv.base + "/echo", { method: "POST", body: "from-request" }));
    assert.strictEqual(await r.text(), "from-request");

    // ReadableStream body
    r = await streamingFetch(srv.base + "/echo", {
      method: "POST",
      body: new Blob(["blob-body"]).stream(),
    });
    assert.strictEqual(await r.text(), "blob-body");

    // encoded responses are decoded
    r = await streamingFetch(srv.base + "/gzip");
    assert.strictEqual(await r.text(), "zipped");
    assert.strictEqual(r.headers.get("content-encoding"), null);

    // multi-value response headers
    r = await streamingFetch(srv.base + "/multi");
    assert.strictEqual(r.headers.get("x-multi"), "p, q");
    assert.deepStrictEqual(r.headers.getSetCookie(), ["a=1", "b=2"]);

    // null-body status
    r = await streamingFetch(srv.base + "/204");
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.body, null);

    // redirects are returned, not followed
    r = await streamingFetch(srv.base + "/redirect");
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get("location"), "/204");

    // GET with body is a TypeError, like fetch
    await assert.rejects(streamingFetch(srv.base, { body: "x" }), TypeError);
  } finally {
    await srv.close();
  }
});

test("streamingFetch: abort cancels the request and the response stream", async () => {
  const srv = await listen((req, res) => {
    if (req.url === "/hang") return; // never respond
    res.write("first");
  });
  try {
    // abort while waiting for headers
    const c1 = new AbortController();
    const p1 = streamingFetch(srv.base + "/hang", { signal: c1.signal });
    setTimeout(() => c1.abort(), 20);
    await assert.rejects(p1, (e: unknown) => (e as Error).name === "AbortError");

    // already aborted
    await assert.rejects(
      streamingFetch(srv.base, { signal: AbortSignal.abort() }),
      (e: unknown) => (e as Error).name === "AbortError"
    );

    // abort mid-stream
    const c2 = new AbortController();
    const r = await streamingFetch(srv.base + "/stream", { signal: c2.signal });
    const reader = r.body!.getReader();
    assert.strictEqual(new TextDecoder().decode((await reader.read()).value), "first");
    const next = reader.read();
    c2.abort();
    await assert.rejects(next);
  } finally {
    await srv.close();
  }
});
