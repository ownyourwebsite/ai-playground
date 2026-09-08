import { streamText, jsonSchema, ModelMessage, LanguageModel, JSONSchema7, TextPart, ToolCallPart, ToolResultPart } from 'ai';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUrlSsrfSafe } from '@/lib/ssrf';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ollama-ai-provider';
import { createGroq } from '@ai-sdk/groq';

// Route segment config: allows longer function executions on Vercel/deployments
// while extended reasoning ("thinking") is being generated (long latencies).
export const maxDuration = 60;

type JsonSchemaNode = {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  [key: string]: unknown;
};

// Recursively sanitize JSON schema to keep only standard properties
function sanitizeSchema(schema: JsonSchemaNode): JsonSchemaNode {
  if (!schema || typeof schema !== 'object') return schema;

  const sanitized: JsonSchemaNode = { ...schema };
  delete sanitized['x-mcp-header'];

  if (sanitized.properties) {
    const props: Record<string, JsonSchemaNode> = {};
    for (const key in schema.properties) {
      props[key] = sanitizeSchema(schema.properties[key]);
    }
    sanitized.properties = props;
  }

  if (sanitized.items && schema.items) {
    sanitized.items = sanitizeSchema(schema.items);
  }

  return sanitized;
}

type IncomingToolInvocation = {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  state?: string;
  result?: unknown;
};

type IncomingMessage = {
  role?: string;
  content?: unknown;
  toolInvocations?: IncomingToolInvocation[];
};
type IncomingTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaNode;
  /** Server id the tool came from (e.g. "github" for the GitHub preset). */
  serverId?: string;
};

