import type { McpTool, InputSchema } from "../types";

export type { McpTool };

export interface McpCallResult {
  content: Array<Record<string, unknown> & { type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * MCP protocol version advertised per-request (stateless transport).
 * 2026-07-28 servers expect the version in per-request metadata, not in a
 * one-time `initialize` handshake. Legacy servers (2025-11-25 and older)
 * still negotiate via `initialize` — see LEGACY_PROTOCOL_VERSION.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Protocol version used only for the legacy `initialize` fallback path. */
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/**
 * Frontend timeout for a single MCP round-trip. Must exceed the proxy's
 * upstream timeout (15s, 60s for tools/call) so the proxy reports first.
 */
const FRONTEND_TIMEOUT_MS = 25000;
const FRONTEND_TOOL_CALL_TIMEOUT_MS = 65000;

/** Cap on tools/list pages followed via nextCursor. */
const MAX_TOOL_PAGES = 20;

/** HTTP header carrying the per-request protocol version. */
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | string;
};

type ProxyErrorBody = {
  error?: string | { code?: number; message?: string; data?: unknown };
  message?: string;
};

/**
 * Never let an error object leak into `new Error(obj)` — that stringifies to
 * "[object Object]". Always prefer `.message`, fall back to JSON.
 */
function errorPayloadToMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const obj = error as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string" && obj.message.trim()) {
      return typeof obj.code === "number"
        ? `${obj.message} (code ${obj.code})`
        : obj.message;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      // fall through to fallback below
    }
  }
  return fallback;
}

// Optional session ids issued by stateful (legacy) Streamable HTTP servers
// via the "mcp-session-id" response header on initialize, keyed by server URL.
// Not required by the 2026-07-28 stateless transport — only used after we
// have fallen back to the legacy path for a given URL.
const sessionIds = new Map<string, string>();

// Cached transport decision per server URL so we do not probe on every call:
// - "stateless": server answered a handshake-free request, keep going stateless.
// - "legacy": server demanded initialize/session, keep using initialize path.
const transportModes = new Map<string, "stateless" | "legacy">();

// URLs for which the legacy initialize handshake already succeeded.
const legacyInitialized = new Set<string>();

// protocolVersion the server answered with on initialize, keyed by server URL.
const negotiatedVersions = new Map<string, string>();

export function clearMcpSession(url: string): void {
  sessionIds.delete(url);
  transportModes.delete(url);
  legacyInitialized.delete(url);
  negotiatedVersions.delete(url);
}

/** Version for legacy requests: what the server negotiated, else our offer. */
function legacyVersionFor(url: string): string {
  return negotiatedVersions.get(url) ?? LEGACY_PROTOCOL_VERSION;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

/**
 * Attach per-request protocol metadata. The 2026-07-28 transport carries the
 * version on every request via `_meta`, so `tools/list` / `tools/call` are
 * self-sufficient without a prior `initialize`.
 */
function withProtocolMeta(
  params: Record<string, unknown> | undefined,
  protocolVersion: string = MCP_PROTOCOL_VERSION
): Record<string, unknown> {
  const base = params ?? {};
  const existingMeta =
    base._meta && typeof base._meta === "object"
      ? (base._meta as Record<string, unknown>)
      : {};
  return {
    ...base,
    _meta: {
      ...existingMeta,
      protocolVersion: existingMeta.protocolVersion ?? protocolVersion,
    },
  };
}

/**
 * True when a failed `initialize` means "this server is stateless, try the
 * 2026-07-28 transport". Deliberately narrow: only signals that the server
 * does not know `initialize` / the offered protocol version qualify.
 * - JSON-RPC -32601 / "method not found"
 * - bare HTTP 404 / 501 (endpoint or method unsupported)
 * - HTTP 400 whose detail names the protocol version or initialize/method
 * Auth (401/403), rate limits, 5xx, timeouts, network errors, bad-argument
 * errors and session errors must surface as-is; retrying them against another
 * transport only hides the real failure. The proxy puts the upstream status
 * in the thrown message ("Proxy error <status> ...").
 */
function isStatelessFallbackError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("method not found") ||
    m.includes("-32601") ||
    /^proxy error (404|501)\b/.test(m) ||
    (/^proxy error 400\b/.test(m) &&
      /protocol ?version|initialize|unknown method|unsupported method/.test(m))
  );
}

