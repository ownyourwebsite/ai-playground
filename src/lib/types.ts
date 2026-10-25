/** Input schema for MCP tool arguments. */
export type InputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  /** Preserve JSON Schema keywords/dialects and MCP extensions verbatim. */
  [keyword: string]: unknown;
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
  outcome?: "success" | "declined" | "error" | "unknown";
  attemptId?: string;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

export type ChatError = {
  category: "app-rate-limit" | "redis-unavailable" | "provider-rate-limit" | "quota" | "context" | "auth" | "provider" | "network" | "timeout" | "interrupted" | "response-limit" | "content-filter" | "protocol" | "mcp" | "storage" | "attachment" | "request" | "tool-schema" | "image-incompatible" | "model-not-found" | "org-verification" | "private-network";
  message: string;
  retryable: boolean;
  retryAt?: number;
  /** Allow-listed diagnostic code only; never a raw provider/storage message. */
  code?: string;
};

export type Execution = {
  sessionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  status: "waiting" | "streaming" | "approval" | "tools" | "pending-model" | "retry-wait" | "complete" | "error" | "cancelled" | "interrupted";
  startedAt: number;
  durationMs?: number;
  usage?: Usage;
  error?: ChatError;
  retryAt?: number;
  retryNumber?: number;
  recovered?: boolean;
  /** Results received; only the next model step may be resumed, never MCP replay. */
  continuationPending?: boolean;
  /** False at a pre-request checkpoint or a terminal unsent attempt; absent for legacy/uncertain recovery. */
  requestSent?: boolean;
  interruption?: "user" | "session-switch" | "page-exit" | "reload" | "step-limit";
};

/** Lightweight metadata kept with a message; payloads are stored separately. */
export type AttachmentRef = {
  id: string;
  name: string;
  kind: 'text' | 'image';
  mediaType: string;
  size: number;
};

/** UTF-8 decoded text, or a complete, strict raster image data URL. */
export type AttachmentRecord = AttachmentRef & { data: string };

export type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "data" | "tool";
  content: string;
  toolInvocations?: ToolInvocation[];
  attachments?: AttachmentRef[];
  /** Extracted reasoning / "thinking" content (from <think> tags or a dedicated API field). */
  reasoning?: string | null;
  /** True while a reasoning block is still streaming (open tag, no close yet). */
  reasoningOpen?: boolean;
  /** Runtime error surfaced on the message card. */
  error?: string;
  /** Ephemeral status line shown while the assistant is working. */
  statusLine?: string;
  execution?: Execution;
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
  /** Epoch-ms expiry timestamps per remembered secret key field (see keyExpiry.ts). */
  keyExpirations?: Record<string, number>;
  systemPrompt: string;
  rememberKeys: boolean;
  defaultModel?: string;
  githubWriteMode?: boolean;
  theme?: "light" | "dark" | "system";
  /** Version of the one-time settings migrations already applied (see settingsMigration.ts). */
  settingsVersion?: number;
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
  messages: Array<Pick<Message, "role" | "content" | "toolInvocations"> & { attachments?: AttachmentRecord[] }>;
  enabledTools: ChatRequestTool[];
  /** @deprecated Accepted for older clients; has no effect on image compatibility. */
  imageSupportAcknowledged?: boolean;
};
