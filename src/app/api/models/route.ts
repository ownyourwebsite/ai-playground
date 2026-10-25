import { NextRequest } from 'next/server';
import { checkRateLimit, rateLimitErrorResponse } from '@/lib/rateLimit';
import { ModelsError, listModels, type ModelCreds } from '@/lib/models/list';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function credsFor(req: NextRequest, provider: string): ModelCreds {
  const header = (name: string) => req.headers.get(name) || '';
  switch (provider) {
    case 'openai': return { apiKey: header('x-openai-key') };
    case 'anthropic': return { apiKey: header('x-anthropic-key') };
    case 'groq': return { apiKey: header('x-groq-key') };
    case 'ollama': return { baseUrl: header('x-ollama-url') };
    case 'custom': return { apiKey: header('x-custom-key'), baseUrl: header('x-custom-base-url') };
    default: return {};
  }
}

export async function GET(req: NextRequest) {
  const rateLimitError = rateLimitErrorResponse(await checkRateLimit(req, 'models'));
  if (rateLimitError) return rateLimitError;

  const provider = req.nextUrl.searchParams.get('provider') || '';
  try {
    const models = await listModels(provider, credsFor(req, provider), req.signal);
    return Response.json({ models }, { headers: NO_STORE });
  } catch (error) {
    // Only static codes leave the server: never upstream bodies, headers or keys.
    const failure = error instanceof ModelsError ? error : new ModelsError('upstream');
    return Response.json({ error: failure.code }, { status: failure.status, headers: NO_STORE });
  }
}
