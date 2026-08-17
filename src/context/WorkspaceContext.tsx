"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { Session, AppSettings, McpServer, ChatRequestBody, Message } from "@/lib/types";
import { getSessions, getSettings, saveSettings, getMcpServers } from "@/lib/db";
import { initializeMcp, listMcpTools, McpTool } from "@/lib/mcp/client";

const DEFAULT_SETTINGS: AppSettings = {
  id: "default",
  systemPrompt: "You are a helpful and precise assistant.",
  rememberKeys: true
};

// Upgrade stale default model IDs persisted by older versions to the current
// defaults. User-chosen custom models (anything else) are left untouched.
const LEGACY_MODEL_DEFAULTS: Record<string, string> = {
  "gpt-4o": "gpt-5.6-luna",
  "gpt-4o-mini": "gpt-5.6-luna",
  "o1-preview": "gpt-5.6-luna",
  "o1-mini": "gpt-5.6-luna",
  "claude-3-5-sonnet-latest": "claude-5-sonnet",
  "claude-3-5-haiku-latest": "claude-5-sonnet",
  "claude-3-opus-latest": "claude-5-sonnet",
  "llama-3.3-70b-versatile": "qwen/qwen3.6-27b",
  "llama-3.1-70b-versatile": "qwen/qwen3.6-27b",
  "llama-3.1-8b-instant": "qwen/qwen3.6-27b",
  "mixtral-8x7b-32768": "qwen/qwen3.6-27b",
};

function migrateSettings(settings: AppSettings): AppSettings {
  const migrate = (value: string | undefined) =>
    value && LEGACY_MODEL_DEFAULTS[value] ? LEGACY_MODEL_DEFAULTS[value] : value;

  return {
    ...settings,
    openAiModel: migrate(settings.openAiModel),
    anthropicModel: migrate(settings.anthropicModel),
    groqModel: migrate(settings.groqModel),
    ollamaModel: migrate(settings.ollamaModel),
    customModel: migrate(settings.customModel),
  };
}

const DEFAULT_MCP_SERVERS: McpServer[] = [
  { id: "github", name: "GitHub Integration", description: "Create issues, view PRs, search code", url: "https://api.githubcopilot.com/mcp/", preset: "github", status: "disconnected" }
];

const WELCOME_MESSAGES: Message[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "Hello! I am ready. You can select a model and configure MCP tools. How can I help you today?"
  }
];

