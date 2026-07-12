import {
  embeddingModel,
  providerOf,
  stripPrefix,
  localBaseUrl,
  nvidiaBaseUrl,
  githubBaseUrl,
  groqBaseUrl,
  readApiKey,
  readNvidiaKey,
  readGithubToken,
  readGroqKey,
} from './config.js';

/**
 * Text embeddings for the project brain's semantic search. The embedding model is
 * configurable (see embeddingModel()) and routed by its prefix to that provider's
 * OpenAI-compatible `/embeddings` endpoint. Any failure throws so callers fall back to
 * keyword retrieval — semantic search is a best-effort enhancement, never a hard dep.
 */

/** True if an embedding model is configured (semantic search available). */
export function embeddingsEnabled(): boolean {
  return !!embeddingModel();
}

/** Resolve the base URL + key + wire model name for the configured embedding model. */
function target(): { baseUrl: string; apiKey: string; wireModel: string } {
  const model = embeddingModel();
  if (!model) throw new Error('No embedding model configured.');
  const wireModel = stripPrefix(model);
  switch (providerOf(model)) {
    case 'local':
      return { baseUrl: localBaseUrl(), apiKey: '', wireModel };
    case 'nvidia':
      return { baseUrl: nvidiaBaseUrl(), apiKey: readNvidiaKey(), wireModel };
    case 'github':
      return { baseUrl: githubBaseUrl(), apiKey: readGithubToken(), wireModel };
    case 'groq':
      return { baseUrl: groqBaseUrl(), apiKey: readGroqKey(), wireModel };
    default: // openrouter / bare
      return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: readApiKey(), wireModel };
  }
}

/** Embed one or more texts → an array of vectors (one per input). Throws on any failure. */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (!texts.length) return [];
  const { baseUrl, apiKey, wireModel } = target();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model: wireModel, input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`embeddings ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
  const data = body.data ?? [];
  // Preserve input order (some providers return an index).
  const out: number[][] = new Array(texts.length);
  data.forEach((d, i) => {
    out[d.index ?? i] = d.embedding;
  });
  if (out.some((v) => !Array.isArray(v))) throw new Error('embeddings response missing vectors');
  return out;
}

/** Embed a single text → one vector. */
export async function embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
  return (await embedTexts([text], signal))[0];
}

/** Cosine similarity of two equal-length vectors (0 if degenerate). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
