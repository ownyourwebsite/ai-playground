import { isIP } from "node:net";

/**
 * Optional first-request-anchored 60-second window, backed by Upstash REST.
 * No credentials + no required flag keeps local forks working without Redis.
 * Once configured, failures are closed unless fail-open is explicitly enabled.
 * IP identity is trusted only through an operator-selected, overwritten header;
 * otherwise all requests in a scope share a bucket.
 */
type RateLimitScope = "chat" | "mcp";

export type RateLimitResult =
  | { allowed: true; remaining?: number }
  | { allowed: false; status: 429 | 503; retryAfter: number };

const WINDOW_SECONDS = 60;
const UNAVAILABLE_RETRY_SECONDS = 5;

function booleanEnv(name: string): boolean {
  const raw = process.env[name]?.trim();
  if (!raw || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error("Invalid rate limit flag");
}

function positiveIntegerEnv(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Invalid rate limit integer");
  }
  return parsed;
}

function unavailable(): RateLimitResult {
  return { allowed: false, status: 503, retryAfter: UNAVAILABLE_RETRY_SECONDS };
}

function transactionUrl(raw: string): string {
  const url = new URL(raw);
  // This is operator configuration, not a user-provided destination. Require
  // the base REST URL and never follow redirects carrying the Redis token.
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid Upstash base URL");
  }
  url.pathname = "/multi-exec";
  return url.toString();
}

function clientIdentity(req: Request, header: string): string {
  if (!header) return "shared";
  if (header.length > 128 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(header)) {
    throw new Error("Invalid trusted IP header configuration");
  }
  const ip = req.headers.get(header)?.trim() ?? "";
  // No XFF chain guessing or fallback to a second, possibly spoofed header.
  // The trusted edge must supply exactly one IP and overwrite visitor input.
  if (ip.includes("%") || isIP(ip) === 0) {
    throw new Error("Trusted IP header is missing or invalid");
  }
  if (isIP(ip) === 4) return ip;

  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return canonical;
}

function commandResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      "error" in value || !("result" in value)) {
    throw new Error("Invalid Redis command result");
  }
  return value.result;
}

function parseTransaction(data: unknown): { count: number; ttl: number } {
  if (!Array.isArray(data) || data.length !== 3) {
    throw new Error("Invalid Redis transaction response");
  }
  const [count, expires, ttl] = data.map(commandResult);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 ||
      (expires !== 0 && expires !== 1) ||
      typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > WINDOW_SECONDS) {
    throw new Error("Invalid Redis counter or TTL");
  }
  return { count, ttl };
}

async function incrementWindow(
  req: Request,
  url: string,
  token: string,
  key: string,
  timeoutMs: number
): Promise<{ count: number; ttl: number }> {
  req.signal.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(req.signal.reason);
  req.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Unlike /pipeline, /multi-exec prevents interleaving. EXPIRE NX does not
    // extend an existing window and repairs counters missing a TTL. Individual
    // command failures still need validation: transactions do not roll back.
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(WINDOW_SECONDS), "NX"],
        ["TTL", key],
      ]),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Redis HTTP failure");
    // Keep the deadline active until the body has been read, not just headers.
    return parseTransaction(await res.json());
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
  }
}

export async function checkRateLimit(req: Request, scope: RateLimitScope): Promise<RateLimitResult> {
  // Read configuration per request, not at module load time.
  let config: { url: string; token: string; key: string; limit: number; timeoutMs: number; failOpen: boolean };
  try {
    const required = booleanEnv("RATE_LIMIT_REQUIRED");
    const failOpen = booleanEnv("RATE_LIMIT_FAIL_OPEN");
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (!url && !token && !required) return { allowed: true };
    if (!url || !token) throw new Error("Redis credentials are missing");

    config = {
      url: transactionUrl(url),
      token,
      key: `ratelimit:${scope}:${clientIdentity(req, process.env.RATE_LIMIT_IP_HEADER?.trim() ?? "")}`,
      limit: positiveIntegerEnv(scope === "chat" ? "RATE_LIMIT_CHAT_PER_MINUTE" : "RATE_LIMIT_MCP_PER_MINUTE", scope === "chat" ? 20 : 60),
      timeoutMs: positiveIntegerEnv("RATE_LIMIT_TIMEOUT_MS", 2000, 10000),
      failOpen,
    };
  } catch {
    // Never log credentials, request headers, IPs or raw upstream exceptions.
    console.warn("[rateLimit] invalid or incomplete configuration; failing closed.");
    return unavailable();
  }

  try {
    const { count, ttl } = await incrementWindow(req, config.url, config.token, config.key, config.timeoutMs);
    if (count > config.limit) {
      return { allowed: false, status: 429, retryAfter: Math.max(1, ttl) };
    }
    return { allowed: true, remaining: config.limit - count };
  } catch {
    console.warn(config.failOpen
      ? "[rateLimit] check unavailable; explicit fail-open policy is active."
      : "[rateLimit] check unavailable; failing closed.");
    return config.failOpen ? { allowed: true } : unavailable();
  }
}

/** Return only static, safe errors; unavailable Redis is not quota exhaustion. */
export function rateLimitErrorResponse(result: RateLimitResult): Response | null {
  if (result.allowed) return null;
  return new Response(JSON.stringify({
    error: result.status === 429
      ? "Rate limit exceeded. Try again later."
      : "Request protection is temporarily unavailable. Try again later.",
  }), {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": String(result.retryAfter),
    },
  });
}
