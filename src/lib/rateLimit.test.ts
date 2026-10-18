import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { checkRateLimit, rateLimitErrorResponse } from "./rateLimit";

const envKeys = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "RATE_LIMIT_CHAT_PER_MINUTE",
  "RATE_LIMIT_MCP_PER_MINUTE",
  "RATE_LIMIT_REQUIRED",
  "RATE_LIMIT_FAIL_OPEN",
  "RATE_LIMIT_IP_HEADER",
  "RATE_LIMIT_TIMEOUT_MS",
] as const;

function setup(t: TestContext, configured = true) {
  const saved = envKeys.map((key) => [key, process.env[key]] as const);
  for (const key of envKeys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(console, "warn", () => {});
  if (configured) {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fixture-token";
  }
}

function request(headers: HeadersInit = {}) {
  return new Request("https://playground.example/api/chat", { headers });
}

function transactionResult(count: number, ttl = 60, expires = 0) {
  return Response.json([{ result: count }, { result: expires }, { result: ttl }]);
}

test("rate limit: unconfigured local use remains enabled without network access", async (t) => {
  setup(t, false);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  assert.deepEqual(await checkRateLimit(request(), "chat"), { allowed: true });
  assert.equal(fetch.mock.callCount(), 0);
});

test("rate limit: the 21st chat request is rejected, not allowed with NaN remaining", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async () => transactionResult(21, 37));
  assert.deepEqual(await checkRateLimit(request(), "chat"), {
    allowed: false, status: 429, retryAfter: 37,
  });
});

test("rate limit: counts below and exactly at the limit have finite remaining", async (t) => {
  setup(t);
  let count = 19;
  t.mock.method(globalThis, "fetch", async () => transactionResult(count++));
  assert.deepEqual(await checkRateLimit(request(), "chat"), { allowed: true, remaining: 1 });
  assert.deepEqual(await checkRateLimit(request(), "chat"), { allowed: true, remaining: 0 });
});

test("rate limit: count, TTL installation and TTL read use one REST transaction", async (t) => {
  setup(t);
  process.env.UPSTASH_REDIS_REST_URL += "/";
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(1, 60, 1));
  assert.deepEqual(await checkRateLimit(request(), "chat"), { allowed: true, remaining: 19 });
  const [url, options] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(String(url), "https://redis.example/multi-exec");
  assert.equal(options.method, "POST");
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-token");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(options.body)), [
    ["INCR", "ratelimit:chat:shared"],
    ["EXPIRE", "ratelimit:chat:shared", "60", "NX"],
    ["TTL", "ratelimit:chat:shared"],
  ]);
});

test("rate limit: chat and MCP defaults and overrides are separate", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async () => transactionResult(4));
  assert.deepEqual(await checkRateLimit(request(), "mcp"), { allowed: true, remaining: 56 });
  process.env.RATE_LIMIT_CHAT_PER_MINUTE = "3";
  process.env.RATE_LIMIT_MCP_PER_MINUTE = "5";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  assert.deepEqual(await checkRateLimit(request(), "mcp"), { allowed: true, remaining: 1 });
});

test("rate limit: required Redis and incomplete credentials fail closed", async (t) => {
  setup(t, false);
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(1));
  process.env.RATE_LIMIT_REQUIRED = "1";
  assert.deepEqual(await checkRateLimit(request(), "chat"), {
    allowed: false, status: 503, retryAfter: 5,
  });
  delete process.env.RATE_LIMIT_REQUIRED;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.RATE_LIMIT_FAIL_OPEN = "1";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = "fixture-token";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test("rate limit: upstream failures are 503 by default and fail-open is explicit", async (t) => {
  setup(t);
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("https://redis.example fixture-token upstream-secret");
  });
  assert.deepEqual(await checkRateLimit(request(), "chat"), {
    allowed: false, status: 503, retryAfter: 5,
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls), /upstream-secret|fixture-token|redis\.example/);
  process.env.RATE_LIMIT_FAIL_OPEN = "1";
  assert.deepEqual(await checkRateLimit(request(), "chat"), { allowed: true });
});

