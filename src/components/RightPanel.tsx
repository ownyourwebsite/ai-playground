"use client";

import React, { useState } from "react";
import {
  Command,
  Database,
  PanelRightClose,
  Plus,
  Trash2,
  Play,
  ExternalLink,
  ChevronDown,
  CheckCircle2,
  Pencil,
  X,
  Save,
} from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { initializeMcp, listMcpTools, callMcpTool, clearMcpSession, McpTool } from "@/lib/mcp/client";
import { resolveGithubToolArgs } from "@/lib/mcp/utils";
import { generateCurl, generateTypeScript } from "@/lib/export/snippet";
import { McpServer } from "@/lib/types";

export default function RightPanel() {
  const {
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    activeRightTab,
    setActiveRightTab,
    mcpServers,
    toggleMcpServer,
    addMcpServer,
    updateMcpServer,
    removeMcpServer,
    settings,
    updateSettings,
    selectedModel,
    tokensCount,
    latency,
    messages,
    rawRequestJson,
    rawResponseJson,
  } = useWorkspace();

  // Custom MCP Adding State
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [newMcpHeaders, setNewMcpHeaders] = useState<{ name: string; value: string }[]>([{ name: "", value: "" }]);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);

  // Selected tool runner state
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = useState<McpTool[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [toolArguments, setToolArguments] = useState<string>("{}");
  const [toolExecutionResult, setToolExecutionResult] = useState<unknown>(null);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [connectingServerId, setConnectingServerId] = useState<string | null>(null);

  // Snippet export state
  const [snippetType, setSnippetType] = useState<"curl" | "typescript">("curl");

  // State to toggle GitHub Write Mode accordion
  const [isGithubWriteModeExpanded, setIsGithubWriteModeExpanded] = useState(false);

  if (!isRightSidebarOpen) return null;

  const presetServers = mcpServers.filter((s) => s.preset);
  const customServers = mcpServers.filter((s) => !s.preset);

  // Build the exact headers to send for a server. GitHub is just a preset whose
  // PAT becomes an Authorization: Bearer header; any custom server's stored
  // headers are forwarded as-is (including multiple entries).
  const getAuthHeaders = (server: McpServer): Record<string, string> =>
    server.preset === "github" && settings.githubPat
      ? { Authorization: `Bearer ${settings.githubPat}` }
      : server.headers || {};

  const buildHeadersObject = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const row of newMcpHeaders) {
      const name = row.name.trim();
      if (name) {
        headers[name] = row.value;
      }
    }
    return headers;
  };

  const resetForm = () => {
    setNewMcpName("");
    setNewMcpUrl("");
    setNewMcpHeaders([{ name: "", value: "" }]);
    setEditingServerId(null);
  };

  const addHeaderRow = () => setNewMcpHeaders((prev) => [...prev, { name: "", value: "" }]);

  const updateHeaderRow = (idx: number, patch: Partial<{ name: string; value: string }>) =>
    setNewMcpHeaders((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));

  const removeHeaderRow = (idx: number) =>
    setNewMcpHeaders((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));

  const handleConnectMcp = async (server: McpServer) => {
    // If already connected, disconnect and return
    if (server.status === "connected") {
      toggleMcpServer(server.id);
      alert(`Successfully disconnected from ${server.name}.`);
      return;
    }

    setConnectingServerId(server.id);
    try {
      const authHeaders = getAuthHeaders(server);
      // A stale session may exist if this server was connected before
      clearMcpSession(server.url);
      await initializeMcp(server.url, authHeaders);
      const tools = await listMcpTools(server.url, authHeaders);

      setDiscoveredTools(tools);
      setSelectedServerId(server.id);
      if (tools.length > 0) {
        setSelectedTool(tools[0]);
      }
      toggleMcpServer(server.id, tools); // set status to connected and save tools
      alert(`Successfully connected to ${server.name}! Loaded ${tools.length} tools.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Connection failed: ${message}`);
    } finally {
      setConnectingServerId(null);
    }
  };

  const handleAddCustomMcp = () => {
    if (!newMcpName || !newMcpUrl) {
      alert("Name and URL are required.");
      return;
    }
    const headers = buildHeadersObject();
    addMcpServer({
      id: `custom-${Date.now()}`,
      name: newMcpName,
      description: "User defined MCP Server",
      url: newMcpUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    resetForm();
  };

  const startEdit = (server: McpServer) => {
    setEditingServerId(server.id);
    setNewMcpName(server.name);
    setNewMcpUrl(server.url);
    const entries = Object.entries(server.headers || {});
    setNewMcpHeaders(entries.length > 0 ? entries.map(([name, value]) => ({ name, value })) : [{ name: "", value: "" }]);
    requestAnimationFrame(() => {
      document.getElementById("add-custom-mcp-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const handleSaveEdit = () => {
    if (!editingServerId) return;
    if (!newMcpName || !newMcpUrl) {
      alert("Name and URL are required.");
      return;
    }
    const headers = buildHeadersObject();
    updateMcpServer(editingServerId, {
      name: newMcpName,
      url: newMcpUrl,
      description: "User defined MCP Server",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
    resetForm();
    alert("Server updated.");
  };

  const handleDeleteCustomMcp = (server: McpServer) => {
    if (!window.confirm(`Delete custom MCP server "${server.name}"?`)) return;
    removeMcpServer(server.id);
    if (selectedServerId === server.id) {
      setSelectedServerId(null);
      setDiscoveredTools([]);
      setSelectedTool(null);
      setToolExecutionResult(null);
    }
  };

  const handleExecuteTool = async () => {
    if (!selectedTool || !selectedServerId) return;
    setIsExecutingTool(true);
    setToolExecutionResult(null);

    const activeServ = mcpServers.find((s) => s.id === selectedServerId);
    if (!activeServ) return;

    try {
      const parsedArgs = JSON.parse(toolArguments) as Record<string, unknown>;
      const authHeaders = getAuthHeaders(activeServ);
      const res = await callMcpTool(activeServ.url, authHeaders, selectedTool.name, parsedArgs);
      setToolExecutionResult(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setToolExecutionResult({ error: message });
    } finally {
      setIsExecutingTool(false);
    }
  };

  const currentSnippet =
    snippetType === "curl"
      ? generateCurl("openai", selectedModel, messages, settings.openAiKey || "", settings.systemPrompt)
      : generateTypeScript("openai", selectedModel, messages, settings.systemPrompt);

  return (
    <aside className="fixed md:relative inset-y-0 right-0 z-40 w-[280px] sm:w-[300px] xl:w-[350px] border-l border-border bg-sidebar flex flex-col transition-all duration-300 ease-in-out shrink-0 h-full shadow-xl md:shadow-none">
      {/* Tabs Header */}
      <div className="flex h-14 border-b border-border text-sm px-2 items-center justify-between">
        <div className="flex flex-1 h-full">
          <button
            onClick={() => setActiveRightTab("inspector")}
            className={`flex-1 font-medium border-b-2 inline-flex items-center justify-center gap-2 cursor-pointer transition-colors ${activeRightTab === "inspector"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
          >
            <Command className="w-3.5 h-3.5" />
            Inspector
          </button>
          <button
            onClick={() => setActiveRightTab("mcp")}
            className={`flex-1 font-medium border-b-2 inline-flex items-center justify-center gap-2 cursor-pointer transition-colors ${activeRightTab === "mcp"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
          >
            <Database className="w-3.5 h-3.5" />
            MCP Servers
          </button>
        </div>
        <button
          onClick={() => setIsRightSidebarOpen(false)}
          className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors ml-1 cursor-pointer"
          title="Collapse Inspector"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-muted/10">
        {activeRightTab === "inspector" ? (
          <div className="p-4 space-y-5">
            {/* Request Raw JSON */}
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Last API Request
              </h3>
              <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
                <div className="bg-muted/40 px-3 py-2 text-xs font-medium border-b border-border flex justify-between items-center">
                  <span className="text-foreground">Raw Request Payload</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(rawRequestJson, null, 2));
                      alert("Copied to clipboard!");
                    }}
                    className="text-muted-foreground hover:text-foreground transition-colors text-[11px] font-medium cursor-pointer"
                  >
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-[11px] text-muted-foreground overflow-x-auto font-mono leading-relaxed max-h-[150px]">
                  {rawRequestJson ? JSON.stringify(rawRequestJson, null, 2) : "// No request made yet"}
                </pre>
              </div>
            </div>

            {/* Response Raw JSON */}
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Last API Response
              </h3>
              <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
                <div className="bg-muted/40 px-3 py-2 text-xs font-medium border-b border-border flex justify-between items-center">
                  <span className="text-foreground">Raw Response Stream / Output</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(rawResponseJson, null, 2));
                      alert("Copied to clipboard!");
                    }}
                    className="text-muted-foreground hover:text-foreground transition-colors text-[11px] font-medium cursor-pointer"
                  >
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-[11px] text-muted-foreground overflow-x-auto font-mono leading-relaxed max-h-[150px]">
                  {rawResponseJson ? JSON.stringify(rawResponseJson, null, 2) : "// No response received yet"}
                </pre>
              </div>
            </div>

            {/* Snippet Code Export */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Export Snippet
                </h3>
                <div className="flex gap-1.5 bg-muted/60 p-0.5 rounded-lg border border-border">
                  <button
                    onClick={() => setSnippetType("curl")}
                    className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${snippetType === "curl" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                      }`}
                  >
                    cURL
                  </button>
                  <button
                    onClick={() => setSnippetType("typescript")}
                    className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${snippetType === "typescript" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                      }`}
                  >
                    TS (SDK)
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
                <div className="bg-muted/40 px-3 py-2 text-xs font-medium border-b border-border flex justify-between items-center">
                  <span className="text-foreground">{snippetType === "curl" ? "curl-command.sh" : "ai-sdk.ts"}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(currentSnippet);
                      alert("Snippet copied!");
                    }}
                    className="text-muted-foreground hover:text-foreground transition-colors text-[11px] font-medium cursor-pointer"
                  >
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-[11px] text-muted-foreground overflow-x-auto font-mono leading-relaxed max-h-[180px]">
                  {currentSnippet}
                </pre>
              </div>
            </div>

            {/* Metrics */}
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Metrics
              </h3>
              <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
                <div className="p-3 text-xs grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="text-muted-foreground">Tokens</div>
                    <div className="text-xl font-semibold text-foreground">{tokensCount}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground">Latency</div>
                    <div className="text-xl font-semibold text-foreground">{latency ? `${latency}ms` : "—"}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* Built-in / Preset MCP Servers */}
            {presetServers.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Presets
                  </h3>
                </div>

                {presetServers.map((server) => (
                  <div key={server.id} className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-2.5">
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5">
                        <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                          {server.name}
                          {server.status === "connected" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 fill-emerald-500/10" />}
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-snug">{server.description}</div>
                      </div>
                    </div>

                    {server.preset === "github" && (
                      <div className="space-y-1.5 pt-1">
                        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                          Personal Access Token (PAT)
                        </label>
                        <input
                          type="password"
                          placeholder="ghp_..."
                          value={settings.githubPat || ""}
                          onChange={(e) => updateSettings({ githubPat: e.target.value })}
                          className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="flex justify-between items-center text-[10px]">
                          <span className="text-muted-foreground">Scopes: Contents read, Issues, PRs</span>
                          <a
                            href="https://github.com/settings/personal-access-tokens/new"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline flex items-center gap-0.5 font-medium"
                          >
                            Create Fine-Grained PAT
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>

                        {/* Collapsible GitHub Write Mode Section */}
                        <div className="pt-2.5 border-t border-border/40 mt-2">
                          <div className="text-[10px] text-amber-600 dark:text-amber-500 font-semibold italic mb-2 leading-snug">
                            ⚠️ GitHub MCP requires ~30,000 TPM to function properly.
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsGithubWriteModeExpanded(!isGithubWriteModeExpanded)}
                            className="w-full flex items-center justify-between text-[10px] font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors cursor-pointer"
                          >
                            <span>GitHub Write Mode Settings</span>
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isGithubWriteModeExpanded ? "rotate-180" : ""}`} />
                          </button>

                          {isGithubWriteModeExpanded && (
                            <div className="mt-2 space-y-2 animate-in slide-in-from-top-1 duration-150">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-semibold text-muted-foreground uppercase">Enable Write Actions</span>
                                <button
                                  onClick={() => updateSettings({ githubWriteMode: settings.githubWriteMode !== false ? false : true })}
                                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${settings.githubWriteMode !== false ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                                >
                                  <span
                                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out ${settings.githubWriteMode !== false ? 'translate-x-4' : 'translate-x-0'}`}
                                  />
                                </button>
                              </div>
                              {settings.githubWriteMode === false ? (
                                <div className="text-[9px] text-amber-600 dark:text-amber-500 font-semibold leading-snug bg-amber-500/10 p-1.5 rounded-lg border border-amber-500/10">
                                  ⚠️ Write tools filtered (saves tokens, could fit free tier limit).
                                </div>
                              ) : (
                                <div className="text-[9px] text-rose-600 dark:text-rose-500 font-semibold leading-snug bg-rose-500/10 p-1.5 rounded-lg border border-rose-500/10">
                                  🚨 Full tools enabled (might hit free tier token limits).
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1.5 border-t border-muted/50">
                      <span className="text-[10px] font-mono text-muted-foreground uppercase">{server.status}</span>
                      <button
                        onClick={() => handleConnectMcp(server)}
                        disabled={connectingServerId === server.id}
                        className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors cursor-pointer ${server.status === "connected"
                          ? "text-destructive hover:bg-destructive/5"
                          : "text-primary hover:bg-primary/5"
                          }`}
                      >
                        {connectingServerId === server.id ? "Connecting..." : server.status === "connected" ? "Disconnect" : "Connect"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add Remote MCP Server — pinned so it's always reachable; added
                servers stack in the Custom Servers list right below it */}
            <div id="add-custom-mcp-form" className="sticky top-0 z-10 -mx-4 px-4 pt-3 pb-3 space-y-2.5 bg-sidebar border-b border-border/50 shadow-sm scroll-mt-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {editingServerId ? "Edit Remote MCP Server" : "Add Remote MCP Server"}
                </h3>
                {editingServerId && (
                  <button
                    onClick={resetForm}
                    className="text-[10px] font-semibold text-muted-foreground hover:text-foreground uppercase tracking-wider cursor-pointer"
                  >
                    Cancel edit
                  </button>
                )}
              </div>
              <div className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-2">
                <input
                  type="text"
                  placeholder="Server Name (e.g. Tavily Search)"
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                  className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  placeholder="URL (https://... e.g. https://mcp.tavily.com/mcp)"
                  value={newMcpUrl}
                  onChange={(e) => setNewMcpUrl(e.target.value)}
                  className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />

                {/* Repeatable headers */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Headers
                    </label>
                    <button
                      type="button"
                      onClick={addHeaderRow}
                      className="text-[10px] font-semibold text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      Add header
                    </button>
                  </div>
                  {newMcpHeaders.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
                      <input
                        type="text"
                        placeholder="Name (e.g. Authorization)"
                        value={row.name}
                        onChange={(e) => updateHeaderRow(idx, { name: e.target.value })}
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <input
                        type="text"
                        placeholder="Value (e.g. Bearer key)"
                        value={row.value}
                        onChange={(e) => updateHeaderRow(idx, { value: e.target.value })}
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        type="button"
                        onClick={() => removeHeaderRow(idx)}
                        disabled={newMcpHeaders.length <= 1}
                        title="Remove header"
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {editingServerId ? (
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleSaveEdit}
                      className="flex-1 bg-primary text-primary-foreground font-semibold py-1 px-3 rounded-lg text-xs flex items-center justify-center gap-1 hover:bg-primary/90 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save Changes
                    </button>
                    <button
                      onClick={resetForm}
                      className="px-3 border border-border bg-background text-foreground font-semibold py-1 rounded-lg text-xs hover:bg-muted transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleAddCustomMcp}
                    className="w-full bg-primary text-primary-foreground font-semibold py-1 px-3 rounded-lg text-xs flex items-center justify-center gap-1 hover:bg-primary/90 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Remote Server
                  </button>
                )}
              </div>
            </div>

            {/* User Custom MCPs */}
            {customServers.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                  Custom Servers
                </h3>
                {customServers.map((server) => (
                  <div key={server.id} className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5 min-w-0">
                        <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                          <span className="truncate">{server.name}</span>
                          {server.status === "connected" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 fill-emerald-500/10 shrink-0" />}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">{server.url}</div>
                        {server.headers && Object.keys(server.headers).length > 0 && (
                          <div className="text-[10px] text-muted-foreground/70">
                            {Object.keys(server.headers).length} header{Object.keys(server.headers).length > 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => startEdit(server)}
                          title="Edit server"
                          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteCustomMcp(server)}
                          title="Delete server"
                          className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/5 rounded-md transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={() => handleConnectMcp(server)}
                      disabled={connectingServerId === server.id}
                      className={`w-full text-xs py-1 px-2 rounded-lg font-medium transition-colors cursor-pointer border ${server.status === "connected"
                        ? "text-destructive border-destructive/20 hover:bg-destructive/5"
                        : "text-foreground border-border hover:bg-muted"
                        }`}
                    >
                      {connectingServerId === server.id ? "Connecting..." : server.status === "connected" ? "Disconnect" : "Connect"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Tool Runner Area */}
            {discoveredTools.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-muted-foreground/10">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                  Manual Tool Runner
                </h3>
                <div className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-2.5">
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase">Select Tool</label>
                    <div className="relative">
                      <select
                        onChange={(e) => {
                          const tool = discoveredTools.find((t) => t.name === e.target.value);
                          setSelectedTool(tool || null);
                          if (tool) {
                            const initialArgs: Record<string, unknown> = tool.inputSchema?.properties
                              ? Object.keys(tool.inputSchema.properties).reduce<Record<string, unknown>>((acc, k) => ({ ...acc, [k]: "" }), {})
                              : {};
                            const resolved = resolveGithubToolArgs(tool.name, initialArgs, tool.inputSchema, messages);
                            setToolArguments(JSON.stringify(resolved, null, 2));
                          } else {
                            setToolArguments("{}");
                          }
                        }}
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none appearance-none pr-8 cursor-pointer"
                      >
                        {discoveredTools.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground" />
                    </div>
                  </div>

                  {selectedTool && (
                    <div className="text-[11px] text-muted-foreground leading-snug bg-muted/30 p-2 rounded-lg">
                      {selectedTool.description || "No description provided"}
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase">Arguments (JSON)</label>
                    <textarea
                      value={toolArguments}
                      onChange={(e) => setToolArguments(e.target.value)}
                      className="w-full bg-muted/20 border border-input rounded-lg p-2 text-xs font-mono min-h-[80px] focus:outline-none"
                    />
                  </div>

                  <button
                    onClick={handleExecuteTool}
                    disabled={isExecutingTool}
                    className="w-full bg-primary text-primary-foreground font-semibold py-1.5 px-3 rounded-lg text-xs flex items-center justify-center gap-1.5 hover:bg-primary/90 cursor-pointer"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    {isExecutingTool ? "Executing..." : "Run Tool"}
                  </button>

                  {toolExecutionResult !== null && toolExecutionResult !== undefined && (
                    <div className="space-y-1 pt-1.5 border-t border-muted/50">
                      <label className="text-[10px] font-medium text-muted-foreground uppercase">Result</label>
                      <pre className="p-2 bg-muted/40 rounded-lg text-[10px] font-mono overflow-x-auto leading-normal max-h-[150px]">
                        {JSON.stringify(toolExecutionResult, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
