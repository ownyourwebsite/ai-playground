import { Message } from "../types";

export function generateCurl(
  provider: string,
  model: string,
  messages: Message[],
  apiKey: string,
  systemPrompt?: string
): string {
  const resolvedKey = apiKey || `YOUR_${provider.toUpperCase()}_API_KEY`;
  
  // Format messages
  const formattedMessages = [];
  if (systemPrompt) {
    formattedMessages.push({ role: "system", content: systemPrompt });
  }
  messages.forEach((msg) => {
    formattedMessages.push({ role: msg.role, content: msg.content });
  });

  if (provider === "openai") {
    return `curl https://api.openai.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${resolvedKey}" \\
  -d '${JSON.stringify(
    {
      model: model || "gpt-4o",
      messages: formattedMessages,
      stream: true,
    },
    null,
    2
  )}'`;
  }

  if (provider === "anthropic") {
    return `curl https://api.anthropic.com/v1/messages \\
  -H "content-type: application/json" \\
  -H "x-api-key: ${resolvedKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '${JSON.stringify(
    {
      model: model || "claude-3-5-sonnet-latest",
      messages: formattedMessages.filter((m) => m.role !== "system"),
      system: systemPrompt,
      max_tokens: 1024,
      stream: true,
    },
    null,
    2
  )}'`;
  }

  if (provider === "groq") {
    return `curl https://api.groq.com/openai/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${resolvedKey}" \\
  -d '${JSON.stringify(
    {
      model: model || "llama-3.1-70b-versatile",
      messages: formattedMessages,
      stream: true,
    },
    null,
    2
  )}'`;
  }

  if (provider === "ollama") {
    return `curl http://127.0.0.1:11434/api/chat \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(
    {
      model: model || "llama3",
      messages: formattedMessages,
      stream: false,
    },
    null,
    2
  )}'`;
  }

  return `// cURL generator not supported for ${provider}`;
}

export function generateTypeScript(
  provider: string,
  model: string,
  messages: Message[],
  systemPrompt?: string
): string {
  const providerImport = 
    provider === "openai" ? "createOpenAI" :
    provider === "anthropic" ? "createAnthropic" :
    provider === "groq" ? "createGroq" : "createOllama";
    
  const providerPackage = 
    provider === "openai" ? "@ai-sdk/openai" :
    provider === "anthropic" ? "@ai-sdk/anthropic" :
    provider === "groq" ? "@ai-sdk/groq" : "ollama-ai-provider";

  return `import { streamText } from 'ai';
import { ${providerImport} } from '${providerPackage}';

const ${provider} = ${providerImport}({
  apiKey: process.env.${provider.toUpperCase()}_API_KEY,
});

async function main() {
  const result = streamText({
    model: ${provider}('${model}'),
    system: ${systemPrompt ? JSON.stringify(systemPrompt) : "undefined"},
    messages: ${JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })), null, 2)},
  });

  for await (const textPart of result.textStream) {
    process.stdout.write(textPart);
  }
}

main().catch(console.error);`;
}
