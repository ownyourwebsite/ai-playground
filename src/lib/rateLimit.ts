/**
 * Optional fixed-window rate limiter backed by Upstash Redis REST API.
 *
 * Implemented with plain `fetch` on purpose — no npm dependency is added so
 * that forks stay lightweight. If `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` are not configured, the limiter is a no-op and
 * always allows requests (critical for users who fork without Redis).
 *
 * Any network/Redis failure fails open (`allowed: true`) so an unavailable
 * Redis instance can never take the application down.
 */

type RateLimitScope = "chat" | "mcp";

const WINDOW_SECONDS = 60;

function getLimitForScope(scope: RateLimitScope): number {
  const raw =
    scope === "chat"
      ? process.env.RATE_LIMIT_CHAT_PER_MINUTE
      : process.env.RATE_LIMIT_MCP_PER_MINUTE;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return scope === "chat" ? 20 : 60;
}

function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Runs a pipeline of commands against the Upstash Redis REST API in a single
 * HTTP round-trip. Body is an array of command arrays, e.g.
 * `[["INCR", key], ["EXPIRE", key, "60"]]`; the response is an array of results.
 */
async function upstashPipeline(
  url: string,
  token: string,
  commands: string[][]
): Promise<unknown[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    throw new Error(`Upstash REST responded with ${res.status}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

export async function checkRateLimit(
  req: Request,
  scope: RateLimitScope
): Promise<{ allowed: boolean; remaining?: number }> {
  // Read env inside the function so runtime values are picked up correctly.
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Limiter disabled when Upstash is not configured (e.g. local forks).
  if (!url || !token) {
    return { allowed: true };
  }

  try {
    const ip = getClientIP(req);
    const key = `ratelimit:${scope}:${ip}`;
    const limit = getLimitForScope(scope);

    // Fixed window: INCR, then EXPIRE only when the counter was just created
    // (result of INCR === 1), so the window restarts on every new minute slot.
    const results = await upstashPipeline(url, token, [["INCR", key]]);
    const count = Number(results[0] ?? 0);

    if (count === 1) {
      await upstashPipeline(url, token, [
        ["EXPIRE", key, String(WINDOW_SECONDS)],
      ]);
    }

    if (count > limit) {
      return { allowed: false };
    }

    return { allowed: true, remaining: Math.max(0, limit - count) };
  } catch (err) {
    console.warn("[rateLimit] failed to check rate limit, failing open:", err);
    return { allowed: true };
  }
}