async function rawSendMcpRequest(
  url: string,
  authHeaders: Record<string, string> | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  options: { withSession: boolean; protocolVersion?: string; signal?: AbortSignal } = {
    withSession: true,
  }
): Promise<unknown> {
  const headers: Record<string, string> = { ...(authHeaders || {}) };

  if (options.withSession) {
    const sessionId = sessionIds.get(url);
    if (sessionId && !getHeaderCaseInsensitive(headers, "mcp-session-id")) {
      headers["mcp-session-id"] = sessionId;
    }
  }

  if (!getHeaderCaseInsensitive(headers, PROTOCOL_VERSION_HEADER)) {
    headers[PROTOCOL_VERSION_HEADER] =
      options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  }

  // JSON-RPC notifications (e.g. "notifications/initialized") carry no id,
  // and their params may be omitted entirely.
  const isNotification =
    params === undefined && method.startsWith("notifications/");
  const rpcBody: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!isNotification) {
    rpcBody.id = crypto.randomUUID();
    // initialize keeps its legacy top-level protocolVersion shape; every
    // other method carries the version per-request via _meta.
    rpcBody.params =
      method === "initialize"
        ? (params ?? {})
        : withProtocolMeta(
            params,
            options.protocolVersion ?? MCP_PROTOCOL_VERSION
          );
  }

  const timeoutMs =
    method === "tools/call" ? FRONTEND_TOOL_CALL_TIMEOUT_MS : FRONTEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          method: "POST",
          headers,
          body: rpcBody,
        }),
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `MCP request timed out after ${timeoutMs}ms (${method})`
        );
      }
      throw err instanceof Error
        ? new Error(`MCP request failed (${method}): ${err.message}`)
        : new Error(`MCP request failed (${method}): ${String(err)}`);
    }

    if (!response.ok) {
      const errData = (await response.json().catch(() => ({}))) as ProxyErrorBody;
      // The proxy forwards the upstream status as-is; upstream JSON-RPC errors
      // arrive as objects {code, message} — never pass an object to Error().
      const detail = errorPayloadToMessage(
        errData.error ?? errData.message,
        `Proxy error: ${response.status} ${response.statusText}`
      );
      throw new Error(
        `Proxy error ${response.status} ${response.statusText}: ${detail}`
      );
    }

    // Persist the session id (if any) for subsequent legacy requests.
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      sessionIds.set(url, newSessionId);
    }

    // Notifications may be answered with an empty or non-JSON body (e.g. 202 Accepted).
    const responseText = await response.text();
    if (!responseText.trim()) {
      if (method === 'tools/call') throw new Error('Missing MCP result; outcome unknown');
      return undefined;
    }
    let data: JsonRpcResponse;
    try {
      data = JSON.parse(responseText) as JsonRpcResponse;
    } catch {
      if (response.status >= 200 && response.status < 300) {
        if (method === 'tools/call') throw new Error('Invalid MCP result; outcome unknown');
        return undefined;
      }
      throw new Error(
        `Proxy returned invalid JSON: ${response.status} ${response.statusText}`
      );
    }
    if (data.error) {
      throw new Error(errorPayloadToMessage(data.error, "MCP request failed"));
    }

    if (method === 'tools/call' && data.result === undefined) throw new Error('Missing MCP result; outcome unknown');
    return data.result;
  } finally { clearTimeout(timeout); }
}

async function notifyInitialized(
  url: string,
  authHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<void> {
  await rawSendMcpRequest(url, authHeaders, "notifications/initialized", undefined, {
    withSession: true,
    protocolVersion: legacyVersionFor(url),
    signal,
  });
}

async function legacyInitialize(
  url: string,
  authHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const result = await rawSendMcpRequest(
    url,
    authHeaders,
    "initialize",
    {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "ai-api-playground",
        version: "1.0.0",
      },
    },
    { withSession: true, protocolVersion: LEGACY_PROTOCOL_VERSION, signal }
  );

  // Later requests use the version the server negotiated (it may be older
  // than our offer). Ignore anything that is not a date-style version.
  const negotiated = (result as { protocolVersion?: unknown } | null | undefined)
    ?.protocolVersion;
  if (typeof negotiated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(negotiated)) {
    negotiatedVersions.set(url, negotiated);
  }

  // Per the pre-2026 spec, the client MUST send notifications/initialized
  // after a successful initialize. A failure here must not break the connection.
  try {
    await notifyInitialized(url, authHeaders, signal);
  } catch {
    signal?.throwIfAborted();
    console.warn('[MCP] initialized notification unavailable');
  }

  legacyInitialized.add(url);
  return result;
}

