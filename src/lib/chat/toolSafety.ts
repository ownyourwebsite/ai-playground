import type { McpServer, ToolInvocation } from '../types';
import { GITHUB_READ_ONLY_TOOLS } from '../mcp/githubTools';

/** Trust local endpoint identity + reviewed allow-list, never remote annotations alone. */
export function canRetryTool(call: ToolInvocation, server?: McpServer): boolean {
  if (!server || server.status !== 'connected' || server.preset !== 'github') return false;
  try {
    const url = new URL(server.url);
    return url.protocol === 'https:' && url.hostname === 'api.githubcopilot.com' && !url.username && !url.password &&
      GITHUB_READ_ONLY_TOOLS.has(call.originalName || call.toolName) && call.state === 'result' &&
      (call.outcome === 'error' || call.outcome === 'unknown');
  } catch { return false; }
}
