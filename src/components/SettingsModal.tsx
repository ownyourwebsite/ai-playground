"use client";

import React, { useState } from "react";
import { Sliders, X, Check, ChevronDown, Trash2, Plus } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { AppSettings, SavedProvider } from "@/lib/types";

export default function SettingsModal() {
  const { isSettingsOpen } = useWorkspace();

  // Gate rendering so the form remounts with fresh state on every open.
  if (!isSettingsOpen) return null;
  return <SettingsForm />;
}

function SettingsForm() {
  const { setIsSettingsOpen, settings, updateSettings, setSelectedModel } = useWorkspace();

  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt || "");
  const [customBaseUrl, setCustomBaseUrl] = useState(settings.customBaseUrl || "");
  const [customKey, setCustomKey] = useState(settings.customKey || "");
  const [customModel, setCustomModel] = useState(settings.customModel || "");
  const [customName, setCustomName] = useState("");

  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>(settings.savedProviders || []);
  const [isSavedProvidersOpen, setIsSavedProvidersOpen] = useState(false);

  const [openAiKey, setOpenAiKey] = useState(settings.openAiKey || "");
  const [openAiModel, setOpenAiModel] = useState(settings.openAiModel || "gpt-5.6-luna");
  const [anthropicKey, setAnthropicKey] = useState(settings.anthropicKey || "");
  const [anthropicModel, setAnthropicModel] = useState(settings.anthropicModel || "claude-5-sonnet");
  const [groqKey, setGroqKey] = useState(settings.groqKey || "");
  const [groqModel, setGroqModel] = useState(settings.groqModel || "qwen/qwen3.6-27b");
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl || "http://127.0.0.1:11434/api");
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel || "llama3");
  const [githubWriteMode, setGithubWriteMode] = useState(settings.githubWriteMode !== false);
  const [rememberKeys, setRememberKeys] = useState(settings.rememberKeys || false);

  const [isPopularOpen, setIsPopularOpen] = useState(false);

  const handleSave = () => {
    const newSettings: Partial<AppSettings> = {
      systemPrompt,
      customBaseUrl,
      customKey,
      customModel,
      openAiKey,
      openAiModel,
      anthropicKey,
      anthropicModel,
      groqKey,
      groqModel,
      ollamaUrl,
      ollamaModel,
      githubWriteMode,
      rememberKeys,
      savedProviders,
    };

    // Auto-switch provider if exactly one key is provided and no others
    const providedKeys = [
      { key: customKey, model: "custom" },
      { key: openAiKey, model: "openai" },
      { key: anthropicKey, model: "anthropic" },
      { key: groqKey, model: "groq" }
    ].filter(k => k.key && k.key.trim().length > 0);

    if (providedKeys.length === 1) {
      setSelectedModel(providedKeys[0].model);
      newSettings.defaultModel = providedKeys[0].model;
    }

    updateSettings(newSettings);
    setIsSettingsOpen(false);
  };

  const handleSaveCustomProvider = () => {
    if (!customBaseUrl) {
      alert("Please enter a Base URL");
      return;
    }
    const name = customName.trim() || customModel || "Custom Provider";
    const newProvider: SavedProvider = {
      id: Date.now().toString(),
      name,
      baseUrl: customBaseUrl,
      key: customKey,
      model: customModel || "custom"
    };

    const updated = [...savedProviders, newProvider];
    setSavedProviders(updated);

    // Auto-switch to newly saved provider immediately
    setSelectedModel(`custom-${newProvider.id}`);

    // Save it to settings in-memory immediately as well
    updateSettings({
      ...settings,
      savedProviders: updated,
      defaultModel: `custom-${newProvider.id}`
    });

    setCustomName("");
    alert(`Saved and selected "${name}"!`);
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-background border border-border rounded-2xl w-full max-w-md shadow-lg flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/10">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Sliders className="w-4 h-4 text-primary" />
            <span>Configuration Settings</span>
          </div>
          <button
            onClick={() => setIsSettingsOpen(false)}
            className="p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 flex-1 overflow-y-auto max-h-[70vh]">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              System Instructions
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Set system instructions..."
              className="w-full bg-muted/20 border border-input rounded-xl p-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px] resize-none leading-relaxed text-foreground"
            />
          </div>

          <div className="h-[1px] w-full bg-border my-3" />

          {/* Custom Provider (Main section) */}
          <div className="text-[10px] text-amber-600 dark:text-amber-500 font-semibold italic mt-1 mb-2 leading-snug">
            {"⚠️ Warning: Free/on-demand tiers might not be capable of full GitHub MCP. Turning off 'GitHub Write Mode' in the MCP sidebar could help fit inside the limits."}
          </div>
          <div className="border border-border rounded-xl p-4 space-y-3 bg-muted/5">
            <div className="text-xs font-bold text-primary uppercase tracking-wider">
              Custom Provider (OpenAI Compatible)
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                Base URL
              </label>
              <input
                type="text"
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full bg-muted/20 border border-input rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                API Key
              </label>
              <input
                type="password"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="sk-..."
                className="w-full bg-muted/20 border border-input rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase">
                Model ID
              </label>
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="custom-model-name"
                className="w-full bg-muted/20 border border-input rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              />
            </div>

            {/* Custom Nickname and Save Button */}
            <div className="pt-2 border-t border-border/40 flex gap-2 items-end">
              <div className="flex-1 space-y-1.5">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase">
                  Nickname (e.g., LM Studio Llama)
                </label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="My Custom Model"
                  className="w-full bg-muted/20 border border-input rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                />
              </div>
              <button
                type="button"
                onClick={handleSaveCustomProvider}
                className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center gap-1 h-7.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Save Provider
              </button>
            </div>
          </div>

          {/* Collapsible Saved Providers */}
          <div className="border border-border rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setIsSavedProvidersOpen(!isSavedProvidersOpen)}
              className="w-full flex items-center justify-between px-4 py-3 bg-muted/20 hover:bg-muted/30 transition-colors text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer"
            >
              <span>Saved Providers ({savedProviders.length})</span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isSavedProvidersOpen ? "rotate-180" : ""}`} />
            </button>

            {isSavedProvidersOpen && (
              <div className="p-4 border-t border-border space-y-3 bg-muted/5 animate-in slide-in-from-top-1 duration-150">
                {savedProviders.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic text-center py-2">
                    {"No saved custom providers yet. Configure above and click \"Save Provider\"."}
                  </div>
                ) : (
                  savedProviders.map((prov) => (
                    <div key={prov.id} className="flex items-center justify-between p-2.5 bg-background rounded-lg border border-border shadow-xs text-xs">
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="font-bold text-foreground truncate">{prov.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">{prov.baseUrl}</div>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">Model: {prov.model}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedModel(`custom-${prov.id}`);
                            updateSettings({ defaultModel: `custom-${prov.id}` });
                            alert(`Selected "${prov.name}"!`);
                          }}
                          className="px-2.5 py-1 bg-primary/5 text-primary hover:bg-primary/10 rounded-md font-semibold transition-colors cursor-pointer"
                        >
                          Select
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Delete "${prov.name}"?`)) {
                              const updated = savedProviders.filter((p) => p.id !== prov.id);
                              setSavedProviders(updated);
                              updateSettings({ savedProviders: updated });
                            }
                          }}
                          className="p-1 hover:bg-destructive/5 text-muted-foreground hover:text-destructive rounded-md transition-colors cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Collapsible Popular Providers */}
          <div className="border border-border rounded-xl overflow-hidden">
            <button
              onClick={() => setIsPopularOpen(!isPopularOpen)}
              className="w-full flex items-center justify-between px-4 py-3 bg-muted/20 hover:bg-muted/30 transition-colors text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer"
            >
              <span>Popular Providers</span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isPopularOpen ? "rotate-180" : ""}`} />
            </button>

            {isPopularOpen && (
              <div className="p-4 border-t border-border space-y-4 bg-muted/5 animate-in slide-in-from-top-1 duration-150">
                {/* OpenAI */}
                <div className="space-y-2 border-b border-border/40 pb-3">
                  <div className="text-xs font-bold text-foreground">OpenAI</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Key</label>
                      <input
                        type="password"
                        value={openAiKey}
                        onChange={(e) => setOpenAiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Model</label>
                      <input
                        type="text"
                        value={openAiModel}
                        onChange={(e) => setOpenAiModel(e.target.value)}
                        placeholder="gpt-5.6-luna"
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                  </div>
                </div>

                {/* Anthropic */}
                <div className="space-y-2 border-b border-border/40 pb-3">
                  <div className="text-xs font-bold text-foreground">Anthropic</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Key</label>
                      <input
                        type="password"
                        value={anthropicKey}
                        onChange={(e) => setAnthropicKey(e.target.value)}
                        placeholder="sk-ant-..."
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Model</label>
                      <input
                        type="text"
                        value={anthropicModel}
                        onChange={(e) => setAnthropicModel(e.target.value)}
                        placeholder="claude-5-sonnet"
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                  </div>
                </div>

                {/* Groq */}
                <div className="space-y-2 border-b border-border/40 pb-3">
                  <div className="text-xs font-bold text-foreground">Groq</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Key</label>
                      <input
                        type="password"
                        value={groqKey}
                        onChange={(e) => setGroqKey(e.target.value)}
                        placeholder="gsk_..."
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Model</label>
                      <input
                        type="text"
                        value={groqModel}
                        onChange={(e) => setGroqModel(e.target.value)}
                        placeholder="qwen/qwen3.6-27b"
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                  </div>
                </div>

                {/* Ollama */}
                <div className="space-y-2">
                  <div className="text-xs font-bold text-foreground">Ollama</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">URL</label>
                      <input
                        type="text"
                        value={ollamaUrl}
                        onChange={(e) => setOllamaUrl(e.target.value)}
                        placeholder="http://127.0.0.1:11434/api"
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-muted-foreground uppercase">Model</label>
                      <input
                        type="text"
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                        placeholder="llama3"
                        className="w-full bg-muted/20 border border-input rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="githubWriteMode"
              checked={githubWriteMode}
              onChange={(e) => {
                setGithubWriteMode(e.target.checked);
                updateSettings({ githubWriteMode: e.target.checked });
              }}
              className="rounded border-input text-rose-600 focus:ring-rose-500 h-4 w-4"
            />
            <label htmlFor="githubWriteMode" className="text-xs text-rose-600 dark:text-rose-500 font-semibold cursor-pointer">
              Enable GitHub Write Mode
            </label>
          </div>
          {githubWriteMode && (
            <div className="text-[10px] text-rose-600 dark:text-rose-500 font-bold bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
              🚨 WARNING: This enables tools that can modify your repositories. Use with caution. Never silently write to default branch.
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="rememberKeys"
              checked={rememberKeys}
              onChange={(e) => setRememberKeys(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary h-4 w-4"
            />
            <label htmlFor="rememberKeys" className="text-xs text-muted-foreground cursor-pointer">
              Remember keys on this device (stored encrypted/local-first in IndexedDB)
            </label>
          </div>
          <div className="text-[10px] text-amber-600 dark:text-amber-500 font-medium italic leading-snug">
            ⚠️ Warning: Enabling this persists your keys in your local browser database. They are never sent to our servers.
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 bg-muted/20 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={() => setIsSettingsOpen(false)}
            className="px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-muted rounded-xl transition-all cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl text-sm font-semibold shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <Check className="w-4 h-4" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
