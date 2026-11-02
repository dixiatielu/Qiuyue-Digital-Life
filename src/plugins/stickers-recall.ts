import type { Config } from '../config.js';
import { errorText, type EnvironmentEvent } from '../domain.js';
import { closestLine, type Line, type SemanticSource } from '../embedding.js';
import type { StickerStore } from './stickers-store.js';

/** Match conversational use before appearance, retaining the whole description as a fallback. */
export function stickerLines(desc: string): string[] {
  const whole = desc.trim();
  const index = Math.max(...['适合', '表示', '用于'].map(word => whole.lastIndexOf(word)));
  const use = index > 0 ? whole.slice(index) : '';
  return use ? [use, whole] : [whole];
}
export interface StickerSuggestion { emojiId: string; desc: string; similarity: number }
const stickerActions = new Set(['add_custom_face', 'modify_custom_face', 'delete_custom_face']);

/** The plugin owns collection indexing and reuses message vectors already made for memory recall. */
export class StickerRecall {
  private stickers = new Map<string, { desc: string; lines: Line[] }>();
  private rejected = new Set<string>();
  private indexing?: Promise<void>;
  private reindex = false;
  private retry?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private controller = new AbortController();
  constructor(private config: Config['embedding'], private saved: StickerStore, private semantics: SemanticSource) {}
  start() {
    this.saved.dropOtherVectors(this.semantics.model);
    for (const { emojiId, desc, line, vector } of this.saved.stickerVectors(this.semantics.model)) this.stickers.set(emojiId, { desc, lines: [...this.stickers.get(emojiId)?.lines ?? [], { line, vector }] });
    this.unsubscribe = this.saved.store.subscribe(notice => {
      if (notice.kind === 'action' && notice.action.status === 'success' && stickerActions.has(notice.action.kind)) this.index();
    });
    this.index();
  }
  async stop() { this.unsubscribe?.(); clearTimeout(this.retry); this.controller.abort(); await this.indexing; }
  async idle() { while (this.indexing) await this.indexing; }
  suggestions(events: EnvironmentEvent[], exclude: ReadonlySet<string> = new Set()): StickerSuggestion[] {
    const queries = this.semantics.queries(events);
    if (!queries.length) return [];
    const found: StickerSuggestion[] = [];
    for (const [emojiId, { desc, lines }] of this.stickers) {
      if (exclude.has(emojiId)) continue;
      const { similarity } = closestLine(queries, lines);
      if (similarity >= this.config.stickerThreshold) found.push({ emojiId, desc, similarity });
    }
    return found.sort((a, b) => b.similarity - a.similarity).slice(0, this.config.stickerLimit);
  }
  private index() {
    if (this.controller.signal.aborted) return;
    if (this.indexing) { this.reindex = true; return; }
    this.indexing = this.indexStickers().finally(() => { this.indexing = undefined; if (this.reindex) { this.reindex = false; this.index(); } });
  }
  private async indexStickers() {
    const saved = new Map(this.saved.savedStickers().filter(sticker => sticker.desc.trim()).map(sticker => [sticker.emojiId, sticker.desc]));
    for (const [emojiId, { desc }] of this.stickers) if (saved.get(emojiId) !== desc) this.stickers.delete(emojiId);
    this.saved.keepStickerVectors(saved);
    for (const [emojiId, desc] of saved) {
      if (this.controller.signal.aborted) return;
      if (this.stickers.has(emojiId) || this.rejected.has(`${emojiId}:${desc}`)) continue;
      const lines = stickerLines(desc);
      try {
        const vectors = await this.semantics.embed(lines, this.controller.signal);
        const entries = lines.map((line, index) => ({ line, vector: vectors[index]! }));
        if (this.controller.signal.aborted) return;
        if (this.saved.saveStickerVectors(emojiId, this.semantics.model, desc, entries)) this.stickers.set(emojiId, { desc, lines: entries });
      } catch (error) {
        if (this.controller.signal.aborted) return;
        this.saved.store.log('recall_error', { stage: 'sticker', emojiId, message: errorText(error) });
        const status = (error as { status?: number }).status;
        if (status === 400 || status === 413 || status === 422) { this.rejected.add(`${emojiId}:${desc}`); continue; }
        clearTimeout(this.retry); this.retry = setTimeout(() => this.index(), 60_000); this.retry.unref?.();
        return;
      }
    }
  }
}
