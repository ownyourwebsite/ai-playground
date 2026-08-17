/** Input schema for MCP tool arguments. */
export type InputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
};

/** A tool exposed by a connected MCP server. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: InputSchema;
  /** Namespaced tool name when multiple servers are active. */
  originalName?: string;
  /** Server id the tool belongs to. */
  serverId?: string;
};

/** A tool invocation attached to an assistant message. */
export type ToolInvocation = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: "calling" | "executing" | "needs-approval" | "result";
  result?: unknown;
  validation?: { valid: boolean; missingFields: string[] };
  originalName?: string;
  serverId?: string;
  turnCount?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "data" | "tool";
  content: string;
  toolInvocations?: ToolInvocation[];
  /** Extracted reasoning / "thinking" content (from <think> tags or a dedicated API field). */
  reasoning?: string | null;
  /** True while a reasoning block is still streaming (open tag, no close yet). */
  reasoningOpen?: boolean;
  /** Runtime error surfaced on the message card. */
  error?: string;
  /** Ephemeral status line shown while the assistant is working. */
  statusLine?: string;
};

export type Session = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
};

export type Provider = "openai" | "anthropic" | "groq" | "ollama" | "custom";

export type McpServerConfig = {
  id: string;
  name: string;
  description: string;
  url: string;
  preset?: "github"; // If it's the github preset
  rememberAuth?: boolean;
  /** Optional extra request headers for the MCP proxy. */
  headers?: Record<string, string>;
};

// UI state for MCP Server
export type McpServer = McpServerConfig & {
  status: "connected" | "disconnected" | "connecting";
  tools?: McpTool[];
};

export type Prompt = {
  id: string;
  title: string;
  content: string;
};

export type Skill = {
  id: string;
  name: string;
  icon: string; // lucide icon key, e.g. "folder-tree", "code", "bug", "database", "sparkles"
  description: string;
  instructions: string;
  useGithubMcp?: boolean;
  isCustom?: boolean;
  createdAt: number;
};

export type SavedProvider = {
  id: string;
  name: string;
  baseUrl: string;
  key: string;
  model: string;
};

export type AppSettings = {
  id: "default";
  openAiKey?: string;
  openAiModel?: string;
  anthropicKey?: string;
  anthropicModel?: string;
  groqKey?: string;
  groqModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  customBaseUrl?: string;
  customKey?: string;
  customModel?: string;
  savedProviders?: SavedProvider[];
  githubPat?: string;
  systemPrompt: string;
  rememberKeys: boolean;
  defaultModel?: string;
  githubWriteMode?: boolean;
};

export type GitHubContext = {
  owner: string;
  repo: string;
  branch?: string;
};

/** A tool definition sent to the chat API (for the raw request inspector). */
export type ChatRequestTool = {
  name: string;
  description?: string;
  inputSchema?: InputSchema;
  originalName?: string;
  serverId?: string;
};

/** The JSON body sent to `/api/chat` (captured for the raw request inspector). */
export type ChatRequestBody = {
  provider: string;
  model: string;
  systemPrompt?: string;
  ollamaUrl?: string;
  messages: Array<Pick<Message, "role" | "content" | "toolInvocations">>;
  enabledTools: ChatRequestTool[];
};
