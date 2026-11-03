import { environmentCredential, type CredentialReader } from './credentials.js';
import type { Config } from './config.js';
import type { EnvironmentEvent } from './domain.js';

/** Turns texts into vectors, one per text and in order. */
export interface Embedder { readonly model: string; embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> }

/** An OpenAI-compatible embeddings endpoint, such as https://api.openai.com/v1 or a local server the operator runs. */
export class EmbeddingClient implements Embedder {
  constructor(private config: Config['embedding'], private request: typeof fetch = fetch, private credential: CredentialReader = environmentCredential) {}
  get model() { return this.config.model; }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const key = this.credential(this.config.apiKeyEnv);
    const response = await this.request(`${this.config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw Object.assign(new Error(`The embedding request failed: HTTP ${response.status}.`), { status: response.status });
    const body = await response.json() as { data?: { index?: unknown; embedding?: unknown }[] } | null;
    const items = Array.isArray(body?.data) ? [...body.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)) : [];
    const vectors = items.map(item => Array.isArray(item.embedding) && item.embedding.every(value => typeof value === 'number' && Number.isFinite(value)) ? Float32Array.from(item.embedding as number[]) : undefined);
    if (vectors.length !== texts.length || vectors.some(vector => !vector?.length || vector.length !== vectors[0]!.length)) throw new Error('The embedding response has an invalid format.');
    return vectors as Float32Array[];
  }
}

/** Normalized text and message vectors; plugins reuse the work already done for incoming messages. */
export interface SemanticSource extends Embedder { queries(events: EnvironmentEvent[]): Float32Array[] }

export type Line = { line: string; vector: Float32Array };

export const unit = (vector: Float32Array) => {
  let norm = 0; for (const value of vector) norm += value * value;
  if (!norm) throw new Error('The embedding model returned a zero vector.');
  norm = Math.sqrt(norm); return vector.map(value => value / norm);
};
const dot = (a: Float32Array, b: Float32Array) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum; };
/** The line most alike to any of the queries. */
export function closestLine(queries: Float32Array[], lines: Line[]) {
  let best = { line: '', similarity: -1 };
  for (const query of queries) for (const { line, vector } of lines) {
    if (vector.length !== query.length) continue;
    const similarity = dot(query, vector);
    if (similarity > best.similarity) best = { line, similarity };
  }
  return best;
}
