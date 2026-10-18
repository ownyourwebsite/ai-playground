"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { Session, AppSettings, McpServer, McpServerConfig, ChatRequestBody, Message } from "@/lib/types";
import { getSessions, getSettings, saveSettings, getMcpServers, saveMcpServer, deleteMcpServer, deleteSession } from "@/lib/db";
import { initializeMcp, listMcpTools, clearMcpSession, McpTool } from "@/lib/mcp/client";
import { cleanExpiredKeys, refreshKeyExpirations, settingsForStorage, KEY_FIELDS } from "@/lib/keyExpiry";
import { storageErrorCode } from "@/lib/storageErrors";

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
  "claude-3-5-sonnet-latest": "claude-sonnet-5",
  "claude-3-5-haiku-latest": "claude-sonnet-5",
  "claude-3-opus-latest": "claude-sonnet-5",
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

export type WorkspaceTheme = "light" | "dark" | "system";
type SessionLifecycle = {
  switch: (id: string | null) => Promise<boolean>;
  beforeDelete: (id: string) => Promise<void>;
  deleteFailed: (id: string) => void;
  deleted: (id: string) => void;
};

export type WorkspaceContextType = {
  // DB state
  sessions: Session[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  startNewSession: () => void;
  refreshSessions: () => Promise<void>;
  rememberSession: (session: Session) => Session;
  removeSession: (id: string) => Promise<void>;
  sessionError: string | null;
  registerSessionLifecycle: (lifecycle: SessionLifecycle) => () => void;

  // Settings
  settings: AppSettings;
  updateSettings: (newSettings: Partial<AppSettings>) => Promise<boolean>;
  settingsReady: boolean;
  settingsLoadFailed: boolean;
  settingsError: string | null;
  retryWorkspaceStorage: () => Promise<void>;
  hasUnsavedSettings: () => boolean;

  // Theme
  theme: WorkspaceTheme;
  setTheme: (theme: WorkspaceTheme) => void;

  // MCP
  mcpServers: McpServer[];
  toggleMcpServer: (id: string, tools?: McpTool[]) => void;
  addMcpServer: (config: McpServerConfig) => void;
  updateMcpServer: (id: string, patch: Partial<McpServerConfig>) => void;
  removeMcpServer: (id: string) => void;

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

};

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const sessionLifecycle = useRef<SessionLifecycle | null>(null);
  const selection = useRef(0);
  const deletingSessions = useRef(new Set<string>());
  const deletedSessions = useRef(new Set<string>());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const commitSelection = useCallback((id: string | null) => {
    activeSessionRef.current = id;
    setActiveSessionIdState(id);
  }, []);
  const registerSessionLifecycle = useCallback((lifecycle: SessionLifecycle) => {
    sessionLifecycle.current = lifecycle;
    return () => { if (sessionLifecycle.current === lifecycle) sessionLifecycle.current = null; };
  }, []);
  const setActiveSessionId = useCallback((id: string | null) => {
    if (id === activeSessionRef.current || (id && (deletingSessions.current.has(id) || deletedSessions.current.has(id)))) return;
    const ticket = ++selection.current;
    const lifecycle = sessionLifecycle.current;
    if (!lifecycle) { commitSelection(id); return; }
    void lifecycle.switch(id).then(accepted => {
      if (accepted && ticket === selection.current && (!id || (!deletingSessions.current.has(id) && !deletedSessions.current.has(id)))) commitSelection(id);
    }).catch(() => { setSessionError('Session could not be switched. Current data is retained. Retry after storage recovers.'); });
  }, [commitSelection]);
  const removeSession = useCallback(async (id: string) => {
    if (deletingSessions.current.has(id) || deletedSessions.current.has(id)) return;
    deletingSessions.current.add(id);
    const lifecycle = sessionLifecycle.current;
    try {
      // Detach is synchronous up to its first await: pagehide/late results cannot
      // enqueue a new save after deletion has started. Existing saves settle first.
      await lifecycle?.beforeDelete(id);
      await deleteSession(id);
    } catch {
      lifecycle?.deleteFailed(id);
      setSessionError('Session could not be deleted. Its data is retained. Retry deletion after storage recovers.');
      deletingSessions.current.delete(id);
      return;
    }
    deletedSessions.current.add(id);
    memorySessions.current.delete(id);
    deletingSessions.current.delete(id);
    setSessions(previous => previous.filter(session => session.id !== id));
    setSessionError(null);
    if (activeSessionRef.current === id) { ++selection.current; commitSelection(null); }
    lifecycle?.deleted(id);
  }, [commitSelection]);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const settingsLoaded = useRef(false);
  const pendingSettings = useRef<Partial<AppSettings>>({});
  const settingsDirty = useRef(false);
  const settingsSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const workspaceLoad = useRef<Promise<void> | null>(null);
  const configurationNeedsReload = useRef(false);
  const memorySessions = useRef(new Map<string, Session>());
  const sessionTitles = useRef(new Map<string, string>());
  const rememberSession = useCallback((session: Session) => {
    const remembered = { ...session, title: sessionTitles.current.get(session.id) ?? session.title };
    if (deletedSessions.current.has(session.id) || deletingSessions.current.has(session.id)) return remembered;
    sessionTitles.current.set(session.id, remembered.title);
    memorySessions.current.set(session.id, remembered);
    setSessions(previous => [...previous.filter(s => s.id !== session.id), remembered]);
    return remembered;
  }, []);

  const [mcpServers, setMcpServers] = useState<McpServer[]>(DEFAULT_MCP_SERVERS);
  const mcpServersRef = useRef(mcpServers);
  useEffect(() => {
    mcpServersRef.current = mcpServers;
  }, [mcpServers]);

  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [activeRightTab, setActiveRightTab] = useState<"inspector" | "mcp">("inspector");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [theme, setThemeState] = useState<WorkspaceTheme>("system");
  const [selectedModel, setSelectedModel] = useState("openai");
  const [messages, setMessages] = useState(WELCOME_MESSAGES);
  const [input, setInput] = useState("");
  const [rawRequestJson, setRawRequestJson] = useState<ChatRequestBody | null>(null);
  const [rawResponseJson, setRawResponseJson] = useState<unknown>(null);

  // Independent reads: a failure in one store must not hide the other data.
  const performLoad = useCallback(async () => {
      let loadedSettings = settingsRef.current;
      let loadedServers = mcpServersRef.current;
      await Promise.all([
      (async () => {
      try {
      const dbSettings = await getSettings();
      if (dbSettings) {
        // Upgrade stale default model IDs persisted by older versions.
        const migrated = migrateSettings(dbSettings);
        // Drop remembered keys whose 30-day expiry has passed (keys saved before
        // this feature have no expiry entry and are left intact). Persist the
        // cleanup so the deletion sticks.
        const pending = pendingSettings.current;
        const merged = { ...DEFAULT_SETTINGS, ...migrated, ...pending };
        if (!settingsLoaded.current && pending.savedProviders) {
          merged.savedProviders = [...new Map([...(migrated.savedProviders ?? []), ...pending.savedProviders].map(provider => [provider.id, provider])).values()];
        }
        const refreshed = refreshKeyExpirations(merged, KEY_FIELDS.filter(field => field in pending));
        const { settings: cleaned, dropped } = cleanExpiredKeys(refreshed);
        if (dropped.length) settingsDirty.current = true;
        settingsRef.current = cleaned;
        setSettings(cleaned);
        loadedSettings = cleaned;
        if (cleaned.defaultModel) {
          setSelectedModel(cleaned.defaultModel);
        }
        if (cleaned.theme) {
          setThemeState(cleaned.theme);
        }
      } else {
        // Default rememberKeys to true
        const defaultSettings = { ...DEFAULT_SETTINGS, rememberKeys: true };
        loadedSettings = { ...defaultSettings, ...pendingSettings.current };
        settingsRef.current = loadedSettings;
        setSettings(loadedSettings);
      }
      settingsLoaded.current = true;
      setSettingsLoadFailed(false);
      const expected = settingsRef.current;
      if (settingsDirty.current) await saveSettings(settingsForStorage(loadedSettings));
      if (settingsRef.current === expected) {
        settingsDirty.current = false; pendingSettings.current = {};
        setSettingsError(null);
      }
      } catch (error) {
        if (!settingsLoaded.current) setSettingsLoadFailed(true);
        setSettingsError(`Settings could not be ${settingsLoaded.current ? 'saved' : 'loaded'} (${storageErrorCode(error)}). Nothing was cleared. Check that you are using the same browser address and port.`);
      } finally { setSettingsReady(true); }
      })(),
      (async () => { try {
      const dbSessions = await getSessions();
      for (const session of dbSessions) if (!sessionTitles.current.has(session.id)) sessionTitles.current.set(session.id, session.title);
      const merged = new Map(dbSessions.map(session => [session.id, session]));
      for (const [id, session] of memorySessions.current) merged.set(id, session);
      setSessions([...merged.values()].filter(s => !deletedSessions.current.has(s.id)));
      setSessionError(null);
      } catch (error) { configurationNeedsReload.current = true; setSessionError(`Saved chats could not be loaded (${storageErrorCode(error)}). Chats already open in this tab are retained.`); } })(),
      (async () => { try {
      const dbServers = await getMcpServers();
      if (dbServers.length > 0) {
        const withStatus: McpServer[] = dbServers.map(s => {
          const runtime = mcpServersRef.current.find(current => current.id === s.id);
          return { ...s, status: runtime?.status ?? 'disconnected', tools: runtime?.tools };
        });
        // Merge built-in presets missing from IndexedDB. Without this, adding
        // any custom server (e.g. Tavily) persists only that server, and on the
        // next reload the GitHub preset vanishes from the right panel.
        const missingPresets = DEFAULT_MCP_SERVERS.filter(d => !withStatus.some(s => s.id === d.id));
        loadedServers = [...missingPresets, ...withStatus];
        mcpServersRef.current = loadedServers;
        setMcpServers(loadedServers);
      }
      } catch (error) { configurationNeedsReload.current = true; setSessionError(`MCP configuration could not be loaded (${storageErrorCode(error)}). It has not been deleted.`); } })(),
      ]);

      // Auto-connect to GitHub MCP server on load if PAT exists
      const githubServer = loadedServers.find(s => s.id === "github");
      if (githubServer && githubServer.status !== 'connected' && loadedSettings.githubPat) {
        try {
          const authHeaders: Record<string, string> = loadedSettings.githubPat
            ? { Authorization: `Bearer ${loadedSettings.githubPat}` }
            : {};
          // A stale session from a previous run may no longer be valid
          clearMcpSession(githubServer.url);
          await initializeMcp(githubServer.url, authHeaders);
          const tools = await listMcpTools(githubServer.url, authHeaders);

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
  }, []);
  const loadWorkspace = useCallback(() => {
    if (!workspaceLoad.current) {
      configurationNeedsReload.current = false;
      workspaceLoad.current = performLoad().finally(() => { workspaceLoad.current = null; });
    }
    return workspaceLoad.current;
  }, [performLoad]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  // Apply theme to <html> element
  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = (t: WorkspaceTheme) => {
      root.classList.remove("dark", "light");
      if (t === "dark") {
        root.classList.add("dark");
      } else if (t === "light") {
        root.classList.add("light");
      } else {
        // system: follow OS preference
        root.classList.add(mql.matches ? "dark" : "light");
      }
    };

    apply(theme);

    if (theme === "system") {
      const handler = () => apply("system");
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
  }, [theme]);

  const updateSettings = useCallback(async (newS: Partial<AppSettings>) => {
    const touchedFields = KEY_FIELDS.filter(f => f in newS);
    const updated = refreshKeyExpirations({ ...settingsRef.current, ...newS }, touchedFields);
    settingsRef.current = updated;
    setSettings(updated);
    pendingSettings.current = { ...pendingSettings.current, ...newS };
    settingsDirty.current = true;
    if (!settingsLoaded.current) {
      setSettingsError('Settings are temporarily available in this tab. Retry loading before saving, so existing settings are not overwritten.');
      return false;
    }
    const task = settingsSaveQueue.current.catch(() => {}).then(async () => {
      try {
        await saveSettings(settingsForStorage(updated));
        if (settingsRef.current === updated) {
          settingsDirty.current = false; pendingSettings.current = {}; setSettingsError(null);
        }
        return true;
      } catch (error) {
        setSettingsError(`Settings are available in this tab but could not be saved (${storageErrorCode(error)}). Retry before closing this tab.`);
        return false;
      }
    });
    settingsSaveQueue.current = task;
    return task;
  }, []);
  const setTheme = useCallback((newTheme: WorkspaceTheme) => {
    setThemeState(newTheme);
    void updateSettings({ theme: newTheme });
  }, [updateSettings]);
  const retryWorkspaceStorage = useCallback(async () => {
    if (!settingsLoaded.current) await loadWorkspace();
    else if (settingsDirty.current) await updateSettings({});
    if (configurationNeedsReload.current) await loadWorkspace();
  }, [loadWorkspace, updateSettings]);
  const hasUnsavedSettings = useCallback(() => settingsDirty.current, []);

  const startNewSession = () => {
    setActiveSessionId(null);
  };

  const refreshSessions = async () => {
    const dbSessions = await getSessions();
    // A refresh begun by an older save must not put a deleted row back in UI.
    const merged = new Map(dbSessions.map(session => [session.id, session]));
    for (const [id, session] of memorySessions.current) merged.set(id, session);
    setSessions([...merged.values()].filter(s => !deletedSessions.current.has(s.id)));
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

  // Persist only the config fields (strip runtime-only status/tools).
  const toConfig = (server: McpServer): McpServerConfig => {
    const config: Record<string, unknown> = { ...server };
    delete config.status;
    delete config.tools;
    return config as McpServerConfig;
  };

  // Add a custom ("bring your own") MCP server and persist it locally.
  const addMcpServer = (config: McpServerConfig) => {
    const newServer: McpServer = { ...config, status: "disconnected", tools: [] };
    setMcpServers(prev => [...prev, newServer]);
    void saveMcpServer(toConfig(newServer)).catch(error => setSessionError(`MCP configuration is available in this tab but could not be saved (${storageErrorCode(error)}).`));
  };

  // Update a custom MCP server's config and persist it locally.
  const updateMcpServer = (id: string, patch: Partial<McpServerConfig>) => {
    setMcpServers(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
    const existing = mcpServersRef.current.find(s => s.id === id);
    if (existing) {
      void saveMcpServer(toConfig({ ...existing, ...patch })).catch(error => setSessionError(`MCP configuration could not be saved (${storageErrorCode(error)}).`));
    }
  };

  // Remove a custom MCP server (local list + IndexedDB).
  const removeMcpServer = (id: string) => {
    setMcpServers(prev => prev.filter(s => s.id !== id));
    void deleteMcpServer(id).catch(error => setSessionError(`MCP configuration could not be deleted (${storageErrorCode(error)}).`));
  };

  return (
    <WorkspaceContext.Provider value={{
      sessions, activeSessionId, setActiveSessionId, startNewSession, refreshSessions, rememberSession,
      removeSession, sessionError, registerSessionLifecycle,
      settings, updateSettings, settingsReady, settingsLoadFailed, settingsError, retryWorkspaceStorage, hasUnsavedSettings,
      mcpServers, toggleMcpServer, addMcpServer, updateMcpServer, removeMcpServer,
      isLeftSidebarOpen, setIsLeftSidebarOpen,
      isRightSidebarOpen, setIsRightSidebarOpen,
      activeRightTab, setActiveRightTab,
      isSettingsOpen, setIsSettingsOpen,
      selectedModel, setSelectedModel,
      messages, setMessages,
      input, setInput,
      rawRequestJson, setRawRequestJson,
      rawResponseJson, setRawResponseJson,
      theme, setTheme,
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
