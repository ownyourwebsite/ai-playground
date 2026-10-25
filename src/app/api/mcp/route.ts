import { NextRequest } from "next/server";
import { checkRateLimit, rateLimitErrorResponse } from "@/lib/rateLimit";
import { handleMcpProxy } from "@/lib/mcp/proxy";

export const runtime = "nodejs";
// tools/call may wait up to 60s on the MCP server (the browser gives up at 65s).
// Needs Fluid compute on Vercel Hobby, like the chat route.
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const rateLimitError = rateLimitErrorResponse(await checkRateLimit(req, "mcp"));
  if (rateLimitError) return rateLimitError;

  return handleMcpProxy(req);
}