export async function POST(req: Request) {
  const rl = await checkRateLimit(req, "chat");
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } });
  }

  try {
    const { messages, provider, model, systemPrompt, ollamaUrl, enabledTools, githubContext } = await req.json();

    const hasTools = enabledTools && Array.isArray(enabledTools) && enabledTools.length > 0;

    // Dev-only request logging
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Chat API] Provider: ${provider}, Model: ${model}`);
      console.log(`[Chat API] Enabled tools: ${enabledTools?.length || 0} (${enabledTools?.slice(0, 3).map((t: IncomingTool) => t.name).join(', ')}${(enabledTools?.length > 3 ? '...' : '')})`);
      console.log(`[Chat API] Resolved toolChoice: ${hasTools ? 'auto' : 'undefined'}`);
    }

    // We expect headers for the API key to avoid writing them to disk
    const openaiKey = req.headers.get('x-openai-key') || '';
    const anthropicKey = req.headers.get('x-anthropic-key') || '';
    const groqKey = req.headers.get('x-groq-key') || '';
    const customKey = req.headers.get('x-custom-key') || '';
    const customBaseUrl = req.headers.get('x-custom-base-url') || '';

    let languageModel: LanguageModel;
    // The exact model id actually used after applying the provider default.
    let resolvedModel = '';

    if (provider === 'openai') {
      const openai = createOpenAI({ apiKey: openaiKey });
      resolvedModel = model || 'gpt-5.6-luna';
      languageModel = openai(resolvedModel);
    } else if (provider === 'anthropic') {
      const anthropic = createAnthropic({ apiKey: anthropicKey });
      resolvedModel = model || 'claude-sonnet-5';
      languageModel = anthropic(resolvedModel);
    } else if (provider === 'groq') {
      const groq = createGroq({ apiKey: groqKey });
      resolvedModel = model || 'qwen/qwen3.6-27b';
      languageModel = groq(resolvedModel);
    } else if (provider === 'ollama') {
      const ollamaBase = ollamaUrl || 'http://127.0.0.1:11434/api';

      // SSRF guard: on hosted deployments the baseURL comes from the request
      // body, so without this check anyone could make the server talk to its
      // own internal network (metadata endpoints, localhost services, ...).
      // Local development (no VERCEL env) stays unrestricted so users can
      // keep using their local Ollama out of the box.
      if (process.env.VERCEL && process.env.ALLOW_PRIVATE_MCP !== '1') {
        const safe = await isUrlSsrfSafe(ollamaBase);
        if (!safe) {
          return new Response(
            JSON.stringify({ error: 'Ollama URL must be a public HTTPS endpoint on hosted deployments.' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      const ollama = createOllama({ baseURL: ollamaBase });
      resolvedModel = model || 'llama3';
      languageModel = ollama(resolvedModel) as unknown as LanguageModel;
    } else if (provider === 'custom') {
      const customProvider = createOpenAI({
        apiKey: customKey,
        baseURL: customBaseUrl,
      });
      resolvedModel = model || 'custom';
      languageModel = customProvider(resolvedModel);
    } else {
      return new Response(JSON.stringify({ error: `Provider ${provider} not supported` }), { status: 400 });
    }

    // Provider-specific options that request extended reasoning ("thinking") on
    // models that support it. Models that reject these options (the legacy
    // claude-3 ids, non-reasoning openai/groq ids) are gated out so they don't
    // error with a 400. Reasoning text returned by the SDK streams back over
    // the wire as its own parts — it is never injected into the visible text.
    let providerOptions: NonNullable<Parameters<typeof streamText>[0]['providerOptions']> | undefined;
    if (provider === 'anthropic') {
      // "adaptive" thinking (no budgetTokens) is the gen-5 path. The claude-3
      // ids would reject these options, so only apply to anything that isn't
      // a claude-3-* id.
      if (!/^claude-3-?/.test(resolvedModel)) {
        providerOptions = { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } };
      }
    } else if (provider === 'openai') {
      if (/(^|-)o1/.test(resolvedModel) || /gpt-5/i.test(resolvedModel)) {
        providerOptions = { openai: { reasoningEffort: 'medium' } };
      }
    } else if (provider === 'groq') {
      // Qwen3 thinking is opt-in, and reasoning text is only streamed back when
      // reasoningFormat is "raw". Non-qwen groq models (llama/mixtral) would
      // error on these, so gate on the model id containing "qwen".
      if (resolvedModel.toLowerCase().includes('qwen')) {
        providerOptions = { groq: { reasoningEffort: 'medium', reasoningFormat: 'raw' } };
      }
    }
    // ollama / custom intentionally get no providerOptions: local models embed
    // <think> tags in the text channel, and custom endpoints are unknown.

    // Convert UI messages to standard CoreMessage format for Vercel AI SDK
    const coreMessages: ModelMessage[] = [];
    if (messages && Array.isArray(messages)) {
      for (const msg of messages as IncomingMessage[]) {
        if (msg.role === 'user') {
          coreMessages.push({
            role: 'user',
            content: typeof msg.content === 'string' ? msg.content : '',
          });
        } else if (msg.role === 'assistant') {
          const assistantContent: Array<TextPart | ToolCallPart> = [];

          if (msg.content && typeof msg.content === 'string' && msg.content.trim().length > 0) {
            assistantContent.push({ type: 'text', text: msg.content });
          }

          if (msg.toolInvocations && Array.isArray(msg.toolInvocations) && msg.toolInvocations.length > 0) {
            msg.toolInvocations.forEach((ti) => {
              assistantContent.push({
                type: 'tool-call',
                toolCallId: ti.toolCallId || '',
                toolName: ti.toolName || '',
                input: ti.args || {},
              });
            });

            coreMessages.push({
              role: 'assistant',
              content: assistantContent,
            });

            const toolResults: ToolResultPart[] = [];
            msg.toolInvocations.forEach((ti) => {
              if (ti.state === 'result' || ti.result !== undefined) {
                // Ensure result is not undefined and provide a fallback
                const resultValue = ti.result ?? "No result provided";
                toolResults.push({
                  type: 'tool-result',
                  toolCallId: ti.toolCallId || '',
                  toolName: ti.toolName || '',
                  output: typeof resultValue === 'string'
                    ? { type: 'text', value: resultValue }
                    : { type: 'json', value: resultValue as import('ai').JSONValue },
                });
              }
            });

            if (toolResults.length > 0) {
              coreMessages.push({
                role: 'tool',
                content: toolResults,
              });
            }
          } else if (assistantContent.length > 0) {
            coreMessages.push({
              role: 'assistant',
              content: assistantContent,
            });
          } else {
            coreMessages.push({
              role: 'assistant',
              content: typeof msg.content === 'string' ? msg.content : '',
            });
          }
        }
      }
    }

    // Dynamic tools declaration
    const tools: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> = {};
    let toolsContext = "";

    if (hasTools) {
      toolsContext = "\n\nYou have access to the following tools:\n";

      enabledTools.forEach((tool: IncomingTool) => {
        const rawSchema = tool.inputSchema || { type: 'object', properties: {}, required: [] };
        const schema = sanitizeSchema(rawSchema);
        const params = schema.properties ? Object.keys(schema.properties).join(', ') : 'none';

        let description = tool.description || 'No description provided';

        // GitHub tools are identified by their originating server (serverId),
        // falling back to the owner/repo schema heuristic for clients that do
        // not send serverId. The heuristic alone misfires on non-GitHub MCPs
        // (GitLab/Gitea) whose tools also use owner/repo parameters.
        const isGithubTool =
          tool.serverId === 'github' ||
          (!tool.serverId && !!schema.properties && ('owner' in schema.properties || 'repo' in schema.properties));

        if (isGithubTool && githubContext) {
          const repoNote = `\nRepository context is available: owner=${githubContext.owner}, repo=${githubContext.repo}.\nUse these exact argument keys. Required: ${schema.required?.join(', ') || 'none'}. ${tool.name === 'get_file_contents' ? 'For the repository README, path is README.md.' : ''}`;
          description += repoNote;
        }

        if (process.env.NODE_ENV === 'development' && tool.name === 'get_file_contents') {
          console.log(`[Chat API] Sanitized Schema for ${tool.name}:`, JSON.stringify(schema));
        }

        toolsContext += `- ${tool.name}: ${description} (Parameters: ${params})\n`;

        tools[tool.name] = {
          description,
          inputSchema: jsonSchema(schema as JSONSchema7),
        };
      });

      toolsContext += "\nCRITICAL INSTRUCTION: If the user asks you to perform a task that requires one of these tools, YOU MUST use the proper tool calling format to execute it. Pay close attention to the EXACT parameter names required by each tool. For GitHub tools, you usually need 'owner', 'repo', and 'path'. Do not hallucinate or omit them.";
    }

    const finalSystemPrompt = systemPrompt + toolsContext;

    const result = streamText({
      model: languageModel,
      messages: coreMessages,
      system: finalSystemPrompt,
      tools: hasTools ? tools : undefined,
      toolChoice: hasTools ? 'auto' : undefined,
      ...(providerOptions ? { providerOptions } : {}),
      onFinish({ toolCalls, finishReason, usage }) {
        // Always log (not dev-only) so Vercel logs show why free-tier models
        // like minimax-m3 skip tool calls instead of failing silently.
        console.log(`[Chat API] finish model=${resolvedModel} reason=${finishReason} toolCalls=${toolCalls?.length ?? 0} toolsAvailable=${enabledTools?.length ?? 0} usage=${JSON.stringify(usage ?? {})}`);
        if (hasTools && (!toolCalls || toolCalls.length === 0)) {
          console.warn(`[Chat API] Model ${resolvedModel} responded with 0 tool calls despite ${enabledTools.length} tools available. Last user msg: ${(messages as unknown[] ?? []).length} msgs in history.`);
        }
      }
    });

    return result.toUIMessageStreamResponse({
      onError: (error: unknown) => {
        // Never leak API keys/secrets; the AI SDK error objects here don't contain them.
        console.error(`[Chat API] stream error model=${resolvedModel}:`, error instanceof Error ? error.message : String(error));
        const err = error as {
          statusCode?: number;
          message?: string;
          data?: { error?: { type?: string; message?: string } };
        };
        if (err?.statusCode === 413 || err?.data?.error?.type === 'tokens' || err?.message?.includes('rate_limit') || err?.message?.includes('exceeded') || err?.message?.includes('limit')) {
          return `Request too large for the current model/tier: ${err?.data?.error?.message || err.message}. Try disabling "GitHub Write Mode" to reduce the tool count, enabling fewer tools, or switching to a provider with a higher limit.`;
        }
        return err?.message || 'Request failed.';
      },
    });
  } catch (error: unknown) {
    console.error('Chat API Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
