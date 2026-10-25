import { NextResponse } from "next/server";
import { ssrfGuardedFetch, assertUrlIsPublic } from "@/lib/ssrf";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_REQUEST_BYTES = 1024 * 1024; // 1MiB

// Socket inactivity timeouts (not wall-clock): tools/call may run web fetches
// or repo operations; everything else (initialize, tools/list, ...) is quick.
export const UPSTREAM_TIMEOUT_MS = 15000;
export const TOOL_CALL_TIMEOUT_MS = 60000;

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

export function jsonError(message: string, status: number, extraHeaders?: Record<string, string>) {
  return new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads the JSON request body with a hard size cap: Content-Length is checked
 * up front, then bytes are counted while streaming (it can lie or be absent).
 */
export async function readJsonBodyLimited(
  req: Request,
  maxBytes: number = MAX_REQUEST_BYTES
): Promise<BodyResult> {
  const tooLarge: BodyResult = { ok: false, status: 413, error: "Request body too large" };

  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return tooLarge;
  }

  if (!req.body) return { ok: false, status: 400, error: "Missing request body" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge;
    }
    chunks.push(value);
  }

  try {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
}

/**
 * Parses an SSE stream into per-event `data` payloads. Events end at a blank
 * line; line endings may be CRLF, LF or CR. Multiple `data:` lines of one
 * event are joined with "\n", a single space after the colon is stripped, and
 * comments (":...") and non-data fields (event/id/retry) are ignored.
 */
export function parseSseEvents(text: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) events.push(data.join("\n"));
    data = [];
  };

  for (const line of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  }
  // The upstream already closed the stream; a final event without a trailing
  // blank line is still complete in practice (unparseable ones are skipped).
  flush();
  return events;
}

export type RpcId = string | number;

/** A JSON-RPC response has result/error and no method (requests/notifications do). */
function isRpcResponse(msg: unknown): msg is Record<string, unknown> {
  return isRecord(msg) && !("method" in msg) && ("result" in msg || "error" in msg);
}

/**
 * Picks the JSON-RPC response for `id` out of a list of messages. The id must
 * match strictly (1 !== "1"); server->client requests and notifications are
 * skipped. Without an id (not a regular request) the first response wins.
 */
export function findRpcResponse(messages: unknown[], id: RpcId | undefined): unknown {
  for (const msg of messages) {
    if (!isRpcResponse(msg)) continue;
    if (id === undefined || msg.id === id) return msg;
  }
  return undefined;
}

/** SSE events -> flat list of JSON messages (a data payload may be a batch array). */
function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const data of parseSseEvents(text)) {
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // Ignore events that are not JSON
    }
  }
  return out;
}

type RequestKind =
  | { kind: "request"; id: RpcId }
  | { kind: "notification" }
  | { kind: "other" };

function classifyBody(body: unknown): RequestKind {
  if (!isRecord(body) || typeof body.method !== "string") return { kind: "other" };
  if (typeof body.id === "string" || typeof body.id === "number") {
    return { kind: "request", id: body.id };
  }
  return "id" in body ? { kind: "other" } : { kind: "notification" };
}

export function upstreamTimeoutMs(body: unknown): number {
  return isRecord(body) && body.method === "tools/call"
    ? TOOL_CALL_TIMEOUT_MS
    : UPSTREAM_TIMEOUT_MS;
}

export interface ProxyDeps {
  assertUrlIsPublic: typeof assertUrlIsPublic;
  fetchUpstream: typeof ssrfGuardedFetch;
}

const defaultDeps: ProxyDeps = {
  assertUrlIsPublic,
  fetchUpstream: ssrfGuardedFetch,
};

