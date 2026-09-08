import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { ssrfGuardedFetch, assertUrlIsPublic } from "@/lib/ssrf";

export const runtime = "nodejs";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
const UPSTREAM_TIMEOUT_MS = 15000;

// Default protocol version advertised per-request on the 2026-07-28
// stateless transport. Clients send it via the MCP-Protocol-Version header
// and via params._meta; the proxy fills it in when the client omits it.
const MCP_PROTOCOL_VERSION = "2026-07-28";

// MCP Streamable HTTP only needs these methods.
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);

/**
 * Hop-by-hop and dangerous headers are never forwarded from the client body
 * to the upstream server. `mcp-session-id` is forwarded separately (request
 * header wins, JSON-body header is the fallback) to avoid spoofing/conflicts.
 */
const BLOCKED_HEADERS = new Set([
  // Hop-by-hop
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Framing / routing
  "content-length",
  "expect",
  "mcp-session-id",
]);

function jsonError(message: string, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function getBodyHeaderCaseInsensitive(
  headers: Record<string, unknown>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof val === "string") {
      return val;
    }
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, "mcp");
  if (!rl.allowed) {
    return jsonError("Rate limit exceeded. Try again in a minute.", 429, { "Retry-After": "60" });
  }

  try {
    const { url, method = "POST", headers = {}, body } = await req.json();

    if (!url || typeof url !== "string") {
      return jsonError("Missing url parameter", 400);
    }

    if (!ALLOWED_METHODS.has(method)) {
      return jsonError(`Method ${method} is not allowed`, 405);
    }


    // Full SSRF validation (protocol, private hosts/IPs, DNS resolution).
    // Throws a safe error message when the target is not allowed.
    try {
      await assertUrlIsPublic(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "URL is not allowed";
      return jsonError(message, 403);
    }

    // Prepare headers: safe defaults, then user-supplied headers minus the
    // blocked (hop-by-hop / framing) ones. Values must be header-safe.
    const safeHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    for (const [key, val] of Object.entries(headers)) {
      if (
        typeof val === "string" &&
        val.length <= 4096 &&
        !/[\r\n]/.test(val) &&
        !BLOCKED_HEADERS.has(key.toLowerCase())
      ) {
        safeHeaders[key] = val;
      }
    }

    // Per-request protocol version (2026-07-28 stateless transport).
    // Priority: incoming HTTP header > JSON-body header > server default.
    // Always forwarded upstream so stateless servers can negotiate per-request.
    const incomingProtocolVersion = req.headers.get("mcp-protocol-version");
    const bodyProtocolVersion =
      typeof headers === "object" && headers !== null
        ? getBodyHeaderCaseInsensitive(
            headers as Record<string, unknown>,
            "mcp-protocol-version"
          )
        : undefined;
    const protocolVersion =
      incomingProtocolVersion && !/[\r\n]/.test(incomingProtocolVersion)
        ? incomingProtocolVersion
        : bodyProtocolVersion && !/[\r\n]/.test(bodyProtocolVersion)
          ? bodyProtocolVersion
          : MCP_PROTOCOL_VERSION;
    safeHeaders["mcp-protocol-version"] = protocolVersion;

    // Forward the MCP session id (legacy stateful servers only). The request
    // HTTP header wins; the JSON-body header is accepted as a fallback
    // because browser clients cannot always set custom HTTP headers through
    // the proxy wrapper. Stateless 2026-07-28 servers simply ignore it.
    const incomingSessionId = req.headers.get("mcp-session-id");
    const bodySessionId =
      typeof headers === "object" && headers !== null
        ? getBodyHeaderCaseInsensitive(
            headers as Record<string, unknown>,
            "mcp-session-id"
          )
        : undefined;
    const sessionId =
      incomingSessionId && !/[\r\n]/.test(incomingSessionId)
        ? incomingSessionId
        : bodySessionId && !/[\r\n]/.test(bodySessionId)
          ? bodySessionId
          : undefined;
    if (sessionId) {
      safeHeaders["mcp-session-id"] = sessionId;
    }

    // Ensure per-request protocol metadata for stateless servers: when the
    // JSON-RPC params lack `_meta.protocolVersion` (old clients), inject the
    // negotiated version. `initialize` keeps its legacy top-level shape.
    let upstreamBody: unknown = body ?? null;
    if (
      upstreamBody &&
      typeof upstreamBody === "object" &&
      (upstreamBody as { method?: unknown }).method !== "initialize" &&
      (upstreamBody as { params?: unknown }).params &&
      typeof (upstreamBody as { params: unknown }).params === "object"
    ) {
      const rpc = upstreamBody as {
        params: Record<string, unknown>;
      };
      const meta =
        rpc.params._meta && typeof rpc.params._meta === "object"
          ? (rpc.params._meta as Record<string, unknown>)
          : {};
      if (meta.protocolVersion === undefined) {
        upstreamBody = {
          ...(upstreamBody as Record<string, unknown>),
          params: {
            ...rpc.params,
            _meta: { ...meta, protocolVersion },
          },
        };
      }
    }

    try {
      const response = await ssrfGuardedFetch(url, {
        method,
        headers: safeHeaders,
        body: method !== "GET" && method !== "HEAD" ? JSON.stringify(upstreamBody) : undefined,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      });

      if (response.status >= 300 && response.status < 400) {
        return jsonError("Redirects are blocked for security", 502);
      }

      if (response.truncated) {
        return jsonError("Response payload too large", 413);
      }

      const responseText = response.bodyText;
      let responseJson;
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // Try parsing SSE (Server-Sent Events) format
        // Typically: data: {"jsonrpc":"2.0",...}
        const dataLines = responseText
          .split("\n")
          .filter((line) => line.trim().startsWith("data:"))
          .map((line) => line.trim().substring(5).trim());

        if (dataLines.length > 0) {
          for (const dataLine of dataLines) {
            try {
              const parsed = JSON.parse(dataLine);
              if (
                parsed &&
                typeof parsed === "object" &&
                (parsed.jsonrpc === "2.0" || parsed.result || parsed.error)
              ) {
                responseJson = parsed;
                break;
              }
            } catch {
              // Ignore single line parse errors and continue
            }
          }
        }

        if (!responseJson) {
          responseJson = { raw: responseText };
        }
      }

      const responseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Pass the MCP session id back to the client so legacy stateful servers
      // can be reused. Stateless servers omit it — that is expected, not an error.
      const upstreamSessionId = response.headers["mcp-session-id"];
      if (typeof upstreamSessionId === "string" && !/[\r\n]/.test(upstreamSessionId)) {
        responseHeaders["mcp-session-id"] = upstreamSessionId;
      }

      return new NextResponse(JSON.stringify(responseJson), {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      if (error.message === "Gateway timeout") {
        return jsonError(
          `MCP upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
          504
        );
      }
      if (error.message === "Response payload too large") {
        return jsonError("Response payload too large", 413);
      }
      if (error.code === "EBLOCKED" || error.message?.includes("private")) {
        return jsonError("Access to private or non-HTTPS URLs is restricted", 403);
      }
      return jsonError(`Connection failed: ${error.message}`, 502);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 500);
  }
}

