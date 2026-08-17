import { Provider } from "./types";

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
}

export const PROVIDER_MODELS: Record<Provider, ModelInfo[]> = {
  openai: [
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
    { id: "o1-preview", name: "o1 Preview", provider: "openai" },
    { id: "o1-mini", name: "o1 Mini", provider: "openai" },
  ],
  anthropic: [
    { id: "claude-5-sonnet", name: "Claude 5 Sonnet", provider: "anthropic" },
    { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", provider: "anthropic" },
    { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", provider: "anthropic" },
    { id: "claude-3-opus-latest", name: "Claude 3 Opus", provider: "anthropic" },
  ],
  groq: [
    { id: "qwen/qwen3.6-27b", name: "Qwen 3.6 27B (Groq)", provider: "groq" },
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70b (Groq)", provider: "groq" },
    { id: "llama-3.1-70b-versatile", name: "Llama 3.1 70b (Groq)", provider: "groq" },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8b (Groq)", provider: "groq" },
    { id: "mixtral-8x7b-32768", name: "Mixtral 8x7b (Groq)", provider: "groq" },
  ],
  ollama: [
    { id: "llama3", name: "Local Llama 3", provider: "ollama" },
    { id: "mistral", name: "Local Mistral", provider: "ollama" },
    { id: "phi3", name: "Local Phi-3", provider: "ollama" },
  ],
  custom: [],
};

export function getModelLabel(provider: Provider, modelId: string): string {
  const models = PROVIDER_MODELS[provider];
  const model = models?.find((m) => m.id === modelId);
  return model ? model.name : modelId;
}
