import type { McpTool, InputSchema } from "../types";

export type { McpTool };

export interface McpCallResult {
  content: Array<Record<string, unknown> & { type?: string; text?: string }>;
  isError?: boolean;
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { message?: string } | string;
};

// Session ids issued by stateful Streamable HTTP MCP servers via the
// "mcp-session-id" response header on initialize, keyed by server URL.
const sessionIds = new Map<string, string>();

export function clearMcpSession(url: string): void {
  sessionIds.delete(url);
}

export async function sendMcpRequest(
  url: string,
  authHeaders: Record<string, string> | undefined,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const headers: Record<string, string> = { ...(authHeaders || {}) };

  const sessionId = sessionIds.get(url);
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  // JSON-RPC notifications (e.g. "notifications/initialized") carry no id,
  // and their params may be omitted entirely.
  const isNotification = params === undefined && method.startsWith("notifications/");
  const rpcBody: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!isNotification) {
    rpcBody.id = Math.floor(Math.random() * 1000000);
    rpcBody.params = params ?? {};
  }

  const response = await fetch("/api/mcp", {
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
  });

  if (!response.ok) {
    const errData = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(errData.error || `Proxy error: ${response.status} ${response.statusText}`);
  }

  // Persist the session id (if any) for subsequent requests to this server.
  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) {
    sessionIds.set(url, newSessionId);
  }

  // Notifications may be answered with an empty or non-JSON body (e.g. 202 Accepted).
  const responseText = await response.text();
  if (!responseText.trim()) {
    return undefined;
  }
  let data: JsonRpcResponse;
  try {
    data = JSON.parse(responseText) as JsonRpcResponse;
  } catch {
    if (response.status >= 200 && response.status < 300) {
      return undefined;
    }
    throw new Error(`Proxy returned invalid JSON: ${response.status} ${response.statusText}`);
  }
  if (data.error) {
    throw new Error(typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error));
  }

  return data.result;
}

export async function notifyInitialized(url: string, authHeaders?: Record<string, string>): Promise<void> {
  await sendMcpRequest(url, authHeaders, "notifications/initialized");
}

export async function initializeMcp(url: string, authHeaders?: Record<string, string>): Promise<unknown> {
  const result = await sendMcpRequest(url, authHeaders, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "ai-api-playground",
      version: "1.0.0",
    },
  });

  // Per the MCP spec, the client MUST send notifications/initialized after
  // a successful initialize. A failure here must not break the connection.
  try {
    await notifyInitialized(url, authHeaders);
  } catch (err) {
    console.warn("Failed to send notifications/initialized:", err instanceof Error ? err.message : String(err));
  }

  return result;
}

export async function listMcpTools(url: string, authHeaders?: Record<string, string>): Promise<McpTool[]> {
  const result = (await sendMcpRequest(url, authHeaders, "tools/list", {})) as { tools?: McpTool[] } | null;
  return result?.tools || [];
}

export async function callMcpTool(
  url: string,
  authHeaders: Record<string, string> | undefined,
  name: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  return (await sendMcpRequest(url, authHeaders, "tools/call", {
    name,
    arguments: args,
  })) as McpCallResult;
}

export type { InputSchema };