/** Proxy core; `deps` is a test seam for the SSRF-guarded network layer. */
export async function handleMcpProxy(
  req: Request,
  deps: ProxyDeps = defaultDeps
): Promise<NextResponse> {
  try {
    const parsedBody = await readJsonBodyLimited(req);
    if (!parsedBody.ok) return jsonError(parsedBody.error, parsedBody.status);
    if (!isRecord(parsedBody.value)) return jsonError("Invalid request body", 400);

    const { url, method = "POST", headers = {}, body } = parsedBody.value;

    if (!url || typeof url !== "string") {
      return jsonError("Missing url parameter", 400);
    }

    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return jsonError(`Method ${String(method)} is not allowed`, 405);
    }

    // Full SSRF validation (protocol, private hosts/IPs, DNS resolution).
    // Throws a safe error message when the target is not allowed.
    try {
      await deps.assertUrlIsPublic(url);
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

    for (const [key, val] of Object.entries(headers as object)) {
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

    const timeoutMs = upstreamTimeoutMs(upstreamBody);
    const rpcKind = classifyBody(upstreamBody);

    try {
      const response = await deps.fetchUpstream(url, {
        method,
        headers: safeHeaders,
        body: method !== "GET" && method !== "HEAD" ? JSON.stringify(upstreamBody) : undefined,
        signal: req.signal,
        timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
      });

      if (response.status >= 300 && response.status < 400) {
        return jsonError("Redirects are blocked for security", 502);
      }

      if (response.truncated) {
        return jsonError("Response payload too large", 413);
      }

      const responseHeaders: Record<string, string> = {};

      // Pass the MCP session id back to the client so legacy stateful servers
      // can be reused. Stateless servers omit it — that is expected, not an error.
      const upstreamSessionId = response.headers["mcp-session-id"];
      if (typeof upstreamSessionId === "string" && !/[\r\n]/.test(upstreamSessionId)) {
        responseHeaders["mcp-session-id"] = upstreamSessionId;
      }

      const responseText = response.bodyText;
      const ok = response.status >= 200 && response.status < 300;

      // Body-less replies: 202/204/205 and empty bodies (a body on a null-body
      // status makes the Response constructor throw). Notifications have no
      // response to relay, so any 2xx is normalized to 202.
      if (rpcKind.kind === "notification" && ok) {
        return new NextResponse(null, { status: 202, headers: responseHeaders });
      }
      if (
        response.status === 202 ||
        response.status === 204 ||
        response.status === 205 ||
        !responseText.trim()
      ) {
        return new NextResponse(null, { status: response.status, headers: responseHeaders });
      }

      responseHeaders["Content-Type"] = "application/json";
      const id = rpcKind.kind === "request" ? rpcKind.id : undefined;

      let responseJson: unknown;
      try {
        responseJson = JSON.parse(responseText);
        if (Array.isArray(responseJson) && id !== undefined) {
          responseJson = findRpcResponse(responseJson, id);
          if (responseJson === undefined) {
            return jsonError("MCP upstream returned no response matching the request id", 502);
          }
        }
      } catch {
        // SSE (Server-Sent Events): pick the response whose id matches the
        // request; interleaved server requests/notifications are skipped.
        responseJson = findRpcResponse(sseMessages(responseText), id);
        if (responseJson === undefined) {
          if (ok) {
            return jsonError("MCP upstream returned no response matching the request id", 502);
          }
          responseJson = { raw: responseText };
        }
      }

      return new NextResponse(JSON.stringify(responseJson), {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      if (error.message === "Gateway timeout") {
        return jsonError(
          `MCP upstream timed out after ${timeoutMs}ms`,
          504
        );
      }
      if (error.message === "Response payload too large") {
        return jsonError("Response payload too large", 413);
      }
      if (error.code === "EBLOCKED" || error.message?.includes("private")) {
        return jsonError("Access to private or non-HTTPS URLs is restricted", 403);
      }
      return jsonError("MCP connection failed; operation outcome may be unknown.", 502);
    }
  } catch (error: unknown) {
    void error;
    return jsonError("MCP request failed.", 500);
  }
}