export type WorkspaceContextType = {
  // DB state
  sessions: Session[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  startNewSession: () => void;
  refreshSessions: () => Promise<void>;

  // Settings
  settings: AppSettings;
  updateSettings: (newSettings: Partial<AppSettings>) => void;

  // MCP
  mcpServers: McpServer[];
  toggleMcpServer: (id: string, tools?: McpTool[]) => void;

  // UI State
  isLeftSidebarOpen: boolean;
  setIsLeftSidebarOpen: (v: boolean) => void;
  isRightSidebarOpen: boolean;
  setIsRightSidebarOpen: (v: boolean) => void;
  activeRightTab: "inspector" | "mcp";
  setActiveRightTab: (v: "inspector" | "mcp") => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (v: boolean) => void;

  selectedModel: string;
  setSelectedModel: (v: string) => void;

  messages: Message[];
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  input: string;
  setInput: (v: string) => void;

  rawRequestJson: ChatRequestBody | null;
  setRawRequestJson: (v: ChatRequestBody | null) => void;
  rawResponseJson: unknown;
  setRawResponseJson: (v: unknown) => void;

  // Stats
  tokensCount: number;
  setTokensCount: (v: number) => void;
  latency: number;
  setLatency: (v: number) => void;
};

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [mcpServers, setMcpServers] = useState<McpServer[]>(DEFAULT_MCP_SERVERS);

  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [activeRightTab, setActiveRightTab] = useState<"inspector" | "mcp">("inspector");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [selectedModel, setSelectedModel] = useState("openai");
  const [messages, setMessages] = useState(WELCOME_MESSAGES);
  const [input, setInput] = useState("");
  const [rawRequestJson, setRawRequestJson] = useState<ChatRequestBody | null>(null);
  const [rawResponseJson, setRawResponseJson] = useState<unknown>(null);
  const [tokensCount, setTokensCount] = useState(15);
  const [latency, setLatency] = useState(0);

  // Load initial data
  useEffect(() => {
    async function load() {
      const dbSettings = await getSettings();
      let loadedSettings: AppSettings = DEFAULT_SETTINGS;
      if (dbSettings) {
        // Upgrade stale default model IDs persisted by older versions.
        const migrated = migrateSettings(dbSettings);
        setSettings(migrated);
        loadedSettings = migrated;
        if (migrated.defaultModel) {
          setSelectedModel(migrated.defaultModel);
        }
      } else {
        // Default rememberKeys to true
        const defaultSettings = { ...DEFAULT_SETTINGS, rememberKeys: true };
        setSettings(defaultSettings);
        loadedSettings = defaultSettings;
      }
      const dbSessions = await getSessions();
      if (dbSessions.length > 0) {
        setSessions(dbSessions);
      }
      const dbServers = await getMcpServers();
      let loadedServers: McpServer[] = DEFAULT_MCP_SERVERS;
      if (dbServers.length > 0) {
        loadedServers = dbServers.map(s => ({ ...s, status: "disconnected" as const }));
        setMcpServers(loadedServers);
      }

      // Auto-connect to GitHub MCP server on load if PAT exists
      const githubServer = loadedServers.find(s => s.id === "github");
      if (githubServer && loadedSettings.githubPat) {
        try {
          const token = loadedSettings.githubPat;
          await initializeMcp(githubServer.url, token);
          const tools = await listMcpTools(githubServer.url, token);

          setMcpServers(prev => prev.map(s => {
            if (s.id === "github") {
              return { ...s, status: "connected" as const, tools: tools || [] };
            }
            return s;
          }));
        } catch (err) {
          console.warn("Auto-connect to GitHub MCP failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
    load();
  }, []);

  const updateSettings = useCallback(async (newS: Partial<AppSettings>) => {
    const updated = { ...settingsRef.current, ...newS };
    settingsRef.current = updated;
    setSettings(updated);
    if (updated.rememberKeys) {
      await saveSettings(updated);
    } else {
      // clear keys from storage, but keep system prompt
      await saveSettings({
        ...updated,
        openAiKey: undefined,
        anthropicKey: undefined,
        groqKey: undefined,
        customKey: undefined,
        githubPat: undefined
      });
    }
  }, []);

  const startNewSession = () => {
    setActiveSessionId(null);
  };

  const refreshSessions = async () => {
    const dbSessions = await getSessions();
    setSessions(dbSessions);
  };

  const toggleMcpServer = (id: string, tools?: McpTool[]) => {
    setMcpServers(prev => prev.map(s => {
      if (s.id === id) {
        if (s.status === 'connected') {
          return { ...s, status: 'disconnected' as const, tools: [] };
        } else {
          return { ...s, status: 'connected' as const, tools: tools || [] };
        }
      }
      return s;
    }));
  };

  return (
    <WorkspaceContext.Provider value={{
      sessions, activeSessionId, setActiveSessionId, startNewSession, refreshSessions,
      settings, updateSettings,
      mcpServers, toggleMcpServer,
      isLeftSidebarOpen, setIsLeftSidebarOpen,
      isRightSidebarOpen, setIsRightSidebarOpen,
      activeRightTab, setActiveRightTab,
      isSettingsOpen, setIsSettingsOpen,
      selectedModel, setSelectedModel,
      messages, setMessages,
      input, setInput,
      rawRequestJson, setRawRequestJson,
      rawResponseJson, setRawResponseJson,
      tokensCount, setTokensCount, latency, setLatency
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