test("rate limit: malformed transaction results and individual command errors never allow requests", async (t) => {
  setup(t);
  const invalid = [
    null, {}, { error: "transaction discarded" }, [],
    [{ result: 1 }, { result: 1 }],
    [{ error: "INCR failed" }, { result: 1 }, { result: 60 }],
    [{ result: 1 }, { error: "EXPIRE failed" }, { result: 60 }],
    [{ result: 1 }, { result: 1 }, { error: "TTL failed" }],
    ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map((count) =>
      [{ result: count }, { result: 1 }, { result: 60 }]),
    ...[-2, -1, 61, "60", null].map((ttl) =>
      [{ result: 1 }, { result: 1 }, { result: ttl }]),
    [{ result: 1 }, { result: 2 }, { result: 60 }],
  ];
  let current: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(current));
  for (current of invalid) {
    assert.deepEqual(await checkRateLimit(request(), "chat"), {
      allowed: false, status: 503, retryAfter: 5,
    }, JSON.stringify(current));
  }
});

test("rate limit: HTTP errors and invalid JSON are unavailable, not exhausted", async (t) => {
  setup(t);
  let response = new Response("upstream secret", { status: 401 });
  t.mock.method(globalThis, "fetch", async () => response);
  assert.deepEqual(await checkRateLimit(request(), "chat"), {
    allowed: false, status: 503, retryAfter: 5,
  });
  response = new Response("not JSON");
  assert.equal((await checkRateLimit(request(), "mcp")).allowed, false);
});

test("rate limit: forged forwarding headers cannot choose a bucket by default", async (t) => {
  setup(t);
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    keys.push(JSON.parse(String(options.body))[0][1]);
    return transactionResult(1);
  });
  await checkRateLimit(request({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "1.1.1.1" }), "chat");
  await checkRateLimit(request({ "x-forwarded-for": "9.9.9.9" }), "chat");
  assert.deepEqual(keys, ["ratelimit:chat:shared", "ratelimit:chat:shared"]);
});

test("rate limit: a configured trusted header requires one valid IP and canonicalizes IPv6", async (t) => {
  setup(t);
  process.env.RATE_LIMIT_IP_HEADER = "x-real-ip";
  const keys: string[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    keys.push(JSON.parse(String(options.body))[0][1]);
    return transactionResult(1);
  });
  for (const ip of ["2606:4700:0000:0000:0000:0000:0000:1111", "2606:4700::1111", "::ffff:8.8.8.8", "8.8.8.8"]) {
    await checkRateLimit(request({ "x-real-ip": ip, "x-forwarded-for": "9.9.9.9" }), "chat");
  }
  assert.deepEqual(keys, [
    "ratelimit:chat:2606:4700::1111", "ratelimit:chat:2606:4700::1111",
    "ratelimit:chat:8.8.8.8", "ratelimit:chat:8.8.8.8",
  ]);
  for (const ip of ["", "not-an-ip", "8.8.8.8, 1.1.1.1", "fe80::1%eth0"]) {
    assert.equal((await checkRateLimit(request(ip ? { "x-real-ip": ip } : {}), "chat")).allowed, false);
  }
  assert.equal(fetch.mock.callCount(), 4);
});

test("rate limit: malformed config cannot silently disable protection or send credentials to redirects", async (t) => {
  setup(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(1));
  for (const url of ["not-a-url", "http://redis.example", "https://user:secret@redis.example", "https://redis.example/pipeline", "https://redis.example/?token=secret", "https://redis.example/#fragment"]) {
    process.env.UPSTASH_REDIS_REST_URL = url;
    assert.equal((await checkRateLimit(request(), "chat")).allowed, false, url);
  }
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  for (const limit of ["0", "-1", "3oops", "1.5", "Infinity", "9007199254740992"]) {
    process.env.RATE_LIMIT_CHAT_PER_MINUTE = limit;
    assert.equal((await checkRateLimit(request(), "chat")).allowed, false, limit);
  }
  delete process.env.RATE_LIMIT_CHAT_PER_MINUTE;
  process.env.RATE_LIMIT_REQUIRED = "yes";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  delete process.env.RATE_LIMIT_REQUIRED;
  process.env.RATE_LIMIT_IP_HEADER = "invalid header";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  delete process.env.RATE_LIMIT_IP_HEADER;
  process.env.RATE_LIMIT_TIMEOUT_MS = "0";
  assert.equal((await checkRateLimit(request(), "chat")).allowed, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test("rate limit: deadline covers connection and response body reading", async (t) => {
  setup(t);
  process.env.RATE_LIMIT_TIMEOUT_MS = "20";
  for (const phase of ["connection", "body"]) {
    const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      const signal = options.signal;
      assert.ok(signal);
      if (phase === "connection") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }));
    });
    assert.deepEqual(await checkRateLimit(request(), "chat"), {
      allowed: false, status: 503, retryAfter: 5,
    }, phase);
    fetch.mock.restore();
  }
});

