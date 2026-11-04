import type { AdapterConfig } from '../config.js';
import { nativeToolName } from '../platform.js';
import type { Action } from '../domain.js';
import type { Store } from '../store.js';

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** The collection is derived from actual QQ action receipts; existing rows and vectors are retained. */
export class StickerStore {
  constructor(readonly store: Store, private account: Pick<AdapterConfig, 'id' | 'accountId'>) { store.db.exec('CREATE TABLE IF NOT EXISTS sticker_vectors(account TEXT NOT NULL, emoji_id TEXT NOT NULL, chunk INTEGER NOT NULL, model TEXT NOT NULL, desc TEXT NOT NULL, line TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(account,emoji_id,chunk));'); }
  private get accountKey() { return `qq:${this.account.accountId}`; }
  private kind(operation: string) { return nativeToolName(this.account.id, operation); }
  changed(action: Action) { return action.status === 'success' && ['add_custom_face', 'modify_custom_face', 'delete_custom_face'].some(operation => action.kind === this.kind(operation)); }
  private get db() { return this.store.db; }
  dropOtherVectors(model: string) { this.db.prepare('DELETE FROM sticker_vectors WHERE account=? AND model!=?').run(this.accountKey, model); }
  /** Vectors of saved stickers' descriptions for one embedding model, each with the description it was made from. */
  stickerVectors(model: string): { emojiId: string; desc: string; line: string; vector: Float32Array }[] {
    return this.db.prepare('SELECT * FROM sticker_vectors WHERE account=? AND model=? ORDER BY emoji_id,chunk').all(this.accountKey, model)
      .map(row => ({ emojiId: String(row.emoji_id), desc: String(row.desc), line: String(row.line), vector: new Float32Array(Uint8Array.from(row.vector as Uint8Array).buffer) }));
  }
  /** Replace a sticker's vectors, unless it was deleted or described anew while they were made. */
  saveStickerVectors(emojiId: string, model: string, desc: string, lines: { line: string; vector: Float32Array }[]): boolean {
    return this.store.transaction(() => {
      if (!this.stickerSaved(emojiId) || this.stickerNote(emojiId) !== desc) return false;
      this.db.prepare('DELETE FROM sticker_vectors WHERE account=? AND emoji_id=?').run(this.accountKey, emojiId);
      const insert = this.db.prepare('INSERT INTO sticker_vectors VALUES (?,?,?,?,?,?,?)');
      lines.forEach(({ line, vector }, chunk) => insert.run(this.accountKey, emojiId, chunk, model, desc, line, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)));
      return true;
    });
  }
  /** Drop the vectors of stickers deleted since, or described anew. */
  keepStickerVectors(saved: Map<string, string>) {
    for (const row of this.db.prepare('SELECT DISTINCT emoji_id, desc FROM sticker_vectors WHERE account=?').all(this.accountKey)) if (saved.get(String(row.emoji_id)) !== String(row.desc)) this.db.prepare('DELETE FROM sticker_vectors WHERE account=? AND emoji_id=?').run(this.accountKey, String(row.emoji_id));
  }
  /** The description last given to a saved sticker. */
  stickerNote(emojiId: string): string | undefined {
    const row = this.db.prepare(`SELECT json_extract(args,'$.desc') AS note FROM actions WHERE kind='${this.kind('modify_custom_face')}' AND status='success' AND json_extract(args,'$.emoji_id')=? ORDER BY created_at DESC LIMIT 1`).get(emojiId);
    return row?.note ? String(row.note) : undefined;
  }
  /** Stickers saved through her own actions and not deleted since, each with the description last given to it. Stickers saved elsewhere, such as on a phone, are not known here. */
  savedStickers(): { emojiId: string; desc: string }[] {
    const saved = new Map<string, string>();
    for (const row of this.db.prepare(`SELECT kind, args, result FROM actions WHERE kind IN ('${this.kind('add_custom_face')}','${this.kind('modify_custom_face')}','${this.kind('delete_custom_face')}') AND status='success' ORDER BY created_at,rowid`).all()) {
      const args = parse<Record<string, unknown>>(String(row.args));
      if (row.kind === this.kind('add_custom_face')) {
        const emojiId = row.result ? parse<{ emoji_id?: unknown } | null>(String(row.result))?.emoji_id : undefined;
        if (typeof emojiId === 'string' && emojiId) saved.set(emojiId, saved.get(emojiId) ?? '');
      } else if (typeof args.emoji_id === 'string' && saved.has(args.emoji_id)) {
        if (row.kind === this.kind('delete_custom_face')) saved.delete(args.emoji_id); else saved.set(args.emoji_id, typeof args.desc === 'string' ? args.desc : '');
      }
    }
    return [...saved].map(([emojiId, desc]) => ({ emojiId, desc }));
  }
  /** Whether a sticker was saved, apart from one save of it, and not deleted since. */
  stickerSaved(emojiId: string, except?: string): boolean {
    const added = this.db.prepare(`SELECT max(created_at) AS at FROM actions WHERE kind='${this.kind('add_custom_face')}' AND status='success' AND json_extract(result,'$.emoji_id')=? AND id IS NOT ?`).get(emojiId, except ?? null)?.at;
    return added != null && !this.db.prepare(`SELECT 1 FROM actions WHERE kind='${this.kind('delete_custom_face')}' AND status='success' AND json_extract(args,'$.emoji_id')=? AND created_at>=?`).get(emojiId, added);
  }
  /** The saved sticker a received image already is. QQ names a saved image by its MD5, which a received image carries as its file name; a market face is known by the emoji_id in the URL it was saved from. */
  savedSticker(image: Record<string, unknown>): { emojiId: string; desc?: string } | undefined {
    const md5 = /^([0-9a-f]{32})\.\w+$/i.exec(String(image.file ?? ''))?.[1];
    const market = /^[0-9a-f]{32}$/i.test(String(image.emoji_id ?? '')) ? String(image.emoji_id) : undefined;
    if (!md5 && !market) return;
    const row = this.db.prepare(`SELECT json_extract(result,'$.emoji_id') AS id FROM actions WHERE kind='${this.kind('add_custom_face')}' AND status='success' AND ${md5 ? "instr(upper(json_extract(result,'$.emoji_id')), ?)" : "instr(json_extract(args,'$.file'), ?)"} ORDER BY created_at DESC LIMIT 1`).get(md5 ? `_${md5.toUpperCase()}_` : market!);
    const emojiId = row?.id == null ? undefined : String(row.id);
    return emojiId && this.stickerSaved(emojiId) ? { emojiId, desc: this.stickerNote(emojiId) } : undefined;
  }
}
