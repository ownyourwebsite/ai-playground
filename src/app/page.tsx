"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  Menu,
  ChevronDown,
  Settings,
  PanelRightClose,
  Bot,
  Square,
  ArrowUp,
  Wrench,
} from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/context/WorkspaceContext";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import SettingsModal from "@/components/SettingsModal";
import { getSession, saveSession } from "@/lib/db";
import { callMcpTool } from "@/lib/mcp/client";
import { resolveGithubToolArgs, validateToolArgs } from "@/lib/mcp/utils";
import { parseReasoning } from "@/lib/reasoning";
import ReasoningAccordion from "@/components/ReasoningAccordion";
import { Message, McpServer, McpTool, ToolInvocation, ChatRequestTool, AppSettings, SavedProvider, ChatRequestBody } from "@/lib/types";

function WorkspaceContent() {
  const {
    activeSessionId,
    setActiveSessionId,
    refreshSessions,
    settings,
    updateSettings,
    mcpServers,
    isLeftSidebarOpen,
    setIsLeftSidebarOpen,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    setIsSettingsOpen,
    selectedModel,
    setSelectedModel,
    rawRequestJson,
    setRawRequestJson,
    setRawResponseJson,
    messages,
    setMessages,
    input,
    setInput,
    setTokensCount,
    setLatency,
  } = useWorkspace();

  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalAction, setConfirmModalAction] = useState<"retry" | "clear" | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isMobile = window.innerWidth < 1024;
      if (isMobile) {
        setIsLeftSidebarOpen(false);
        setIsRightSidebarOpen(false);
      }
    }
  }, [setIsLeftSidebarOpen, setIsRightSidebarOpen]);

  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const stateRef = useRef({ selectedModel, settings, mcpServers, messages });
  useEffect(() => {
    stateRef.current = { selectedModel, settings, mcpServers, messages };
  }, [selectedModel, settings, mcpServers, messages]);

  // Estimate the active MCP tools and token overhead
  const activeServers = mcpServers.filter((s: McpServer) => s.status === "connected");
  let allEnabledToolsList: McpTool[] = [];
  activeServers.forEach((server: McpServer) => {
    let serverTools = server.tools || [];
    if (server.preset === "github" && settings.githubWriteMode === false) {
      const writeKeywords = ["create", "update", "delete", "modify", "set", "push", "write"];
      serverTools = serverTools.filter((t: McpTool) => !writeKeywords.some(kw => t.name.includes(kw)));
    }
    allEnabledToolsList = [...allEnabledToolsList, ...serverTools];
  });
  const estimatedToolsTokenCount = Math.round(JSON.stringify(allEnabledToolsList).length / 4);

  // Map selectedModel (UI option) to AI SDK provider & model
  const getProviderAndModel = (uiModel: string, currentSettings: AppSettings) => {
    if (uiModel.startsWith("custom-") && uiModel !== "custom") {
      const id = uiModel.slice(7);
      const found = currentSettings.savedProviders?.find((p: SavedProvider) => p.id === id);
      if (found) {
        return { provider: "custom", model: found.model || "custom" };
      }
    }
    switch (uiModel) {
      case "openai":
        return { provider: "openai", model: currentSettings.openAiModel || "gpt-5.6-luna" };
      case "anthropic":
        return { provider: "anthropic", model: currentSettings.anthropicModel || "claude-5-sonnet" };
      case "groq":
        return { provider: "groq", model: currentSettings.groqModel || "qwen/qwen3.6-27b" };
      case "ollama":
        return { provider: "ollama", model: currentSettings.ollamaModel || "llama3" };
      case "custom":
        return { provider: "custom", model: currentSettings.customModel || "custom" };
      default:
        return { provider: "openai", model: uiModel };
    }
  };

  const activeOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [];
    if (settings.customKey || settings.customBaseUrl) {
      options.push({ value: "custom", label: `Custom (${settings.customModel || "custom"})` });
    }
    if (settings.savedProviders) {
      settings.savedProviders.forEach((p: SavedProvider) => {
        options.push({ value: `custom-${p.id}`, label: `${p.name} (${p.model})` });
      });
    }
    if (settings.openAiKey) {
      options.push({ value: "openai", label: `OpenAI (${settings.openAiModel || "gpt-5.6-luna"})` });
    }
    if (settings.anthropicKey) {
      options.push({ value: "anthropic", label: `Anthropic (${settings.anthropicModel || "claude-5-sonnet"})` });
    }
    if (settings.groqKey) {
      options.push({ value: "groq", label: `Groq (${settings.groqModel || "qwen/qwen3.6-27b"})` });
    }
    if (settings.ollamaUrl) {
      options.push({ value: "ollama", label: `Ollama (${settings.ollamaModel || "llama3"})` });
    }
    return options;
  }, [
    settings.customKey,
    settings.customBaseUrl,
    settings.customModel,
    settings.savedProviders,
    settings.openAiKey,
    settings.openAiModel,
    settings.anthropicKey,
    settings.anthropicModel,
    settings.groqKey,
    settings.groqModel,
    settings.ollamaUrl,
    settings.ollamaModel,
  ]);

  useEffect(() => {
    if (activeOptions.length > 0) {
      const isValid = activeOptions.some(opt => opt.value === selectedModel);
      if (!isValid) {
        setSelectedModel(activeOptions[0].value);
        updateSettings({ defaultModel: activeOptions[0].value });
      }
    } else {
      if (selectedModel !== "") {
        setSelectedModel("");
      }
    }
  }, [activeOptions, selectedModel, setSelectedModel, updateSettings]);

  // Load session messages from DB when activeSessionId changes
  useEffect(() => {
    async function loadActiveSession() {
      if (activeSessionId) {
        const session = await getSession(activeSessionId);
        if (session) {
          // Migrate/prune old malformed or incomplete tool invocations
          const prunedMessages = session.messages.map((m: Message) => {
            if (m.role === "assistant" && m.toolInvocations) {
              return {
                ...m,
                toolInvocations: m.toolInvocations.filter((ti: ToolInvocation) =>
                  ti.state === "result" || (ti.result !== undefined && ti.result !== null)
                )
              };
            }
            return m;
          });
          setMessages(prunedMessages);
        }
      } else {
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content: "Hello! I am ready. You can select a model and configure MCP tools. How can I help you today?",
          },
        ]);
      }
    }
    loadActiveSession();
  }, [activeSessionId, setMessages]);

  // Persist session to DB when messages change
  const persistSession = async (currentMessages: Message[]) => {
    if (currentMessages.length > 1) {
      const title = currentMessages.find((m) => m.role === "user")?.content.slice(0, 30) || "Untitled Session";
      const id = activeSessionId || `session-${Date.now()}`;

      const session = {
        id,
        title,
        updatedAt: Date.now(),
        messages: currentMessages,
      };

      await saveSession(session);
      if (!activeSessionId) {
        setActiveSessionId(id);
      }
      // Refresh the sessions list in the sidebar so the current chat appears immediately
      refreshSessions();
    }
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsLoading(false);
  };

  const retryLastMessage = () => {
    if (messages.length === 0 || isLoading) return;
    setConfirmModalAction("retry");
    setShowConfirmModal(true);
  };

  const executeRetry = () => {
    if (messages.length === 0 || isLoading) return;

    // Find last user message
    const lastUserMsgIndex = [...messages].reverse().findIndex(m => m.role === "user");
    if (lastUserMsgIndex === -1) return;

    const actualIndex = messages.length - 1 - lastUserMsgIndex;
    const userContent = messages[actualIndex].content;
    const previousMessages = messages.slice(0, actualIndex);

    sendMessage(userContent, previousMessages);
  };

  const clearChat = () => {
    setConfirmModalAction("clear");
    setShowConfirmModal(true);
  };

  const executeClear = () => {
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content: "Hello! I am ready. You can select a model and configure MCP tools. How can I help you today?",
      },
    ]);
    setActiveSessionId(null);
  };

  // The custom streaming send function
  const sendMessage = async (userContent: string | null, currentMessagesList: Message[] = messages, turnCount = 0) => {
    if (isLoading) return;

    // Use latest state to avoid stale closures
    const currentSettings = stateRef.current.settings;
    let currentSelectedModel = stateRef.current.selectedModel;
    let { provider: currentProvider, model: currentModel } = getProviderAndModel(currentSelectedModel, currentSettings);

    let apiKey = null;
    let customBaseUrlVal = currentSettings.customBaseUrl || "";
    let customKeyVal = currentSettings.customKey || "";

    if (currentSelectedModel.startsWith("custom-") && currentSelectedModel !== "custom") {
      const id = currentSelectedModel.slice(7);
      const found = currentSettings.savedProviders?.find((p: SavedProvider) => p.id === id);
      if (found) {
        apiKey = found.key || "no-key-required"; // fallback if key is empty
        customBaseUrlVal = found.baseUrl || "";
        customKeyVal = found.key || "";
      }
    } else {
      apiKey = currentProvider === "openai" ? currentSettings.openAiKey :
        currentProvider === "anthropic" ? currentSettings.anthropicKey :
          currentProvider === "groq" ? currentSettings.groqKey :
            currentProvider === "custom" ? currentSettings.customKey : null;
    }

    if (currentProvider !== "ollama" && !apiKey) {
      // Check if we can auto-switch to the only available key
      const availableKeys = [
        { key: currentSettings.customKey, model: "custom" },
        { key: currentSettings.openAiKey, model: "openai" },
        { key: currentSettings.anthropicKey, model: "anthropic" },
        { key: currentSettings.groqKey, model: "groq" }
      ].filter(k => k.key && k.key.trim().length > 0);

      if (availableKeys.length === 1) {
        // Auto-switch!
        const newModel = availableKeys[0].model;
        setSelectedModel(newModel);
        updateSettings({ defaultModel: newModel });
        currentSelectedModel = newModel;
        const mapped = getProviderAndModel(newModel, currentSettings);
        currentProvider = mapped.provider;
        currentModel = mapped.model;
        apiKey = availableKeys[0].key;

        // Push a toast/banner message to the UI
        const bannerMsg: Message = { id: `sys-${Date.now()}`, role: "assistant", content: `🔄 Auto-switched to ${newModel} because it's the only configured provider.` };
        currentMessagesList = [...currentMessagesList, bannerMsg];
      } else {
        const foundStr = availableKeys.map(k => k.model).join(", ");
        const currentProviderName = currentProvider === "openai" ? "OpenAI" : currentProvider === "anthropic" ? "Anthropic" : currentProvider === "groq" ? "Groq" : "Custom";
        const errMsg = `No ${currentProviderName} key. Found: ${foundStr || "none"}. Switch the model in the header or add an ${currentProviderName} key.`;
        if (userContent) {
          const userMessage: Message = { id: `user-${Date.now()}`, role: "user", content: userContent };
          const updatedMessages = [...currentMessagesList.filter(m => m.id !== "welcome"), userMessage];
          setMessages([...updatedMessages, { id: `err-${Date.now()}`, role: "assistant", content: `⚠️ Configuration Error: ${errMsg}` }]);
        } else {
          setMessages([...currentMessagesList, { id: `err-${Date.now()}`, role: "assistant", content: `⚠️ Configuration Error: ${errMsg}` }]);
        }
        setInput("");
        return;
      }
    }

    setIsLoading(true);

    const updatedMessages = [...currentMessagesList.filter(m => m.id !== "welcome")];
    if (userContent) {
      const userMessage: Message = { id: `user-${Date.now()}`, role: "user", content: userContent };
      updatedMessages.push(userMessage);
      setInput("");
    }
    setMessages(updatedMessages);

    // Prepare headers and body
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-openai-key": currentSettings.openAiKey || "",
      "x-anthropic-key": currentSettings.anthropicKey || "",
      "x-groq-key": currentSettings.groqKey || "",
      "x-custom-key": customKeyVal || "",
      "x-custom-base-url": customBaseUrlVal || "",
    };

    // Grab tools from all connected MCP servers
    const activeServers = stateRef.current.mcpServers.filter((s: McpServer) => s.status === "connected");
    let allEnabledTools: McpTool[] = [];

    activeServers.forEach((server: McpServer) => {
      let serverTools = server.tools || [];

      // Filter out write tools if "GitHub write mode" is off
      if (server.preset === "github" && currentSettings.githubWriteMode === false) {
        const writeKeywords = ["create", "update", "delete", "modify", "set", "push", "write"];
        serverTools = serverTools.filter((t: McpTool) => !writeKeywords.some(kw => t.name.includes(kw)));
      }

      // Namespace tools if more than one server is active
      if (activeServers.length > 1) {
        serverTools = serverTools.map((t: McpTool) => ({
          ...t,
          originalName: t.name,
          name: `${server.name.replace(/\s+/g, '_').toLowerCase()}_${t.name}`,
          serverId: server.id
        }));
      } else {
        serverTools = serverTools.map((t: McpTool) => ({
          ...t,
          originalName: t.name,
          serverId: server.id
        }));
      }

      allEnabledTools = [...allEnabledTools, ...serverTools];
    });

    const reqBody: ChatRequestBody = {
      provider: currentProvider,
      model: currentModel,
      systemPrompt: currentSettings.systemPrompt,
      ollamaUrl: currentSettings.ollamaUrl,
      messages: updatedMessages.map(m => ({ role: m.role, content: m.content, toolInvocations: m.toolInvocations })),
      enabledTools: allEnabledTools,
    };

    if (process.env.NODE_ENV === 'development') {
      const estimatedTokens = Math.round(JSON.stringify(allEnabledTools).length / 4);
      console.log(`[Chat API] Estimated tools payload size: ~${estimatedTokens} tokens`);
    }

    setRawRequestJson(reqBody);

    abortControllerRef.current = new AbortController();
    const assistantMessageId = `assistant-${Date.now()}`;
    const startTime = Date.now();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(reqBody),
        signal: abortControllerRef.current.signal,
      });

      setRawResponseJson({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText) as { error?: string };
          errMsg = parsed.error || errText;
        } catch { }
        throw new Error(errMsg || `Server responded with ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No readable stream in response");

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      const toolInvocations: ToolInvocation[] = [];
      let streamError = "";

      // Create initial empty assistant message
      setMessages((prev: Message[]) => [...prev, { id: assistantMessageId, role: "assistant", content: "", toolInvocations: [] }]);

      const processLine = (line: string) => {
        if (!line.trim()) return;

        if (process.env.NODE_ENV === 'development') {
          console.debug('[stream line]', line);
        }

        // Parse Vercel AI SDK stream format
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) return;

        const type = line.slice(0, colonIndex);
        const payloadStr = line.slice(colonIndex + 1);

        try {
          if (type === "3") {
            streamError = payloadStr.replace(/^"|"$/g, '') || "Request failed";
            setMessages((prev: Message[]) =>
              prev.map((m: Message) =>
                m.id === assistantMessageId ? { ...m, error: streamError } : m
              )
            );
            return;
          }

          const payload = JSON.parse(payloadStr);

          if (type === "0") {
            assistantContent += payload;
            const parsed = parseReasoning(assistantContent);
            setMessages((prev: Message[]) =>
              prev.map((m: Message) =>
                m.id === assistantMessageId ? { ...m, content: parsed.cleanText, reasoning: parsed.reasoning, reasoningOpen: parsed.isOpen, statusLine: undefined } : m
              )
            );
          } else if (type === "9") {
            const toolCall: ToolInvocation = {
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              args: payload.args,
              state: "calling",
            };
            toolInvocations.push(toolCall);
            const statusLine = assistantContent.trim().length === 0 ? `Using tool: ${payload.toolName}...` : undefined;
            setMessages((prev: Message[]) =>
              prev.map((m: Message) =>
                m.id === assistantMessageId ? { ...m, toolInvocations: [...toolInvocations], ...(statusLine ? { statusLine } : {}) } : m
              )
            );
          } else if (type === "data") {
            if (payload.type === "text-delta") {
              assistantContent += payload.delta || "";
              const parsed = parseReasoning(assistantContent);
              setMessages((prev: Message[]) =>
                prev.map((m: Message) =>
                  m.id === assistantMessageId ? { ...m, content: parsed.cleanText, reasoning: parsed.reasoning, reasoningOpen: parsed.isOpen, statusLine: undefined } : m
                )
              );
            } else if (payload.type === "error") {
              streamError = payload.errorText || "An error occurred";
              setMessages((prev: Message[]) =>
                prev.map((m: Message) =>
                  m.id === assistantMessageId ? { ...m, error: streamError } : m
                )
              );
            } else if (payload.type === "tool-input-start" || payload.type === "tool-input-available" || payload.type === "tool-call") {
              const statusLine = assistantContent.trim().length === 0 ? `Using tool: ${payload.toolName}...` : undefined;

              if (payload.type === "tool-input-start") {
                if (statusLine) {
                  setMessages((prev: Message[]) => prev.map((m: Message) => m.id === assistantMessageId ? { ...m, statusLine } : m));
                }
              } else {
                const toolCall: ToolInvocation = {
                  toolCallId: payload.toolCallId,
                  toolName: payload.toolName,
                  args: payload.input || payload.args || {},
                  state: "calling",
                };
                if (!toolInvocations.find(t => t.toolCallId === toolCall.toolCallId)) {
                  toolInvocations.push(toolCall);
                  setMessages((prev: Message[]) =>
                    prev.map((m: Message) =>
                      m.id === assistantMessageId ? { ...m, toolInvocations: [...toolInvocations], ...(statusLine ? { statusLine } : {}) } : m
                    )
                  );
                } else if (statusLine) {
                  // If we already have it in toolInvocations, just ensure statusLine is set if needed
                  setMessages((prev: Message[]) => prev.map((m: Message) => m.id === assistantMessageId ? { ...m, statusLine } : m));
                }
              }
            }
          }
        } catch { }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      // Flush any trailing content left in buffer after the stream closes
      if (buffer.trim()) {
        processLine(buffer);
      }

      const endTime = Date.now();
      const currentLatency = endTime - startTime;
      setLatency(currentLatency);

      // Estimate tokens
      const promptText = userContent || "";
      const responseText = assistantContent || "";
      const estimatedPromptTokens = Math.round(promptText.length / 3.8);
      const estimatedResponseTokens = Math.round(responseText.length / 3.8);
      const totalTokens = estimatedPromptTokens + estimatedResponseTokens + estimatedToolsTokenCount;
      setTokensCount(totalTokens);

      setIsLoading(false);
      const parsedFinal = parseReasoning(assistantContent);
      const finalAssistant: Message = {
        id: assistantMessageId,
        role: "assistant",
        content: parsedFinal.cleanText,
        reasoning: parsedFinal.reasoning,
        reasoningOpen: parsedFinal.isOpen,
        toolInvocations,
        ...(streamError ? { error: streamError } : {}),
      };
      const finalMessages: Message[] = [...updatedMessages, finalAssistant];
      setMessages(finalMessages);
      persistSession(finalMessages);

      // Handle tool call resolution if tools are pending
      if (toolInvocations.length > 0) {
        await resolveToolCalls(assistantMessageId, toolInvocations, finalMessages, turnCount);
      }
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error.name === "AbortError") {
        console.log("Stream aborted");
      } else {
        setMessages((prev: Message[]) => {
          const hasAssistant = prev.some((m: Message) => m.id === assistantMessageId);
          if (hasAssistant) {
            return prev.map((m: Message) => m.id === assistantMessageId ? { ...m, content: "", error: error.message } : m);
          } else {
            return [...prev, { id: `err-${Date.now()}`, role: "assistant", content: "", error: error.message }];
          }
        });
      }
      setIsLoading(false);
    }
  };

  // Resolve tool calls in the browser, then continue chat
  const resolveToolCalls = async (assistantMessageId: string, toolCalls: ToolInvocation[], currentMessagesList: Message[], turnCount = 0) => {
    if (turnCount >= 10) {
      console.warn("Tool call limit reached (10 turns). Stopping agent loop.");
      return;
    }

    const resolvedInvocations = toolCalls.map(call => {
      // Find the tool definition
      const toolDef = rawRequestJson?.enabledTools?.find((t: ChatRequestTool) => t.name === call.toolName);
      const schema = toolDef?.inputSchema || { type: "object", properties: {}, required: [] };

      // 1. Resolve arguments
      const resolvedArgs = resolveGithubToolArgs(
        toolDef?.originalName || call.toolName,
        call.args || {},
        schema,
        currentMessagesList
      );

      // 2. Validate
      const validation = validateToolArgs(resolvedArgs, schema);

      return {
        ...call,
        args: resolvedArgs,
        validation,
        state: validation.valid ? 'needs-approval' as const : 'result' as const,
        result: validation.valid ? undefined : { error: `Missing required parameter(s): ${validation.missingFields.join(', ')}` },
        turnCount
      };
    });

    setMessages((prev: Message[]) =>
      prev.map((m: Message) =>
        m.id === assistantMessageId ? { ...m, toolInvocations: resolvedInvocations, statusLine: undefined } : m
      )
    );
    setIsLoading(false);
  };

  const executeToolCall = async (assistantMessageId: string, toolCallId: string, updatedArgs?: Record<string, unknown>) => {
    const currentMessages = stateRef.current.messages;
    const msg = currentMessages.find((m: Message) => m.id === assistantMessageId);
    if (!msg) return;

    const toolCall = msg.toolInvocations?.find((ti: ToolInvocation) => ti.toolCallId === toolCallId);
    if (!toolCall) return;

    const args = updatedArgs || toolCall.args;

    setMessages((prev: Message[]) =>
      prev.map((m: Message) => {
        if (m.id === assistantMessageId) {
          return {
            ...m,
            toolInvocations: m.toolInvocations?.map((ti: ToolInvocation) =>
              ti.toolCallId === toolCallId ? { ...ti, state: 'executing' as const, args } : ti
            )
          };
        }
        return m;
      })
    );

    try {
      const toolDef = rawRequestJson?.enabledTools?.find((t: ChatRequestTool) => t.name === toolCall.toolName);
      const originalName = toolDef?.originalName || toolCall.toolName;
      const serverId = toolDef?.serverId;

      const activeServ = mcpServers.find((s: McpServer) => s.id === serverId) || mcpServers.find((s: McpServer) => s.status === "connected");
      if (!activeServ) throw new Error(`No active MCP server found for tool ${toolCall.toolName}.`);

      const token = activeServ.preset === "github" ? settings.githubPat : undefined;
      const result = await callMcpTool(activeServ.url, token, originalName, args);

      setMessages((prev: Message[]) => {
        const newMessages = prev.map((m: Message) => {
          if (m.id === assistantMessageId) {
            const newInvocations = m.toolInvocations?.map((ti: ToolInvocation) => {
              if (ti.toolCallId === toolCallId) {
                return { ...ti, state: 'result' as const, result };
              }
              return ti;
            });
            return { ...m, toolInvocations: newInvocations };
          }
          return m;
        });

        // Check if all tools are resolved
        const updatedMsg = newMessages.find(m => m.id === assistantMessageId);
        const allResolved = updatedMsg?.toolInvocations?.every((ti: ToolInvocation) => ti.state === 'result') ?? false;

        if (allResolved) {
          setTimeout(() => {
            sendMessage(null, newMessages, (toolCall.turnCount || 0) + 1);
          }, 0);
        }

        return newMessages;
      });
    } catch (err: unknown) {
      const error = err as { message?: string };
      setMessages((prev: Message[]) =>
        prev.map((m: Message) => {
          if (m.id === assistantMessageId) {
            return {
              ...m,
              toolInvocations: m.toolInvocations?.map((ti: ToolInvocation) =>
                ti.toolCallId === toolCallId ? { ...ti, state: 'result' as const, result: { error: error.message } } : ti
              )
            };
          }
          return m;
        })
      );
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input);
  };

  const scrollToBottom = () => {
    const needsApprovalCard = document.querySelector('[data-state="needs-approval"]');
    if (needsApprovalCard) {
      needsApprovalCard.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground selection:bg-primary/20 font-sans">
      {/* Sidebar Panel */}
      <Sidebar />

      {/* Main Chat Interface */}
      <main className="flex-1 flex flex-col min-w-0 relative bg-background h-full">
        {/* Top Header */}
        <header className="h-14 border-b border-border flex items-center px-4 md:px-6 bg-background/80 backdrop-blur-sm z-10 justify-between shrink-0">
          <div className="flex items-center gap-2">
            {!isLeftSidebarOpen && (
              <button
                onClick={() => setIsLeftSidebarOpen(true)}
                className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors mr-2 cursor-pointer"
                title="Expand Sidebar"
              >
                <Menu className="w-4 h-4" />
              </button>
            )}
            <Image
              src="/logo.png"
              alt="Own Your Playground logo"
              width={28}
              height={28}
              className="w-6 h-6 sm:w-7 sm:h-7 rounded-md shrink-0"
            />
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                className="appearance-none bg-muted/40 border border-border/50 hover:border-border rounded-xl text-xs sm:text-sm pl-3 pr-8 py-1.5 font-semibold transition-all cursor-pointer text-foreground select-none relative max-w-[185px] sm:max-w-[260px] text-left block truncate"
              >
                <span className="block truncate">
                  {activeOptions.find(opt => opt.value === selectedModel)?.label || "Choose a Provider"}
                </span>
                <ChevronDown className={`w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-transform duration-200 pointer-events-none ${isModelDropdownOpen ? "rotate-180" : ""}`} />
              </button>

              {isModelDropdownOpen && (
                <div className="absolute left-0 mt-2 w-64 sm:w-80 bg-background border border-border rounded-2xl shadow-xl py-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100">
                  {activeOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground italic">No Providers Configured</div>
                  ) : (
                    activeOptions.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setSelectedModel(opt.value);
                          updateSettings({ defaultModel: opt.value });
                          setIsModelDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2.5 text-xs font-semibold hover:bg-muted transition-colors flex items-center justify-between gap-3 text-foreground whitespace-normal break-words ${selectedModel === opt.value ? "bg-primary/5 text-primary" : ""
                          }`}
                      >
                        <span className="flex-1 min-w-0 leading-normal">{opt.label}</span>
                        {selectedModel === opt.value && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="hidden sm:flex items-center gap-2 ml-2 px-2 py-1 rounded-md bg-muted/30 border border-border/50 text-[10px] font-medium text-muted-foreground">
              <span>MCP Tools:</span>
              {(() => {
                const activeMcp = mcpServers.filter((s: McpServer) => s.status === 'connected');
                if (activeMcp.length > 0) {
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="text-emerald-600 dark:text-emerald-500 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        connected ({allEnabledToolsList.length} tools)
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono text-[9px]" title="Estimated prompt token overhead from active tool schemas">
                        ~{estimatedToolsTokenCount} tokens
                      </span>
                    </div>
                  );
                } else {
                  return <span className="text-muted-foreground flex items-center gap-1"><span className="w-1 h-1 rounded-full bg-muted-foreground/50" /> disconnected</span>;
                }
              })()}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors md:hidden cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>
            {!isRightSidebarOpen && (
              <button
                onClick={() => setIsRightSidebarOpen(true)}
                className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title="Expand Inspector"
              >
                <PanelRightClose className="w-4 h-4 rotate-180" />
              </button>
            )}
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto w-full px-4 py-8 space-y-6">
            {messages.map((msg: Message) => (
              <div
                key={msg.id}
                className={`flex gap-4 w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role !== "user" && (
                  <div className="w-8 h-8 rounded-full bg-primary/5 border border-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-5 py-3.5 text-[15px] leading-relaxed shadow-sm overflow-hidden ${msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-tr-sm selection:bg-primary-foreground/30"
                    : "bg-muted/40 text-foreground rounded-tl-sm border border-border/50"
                    }`}
                >
                  {(() => {
                    // Prefer the stored reasoning (set during streaming); fall
                    // back to parsing raw content for older persisted messages.
                    const hasStored = msg.reasoning !== undefined || msg.reasoningOpen;
                    const parsed = hasStored
                      ? { reasoning: msg.reasoning ?? null, cleanText: msg.content, isOpen: !!msg.reasoningOpen }
                      : parseReasoning(msg.content);
                    const showAccordion = !!parsed.reasoning || parsed.isOpen;
                    return (
                      <>
                        {showAccordion && (
                          <ReasoningAccordion
                            reasoning={parsed.reasoning}
                            isStreaming={parsed.isOpen}
                          />
                        )}
                        {parsed.cleanText && (
                          <div className="whitespace-pre-wrap break-words">{parsed.cleanText}</div>
                        )}
                      </>
                    );
                  })()}
                  {msg.error && (
                    <div className="mt-2 p-3.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-[13px] font-medium leading-relaxed">
                      <div className="font-bold uppercase tracking-wider text-[10px] text-destructive mb-1.5 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                        Error Output
                      </div>
                      <div className="whitespace-pre-wrap break-words">{msg.error}</div>
                    </div>
                  )}
                  {msg.role === "assistant" && !msg.error && !msg.toolInvocations?.length && msg.id !== "welcome" && (
                    (() => {
                      const isLast = msg.id === messages[messages.length - 1]?.id;
                      if (isLoading && isLast) return null;

                      const hasActiveTools = mcpServers.some((s: McpServer) => s.status === 'connected' && (s.tools?.length ?? 0) > 0);

                      if (hasActiveTools) {
                        return (
                          <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-500 text-[10px] font-medium border border-amber-500/20 whitespace-nowrap">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            No MCP tool was called.
                          </div>
                        );
                      }
                      return null;
                    })()
                  )}
                  {msg.toolInvocations && (() => {
                    const pendingTools = msg.toolInvocations!.filter((t: ToolInvocation) => t.state === 'needs-approval');
                    const firstPendingToolId = pendingTools.length > 0 ? pendingTools[0].toolCallId : null;

                    return msg.toolInvocations!.map((toolCall: ToolInvocation) => (
                      <ToolCallCard
                        key={toolCall.toolCallId}
                        toolCall={toolCall}
                        msgId={msg.id}
                        isFirstPending={toolCall.toolCallId === firstPendingToolId}
                        executeToolCall={executeToolCall}
                        setMessages={setMessages}
                      />
                    ));
                  })()}

                  {/* Persistent Working Indicator */}
                  {(() => {
                    const isLast = msg.id === messages[messages.length - 1]?.id;
                    const activeTool = msg.toolInvocations?.find((ti: ToolInvocation) => ti.state === 'executing');
                    const isWorking = activeTool || (isLoading && isLast && msg.role === 'assistant');

                    if (isWorking) {
                      const workingText = activeTool ? `Using tool: ${activeTool.toolName}...` : msg.statusLine || 'Working...';
                      return (
                        <div className="flex items-center gap-2 text-muted-foreground text-[11px] font-medium mt-3 mb-1 animate-pulse">
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
                          {workingText}
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>
              </div>
            ))}

            {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
              <div className="flex gap-4 w-full justify-start">
                <div className="w-8 h-8 rounded-full bg-primary/5 border border-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
                <div className="bg-muted/40 text-foreground border border-border/50 rounded-2xl rounded-tl-sm px-5 py-4 flex items-center gap-1.5 shadow-sm">
                  <div className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-foreground/40 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Form */}
        <div className="p-4 bg-gradient-to-t from-background via-background to-transparent pb-4 md:pb-6">
          <form onSubmit={handleFormSubmit} className="max-w-3xl mx-auto w-full relative">
            <div className="flex items-center gap-2 mb-2 px-1">
              {messages.length > 1 && !isLoading && (
                <>
                  <button
                    type="button"
                    onClick={retryLastMessage}
                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground uppercase tracking-tight px-2 py-1 rounded bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    Retry Last
                  </button>
                  <button
                    type="button"
                    onClick={clearChat}
                    className="text-[10px] font-bold text-muted-foreground hover:text-destructive uppercase tracking-tight px-2 py-1 rounded bg-muted/30 hover:bg-destructive/10 transition-colors cursor-pointer"
                  >
                    Clear Chat
                  </button>
                </>
              )}
            </div>
            {(() => {
              const latestMessage = messages[messages.length - 1];
              const hasPendingToolApproval = latestMessage?.role === 'assistant' &&
                latestMessage.toolInvocations?.some((ti: ToolInvocation) => ti.state === 'needs-approval');

              return (
                <div className="relative flex flex-col w-full bg-muted/30 border border-input focus-within:ring-1 focus-within:ring-primary/50 focus-within:border-primary/50 focus-within:bg-background shadow-sm rounded-2xl transition-all duration-200">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={hasPendingToolApproval}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleFormSubmit(e);
                      }
                    }}
                    placeholder={hasPendingToolApproval ? "Waiting for tool approval..." : "Ask anything..."}
                    className={`w-full bg-transparent px-4 pt-4 pb-12 min-h-[120px] max-h-[400px] resize-none focus:outline-none text-[15px] leading-relaxed placeholder:text-muted-foreground ${hasPendingToolApproval ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />

                  <div className="absolute right-3 bottom-3 flex items-center gap-2">
                    {isLoading ? (
                      <button
                        type="button"
                        onClick={stopGeneration}
                        className="flex items-center justify-center p-2 bg-foreground text-background rounded-full hover:bg-foreground/90 transition-all shadow-sm cursor-pointer"
                        title="Stop generating"
                      >
                        <Square className="w-4 h-4 fill-current" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!input.trim() || hasPendingToolApproval}
                        className={`p-2 rounded-full flex items-center justify-center transition-all cursor-pointer ${input.trim() && !hasPendingToolApproval
                          ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                          : "bg-muted-foreground/20 text-muted-foreground cursor-not-allowed"
                          }`}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
            <div className="text-center mt-2 text-xs text-muted-foreground font-medium hidden sm:block leading-tight">
              AI models can make mistakes. Verify important information.
              <br />
              <span className="font-semibold text-foreground/60">Built by Own Your Website</span>
            </div>
          </form>
        </div>
      </main>

      {/* Right Panels (Inspector / MCP) */}
      <RightPanel />

      {/* Settings Modal Dialog */}
      <SettingsModal />

      {/* Left Sidebar Overlay */}
      {isLeftSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-30 md:hidden animate-in fade-in duration-150"
          onClick={() => setIsLeftSidebarOpen(false)}
        />
      )}

      {/* Right Sidebar Overlay */}
      {isRightSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-30 md:hidden animate-in fade-in duration-150"
          onClick={() => setIsRightSidebarOpen(false)}
        />
      )}

      {/* Custom Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-background border border-border rounded-2xl w-full max-w-sm shadow-lg p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-sm font-semibold text-foreground">
              {confirmModalAction === "clear" ? "Clear Chat History?" : "Retry Last Message?"}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {confirmModalAction === "clear"
                ? "Are you sure you want to clear all messages in this session? This action cannot be undone."
                : "Are you sure you want to re-send your last message? This will delete the last assistant response and generate a new one."}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmModalAction(null);
                }}
                className="px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted rounded-xl transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmModalAction === "clear") {
                    executeClear();
                  } else if (confirmModalAction === "retry") {
                    executeRetry();
                  }
                  setShowConfirmModal(false);
                  setConfirmModalAction(null);
                }}
                className={`px-4 py-2 rounded-xl text-xs font-semibold shadow-sm transition-all cursor-pointer ${confirmModalAction === "clear"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type ToolCallCardProps = {
  toolCall: ToolInvocation;
  msgId: string;
  isFirstPending: boolean;
  executeToolCall: (assistantMessageId: string, toolCallId: string, updatedArgs?: Record<string, unknown>) => void;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
};

function ToolCallCard({ toolCall, msgId, isFirstPending, executeToolCall, setMessages }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isResult = toolCall.state === 'result';
  const isExecuting = toolCall.state === 'executing';
  const needsApproval = toolCall.state === 'needs-approval';
  const isQueued = needsApproval && !isFirstPending;
  const isActiveApproval = needsApproval && isFirstPending;

  const result = toolCall.result as { error?: string } | undefined;
  const hasError = isResult && !!result?.error;

  let statusText = 'Unknown';
  let statusColor = 'text-muted-foreground';
  if (isQueued) { statusText = 'Queued'; statusColor = 'text-muted-foreground'; }
  else if (isActiveApproval) { statusText = 'Waiting'; statusColor = 'text-primary animate-pulse'; }
  else if (isExecuting) { statusText = 'Executing...'; statusColor = 'text-primary animate-pulse'; }
  else if (isResult && hasError) { statusText = 'Error'; statusColor = 'text-destructive'; }
  else if (isResult && result?.error === 'User declined tool execution.') { statusText = 'Declined'; statusColor = 'text-muted-foreground'; }
  else if (isResult) { statusText = 'Success'; statusColor = 'text-emerald-500'; }

  return (
    <div
      data-state={toolCall.state}
      className={`w-full mt-2 text-xs border rounded-xl transition-all ${isActiveApproval ? 'border-primary ring-1 ring-primary/20 bg-primary/5 animate-pulse' : 'border-border/60 bg-muted/30'}`}
    >
      {/* Collapsed Header */}
      <div
        className="flex items-center justify-between p-2.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-xl"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-background border border-border/50 shrink-0">
            <Wrench className="w-3 h-3 text-muted-foreground" />
          </div>
          <span className="font-semibold text-foreground truncate text-[11px]">{toolCall.toolName}</span>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-2">
          <span className={`text-[10px] font-medium ${statusColor}`}>
            {statusText}
          </span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-border/40">
          <div className="space-y-1 mt-2">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Arguments</div>
            <pre className="font-mono text-[10px] text-foreground/80 bg-background/50 p-2 rounded-lg border border-border/40 max-h-[120px] overflow-auto">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>

          {isResult && toolCall.result !== undefined && toolCall.result !== null && (
            <div className="space-y-1 pt-2 border-t border-border/40">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Result</div>
              <pre className="font-mono text-[10px] text-muted-foreground max-h-[120px] overflow-auto bg-black/5 dark:bg-white/5 p-2 rounded-lg border border-border/20">
                {JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons for Active Approval */}
      {isActiveApproval && (
        <div className="flex gap-2 p-2 pt-0 border-t border-border/20 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); executeToolCall(msgId, toolCall.toolCallId); }}
            className="flex-1 bg-primary text-primary-foreground font-bold py-1.5 rounded-lg hover:bg-primary/90 transition-colors cursor-pointer text-[10px]"
          >
            Confirm & Run
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMessages((prev: Message[]) => prev.map((m: Message) => m.id === msgId ? {
                ...m,
                toolInvocations: m.toolInvocations?.map((ti: ToolInvocation) => ti.toolCallId === toolCall.toolCallId ? {
                  ...ti, state: 'result' as const, result: { error: 'User declined tool execution.' }
                } : ti)
              } : m));
            }}
            className="px-3 border border-border bg-background hover:bg-muted text-foreground font-bold py-1.5 rounded-lg transition-colors cursor-pointer text-[10px]"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

export default function WorkspacePage() {
  return (
    <WorkspaceProvider>
      <WorkspaceContent />
    </WorkspaceProvider>
  );
}
