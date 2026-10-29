import type { Config } from './config.js';
import type { EnvironmentEvent, Memory } from './domain.js';
import { errorText } from './domain.js';
import type { Store } from './store.js';

/** Turns texts into vectors, one per text and in order. */
export interface Embedder { readonly model: string; embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> }

/** An OpenAI-compatible embeddings endpoint, such as https://api.openai.com/v1 or a local server the operator runs. */
export class EmbeddingClient implements Embedder {
  constructor(private config: Config['embedding'], private request: typeof fetch = fetch) {}
  get model() { return this.config.model; }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const key = process.env[this.config.apiKeyEnv];
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

/** A memory's lines: one diary entry often holds several unrelated things. Headers ending in a colon and very short lines say too little alone. Some entries were written with a literal \n for line breaks. */
export function memoryLines(memory: Pick<Memory, 'content'>): string[] {
  const lines = memory.content.split(/\r?\n|\\n/).map(line => line.trim()).filter(line => [...line].length >= 8 && !/[:：]$/.test(line));
  return (lines.length ? lines : [memory.content.trim()]).slice(0, 40).map(line => line.slice(0, 1000));
}

/** What a message says, for recall: placeholders for what text cannot carry and mentions go, faces read as their names, and so do the names people call the digital life, which every memory about it would match. */
export function queryText(text: string, faces: Record<string, string>, selfNames: readonly string[]): string {
  let value = text.replace(/\[face (\d+)\]/g, (_match, id: string) => ` ${faces[id] ?? ''} `).replace(/\[(?:@\d+|Quoted message -?\d+|[a-z_]+)\]/g, ' ');
  for (const name of [...selfNames].sort((a, b) => b.length - a.length)) value = value.replaceAll(name, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

/** A memory a thought calls to mind, with the line of it that matched. */
export interface Recollection { memory: Memory; line: string; similarity: number }

const BATCH = 10;
const KEPT_MESSAGES = 2000;
const unit = (vector: Float32Array) => {
  let norm = 0; for (const value of vector) norm += value * value;
  if (!norm) throw new Error('The embedding model returned a zero vector.');
  norm = Math.sqrt(norm); return vector.map(value => value / norm);
};
const dot = (a: Float32Array, b: Float32Array) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum; };

/**
 * Recall by meaning (ADR-0009). Memories are embedded line by line once written and messages once they arrive,
 * so spontaneous recall only compares vectors and never waits on the embedding model; a message not embedded in time is left out.
 * Only a deliberate search embeds its query when it is made.
 */
export class SemanticRecall {
  private lines = new Map<string, { line: string; vector: Float32Array }[]>();
  private messages = new Map<string, Float32Array>();
  private waiting = new Map<string, string>();
  private embedding?: Promise<void>;
  private indexing?: Promise<void>;
  private reindex = false;
  /** Memories whose text the endpoint rejected; they wait for a restart rather than hold up the rest. */
  private rejected = new Set<string>();
  private pausedUntil = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private controller = new AbortController();
  constructor(private config: Config, private store: Store, private embedder: Embedder) {}
  start() {
    this.store.dropOtherVectors(this.embedder.model);
    for (const { memoryId, line, vector } of this.store.memoryVectors(this.embedder.model)) this.lines.set(memoryId, [...this.lines.get(memoryId) ?? [], { line, vector }]);
    this.unsubscribe = this.store.subscribe(notice => {
      if (notice.kind === 'environment') this.observe(notice.event);
      if (notice.kind === 'trace' && notice.name === 'memory_written') this.index();
      if (notice.kind === 'trace' && notice.name === 'memory_forgotten') for (const id of (notice.data as { ids?: string[] }).ids ?? []) this.lines.delete(id);
    });
    this.index();
  }
  async stop() { this.unsubscribe?.(); clearTimeout(this.retry); this.controller.abort(); await Promise.allSettled([this.embedding, this.indexing]); }
  /** Settles once arrived messages and written memories are embedded. */
  async idle() { while (this.embedding || this.indexing) await Promise.allSettled([this.embedding, this.indexing]); }
  /** The memories the messages of a thought most call to mind: at most embedding.limit, each at least embedding.threshold alike. Revised versions and development never come up this way. */
  recall(events: EnvironmentEvent[]): Recollection[] {
    const queries = events.map(event => this.messages.get(event.id)).filter((vector): vector is Float32Array => vector !== undefined);
    return queries.length ? this.closest(queries, this.store.recallableIds(), this.config.embedding.threshold, this.config.embedding.limit) : [];
  }
  /**
   * A deliberate search: memories alike in meaning, fused by rank with those sharing the query's exact words, such as names and QQ numbers,
   * which embeddings rarely place first. Text search alone answers when the endpoint cannot be reached.
   */
  async search(query: string, limit: number, subjects: string[] = [], historical = false, signal?: AbortSignal): Promise<(Memory & { matchedLine?: string })[]> {
    const lexical = this.store.search(query, limit, subjects, [], historical);
    let semantic: Recollection[] = [];
    if (query.trim() && Date.now() >= this.pausedUntil) {
      try {
        const [vector] = await this.embedder.embed([query.trim()], signal);
        semantic = this.closest([unit(vector!)], this.store.searchableIds(historical), this.config.embedding.searchThreshold, limit);
      } catch (error) { signal?.throwIfAborted(); this.fail(error, { stage: 'search' }); }
    }
    // Reciprocal rank fusion needs no common scale between similarity and text scores.
    const scores = new Map<string, number>();
    for (const ids of [semantic.map(item => item.memory.id), lexical.map(memory => memory.id)]) ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank)));
    const found = new Map<string, Memory & { matchedLine?: string }>([...lexical.map(memory => [memory.id, memory] as const), ...semantic.map(({ memory, line }) => [memory.id, { ...memory, matchedLine: line }] as const)]);
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => found.get(id)!);
  }
  /** Memories among ids whose closest line is at least threshold alike to any query, most alike first. */
  private closest(queries: Float32Array[], ids: Set<string>, threshold: number, limit: number): Recollection[] {
    const found: { id: string; line: string; similarity: number }[] = [];
    for (const [id, lines] of this.lines) {
      if (!ids.has(id)) continue;
      let best = { line: '', similarity: -1 };
      for (const query of queries) for (const { line, vector } of lines) {
        if (vector.length !== query.length) continue;
        const similarity = dot(query, vector);
        if (similarity > best.similarity) best = { line, similarity };
      }
      if (best.similarity >= threshold) found.push({ id, ...best });
    }
    return found.sort((a, b) => b.similarity - a.similarity).slice(0, limit).flatMap(({ id, line, similarity }) => {
      const memory = this.store.memory(id); return memory ? [{ memory, line, similarity }] : [];
    });
  }
  private observe(event: EnvironmentEvent) {
    if (event.kind !== 'message' || event.actorId === undefined || event.actorId === this.config.snowluma.selfId || this.messages.has(event.id) || this.waiting.has(event.id) || Date.now() < this.pausedUntil) return;
    const faces = event.text.includes('[face ') ? Object.fromEntries(Object.entries(this.store.faces()).map(([id, face]) => [id, face.name])) : {};
    const text = queryText(event.text, faces, this.config.embedding.selfNames);
    if ([...text].length < 2) return;
    this.waiting.set(event.id, text);
    this.drain();
  }
  private drain() {
    this.embedding ??= this.embedWaiting().finally(() => { this.embedding = undefined; if (this.waiting.size) this.drain(); });
  }
  private async embedWaiting() {
    while (this.waiting.size && !this.controller.signal.aborted) {
      const batch = [...this.waiting].slice(0, BATCH);
      try {
        const vectors = await this.embedder.embed(batch.map(([, text]) => text), this.controller.signal);
        batch.forEach(([id], index) => this.messages.set(id, unit(vectors[index]!)));
        for (const id of this.messages.keys()) { if (this.messages.size <= KEPT_MESSAGES) break; this.messages.delete(id); }
      } catch (error) { this.waiting.clear(); this.fail(error, { stage: 'message' }); return; }
      finally { for (const [id] of batch) this.waiting.delete(id); }
    }
  }
  private index() {
    if (this.indexing) { this.reindex = true; return; }
    this.indexing = this.indexMemories().finally(() => { this.indexing = undefined; if (this.reindex) { this.reindex = false; this.index(); } });
  }
  private async indexMemories() {
    while (!this.controller.signal.aborted) {
      const memory = this.store.unindexedMemories(this.embedder.model, this.rejected.size + 1).find(item => !this.rejected.has(item.id));
      if (!memory) return;
      const lines = memoryLines(memory);
      try {
        const vectors: Float32Array[] = [];
        for (let start = 0; start < lines.length; start += BATCH) vectors.push(...await this.embedder.embed(lines.slice(start, start + BATCH).map(line => `${memory.title}：${line}`), this.controller.signal));
        const entries = lines.map((line, index) => ({ line, vector: unit(vectors[index]!) }));
        if (this.controller.signal.aborted) return;
        if (this.store.saveMemoryVectors(memory.id, this.embedder.model, entries)) this.lines.set(memory.id, entries);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 400 || status === 413 || status === 422) { this.rejected.add(memory.id); this.store.log('recall_error', { stage: 'memory', memoryId: memory.id, message: errorText(error) }); continue; }
        this.fail(error, { stage: 'memory', memoryId: memory.id });
        this.retry = setTimeout(() => this.index(), 60_000); this.retry.unref?.();
        return;
      }
    }
  }
  private fail(error: unknown, detail: Record<string, string>) {
    if (this.controller.signal.aborted) return;
    // One failure pauses message embedding for a minute, so an outage logs one error rather than one per message.
    this.pausedUntil = Date.now() + 60_000;
    this.store.log('recall_error', { ...detail, message: errorText(error) });
  }
}