async function ensureLegacyInitialized(
  url: string,
  authHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<void> {
  if (legacyInitialized.has(url)) return;
  await legacyInitialize(url, authHeaders, signal);
}

/**
 * Best-effort capability discovery for the 2026-07-28 transport. Uses the
 * per-request `server/discover` mechanism instead of the one-time handshake.
 * Returns null when the server does not implement discovery (legacy servers).
 *
 * Hardened: ANY discovery failure is swallowed and yields null. `discover`
 * is experimental — GitHub and most third-party servers do not implement it,
 * and a failure here must never break connect or mask the real error.
 */
export async function discoverMcpCapabilities(
  url: string,
  authHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown | null> {
  try {
    return await rawSendMcpRequest(url, authHeaders, "server/discover", {}, {
      withSession: false,
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export async function sendMcpRequest(
  url: string,
  authHeaders: Record<string, string> | undefined,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  // Never negotiate/replay after sending an operation. Discovery is read-only.
  if (method === 'tools/call') {
    signal?.throwIfAborted();
    if (!transportModes.has(url)) await initializeMcp(url, authHeaders, signal);
    signal?.throwIfAborted();
    const legacy = transportModes.get(url) !== 'stateless';
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: legacy, protocolVersion: legacy ? legacyVersionFor(url) : MCP_PROTOCOL_VERSION, signal,
    });
  }
  // Legacy handshake methods always go direct (no fallback loop).
  if (method === "initialize" || method.startsWith("notifications/")) {
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: true,
      protocolVersion:
        method === "initialize" ? LEGACY_PROTOCOL_VERSION : legacyVersionFor(url),
    });
  }

  const cached = transportModes.get(url);
  if (cached === "legacy") {
    await ensureLegacyInitialized(url, authHeaders, signal);
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: true,
      protocolVersion: legacyVersionFor(url),
    });
  }
  if (cached === "stateless") {
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: false,
    });
  }

  // Default: legacy-first (proven path for GitHub + most third-party servers).
  // Only a rejected `initialize` (see isStatelessFallbackError) falls through
  // to the stateless probe. Once initialize has succeeded the server is
  // legacy, so errors from the request itself surface as-is, never replayed.
  try {
    await ensureLegacyInitialized(url, authHeaders, signal);
  } catch (legacyErr) {
    signal?.throwIfAborted();
    const legacyMessage =
      legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
    // Auth / network / timeout errors must surface as-is.
    if (!isStatelessFallbackError(legacyMessage)) {
      throw legacyErr;
    }

    try {
      const retry = await rawSendMcpRequest(url, authHeaders, method, params, {
        withSession: false,
        signal,
      });
      transportModes.set(url, "stateless");
      return retry;
    } catch (statelessErr) {
      // If the stateless path also fails, surface the legacy error (it has
      // the most context for servers that used to work), keep stateless in log.
      console.warn(
        `Legacy ${method} failed (${legacyMessage}), stateless fallback also failed:`,
        statelessErr instanceof Error
          ? statelessErr.message
          : String(statelessErr)
      );
      throw legacyErr;
    }
  }

  transportModes.set(url, "legacy");
  return rawSendMcpRequest(url, authHeaders, method, params, {
    withSession: true,
    protocolVersion: legacyVersionFor(url),
    signal,
  });
}

/**
 * Connect entry-point. Legacy-first: tries the proven `initialize` handshake
 * (the path that worked with GitHub + DeepSeek before the migration), and
 * only when the server explicitly rejects `initialize` as unknown (-32601 /
 * method-not-found / 404 / 501 / 400 naming the protocol version) falls
 * through to the stateless 2026-07-28 probe. The transport decision is cached per-URL.
 */
export async function initializeMcp(
  url: string,
  authHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted();
  const cached = transportModes.get(url);
  if (cached === "legacy") {
    return legacyInitialize(url, authHeaders, signal);
  }
  if (cached === "stateless") {
    return { mode: "stateless", resumed: true };
  }

  try {
    const legacyResult = await legacyInitialize(url, authHeaders, signal);
    transportModes.set(url, "legacy");
    // Best-effort discovery after a working connection; never throws.
    await discoverMcpCapabilities(url, authHeaders, signal);
    return legacyResult;
  } catch (legacyErr) {
    signal?.throwIfAborted();
    const message =
      legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
    // Auth / network errors must fail fast — do not mask them with stateless.
    if (!isStatelessFallbackError(message)) {
      throw legacyErr;
    }
    // Server rejected initialize itself -> try stateless tools/list probe.
    try {
      const discovered = await discoverMcpCapabilities(url, authHeaders, signal);
      await rawSendMcpRequest(url, authHeaders, "tools/list", {}, {
        withSession: false,
        signal,
      });
      transportModes.set(url, "stateless");
      return { mode: "stateless", capabilities: discovered };
    } catch (statelessErr) {
      console.warn(
        `Legacy initialize failed (${message}), stateless fallback also failed:`,
        statelessErr instanceof Error
          ? statelessErr.message
          : String(statelessErr)
      );
      // Surface the legacy error: it describes the previously-working path.
      throw legacyErr;
    }
  }
}

export async function listMcpTools(
  url: string,
  authHeaders?: Record<string, string>
): Promise<McpTool[]> {
  try {
    // Follow nextCursor (capped, loop-safe); first occurrence of a name wins.
    const tools = new Map<string, McpTool>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (await sendMcpRequest(
        url,
        authHeaders,
        "tools/list",
        cursor === undefined ? {} : { cursor }
      )) as { tools?: McpTool[]; nextCursor?: unknown } | null;
      for (const tool of result?.tools ?? []) {
        if (!tools.has(tool.name)) tools.set(tool.name, tool);
      }
      const next = result?.nextCursor;
      if (typeof next !== "string" || !next || next === cursor) break;
      cursor = next;
    }
    return [...tools.values()];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      message.startsWith("MCP") ? message : `MCP tools/list failed: ${message}`
    );
  }
}

export async function callMcpTool(
  url: string,
  authHeaders: Record<string, string> | undefined,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpCallResult> {
  try {
    return (await sendMcpRequest(url, authHeaders, "tools/call", {
      name,
      arguments: args,
    }, signal)) as McpCallResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      message.startsWith("MCP tool call failed")
        ? message
        : `MCP tool call failed: ${message}`
    );
  }
}

export type { InputSchema };
