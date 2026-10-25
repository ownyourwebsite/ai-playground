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
  Info,
  X,
} from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/context/WorkspaceContext";
import Sidebar from "@/components/Sidebar";
import RightPanel from "@/components/RightPanel";
import SettingsModal from "@/components/SettingsModal";
import RestoreBackupDialog from "@/components/RestoreBackupDialog";
import { getSession } from "@/lib/db";
import AttachmentCard from "@/components/AttachmentCard";
import AttachmentControls from "@/components/AttachmentControls";
import { ATTACHMENT_ACCEPT, attachmentRef, readAttachment, validateAttachmentSelection } from "@/lib/attachments/client";
import { getImageSupport, MAX_ATTACHMENTS, MAX_REQUEST_BYTES } from "@/lib/attachments/policy";
import { forgetSessionAttachments, loadAttachment, persistSessionWithAttachments, stageAttachments } from "@/lib/attachments/store";
import { createRecoveryExport, MAX_RECOVERY_BYTES, RecoveryStorageError, RecoveryValidationError } from "@/lib/attachments/recovery";
import { storageErrorCode } from "@/lib/storageErrors";
import { callMcpTool } from "@/lib/mcp/client";
import { resolveGithubToolArgs, validateToolArgs } from "@/lib/mcp/utils";
import { assignToolNames } from "@/lib/mcp/toolNames";
import { filterGithubTools } from "@/lib/mcp/githubTools";
import { parseReasoning } from "@/lib/reasoning";
import ReasoningAccordion from "@/components/ReasoningAccordion";
import Markdown from "@/components/Markdown";
import ExecutionStatus from "@/components/ExecutionStatus";
import { ChatExecution, canContinueModel, type ModelRequest } from "@/lib/chat/execution";
import { chatError } from "@/lib/chat/errors";
import { useChatScroll } from "@/lib/chat/useChatScroll";
import { contextTokens, formatTokens } from "@/lib/chat/contextUsage";
import { DEFAULT_MODELS } from "@/lib/providers";
import { contextWindowFor, fetchModelList, type ModelProvider } from "@/lib/models/client";
import { canRetryTool } from "@/lib/chat/toolSafety";
import { AttachmentRecord, Message, McpServer, McpTool, ToolInvocation, AppSettings, SavedProvider, ChatRequestBody, ChatError } from "@/lib/types";

const MODEL_ACTION_CLASS = "text-[10px] font-bold text-muted-foreground hover:text-foreground uppercase tracking-tight px-2 py-1 rounded bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

