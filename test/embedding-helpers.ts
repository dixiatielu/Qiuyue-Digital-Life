import type { Embedder } from '../src/embedding.js';
import { config } from './helpers.js';

/** One dimension per topic word and a shared baseline, so texts on the same topic are alike (0.745 or more) and others are not (0.447 or less). */
export function topics(model = 'topics', fail?: (texts: string[]) => Error | undefined): Embedder & { calls: string[][] } {
  const words = ['夜曲', '新番', '小笼包', '天气'];
  const calls: string[][] = [];
  return {
    model, calls,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      calls.push(texts);
      const error = fail?.(texts); if (error) throw error;
      return texts.map(text => Float32Array.from([...words.map(word => text.includes(word) ? 1 : 0), 0.5]));
    },
  };
}
export function embeddingConfig(changes: Partial<ReturnType<typeof config>['embedding']> = {}) {
  const cfg = config();
  cfg.embedding = { ...cfg.embedding, enabled: true, baseUrl: 'https://embed.example/v1', model: 'topics', selfNames: ['秋月', '秋月姐姐'], ...changes };
  return cfg;
}
