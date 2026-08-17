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
} from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { initializeMcp, listMcpTools, callMcpTool, McpTool } from "@/lib/mcp/client";
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
  const [newMcpHeaderName, setNewMcpHeaderName] = useState("");
  const [newMcpHeaderValue, setNewMcpHeaderValue] = useState("");
  const [customMcpList, setCustomMcpList] = useState<McpServer[]>([]);

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

  const handleConnectMcp = async (server: McpServer) => {
    // If already connected, disconnect and return
    if (server.status === "connected") {
      toggleMcpServer(server.id);
      alert(`Successfully disconnected from ${server.name}.`);
      return;
    }

    setConnectingServerId(server.id);
    try {
      const token = server.preset === "github" ? settings.githubPat : undefined;
      await initializeMcp(server.url, token);
      const tools = await listMcpTools(server.url, token);

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
    const newServer: McpServer = {
      id: `custom-${Date.now()}`,
      name: newMcpName,
      description: "User defined MCP Server",
      url: newMcpUrl,
      status: "disconnected",
      headers: newMcpHeaderName ? { [newMcpHeaderName]: newMcpHeaderValue } : undefined,
    };
    setCustomMcpList((prev) => [...prev, newServer]);
    setNewMcpName("");
    setNewMcpUrl("");
    setNewMcpHeaderName("");
    setNewMcpHeaderValue("");
  };

  const handleExecuteTool = async () => {
    if (!selectedTool || !selectedServerId) return;
    setIsExecutingTool(true);
    setToolExecutionResult(null);

    const activeServ = [...mcpServers, ...customMcpList].find(s => s.id === selectedServerId);
    if (!activeServ) return;

    try {
      const parsedArgs = JSON.parse(toolArguments) as Record<string, unknown>;
      const token = activeServ.preset === "github" ? settings.githubPat : undefined;
      const res = await callMcpTool(activeServ.url, token, selectedTool.name, parsedArgs);
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
            {/* Built-in MCP Servers */}
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Presets
                </h3>
              </div>

              {mcpServers.map((server) => (
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

            {/* Custom MCP Server Addition */}
            <div className="space-y-2.5 pt-2">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Add Custom Remote MCP
              </h3>
              <div className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-2">
                <input
                  type="text"
                  placeholder="Server Name"
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                  className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  placeholder="URL (https://...)"
                  value={newMcpUrl}
                  onChange={(e) => setNewMcpUrl(e.target.value)}
                  className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    placeholder="Header Name"
                    value={newMcpHeaderName}
                    onChange={(e) => setNewMcpHeaderName(e.target.value)}
                    className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    type="text"
                    placeholder="Header Value"
                    value={newMcpHeaderValue}
                    onChange={(e) => setNewMcpHeaderValue(e.target.value)}
                    className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <button
                  onClick={handleAddCustomMcp}
                  className="w-full bg-primary text-primary-foreground font-semibold py-1 px-3 rounded-lg text-xs flex items-center justify-center gap-1 hover:bg-primary/90 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Remote Server
                </button>
              </div>
            </div>

            {/* User Custom MCPs */}
            {customMcpList.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                  Custom Servers
                </h3>
                {customMcpList.map((server) => (
                  <div key={server.id} className="p-3 bg-background rounded-xl border border-border shadow-sm space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">{server.name}</span>
                      <button
                        onClick={() => setCustomMcpList((prev) => prev.filter((s) => s.id !== server.id))}
                        className="text-muted-foreground hover:text-destructive transition-colors p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">{server.url}</div>
                    <button
                      onClick={() => handleConnectMcp(server)}
                      disabled={connectingServerId === server.id}
                      className="w-full border border-border hover:bg-muted text-foreground text-xs py-1 px-2 rounded-lg font-medium transition-colors"
                    >
                      {connectingServerId === server.id ? "Connecting..." : server.status === "connected" ? "Connected" : "Connect"}
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
