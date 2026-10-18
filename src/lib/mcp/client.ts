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

/** Frontend timeout for a single MCP round-trip (upstream proxy is 15s). */
const FRONTEND_TIMEOUT_MS = 25000;

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

export function clearMcpSession(url: string): void {
  sessionIds.delete(url);
  transportModes.delete(url);
  legacyInitialized.delete(url);
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
 * True when an upstream error means "try the other transport".
 * Used in both directions:
 * - stateless -> legacy (server demands initialize/session)
 * - legacy -> stateless (server dropped initialize, method unknown)
 * The 2026-07-28 spec moves errors to bare HTTP statuses, so match on
 * `http 400`-style markers too — not only JSON-RPC substrings — because the
 * proxy forwards the upstream status code inside the thrown message.
 */
function isLegacyFallbackError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("method not found") ||
    m.includes("-32601") ||
    m.includes("unknown method") ||
    m.includes("unsupported method") ||
    m.includes("invalid request") ||
    m.includes("-32600") ||
    m.includes("protocol version") ||
    m.includes("protocolversion") ||
    m.includes("initialize") ||
    m.includes("notifications/initialized") ||
    m.includes("not initialized") ||
    m.includes("missing session") ||
    m.includes("invalid session") ||
    m.includes("session") ||
    m.includes("mcp-session-id") ||
    m.includes("http 400") ||
    m.includes("http 404") ||
    m.includes("http 501") ||
    m.includes("proxy error 400") ||
    m.includes("proxy error 404") ||
    m.includes("proxy error 501") ||
    m.includes("upstream 400") ||
    m.includes("upstream 404") ||
    m.includes("upstream 501") ||
    m.includes("status 400") ||
    m.includes("status 404") ||
    m.includes("status 501") ||
    m.includes(" 400 ") ||
    m.includes(" 404 ") ||
    m.includes(" 501 ") ||
    m.includes("406") ||
    m.includes("505")
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FRONTEND_TIMEOUT_MS);

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
          `MCP request timed out after ${FRONTEND_TIMEOUT_MS}ms (${method})`
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
    protocolVersion: LEGACY_PROTOCOL_VERSION,
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
      withSession: legacy, protocolVersion: legacy ? LEGACY_PROTOCOL_VERSION : MCP_PROTOCOL_VERSION, signal,
    });
  }
  // Legacy handshake methods always go direct (no fallback loop).
  if (method === "initialize" || method.startsWith("notifications/")) {
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: true,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });
  }

  const cached = transportModes.get(url);
  if (cached === "legacy") {
    await ensureLegacyInitialized(url, authHeaders, signal);
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: true,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });
  }
  if (cached === "stateless") {
    return rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: false,
    });
  }

  // Default: legacy-first (proven path for GitHub + most third-party servers).
  // Only when the server explicitly rejects `initialize` as unknown (-32601 /
  // method-not-found / 404 / 501) do we fall through to the stateless probe.
  try {
    await ensureLegacyInitialized(url, authHeaders, signal);
    const result = await rawSendMcpRequest(url, authHeaders, method, params, {
      withSession: true,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    });
    transportModes.set(url, "legacy");
    return result;
  } catch (legacyErr) {
    const legacyMessage =
      legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
    // Auth / network / timeout / tool-argument errors must surface as-is —
    // only "initialize is unknown" signals trigger the stateless fallback.
    if (!isLegacyFallbackError(legacyMessage)) {
      throw legacyErr;
    }

    try {
      const retry = await rawSendMcpRequest(url, authHeaders, method, params, {
        withSession: false,
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
}

/**
 * Connect entry-point. Legacy-first: tries the proven `initialize` handshake
 * (the path that worked with GitHub + DeepSeek before the migration), and
 * only when the server explicitly rejects `initialize` as unknown (-32601 /
 * method-not-found / 404 / 501) falls through to the stateless 2026-07-28
 * probe. The transport decision is cached per-URL.
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
    if (!isLegacyFallbackError(message)) {
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
    const result = (await sendMcpRequest(url, authHeaders, "tools/list", {})) as {
      tools?: McpTool[];
    } | null;
    return result?.tools || [];
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