function WorkspaceContent() {
  const {
    activeSessionId,
    setActiveSessionId,
    rememberSession,
    registerSessionLifecycle,
    settings,
    updateSettings,
    settingsReady,
    settingsLoadFailed,
    settingsError,
    sessionError,
    retryWorkspaceStorage,
    hasUnsavedSettings,
    mcpServers,
    isLeftSidebarOpen,
    setIsLeftSidebarOpen,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    setIsSettingsOpen,
    selectedModel,
    setSelectedModel,
    setRawRequestJson,
    setRawResponseJson,
    messages,
    setMessages,
    input,
    setInput,
  } = useWorkspace();

  const [isLoading, setIsLoading] = useState(false);
  const { viewport: scrollViewport, content: scrollContent, away: scrollAway, atBottom: scrollAtBottom, latest: scrollLatest } = useChatScroll();
  const [sessionReady, setSessionReady] = useState(false);
  const [storageError, setStorageError] = useState<ChatError>();
  const [unsavedCount, setUnsavedCount] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportingRef = useRef(false);
  const [exportError, setExportError] = useState('');
  const [isRestoreOpen, setIsRestoreOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [showProviderHint, setShowProviderHint] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<AttachmentRecord[]>([]);
  const draftAttachmentsRef = useRef(draftAttachments);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingAttachments, setReadingAttachments] = useState(false);
  const readingAttachmentsRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const updateDraftAttachments = (records: AttachmentRecord[]) => {
    draftAttachmentsRef.current = records;
    setDraftAttachments(records);
  };

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalAction, setConfirmModalAction] = useState<"restart" | "clear" | null>(null);

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

  const allEnabledToolsList = mcpServers.filter(s => s.status === 'connected').flatMap(s =>
    s.preset === 'github' ? filterGithubTools(s.tools || [], settings.githubWriteMode === true) : s.tools || []);
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
        return { provider: "openai", model: currentSettings.openAiModel || DEFAULT_MODELS.openai };
      case "anthropic":
        return { provider: "anthropic", model: currentSettings.anthropicModel || DEFAULT_MODELS.anthropic };
      case "groq":
        return { provider: "groq", model: currentSettings.groqModel || DEFAULT_MODELS.groq };
      case "ollama":
        return { provider: "ollama", model: currentSettings.ollamaModel || DEFAULT_MODELS.ollama };
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
      options.push({ value: "openai", label: `OpenAI (${settings.openAiModel || DEFAULT_MODELS.openai})` });
    }
    if (settings.anthropicKey) {
      options.push({ value: "anthropic", label: `Anthropic (${settings.anthropicModel || DEFAULT_MODELS.anthropic})` });
    }
    if (settings.groqKey) {
      options.push({ value: "groq", label: `Groq (${settings.groqModel || DEFAULT_MODELS.groq})` });
    }
    if (settings.ollamaUrl) {
      options.push({ value: "ollama", label: `Ollama (${settings.ollamaModel || DEFAULT_MODELS.ollama})` });
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
  const providerUnavailable = !activeOptions.some(option => option.value === selectedModel);
  const selectedProvider = getProviderAndModel(selectedModel, settings);
  const imageSupport = getImageSupport(selectedProvider.provider, selectedProvider.model);
  const hasImages = draftAttachments.some(file => file.kind === 'image') || messages.some(message => message.attachments?.some(file => file.kind === 'image'));
  const savedSelection = selectedModel.startsWith('custom-') ? settings.savedProviders?.find(provider => provider.id === selectedModel.slice(7)) : undefined;
  const selectedEndpoint = selectedProvider.provider === 'custom'
    ? (selectedModel.startsWith('custom-') ? savedSelection?.baseUrl : settings.customBaseUrl)
    : selectedProvider.provider === 'ollama' ? settings.ollamaUrl : undefined;
  const selectedKey = selectedProvider.provider === 'custom'
    ? (selectedModel.startsWith('custom-') ? savedSelection?.key : settings.customKey)
    : ({ openai: settings.openAiKey, anthropic: settings.anthropicKey, groq: settings.groqKey } as Record<string, string | undefined>)[selectedProvider.provider];
  const imageHintSelection = imageHintIdentity(selectedProvider.provider, selectedProvider.model, selectedEndpoint);
  const contextUsed = contextTokens(messages);
  const hasContextUsage = contextUsed !== undefined;
  const contextWindowKey = `${selectedProvider.provider}|${selectedProvider.model}|${selectedEndpoint ?? ''}`;
  const [contextWindow, setContextWindow] = useState<{ key: string; tokens?: number }>();
  const contextLimit = contextWindow?.key === contextWindowKey ? contextWindow.tokens : undefined;

  // The window size comes from the provider's live model list (cached for 10 min);
  // providers that do not report it simply show the used count alone.
  useEffect(() => {
    if (!hasContextUsage) return;
    const [provider, model] = [selectedProvider.provider as ModelProvider, selectedProvider.model];
    const controller = new AbortController();
    // fetchModelList reads only the credential fields of `provider`.
    const creds = { openAiKey: selectedKey, anthropicKey: selectedKey, groqKey: selectedKey, customKey: selectedKey, ollamaUrl: selectedEndpoint, customBaseUrl: selectedEndpoint };
    void fetchModelList(provider, creds, controller.signal).then(result => {
      if ('models' in result) setContextWindow({ key: contextWindowKey, tokens: contextWindowFor(result.models, model) });
    });
    return () => controller.abort();
  }, [hasContextUsage, contextWindowKey, selectedProvider.provider, selectedProvider.model, selectedKey, selectedEndpoint]);

  useEffect(() => {
    if (!settingsReady || settingsLoadFailed) return;
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
  }, [activeOptions, selectedModel, setSelectedModel, updateSettings, settingsReady, settingsLoadFailed]);

  const [engine] = useState(() => new ChatExecution({
    publish(next, busy) { setMessages(next); setIsLoading(busy); },
    storage(error, count) { setStorageError(error); setUnsavedCount(count); },
    async persist(next, sessionId) {
      if (!sessionId || !next.some(m => m.role === 'user')) return;
      const firstUser = next.find(m => m.role === 'user');
      const session = rememberSession({ id: sessionId, title: firstUser?.content.trim().slice(0, 30) || firstUser?.attachments?.[0]?.name.slice(0, 30) || 'Untitled Session', updatedAt: Date.now(), messages: next });
      await persistSessionWithAttachments(session);
    },
    visible: () => document.visibilityState === 'visible',
  }));
  useEffect(() => registerSessionLifecycle({
    async switch(id) {
      if ((id || '') === engine.sessionId) return true;
      setSessionReady(false);
      try { await engine.prepareSwitch(); return true; }
      catch { setSessionReady(true); return false; }
    },
    beforeDelete: id => engine.detach(id),
    deleteFailed: id => engine.reattach(id),
    deleted(id) {
      forgetSessionAttachments(id);
      engine.forget(id);
      if (id === engine.sessionId) engine.reset('', [{ id: 'welcome', role: 'assistant', content: 'Hello! I am ready. You can select a model and configure MCP tools. How can I help you today?' }]);
    },
  }), [engine, registerSessionLifecycle]);
  useEffect(() => {
    let stale = false;
    if ((activeSessionId || '') === engine.sessionId && engine.messages.length > 0) {
      void Promise.resolve().then(() => { if (!stale) setSessionReady(true); });
      return () => { stale = true; };
    }
    void (async () => {
      await Promise.resolve();
      if (stale) return;
      setSessionReady(false);
      try {
        await engine.prepareSwitch();
        if (stale) return;
        const cached = activeSessionId ? engine.snapshot(activeSessionId) : undefined;
        const session = activeSessionId && !cached ? await getSession(activeSessionId) : undefined;
        if (stale || (activeSessionId && engine.isDetached(activeSessionId))) return;
        // Do not destroy the old RAM snapshot until its saves have succeeded.
        engine.reset(activeSessionId || '', cached || session?.messages || [{ id: 'welcome', role: 'assistant', content: 'Hello! I am ready. You can select a model and configure MCP tools. How can I help you today?' }]);
        setLoadError(false);
        setSessionReady(true);
      } catch { if (!stale) setLoadError(true); }
    })();
    return () => { stale = true; };
  }, [activeSessionId, engine, loadVersion]);
  useEffect(() => {
    const unload = () => engine.stop('interrupted', 'page-exit');
    const warn = (event: BeforeUnloadEvent) => {
      if (engine.hasUnsavedChanges || hasUnsavedSettings() || draftAttachmentsRef.current.length || readingAttachmentsRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('pagehide', unload);
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('pagehide', unload); window.removeEventListener('beforeunload', warn); engine.stop('interrupted', 'page-exit'); };
  }, [engine, hasUnsavedSettings]);
  const requestModel: ModelRequest = async (signal, history, attemptId) => {
    const current = stateRef.current;
    const { provider, model } = getProviderAndModel(current.selectedModel, current.settings);
    const saved = current.selectedModel.startsWith('custom-') ? current.settings.savedProviders?.find(p => p.id === current.selectedModel.slice(7)) : undefined;
    const serverTools = current.mcpServers.filter(s => s.status === 'connected').map(server => ({ server,
      tools: server.preset === 'github' ? filterGithubTools(server.tools || [], current.settings.githubWriteMode === true) : server.tools || [] }));
    const providerName = assignToolNames(serverTools.map(({ server, tools }) => ({ id: server.id, name: server.name, tools })));
    const enabledTools = serverTools.flatMap(({ server, tools }) =>
      tools.map(t => ({ ...t, originalName: t.name, serverId: server.id, name: providerName(server.id, t.name) })));
    engine.setToolResolver((call, messages) => {
      const def = enabledTools.find(t => t.name === call.toolName);
      const schema = def?.inputSchema || { type: 'object' as const };
      const args = resolveGithubToolArgs(def?.originalName || call.toolName, call.args, schema, messages);
      const validation = validateToolArgs(args, schema);
      return { ...call, args, validation, serverId: def?.serverId, originalName: def?.originalName,
        state: validation.valid && def ? 'needs-approval' : 'result',
        ...(!validation.valid || !def ? { outcome: 'error' as const, result: { error: 'Invalid tool arguments or definition. Nothing was executed.' } } : {}),
      };
    });
    const rejectAttachment = (message: string) => {
      if (!signal.aborted) setAttachmentError(message);
      return Response.json({ error: chatError('attachment') }, { status: 400 });
    };
    let requestMessages: ChatRequestBody['messages'];
    try {
      const records = new Map<string, Promise<AttachmentRecord>>();
      requestMessages = await Promise.all(history.map(async m => ({ role: m.role, content: m.content, toolInvocations: m.toolInvocations,
        ...(m.attachments?.length ? { attachments: await Promise.all(m.attachments.map(ref => {
          if (!records.has(ref.id)) records.set(ref.id, loadAttachment(ref));
          return records.get(ref.id)!;
        })) } : {}),
      })));
    } catch { return rejectAttachment('An attachment is unavailable in local storage. Use Settings → Restore backup, or reattach the original file in a new chat. Nothing was sent to the provider; files were not omitted.'); }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const body: ChatRequestBody = { provider, model, systemPrompt: current.settings.systemPrompt, ollamaUrl: current.settings.ollamaUrl,
      messages: requestMessages, enabledTools };
    const json = JSON.stringify(body);
    if (new TextEncoder().encode(json).byteLength > MAX_REQUEST_BYTES) return rejectAttachment('This conversation exceeds the 4 MB request limit, including file data and history. Start a new chat or use smaller files. Nothing was truncated or sent to the provider.');
    // Keep the inspector useful without retaining/rendering a second base64 copy.
    setRawRequestJson({ ...body, messages: body.messages.map(m => ({ ...m,
      ...(m.attachments ? { attachments: m.attachments.map(a => ({ ...a, data: `[Content redacted from inspector; ${a.size} bytes included in request]` })) } : {}) })) });
    const response = await fetch('/api/chat', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-chat-attempt-id': attemptId,
        'x-openai-key': current.settings.openAiKey || '', 'x-anthropic-key': current.settings.anthropicKey || '',
        'x-groq-key': current.settings.groqKey || '', 'x-custom-key': saved?.key || current.settings.customKey || '',
        'x-custom-base-url': saved?.baseUrl || current.settings.customBaseUrl || '' }, body: json });
    if (!signal.aborted) setRawResponseJson({ status: response.status });
    return response;
  };
  const stopGeneration = () => engine.stop();
  const retryLastMessage = () => { setAttachmentError(''); void engine.retry(requestModel); };
  const executeRestart = () => { setAttachmentError(''); void engine.restart(requestModel); };
  const clearChat = () => { setConfirmModalAction('clear'); setShowConfirmModal(true); };
  const executeClear = () => { setActiveSessionId(null); };
  const retrySaving = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setIsSaving(true); setSaveFeedback(false);
    try {
      // Both APIs may retain a safe error instead of rejecting. Success feedback
      // below also checks their current dirty/error state, not just this await.
      await engine.save(); await retryWorkspaceStorage();
    } catch (error) { setStorageError({ ...chatError('storage'), code: storageErrorCode(error) }); }
    finally { savingRef.current = false; setIsSaving(false); setSaveFeedback(true); }
  };
  const exportRecovery = async () => {
    if (exportingRef.current) return;
    exportingRef.current = true; setIsExporting(true); setExportError('');
    let url: string | undefined;
    try {
      const sessions = engine.exportUnsaved();
      if (!sessions.length) { setExportError('There are no unsaved chats to download. Local saving may already have completed.'); return; }
      const data = await createRecoveryExport(sessions);
      // Compact JSON stays within the same UTF-8 limit checked by recovery.
      const file = new Blob([JSON.stringify(data)], { type: 'application/json' });
      if (file.size > MAX_RECOVERY_BYTES) throw new RecoveryValidationError('RecoveryTooLarge');
      url = URL.createObjectURL(file);
      const link = document.createElement('a'); link.href = url; link.download = 'playground-chat-recovery.json';
      link.click();
    } catch (error) {
      const detail = error instanceof RecoveryValidationError || error instanceof RecoveryStorageError
        ? `${error.message} (${error.code})` : `Local data could not be read completely (${storageErrorCode(error)}).`;
      setExportError(`${detail} No incomplete download was created. Keep this tab open and retry local saving. Recovery backups support up to 32 MiB.`);
    } finally {
      if (url) { const downloadUrl = url; setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000); }
      exportingRef.current = false; setIsExporting(false);
    }
  };
  const executeToolCall = (messageId: string, toolId: string) => engine.approve(messageId, toolId, async (call, signal) => {
    const current = stateRef.current;
    const server = current.mcpServers.find(s => s.id === call.serverId && s.status === 'connected');
    if (!server) throw new Error('MCP server unavailable');
    const headers = server.preset === 'github' && current.settings.githubPat ? { Authorization: `Bearer ${current.settings.githubPat}` } : server.headers || {};
    return callMcpTool(server.url, headers, call.originalName || call.toolName, call.args, signal);
  }, requestModel);
  const declineToolCall = (messageId: string, toolId: string) => { void engine.decline(messageId, toolId, requestModel); };
  const retryToolCall = (messageId: string, toolId: string) => engine.requestToolRetry(messageId, toolId,
    call => canRetryTool(call, stateRef.current.mcpServers.find(s => s.id === call.serverId)));
  const selectAttachments = async (files: File[]) => {
    if (!files.length || readingAttachmentsRef.current) return;
    if (draftAttachmentsRef.current.length + files.length > MAX_ATTACHMENTS) { setAttachmentError('Attach at most 4 files per message.'); return; }
    readingAttachmentsRef.current = true; setReadingAttachments(true); setAttachmentError('');
    try {
      const records: AttachmentRecord[] = [];
      for (const file of files) records.push(await readAttachment(file));
      const next = [...draftAttachmentsRef.current, ...records];
      validateAttachmentSelection(next, input);
      updateDraftAttachments(next);
    } catch (error) { setAttachmentError(error instanceof Error ? error.message : 'Files could not be read locally. Select them again.'); }
    finally { readingAttachmentsRef.current = false; setReadingAttachments(false); }
  };
  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !draftAttachments.length) || readingAttachmentsRef.current || !sessionReady || !settingsReady || engine.busy) return;
    if (!selectedModel || !activeOptions.some(option => option.value === selectedModel)) { setShowProviderHint(true); return; }
    try { validateAttachmentSelection(draftAttachments, input); }
    catch (error) { setAttachmentError((error as Error).message); return; }
    setShowProviderHint(false);
    const sessionId = engine.ensureSession();
    try { stageAttachments(sessionId, draftAttachments); }
    catch { setAttachmentError('Files could not be prepared. Your draft is retained; select the files again.'); return; }
    if (!engine.submit(input, requestModel, draftAttachments.map(attachmentRef))) return;
    if (!activeSessionId) setActiveSessionId(sessionId);
    setInput('');
    updateDraftAttachments([]);
    setAttachmentError('');
  };
  const storageStillPending = !!(storageError || settingsError || sessionError || settingsLoadFailed || unsavedCount || engine.hasUnsavedChanges || hasUnsavedSettings());
  const storageBlocked = storageError?.code === 'StorageBlockedError' || settingsError?.includes('(StorageBlockedError)') || sessionError?.includes('(StorageBlockedError)');

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
              aria-label="Settings"
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
        <div className="relative flex-1 min-h-0">
        <div ref={scrollViewport} tabIndex={0} aria-label="Chat history" className="h-full overflow-y-auto [overflow-anchor:none]">
          <div ref={scrollContent} className="max-w-3xl mx-auto w-full px-4 py-8 space-y-6">
            {messages.filter(m => !(m.execution?.status === 'complete' && !m.content && !m.reasoning && !m.toolInvocations?.length && !m.attachments?.length)).map((msg: Message) => (
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
                    }${(msg.toolInvocations?.length ?? 0) > 0 ? " w-full" : ""}`}
                >
                  {!!msg.attachments?.length && <div aria-label="Message attachments" className="grid gap-2 mb-3">
                    {msg.attachments.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment} />)}
                  </div>}
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
                          <div className={msg.role === 'assistant' ? 'min-w-0 break-words' : 'whitespace-pre-wrap break-words'}>
                            {msg.role === "assistant" ? (
                              <Markdown text={parsed.cleanText} />
                            ) : (
                              parsed.cleanText
                            )}
                          </div>
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
                  <ExecutionStatus message={msg} busy={isLoading || msg.id !== messages.at(-1)?.id} onRetry={retryLastMessage} />
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
                        declineToolCall={declineToolCall}
                        retryToolCall={retryToolCall}
                        isLatest={msg.id === messages.at(-1)?.id}
                        setMessages={setMessages}
                      />
                    ));
                  })()}


                </div>
              </div>
            ))}

            {messages.length > 1 && !isLoading && (
              <div role="toolbar" aria-label="Chat actions" aria-hidden={!scrollAtBottom} inert={!scrollAtBottom}
                className={`flex flex-wrap items-center gap-2 pl-12 ${scrollAtBottom ? '' : 'invisible pointer-events-none'}`}>
                <button type="button" onClick={retryLastMessage} disabled={!canContinueModel(messages.at(-1))} className={MODEL_ACTION_CLASS}>
                  Retry model step
                </button>
                <button type="button" onClick={() => { setConfirmModalAction('restart'); setShowConfirmModal(true); }} className={MODEL_ACTION_CLASS}>
                  Start turn again
                </button>
                <button type="button" onClick={clearChat}
                  className="text-[10px] font-bold text-muted-foreground hover:text-destructive uppercase tracking-tight px-2 py-1 rounded bg-muted/30 hover:bg-destructive/10 transition-colors cursor-pointer">
                  Clear Chat
                </button>
              </div>
            )}
          </div>
        </div>
        {scrollAway && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
          <button type="button" onClick={scrollLatest} className="pointer-events-auto px-4 py-2 rounded-full border border-border/70 bg-background/85 backdrop-blur-md shadow-sm text-xs cursor-pointer">Latest messages ↓{messages.some(m => m.toolInvocations?.some(t => t.state === 'needs-approval')) ? ' · Tool approval waiting' : ''}</button>
        </div>}
        </div>
        {(storageError || settingsError || sessionError) && <div role="alert" aria-label="Local storage" className="mx-4 mt-2 p-3 border border-amber-500/30 bg-amber-500/5 rounded-xl text-xs text-foreground shrink-0">
          {storageError && <p>Local saving is unavailable{storageError.code ? ` (${storageError.code})` : ''}. {unsavedCount} chat(s) are kept in this tab only. You can continue and switch chats. Save or download them before closing this tab.</p>}
          {settingsError && <p className={storageError ? 'mt-1.5' : ''}>{settingsError}</p>}
          {sessionError && <p className="mt-1.5">{sessionError}</p>}
          <p className="mt-1.5 text-muted-foreground">Use the same address, port and browser profile. A read failure does not mean your data was deleted.</p>
          {storageBlocked && <p className="mt-1.5">Close other tabs or windows using this address, then retry. Do not clear site data.</p>}
          <div className="flex flex-wrap gap-2 mt-2">
          <button type="button" disabled={isSaving} onClick={() => { void retrySaving(); }} className="border rounded-md px-3 py-1 disabled:opacity-50 cursor-pointer">{isSaving ? 'Saving…' : 'Retry saving'}</button>
          {storageError && <button type="button" disabled={isExporting} onClick={() => { void exportRecovery(); }} className="border rounded-md px-3 py-1 cursor-pointer disabled:opacity-50">{isExporting ? 'Preparing backup…' : 'Download unsaved chats'}</button>}
          <button type="button" onClick={() => setIsRestoreOpen(true)} className="border rounded-md px-3 py-1 cursor-pointer">Restore backup</button>
          </div>
        </div>}
        {saveFeedback && <div role="status" className="mx-4 mt-2 flex items-start gap-2 text-xs text-muted-foreground shrink-0">
          <p className="flex-1">{storageStillPending ? 'Retry finished. Some local data is still unsaved or could not be read. Keep this tab open; see the storage warning.' : isLoading ? 'Local saving recovered. The current response is still in progress.' : 'Pending chats and settings saved locally.'}</p>
          <button type="button" aria-label="Dismiss saving feedback" onClick={() => setSaveFeedback(false)} className="p-0.5 rounded hover:bg-muted cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>}
        {exportError && <div role="alert" className="mx-4 mt-2 text-xs text-amber-700 dark:text-amber-400 shrink-0">{exportError}</div>}
        {loadError && <div role="alert" className="mx-4 p-3 text-xs text-destructive">Session could not be loaded. Current data is retained.
          <button type="button" onClick={() => setLoadVersion(v => v + 1)} className="block mt-2 border rounded-md px-3 py-1 cursor-pointer">Retry loading</button>
        </div>}
        {/* Input Form */}
        <div className="p-4 shrink-0 pb-1.5 md:pb-2">
          <form onSubmit={handleFormSubmit} className="max-w-3xl mx-auto w-full relative">
            <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="Attach files" className="hidden"
              onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void selectAttachments(files); }} />
            {attachmentError && <div role="alert" className="text-xs border border-amber-500/30 bg-amber-500/5 rounded-xl px-3 py-2 mb-2">{attachmentError}</div>}
            {hasImages && imageSupport !== 'supported' && <ImageSupportHint key={imageHintSelection} selection={imageHintSelection} support={imageSupport} />}
            {(() => {
              const latestMessage = messages[messages.length - 1];
              const hasPendingToolApproval = latestMessage?.role === 'assistant' &&
                latestMessage.toolInvocations?.some((ti: ToolInvocation) => ti.state === 'needs-approval');

              return (
                <div role="group" aria-label="Message composer" className="relative flex flex-col w-full bg-muted/30 border border-input focus-within:ring-1 focus-within:ring-primary/50 focus-within:border-primary/50 focus-within:bg-background shadow-sm rounded-2xl transition-all duration-200">
                  {!!draftAttachments.length && <div className="px-3 pt-3">
                    <ul aria-label="Draft attachments" className="grid w-full max-w-[26rem] gap-2" style={{ gridTemplateColumns: `repeat(${MAX_ATTACHMENTS}, minmax(0, 1fr))` }}>
                      {draftAttachments.map(record => <li key={record.id} className="min-w-0">
                        <AttachmentCard attachment={record} record={record} variant="draft"
                          onRemove={readingAttachments ? undefined : () => { updateDraftAttachments(draftAttachments.filter(file => file.id !== record.id)); setAttachmentError(''); }} />
                      </li>)}
                    </ul>
                  </div>}
                  <textarea
                    aria-label="Message"
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
                    className={`w-full bg-transparent px-4 pb-12 max-h-[400px] resize-none focus:outline-none text-[15px] leading-relaxed placeholder:text-muted-foreground ${draftAttachments.length ? 'min-h-[96px] pt-3' : 'min-h-[120px] pt-4'} ${hasPendingToolApproval ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />

                  <div className="absolute left-3 bottom-3 flex items-center gap-2">
                    <AttachmentControls onChoose={() => fileInput.current?.click()}
                      disabled={readingAttachments || isLoading || !!hasPendingToolApproval || draftAttachments.length >= MAX_ATTACHMENTS} />
                    {contextUsed !== undefined && <span title={`Context used by the last request: ${contextUsed.toLocaleString('en-US')} tokens (input + output, provider-reported)${contextLimit ? ` of ${contextLimit.toLocaleString('en-US')}` : ''}`}
                      className="text-[10px] tabular-nums text-muted-foreground">{formatTokens(contextUsed)}{contextLimit ? ` / ${formatTokens(contextLimit)}` : ''} tokens</span>}
                    {readingAttachments && <span role="status" className="text-[10px] text-muted-foreground">Reading locally…</span>}
                    {!!draftAttachments.length && !readingAttachments && <span aria-label="Attachment count" aria-live="polite" aria-atomic="true" className="text-[10px] tabular-nums text-muted-foreground">{draftAttachments.length}/{MAX_ATTACHMENTS}<span className="sr-only"> files attached</span></span>}
                  </div>
                  <div className="absolute right-3 bottom-3 flex items-center gap-2">
                    {!isLoading && providerUnavailable && settingsReady && showProviderHint && <div id="provider-hint" role="status" className="absolute right-0 bottom-full mb-3 w-64 max-w-[75vw] rounded-xl border border-border/70 bg-muted/85 backdrop-blur-md px-3.5 py-3 text-xs text-foreground shadow-lg">
                      <p className="font-medium">Choose a provider to send a message.</p>
                      <button type="button" onClick={() => activeOptions.length ? setIsModelDropdownOpen(true) : setIsSettingsOpen(true)} className="mt-2 font-semibold underline underline-offset-4 cursor-pointer">{activeOptions.length ? 'Choose provider' : 'Configure provider'}</button>
                    </div>}
                    {isLoading || hasPendingToolApproval ? (
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
                        aria-label="Send message"
                        aria-describedby={providerUnavailable && showProviderHint ? 'provider-hint' : undefined}
                        aria-disabled={providerUnavailable}
                        onMouseEnter={() => { if (providerUnavailable && (input.trim() || draftAttachments.length)) setShowProviderHint(true); }}
                        onFocus={() => { if (providerUnavailable && (input.trim() || draftAttachments.length)) setShowProviderHint(true); }}
                        disabled={(!input.trim() && !draftAttachments.length) || readingAttachments || hasPendingToolApproval || !sessionReady || !settingsReady}
                        className={`p-2 rounded-full flex items-center justify-center transition-all cursor-pointer ${(input.trim() || draftAttachments.length) && !hasPendingToolApproval && !readingAttachments
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
            <div className="text-center mt-1.5 mb-0.5 text-xs text-muted-foreground font-medium hidden sm:block leading-tight">
              AI models can make mistakes. Verify important information.
              <br />
              <span className="inline-flex items-center justify-center gap-1.5">
                <a
                  href="https://github.com/ownyourwebsite/ai-playground"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-foreground/60 hover:text-primary transition-colors"
                >
                  Built by Own Your Website
                </a>
                <a
                  href="https://github.com/ownyourwebsite/ai-playground"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub repository"
                  title="Open source on GitHub"
                  className="text-foreground/50 hover:text-primary transition-colors"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="w-3.5 h-3.5">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                  </svg>
                </a>
              </span>
            </div>
          </form>
        </div>
      </main>

      {/* Right Panels (Inspector / MCP) */}
      <RightPanel />

      {/* Settings Modal Dialog */}
      <SettingsModal onRestoreBackup={() => setIsRestoreOpen(true)} />
      {isRestoreOpen && <RestoreBackupDialog onClose={() => setIsRestoreOpen(false)} />}

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
              {confirmModalAction === "clear" ? "Start a New Chat?" : "Start This Turn Again?"}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {confirmModalAction === "clear"
                ? "Are you sure you want to clear all messages in this session? The saved session remains in the sidebar."
                : "Repeat the last user request as a new turn. History and tool results stay saved. Previously completed remote actions and provider costs may repeat. Verify any unknown tool outcome first; those turns and active Retry-After waits cannot be restarted."}
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
                  } else if (confirmModalAction === "restart") {
                    executeRestart();
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

// Keys and URL credentials/query parameters never participate in hint identity.
function imageHintIdentity(provider: string, model: string, baseUrl?: string) {
  let endpoint = '';
  if (baseUrl) {
    try { const url = new URL(baseUrl); endpoint = `${url.origin}${url.pathname.replace(/\/$/, '')}`; }
    catch { endpoint = 'unconfigured'; }
  }
  return JSON.stringify([provider, endpoint, model]);
}

const dismissedImageHints = new Set<string>();
function ImageSupportHint({ selection, support }: { selection: string; support: 'unknown' | 'unsupported' }) {
  const [visible, setVisible] = useState(false);
  const storageKey = `ai-workspace:image-hint:v1:${selection}`;
  useEffect(() => {
    let stale = false;
    void Promise.resolve().then(() => {
      let dismissed = dismissedImageHints.has(selection);
      try { dismissed ||= localStorage.getItem(storageKey) === '1'; }
      catch { /* An unavailable preference store must never gate image requests. */ }
      if (!stale) setVisible(!dismissed);
    });
    return () => { stale = true; };
  }, [selection, storageKey]);
  if (!visible) return null;
  return <div aria-label="Image support hint" className="mb-2 flex items-start gap-2 rounded-xl border border-border/40 bg-muted/25 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground backdrop-blur-sm">
    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
    <p className="min-w-0 flex-1">{support === 'unsupported' ? 'This model is listed as text-only.' : 'Image support is unverified.'} The provider decides; files stay intact. Charges may apply.</p>
    <button type="button" aria-label="Dismiss image support hint" onClick={() => {
      dismissedImageHints.add(selection);
      try { localStorage.setItem(storageKey, '1'); } catch { /* Tab-memory fallback is enough when storage is blocked. */ }
      setVisible(false);
    }} className="-m-0.5 shrink-0 rounded-md p-1.5 hover:bg-muted/60 hover:text-foreground cursor-pointer"><X className="h-3.5 w-3.5" /></button>
  </div>;
}

type ToolCallCardProps = {
  toolCall: ToolInvocation;
  msgId: string;
  isFirstPending: boolean;
  executeToolCall: (assistantMessageId: string, toolCallId: string, updatedArgs?: Record<string, unknown>) => void;
  declineToolCall: (assistantMessageId: string, toolCallId: string) => void;
  retryToolCall: (assistantMessageId: string, toolCallId: string) => void;
  isLatest: boolean;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
};

function truncateToolTarget(value: string, max = 60): string {
  const clean = value.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function getToolTargetLabel(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== "object") return null;
  const asStr = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // 1. Direct file keys — this is what makes GitHub show ".gitignore".
  for (const key of ["path", "file_path", "file", "filename", "filepath", "filePath"]) {
    const hit = asStr((args as Record<string, unknown>)[key]);
    if (hit) return truncateToolTarget(hit, 60);
  }
  // 2. push_files-style batch: files: [{ path, ... }]
  const files = (args as Record<string, unknown>).files;
  if (Array.isArray(files) && files.length > 0) {
    const firstPath = asStr((files[0] as Record<string, unknown>)?.path);
    if (firstPath) {
      return files.length > 1
        ? `${truncateToolTarget(firstPath, 48)} +${files.length - 1} more`
        : truncateToolTarget(firstPath, 60);
    }
  }
  // 3. owner/repo fallback (e.g. list_issues without a path).
  const owner = asStr((args as Record<string, unknown>).owner);
  const repo = asStr((args as Record<string, unknown>).repo);
  if (owner && repo) return truncateToolTarget(`${owner}/${repo}`, 60);
  // 4. Search-like tools (Tavily): show the query, not an empty slot.
  for (const key of ["query", "q", "question", "url", "title"]) {
    const hit = asStr((args as Record<string, unknown>)[key]);
    if (hit) return truncateToolTarget(hit, 60);
  }
  void toolName;
  return null;
}

function getServerShortLabel(server: McpServer | undefined, toolName: string): string | null {
  if (server) {
    if (server.id === "github" || server.preset === "github") return "GitHub MCP";
    const name = (server.name || "").trim();
    if (!name) return null;
    if (/mcp/i.test(name)) return name;
    // "Tavily Search" -> "Tavily", "GitHub Integration" -> "GitHub".
    const first = name.split(/\s+/)[0];
    return first.length >= 2 ? first : name;
  }
  const lower = toolName.toLowerCase();
  if (lower.startsWith("github_")) return "GitHub MCP";
  if (lower.startsWith("tavily_")) return "Tavily";
  return null;
}

function ToolCallCard({ toolCall, msgId, isFirstPending, executeToolCall, declineToolCall, retryToolCall, isLatest }: ToolCallCardProps) {
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const { mcpServers } = useWorkspace();

  const isResult = toolCall.state === 'result';
  const cardResult = toolCall.result as { error?: string } | undefined;
  const cardHasError = isResult && !!cardResult?.error;
  // Errors auto-expand without setState-in-effect: derived, not synchronized.
  // Default is collapsed — user opens Details on demand.
  const expanded = manuallyExpanded || cardHasError;
  const setExpanded = setManuallyExpanded;
  const isExecuting = toolCall.state === 'executing';
  const needsApproval = toolCall.state === 'needs-approval';
  const isQueued = needsApproval && !isFirstPending;
  const isActiveApproval = needsApproval && isFirstPending;

  const result = toolCall.result as { error?: string } | undefined;
  const hasError = isResult && !!result?.error;

  let statusText = 'Unknown';
  let statusColor = 'text-muted-foreground';
  if (isQueued) { statusText = 'Queued'; statusColor = 'text-muted-foreground'; }
  else if (toolCall.state === 'calling') { statusText = 'Preparing tool…'; statusColor = 'text-muted-foreground'; }
  else if (isActiveApproval) { statusText = 'Waiting'; statusColor = 'text-primary animate-pulse'; }
  else if (isExecuting) { statusText = 'Executing...'; statusColor = 'text-primary animate-pulse'; }
  else if (toolCall.outcome === 'unknown') { statusText = 'Outcome unknown — verify remotely'; statusColor = 'text-destructive'; }
  else if (toolCall.outcome === 'declined' || (isResult && result?.error === 'User declined tool execution.')) { statusText = 'Declined'; statusColor = 'text-muted-foreground'; }
  else if (isResult && hasError) { statusText = 'Error'; statusColor = 'text-destructive'; }
  else if (isResult) { statusText = 'Success'; statusColor = 'text-emerald-500'; }

  // Server attribution: direct id first, then match by known tool names
  // (covers cards created before serverId was persisted), then prefix guess.
  const owningServer: McpServer | undefined =
    mcpServers.find((s: McpServer) => s.id === toolCall.serverId) ??
    mcpServers.find((s: McpServer) =>
      (s.tools ?? []).some((t: McpTool) =>
        t.name === toolCall.toolName ||
        t.originalName === toolCall.toolName ||
        toolCall.toolName.endsWith(`_${t.name}`)
      )
    );
  const serverLabel = getServerShortLabel(owningServer, toolCall.toolName);
  const targetLabel = getToolTargetLabel(
    toolCall.originalName || toolCall.toolName,
    toolCall.args as Record<string, unknown> | undefined
  );
  const headerTitle = [serverLabel, toolCall.toolName, targetLabel].filter(Boolean).join(" • ");

  return (
    <div
      data-state={toolCall.state}
      className={`w-full mt-2 text-xs border rounded-xl transition-all ${isActiveApproval ? 'border-primary ring-1 ring-primary/20 bg-primary/5 animate-pulse' : 'border-border/60 bg-muted/30'}`}
    >
      {/* Collapsed Header: wrench • Server • tool • target ..... status • [Details] */}
      <div
        className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-xl"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-background border border-border/50 shrink-0">
            <Wrench className="w-3 h-3 text-muted-foreground" />
          </div>
          <span className="font-semibold text-foreground truncate text-[11px]" title={headerTitle}>{headerTitle}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className={`text-[10px] font-medium whitespace-nowrap ${statusColor}`}>
            {statusText}
          </span>
          <span className="text-muted-foreground/40 select-none">•</span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-border/60 bg-background text-[10px] font-medium text-muted-foreground hover:bg-muted transition-colors cursor-pointer whitespace-nowrap"
          >
            {expanded ? "Hide" : "Details"}
            <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
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

      {/* Action Buttons for Active Approval: 75% Confirm (black) / 25% Deny (1px light border) */}
      {isLatest && canRetryTool(toolCall, owningServer) && <button type="button" onClick={() => retryToolCall(msgId, toolCall.toolCallId)} className="m-2 px-3 py-1 rounded-md border cursor-pointer">Retry read tool — new approval required</button>}
      {isActiveApproval && (
        <div className="flex gap-2 px-2.5 pb-2.5 pt-2 border-t border-border/20 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); executeToolCall(msgId, toolCall.toolCallId); }}
            className="flex-[3] bg-primary text-primary-foreground font-bold py-1.5 rounded-lg hover:bg-primary/90 transition-colors cursor-pointer text-[11px]"
          >
            Confirm & Run
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              declineToolCall(msgId, toolCall.toolCallId);
            }}
            className="flex-[1] border border-border/60 bg-background hover:bg-muted text-foreground font-bold py-1.5 rounded-lg transition-colors cursor-pointer text-[11px]"
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
