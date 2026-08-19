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

export async function sendMcpRequest(
  url: string,
  authHeaders: Record<string, string> | undefined,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const headers: Record<string, string> = { ...(authHeaders || {}) };

  const response = await fetch("/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      method: "POST",
      headers,
      body: {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1000000),
        method,
        params,
      },
    }),
  });

  if (!response.ok) {
    const errData = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(errData.error || `Proxy error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as JsonRpcResponse;
  if (data.error) {
    throw new Error(typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error));
  }

  return data.result;
}

export async function initializeMcp(url: string, authHeaders?: Record<string, string>): Promise<unknown> {
  return sendMcpRequest(url, authHeaders, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "ai-api-playground",
      version: "1.0.0",
    },
  });
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