test("rate limit: already-cancelled requests do not start a Redis operation", async (t) => {
  setup(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(1));
  const controller = new AbortController();
  controller.abort();
  const req = new Request("https://playground.example", { signal: controller.signal });
  assert.equal((await checkRateLimit(req, "chat")).allowed, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test("rate limit: Retry-After is at least one second at the end of a window", async (t) => {
  setup(t);
  t.mock.method(globalThis, "fetch", async () => transactionResult(21, 0));
  assert.deepEqual(await checkRateLimit(request(), "chat"), {
    allowed: false, status: 429, retryAfter: 1,
  });
});

test("rate limit: concurrent decisions obey one shared counter and isolate scopes", async (t) => {
  setup(t);
  const counters = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const commands = JSON.parse(String(options.body));
    assert.equal(commands.length, 3);
    const key = commands[0][1];
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    return transactionResult(count);
  });
  const results = await Promise.all(Array.from({ length: 25 }, () => checkRateLimit(request(), "chat")));
  assert.equal(results.filter((result) => result.allowed).length, 20);
  assert.equal(results.filter((result) => !result.allowed).length, 5);
  assert.deepEqual(await checkRateLimit(request(), "mcp"), { allowed: true, remaining: 59 });
});

test("rate limit: cancellation reaches a running Redis fetch and removes its listener", async (t) => {
  setup(t);
  const controller = new AbortController();
  const req = new Request("https://playground.example", { signal: controller.signal });
  const initialListeners = getEventListeners(req.signal, "abort").length;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const signal = options.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      controller.abort();
    });
  });
  assert.deepEqual(await checkRateLimit(req, "chat"), {
    allowed: false, status: 503, retryAfter: 5,
  });
  assert.equal(getEventListeners(req.signal, "abort").length, initialListeners);
});

test("rate limit: HTTP error responses are static, uncached and distinguish 429 from 503", async () => {
  assert.equal(rateLimitErrorResponse({ allowed: true }), null);
  for (const status of [429, 503] as const) {
    const response = rateLimitErrorResponse({ allowed: false, status, retryAfter: 17 });
    assert.ok(response);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), {
      error: status === 429
        ? "Rate limit exceeded. Try again later."
        : "Request protection is temporarily unavailable. Try again later.",
    });
  }
});

test("rate limit: chat route rejects an exhausted quota before reading body or calling a provider", async (t) => {
  setup(t);
  const { POST } = await import("../app/api/chat/route");
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(21, 23));
  const req = new Request("https://playground.example/api/chat", { method: "POST", body: "invalid JSON" });
  const response = await POST(req);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "23");
  assert.equal(req.bodyUsed, false);
  assert.equal(fetch.mock.callCount(), 1);
});

test("rate limit: MCP route rejects an exhausted quota before parsing or starting outbound traffic", async (t) => {
  setup(t);
  const { POST } = await import("../app/api/mcp/route");
  const fetch = t.mock.method(globalThis, "fetch", async () => transactionResult(61, 11));
  const req = new NextRequest("https://playground.example/api/mcp", { method: "POST", body: "invalid JSON" });
  const response = await POST(req);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "11");
  assert.equal(req.bodyUsed, false);
  assert.equal(fetch.mock.callCount(), 1);
});

test("rate limit: both routes return 503, not 429, when required Redis is absent", async (t) => {
  setup(t, false);
  process.env.RATE_LIMIT_REQUIRED = "1";
  const chat = await import("../app/api/chat/route");
  const mcp = await import("../app/api/mcp/route");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const requests = [
    new Request("https://playground.example/api/chat", { method: "POST", body: "invalid JSON" }),
    new NextRequest("https://playground.example/api/mcp", { method: "POST", body: "invalid JSON" }),
  ] as const;
  const responses = [await chat.POST(requests[0]), await mcp.POST(requests[1])];
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), {
      error: "Request protection is temporarily unavailable. Try again later.",
    });
  }
  assert.equal(requests[0].bodyUsed, false);
  assert.equal(requests[1].bodyUsed, false);
  assert.equal(fetch.mock.callCount(), 0);
});
