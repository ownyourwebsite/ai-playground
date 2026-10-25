/** Shared by browser and server. Byte limits are not character/token limits. */
export const MAX_ATTACHMENTS = 4;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** User content plus decoded attachment bytes in one message. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Entire UTF-8 JSON wire body, including base64 and conversation history. */
export const MAX_REQUEST_BYTES = 4_000_000;

// Deliberately small exact allow-lists, NOT model-name heuristics. A supported
// modality does not guarantee model availability, account access or context fit.
// Sources: developers.openai.com/api/docs/models/{gpt-4o,gpt-4.1,gpt-4o-mini,gpt-5},
// docs.anthropic.com/en/docs/about-claude/models/overview,
// console.groq.com/docs/vision. New IDs/snapshots need individual verification.
const imageModels: Record<string, ReadonlySet<string>> = {
  openai: new Set([
    'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20',
    'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
    'gpt-4.1', 'gpt-4.1-2025-04-14',
    'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14',
    'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14',
    'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-vision-preview',
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  ]),
  anthropic: new Set([
    'claude-3-haiku-20240307', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229',
    'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022', 'claude-3-7-sonnet-20250219',
    'claude-sonnet-4-20250514', 'claude-opus-4-20250514',
    'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
    'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-sonnet-4-6',
    'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5',
    'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1',
  ]),
  groq: new Set([
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ]),
};

const textOnlyModels: Record<string, ReadonlySet<string>> = {
  openai: new Set([
    'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-3.5-turbo-1106', 'gpt-3.5-turbo-16k',
    'gpt-4', 'gpt-4-0613', 'gpt-4-0314', 'gpt-4-32k',
    'o1-mini', 'o1-mini-2024-09-12', 'o1-preview', 'o1-preview-2024-09-12',
    'o3-mini', 'o3-mini-2025-01-31',
  ]),
  anthropic: new Set(['claude-2', 'claude-2.0', 'claude-2.1', 'claude-instant-1.2']),
  groq: new Set([
    'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama3-8b-8192', 'llama3-70b-8192',
    'mixtral-8x7b-32768', 'gemma2-9b-it', 'qwen/qwen3-32b',
    'deepseek-r1-distill-llama-70b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b',
  ]),
};

export function getImageSupport(provider: string, model: string): 'supported' | 'unsupported' | 'unknown' {
  // Local/custom aliases can point to anything, including text-only models.
  if (provider === 'custom' || provider === 'ollama') return 'unknown';
  if (Object.hasOwn(imageModels, provider) && imageModels[provider].has(model)) return 'supported';
  if (Object.hasOwn(textOnlyModels, provider) && textOnlyModels[provider].has(model)) return 'unsupported';
  return 'unknown';
}

/** Signature sniffing, not a full image decoder. Pass complete bytes for WebP. */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 20 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (length >= 12 && length % 2 === 0 && length + 8 === bytes.length) return 'image/webp';
  }
  return undefined;
}
