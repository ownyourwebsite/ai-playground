import { NextRequest, NextResponse } from "next/server";
import { isIP } from "net";
import { lookup } from "dns/promises";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

const ALLOW_PRIVATE_MCP = process.env.ALLOW_PRIVATE_MCP === "1";

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return true;
  }
  return false;
}

function isPrivateIPAddress(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
  }
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true;
  return false;
}

async function isUrlSsrfSafe(urlStr: string): Promise<boolean> {
  try {
    const url = new URL(urlStr);

    // Hosted playground must use https unless ALLOW_PRIVATE_MCP=1
    if (url.protocol !== "https:" && !ALLOW_PRIVATE_MCP) {
      return false;
    }

    if (ALLOW_PRIVATE_MCP) {
      return true;
    }

    let hostname = url.hostname;

    // Strip brackets from IPv6 literals, e.g. "[::1]" -> "::1"
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    if (isPrivateHostname(hostname)) {
      return false;
    }

    // Reject non-dotted numeric hostnames (decimal like "2130706433" or hex
    // like "0x7f000001"): only dotted IPv4 and regular domains are allowed.
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
      return false;
    }

    if (isIP(hostname)) {
      return !isPrivateIPAddress(hostname);
    }

    // DNS resolution check: a public-looking domain may resolve to a private
    // or link-local address (DNS rebinding / 169.254.169.254 metadata).
    try {
      const addresses = await lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (isPrivateIPAddress(addr.address)) {
          return false;
        }
      }
    } catch {
      // Cannot resolve the host - treat as unsafe
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, "mcp");
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } });
  }

  try {
    const { url, method = "POST", headers = {}, body } = await req.json();

    if (!url) {
      return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
    }

    if (!(await isUrlSsrfSafe(url))) {
      return NextResponse.json({ error: "Access to private or non-HTTPS URLs is restricted" }, { status: 403 });
    }

    // Prepare headers, strip dangerous ones, don't log them
    const safeHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };

    // Forward the MCP session id (stateful Streamable HTTP servers)
    const incomingSessionId = req.headers.get("mcp-session-id");
    if (incomingSessionId) {
      safeHeaders["mcp-session-id"] = incomingSessionId;
    }

    for (const [key, val] of Object.entries(headers)) {
      if (typeof val === "string") {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== "host" && lowerKey !== "connection") {
          safeHeaders[key] = val;
        }
      }
    }

    // Implement fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 10-15s timeout

    try {
      const response = await fetch(url, {
        method,
        headers: safeHeaders,
        body: method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
        redirect: "manual", // Prevent following redirects to avoid SSRF
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
        return NextResponse.json({ error: "Redirects are blocked for security" }, { status: 502 });
      }

      // Check max body size
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) { // 10MB limit
        return NextResponse.json({ error: "Response payload too large" }, { status: 413 });
      }

      const responseText = await response.text();
      let responseJson;
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // Try parsing SSE (Server-Sent Events) format
        // Typically: data: {"jsonrpc":"2.0",...}
        const dataLines = responseText.split("\n")
          .filter(line => line.trim().startsWith("data:"))
          .map(line => line.trim().substring(5).trim());

        if (dataLines.length > 0) {
          for (const dataLine of dataLines) {
            try {
              const parsed = JSON.parse(dataLine);
              if (parsed && typeof parsed === "object" && (parsed.jsonrpc === "2.0" || parsed.result || parsed.error)) {
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

      // Pass the MCP session id back to the client so it can reuse it
      const upstreamSessionId = response.headers.get("mcp-session-id");
      if (upstreamSessionId) {
        responseHeaders["mcp-session-id"] = upstreamSessionId;
      }

      return new NextResponse(JSON.stringify(responseJson), {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const error = err as { name?: string; message?: string };
      if (error.name === "AbortError") {
        return NextResponse.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      return NextResponse.json({ error: `Connection failed: ${error.message}` }, { status: 502 });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
