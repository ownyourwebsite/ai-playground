import type { InputSchema, Message } from "../types";

export type { InputSchema };

/**
 * Parses a GitHub repository identifier from various input formats.
 * Supports full URLs, owner/repo format, and URLs without protocol.
 * 
 * @param input - The input string to parse (URL, owner/repo, etc.)
 * @returns An object with owner and repo properties, or null if parsing fails
 * 
 * @example
 * parseGithubRepo("https://github.com/owner/repo") // { owner: "owner", repo: "repo" }
 * parseGithubRepo("owner/repo") // { owner: "owner", repo: "repo" }
 * parseGithubRepo("github.com/owner/repo") // { owner: "owner", repo: "repo" }
 */
export function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const cleanInput = input.trim();
  if (!cleanInput) return null;

  // Check if it's a full URL
  try {
    if (cleanInput.startsWith("http://") || cleanInput.startsWith("https://")) {
      const url = new URL(cleanInput);
      if (url.hostname === "github.com") {
        const pathParts = url.pathname.split("/").filter(Boolean);
        if (pathParts.length >= 2) {
          return { owner: pathParts[0], repo: pathParts[1] };
        }
      }
    }
  } catch {
    // Ignore URL parsing errors
  }

  // Fallback to owner/repo match
  const match = cleanInput.match(/^([^/]+)\/([^/]+)$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  // Also match URL without protocol, e.g. github.com/owner/repo
  const matchDomain = cleanInput.match(/(?:github\.com\/)?([^/]+)\/([^/]+)/);
  if (matchDomain && !cleanInput.includes("://")) {
    const owner = matchDomain[1];
    const repo = matchDomain[2].split(/[?#]/)[0]; // strip query/hash
    if (owner && repo) {
      return { owner, repo };
    }
  }

  return null;
}

/**
 * Extracts GitHub repository information from a text string.
 * Searches for GitHub URLs or owner/repo patterns in the text.
 * 
 * @param text - The text to search for GitHub repository references
 * @returns An object with owner and repo properties, or null if not found
 */
export function extractGithubRepoFromText(text: string): { owner: string; repo: string } | null {
  if (!text) return null;
  // Simple regex to find any github.com/owner/repo URL or pattern
  const regex = /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/i;
  const match = regex.exec(text);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  // Try fallback to standard owner/repo pattern (word/word) but only if it looks like a repo path
  const fallbackRegex = /\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/g;
  let fallbackMatch;
  while ((fallbackMatch = fallbackRegex.exec(text)) !== null) {
    const owner = fallbackMatch[1];
    const repo = fallbackMatch[2];
    // Simple filter to avoid matching things like "npm/install" or common paths
    if (
      owner !== "npm" &&
      owner !== "node" &&
      repo !== "install" &&
      repo !== "json" &&
      repo !== "js" &&
      repo !== "ts" &&
      owner !== "http" &&
      owner !== "https"
    ) {
      return { owner, repo };
    }
  }
  return null;
}

/**
 * Extracts all unique GitHub repositories mentioned in a conversation's messages.
 * 
 * @param messages - Array of message objects from the conversation
 * @returns Array of unique repository objects with owner and repo properties
 */
export function extractAllGithubReposFromConversation(messages: Message[]): { owner: string; repo: string }[] {
  if (!messages || !Array.isArray(messages)) return [];
  const reposMap = new Map<string, { owner: string; repo: string }>();

  const urlRegex = /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/gi;
  const fallbackRegex = /\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/g;

  for (const msg of messages) {
    const text = msg.content;
    if (typeof text !== "string") continue;

    let match;
    urlRegex.lastIndex = 0;
    while ((match = urlRegex.exec(text)) !== null) {
      const owner = match[1];
      const repo = match[2];
      const key = `${owner}/${repo}`.toLowerCase();
      reposMap.set(key, { owner, repo });
    }

    fallbackRegex.lastIndex = 0;
    while ((match = fallbackRegex.exec(text)) !== null) {
      const owner = match[1];
      const repo = match[2];
      if (
        owner !== "npm" &&
        owner !== "node" &&
        repo !== "install" &&
        repo !== "json" &&
        repo !== "js" &&
        repo !== "ts" &&
        owner !== "http" &&
        owner !== "https"
      ) {
        const key = `${owner}/${repo}`.toLowerCase();
        if (!reposMap.has(key)) {
          reposMap.set(key, { owner, repo });
        }
      }
    }
  }

  return Array.from(reposMap.values());
}

/**
 * Resolves GitHub tool arguments by auto-filling owner/repo from context if not provided.
 * Also handles special cases like README path inference for get_file_contents.
 * 
 * @param toolName - The name of the MCP tool being called
 * @param args - The arguments provided by the user/LLM
 * @param schema - The input schema for the tool
 * @param messagesOrContext - Either conversation messages or a context object with owner/repo
 * @param userMessage - Optional user message for context-aware inference (e.g., README detection)
 * @returns Resolved arguments with auto-filled values where appropriate
 */
export function resolveGithubToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  schema: InputSchema,
  messagesOrContext?: Message[] | { owner: string; repo: string; branch?: string } | null,
  userMessage?: string
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...args };

  // Determine if it's a GitHub tool by checking if 'owner' or 'repo' is in schema properties
  const hasOwner = schema?.properties && "owner" in schema.properties;
  const hasRepo = schema?.properties && "repo" in schema.properties;

  if (hasOwner || hasRepo) {
    let context: { owner: string; repo: string; branch?: string } | null = null;

    if (messagesOrContext) {
      if (Array.isArray(messagesOrContext)) {
        const repos = extractAllGithubReposFromConversation(messagesOrContext);
        context = repos.length === 1 ? repos[0] : null;
      } else {
        context = messagesOrContext;
      }
    }

    if (context) {
      if (hasOwner && (resolved.owner === undefined || resolved.owner === "")) {
        resolved.owner = context.owner;
      }
      if (hasRepo && (resolved.repo === undefined || resolved.repo === "")) {
        resolved.repo = context.repo;
      }
      // Leave ref/branch optional, but we can default from selected branch if available and property exists
      if (schema.properties && "ref" in schema.properties && (resolved.ref === undefined || resolved.ref === "") && context.branch) {
        resolved.ref = context.branch;
      }
      if (schema.properties && "branch" in schema.properties && (resolved.branch === undefined || resolved.branch === "") && context.branch) {
        resolved.branch = context.branch;
      }
    }

    // Special behavior for get_file_contents:
    if (toolName === "get_file_contents") {
      // "if path is absent and user explicitly asked to read README, infer path: "README.md" from the user request only; otherwise do not guess."
      if (resolved.path === undefined || resolved.path === "") {
        let actualUserMsg = userMessage;
        if (!actualUserMsg && messagesOrContext && Array.isArray(messagesOrContext)) {
          const lastUserMsg = [...messagesOrContext].reverse().find(m => m.role === "user")?.content;
          if (lastUserMsg) {
            actualUserMsg = lastUserMsg;
          }
        }
        if (actualUserMsg) {
          const lowerMsg = actualUserMsg.toLowerCase();
          if (lowerMsg.includes("readme")) {
            resolved.path = "README.md";
          }
        }
      }
    }
  }

  return resolved;
}

/**
 * Validates tool arguments against a provided input schema.
 * 
 * @param args - The arguments to validate
 * @param schema - The InputSchema to validate against
 * @returns An object with validation result and list of missing required fields
 * 
 * @example
 * validateToolArgs({ owner: "o", repo: "r" }, { type: "object", required: ["owner", "repo", "path"] })
 * // { valid: false, missingFields: ["path"] }
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema: InputSchema
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  const required = schema?.required || [];

  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
      missingFields.push(field);
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}
