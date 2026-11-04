import { parsePersonRef, requireConversationRef } from '../identity.js';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { closestLine, unit } from '../embedding.js';

export const drawingIdPattern = /^drawing:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const formats: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export interface DrawingSource { id: string; at?: number; conversation?: string; person?: string; name?: string; text?: string }
export interface GalleryDrawing {
  id: string; title: string; description: string; prompt: string; model?: string; tags: string[]; note: string;
  createdAt: number; timeSource: 'generation' | 'file'; sources: DrawingSource[]; favorite: boolean; archived: boolean;
  extension: string; bytes: number; width?: number; height?: number; previewError?: string;
  revision: number; seenAt?: number; deletedAt?: number;
}
export type DrawingPatch = Partial<Pick<GalleryDrawing, 'title' | 'description' | 'tags' | 'note' | 'favorite' | 'archived'>>;
export interface DrawingQuery {
  query?: string; from?: string; to?: string; person?: string; conversation?: string; tags?: string[];
  favorite?: boolean; archived?: boolean; includeArchived?: boolean; includeDeleted?: boolean; needsDescription?: boolean;
  limit?: number; offset?: number;
}
export class GalleryConflict extends Error {}
const parse = <T>(value: unknown): T => JSON.parse(String(value));
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
/** Chinese bigrams also find a subject embedded in a conversational query. */
function tokens(text: string): string[] {
  return [...new Set((normalized(text).match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []).flatMap(word =>
    /\p{Script=Han}/u.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
}
export const drawingText = (item: GalleryDrawing) => [item.title, item.description, item.tags.join(' '), item.prompt, item.note].filter(Boolean).join('\n');
export function validateDrawingQuery(value: DrawingQuery) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid gallery query.');
  for (const key of ['query', 'person', 'conversation', 'from', 'to'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key]!.length > 500)) throw new Error(`Invalid ${key}.`);
  for (const key of ['from', 'to'] as const) if (value[key] && (!/(Z|[+-]\d{2}:\d{2})$/.test(value[key]!) || !Number.isFinite(Date.parse(value[key]!)))) throw new Error(`${key} must be an ISO time with timezone.`);
  if (value.person && !parsePersonRef(value.person)) throw new Error('Use a canonical person reference.');
  if (value.conversation) requireConversationRef(value.conversation);
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) throw new Error('from must be before to.');
  for (const key of ['favorite', 'archived', 'includeArchived', 'includeDeleted', 'needsDescription'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 60))) throw new Error('Invalid tags.');
  for (const [key, max] of [['limit', 100], ['offset', 1_000_000]] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < (key === 'limit' ? 1 : 0) || value[key]! > max)) throw new Error(`Invalid ${key}.`);
}
export function validateDrawingPatch(value: DrawingPatch) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid drawing changes.');
  if (Object.keys(value).some(key => !['title', 'description', 'tags', 'note', 'favorite', 'archived'].includes(key))) throw new Error('Only editable drawing fields may be changed.');
  for (const [key, max] of [['title', 160], ['description', 2000], ['note', 2000]] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key]!.length > max || (key === 'title' && !value[key]!.trim()))) throw new Error(`Invalid ${key}.`);
  validateDrawingQuery({ tags: value.tags, favorite: value.favorite, archived: value.archived });
}

/** Plugin-owned persistence. Construction and all read methods also work with a read-only connection. */
export class DrawingLibrary {
  constructor(readonly db: DatabaseSync, readonly dir: string) {}
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS gallery_drawings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gallery_vectors(drawing_id TEXT PRIMARY KEY, model TEXT NOT NULL, content TEXT NOT NULL, vector BLOB NOT NULL);`);
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('galleryDirectory', JSON.stringify(this.dir));
  }
  exists() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gallery_drawings'").get()); }
  get(id: string): GalleryDrawing | undefined {
    if (!drawingIdPattern.test(id) || !this.exists()) return;
    const row = this.db.prepare('SELECT data FROM gallery_drawings WHERE id=?').get(id);
    return row ? parse<GalleryDrawing>(row.data) : undefined;
  }
  all(): GalleryDrawing[] { return this.exists() ? this.db.prepare('SELECT data FROM gallery_drawings').all().map(row => parse<GalleryDrawing>(row.data)) : []; }
  private put(item: GalleryDrawing) { this.db.prepare('INSERT INTO gallery_drawings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id, JSON.stringify(item)); }
  private file(id: string, extension: string) {
    const uuid = drawingIdPattern.exec(id)?.[1];
    if (!uuid || !formats[extension]) throw new Error('Invalid drawing reference.');
    return join(this.dir, `${uuid}.${extension}`);
  }
  private thumb(id: string) {
    const uuid = drawingIdPattern.exec(id)?.[1];
    if (!uuid) throw new Error('Invalid drawing reference.');
    return join(this.dir, 'thumbnails', `${uuid}.webp`);
  }
  available(item: GalleryDrawing) {
    if (item.deletedAt) return false;
    try { return lstatSync(this.file(item.id, item.extension)).isFile(); } catch { return false; }
  }
  private original(id: string, extension: string): { data: Buffer; mimeType: string } | undefined {
    try { const path = this.file(id, extension); if (lstatSync(path).isFile()) return { data: readFileSync(path), mimeType: formats[extension]! }; }
    catch { /* An unavailable original is represented by the catalog entry. */ }
  }
  image(id: string, thumbnail = false): { data: Buffer; mimeType: string } | undefined {
    const item = this.get(id);
    if (!item || item.deletedAt) return;
    if (thumbnail) {
      try { if (lstatSync(this.thumb(id)).isFile()) return { data: readFileSync(this.thumb(id)), mimeType: 'image/webp' }; }
      catch { /* A missing thumbnail can use the original. */ }
    }
    return this.original(id, item.extension);
  }
  /** Recover only a tracked generation interrupted between committing its file and catalog entry. */
  async recoverGeneration(id: string, info: Parameters<DrawingLibrary['save']>[3]) {
    if (this.get(id)) return;
    for (const extension of Object.keys(formats)) {
      const image = this.original(id, extension);
      if (image) { await this.save(id, image.data, extension, info); return; }
    }
  }
  sources(ids: string[]): DrawingSource[] {
    return [...new Set(ids)].slice(0, 20).map(id => {
      const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
      if (!row) return { id };
      const payload = parse<Record<string, any>>(row.payload);
      const source = row.source ? parse<import('../identity.js').EventSource>(row.source) : undefined;
      return { id, at: Number(row.at), ...(source?.actor ? { person: source.actor } : {}), ...(source?.conversation ? { conversation: source.conversation } : {}),
        name: source?.actorName || payload.sender?.card || payload.sender?.nickname || undefined, text: String(row.text).slice(0, 400) };
    });
  }
  async save(id: string, data: Buffer, extension: string, info: { prompt: string; model: string; createdAt: number; sources: DrawingSource[] }) {
    this.initialize();
    if (this.get(id)) return;
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(id, extension), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(temporary, data); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
    // Commit the original and its provenance before deriving expendable previews.
    const item: GalleryDrawing = { id, title: '', description: '', note: '', tags: [], favorite: false, archived: false, extension,
      bytes: data.length, timeSource: 'generation', revision: 1, ...info };
    this.put(item);
    await this.preview(item, data);
  }
  private async preview(item: GalleryDrawing, data: Buffer) {
    try {
      const input = sharp(data, { limitInputPixels: 80_000_000 });
      const metadata = await input.metadata();
      const thumbnail = await input.rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      // A management deletion may have happened while sharp was working.
      const latest = this.get(item.id); if (!latest || latest.deletedAt) return;
      mkdirSync(join(this.dir, 'thumbnails'), { recursive: true });
      writeFileSync(this.thumb(item.id), thumbnail);
      this.put({ ...latest, width: metadata.width, height: metadata.height, previewError: undefined });
    } catch {
      const latest = this.get(item.id);
      if (latest && !latest.deletedAt) this.put({ ...latest, previewError: 'Preview unavailable' });
    }
  }
  /** Finish an interrupted deletion without scanning or importing unregistered files. */
  recoverDeletions() {
    for (const item of this.all()) if (item.deletedAt) this.removeFiles(item);
  }
  markSeen(id: string) {
    const item = this.get(id); if (item && !item.deletedAt && !item.seenAt) this.put({ ...item, seenAt: Date.now() });
  }
  update(id: string, changes: DrawingPatch, revision?: number, fromModel = false) {
    validateDrawingPatch(changes);
    const item = this.get(id); if (!item || item.deletedAt) throw new Error('Drawing does not exist or has been deleted.');
    if (revision !== undefined && revision !== item.revision) throw new GalleryConflict('The drawing changed. Reload it before saving.');
    if (fromModel && changes.description?.trim() && !item.seenAt) throw new Error('View the drawing before describing its actual appearance.');
    const updated = { ...item, ...changes, ...(changes.tags ? { tags: [...new Set(changes.tags.map(tag => tag.trim()))] } : {}), revision: item.revision + 1 };
    this.put(updated);
    if (drawingText(item) !== drawingText(updated)) this.db.prepare('DELETE FROM gallery_vectors WHERE drawing_id=?').run(id);
    return updated;
  }
  private removeFiles(item: GalleryDrawing) {
    for (const extension of Object.keys(formats)) rmSync(this.file(item.id, extension), { force: true });
    rmSync(this.thumb(item.id), { force: true });
  }
  delete(id: string, revision: number) {
    const item = this.get(id); if (!item) throw new Error('Drawing does not exist.');
    if (!item.deletedAt && revision !== item.revision) throw new GalleryConflict('The drawing changed. Reload it before deleting.');
    this.put({ ...item, deletedAt: item.deletedAt ?? Date.now(), revision: item.deletedAt ? item.revision : item.revision + 1 });
    this.db.prepare('DELETE FROM gallery_vectors WHERE drawing_id=?').run(id);
    this.removeFiles(item);
    return { id, deleted: true };
  }
  usage(id: string) {
    // Inspect only media fields, so mentioning an ID in a text message is not counted as sharing the picture.
    const uses = (value: any, key = ''): boolean => typeof value === 'string' ? ['file', 'images'].includes(key) && value === id
      : Array.isArray(value) ? value.some(item => uses(item, key)) : value && typeof value === 'object' ? Object.entries(value).some(([key, child]) => uses(child, key)) : false;
    return this.db.prepare('SELECT id,kind,args,status,created_at,conversation FROM actions WHERE instr(args,?)>0 ORDER BY created_at DESC').all(id)
      .flatMap(row => { const args = parse<Record<string, any>>(row.args); return uses(args) ? [{ id: String(row.id), kind: String(row.kind), status: String(row.status), at: Number(row.created_at),
        target: row.conversation ? String(row.conversation) : String(row.kind) }] : []; });
  }
  detail(id: string) {
    const item = this.get(id); return item ? { ...item, available: this.available(item), uses: this.usage(id) } : undefined;
  }
  search(options: DrawingQuery = {}, semantic = new Map<string, number>()) {
    validateDrawingQuery(options);
    const query = normalized(options.query?.trim() ?? ''), words = tokens(query);
    const candidates = this.all().filter(item =>
      (!item.deletedAt || options.includeDeleted) && (options.archived !== undefined ? item.archived === options.archived : options.includeArchived || !item.archived)
      && (options.favorite === undefined || item.favorite === options.favorite) && (!options.needsDescription || !item.description.trim())
      && (!options.from || item.createdAt >= Date.parse(options.from)) && (!options.to || item.createdAt <= Date.parse(options.to))
      && (!options.person || item.sources.some(source => source.person === options.person)) && (!options.conversation || item.sources.some(source => source.conversation === options.conversation))
      && (!options.tags?.length || options.tags.every(tag => item.tags.some(saved => normalized(saved) === normalized(tag)))));
    const scored = candidates.map(item => {
      const fields = { title: item.title, description: item.description, tags: item.tags.join(' '), prompt: item.prompt, note: item.note, source: item.sources.map(source => `${source.name ?? ''} ${source.text ?? ''}`).join(' ') };
      const matches = Object.entries(fields).flatMap(([field, text]) => {
        const value = normalized(text), hits = words.filter(word => value.includes(word)).length;
        return query && (value.includes(query) || hits) ? [{ field, score: (value.includes(query) ? 3 : hits / Math.max(1, words.length)) * (field === 'title' || field === 'tags' ? 2 : 1) }] : [];
      });
      return { item, matches: matches.map(match => match.field), lexical: matches.reduce((sum, match) => sum + match.score, 0), semantic: semantic.get(item.id) ?? 0, score: 0 };
    });
    const lexical = scored.filter(row => row.lexical > 0).sort((a, b) => b.lexical - a.lexical);
    const meanings = scored.filter(row => row.semantic > 0).sort((a, b) => b.semantic - a.semantic);
    for (const list of [lexical, meanings]) list.forEach((row, rank) => { row.score += 1 / (60 + rank); });
    const ranked = scored.filter(row => !query || row.score > 0).sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt || a.item.id.localeCompare(b.item.id));
    const offset = options.offset ?? 0, limit = options.limit ?? 5;
    const items = ranked.slice(offset, offset + limit).map(({ item, matches, semantic }) => {
      const uses = this.usage(item.id); const shared = uses.filter(use => use.status === 'success');
      return { id: item.id, title: item.title, description: item.description.slice(0, 300), prompt: item.prompt.slice(0, 200), tags: item.tags, createdAt: item.createdAt, timeSource: item.timeSource,
        favorite: item.favorite, archived: item.archived, deletedAt: item.deletedAt, available: this.available(item), needsDescription: !item.description.trim(), revision: item.revision,
        width: item.width, height: item.height, bytes: item.bytes, matches: [...matches, ...(semantic ? ['meaning'] : [])],
        sources: item.sources.map(({ text: _text, ...source }) => source), lastUsed: shared[0], useCount: shared.length };
    });
    return { items, total: ranked.length, nextOffset: offset + limit < ranked.length ? offset + limit : null };
  }
  stats() {
    const items = this.all().filter(item => !item.deletedAt);
    return { total: items.length, bytes: items.filter(item => this.available(item)).reduce((sum, item) => sum + item.bytes, 0), archived: items.filter(item => item.archived).length,
      missing: items.filter(item => !this.available(item)).length, needsDescription: items.filter(item => !item.description.trim()).length };
  }
  unindexed(model: string) {
    if (!this.exists()) return [];
    const indexed = new Map(this.db.prepare('SELECT drawing_id, content FROM gallery_vectors WHERE model=?').all(model).map(row => [String(row.drawing_id), String(row.content)]));
    return this.all().filter(item => !item.deletedAt && drawingText(item).trim() && indexed.get(item.id) !== drawingText(item));
  }
  saveVector(item: GalleryDrawing, model: string, vector: Float32Array) {
    const latest = this.get(item.id); if (!latest || latest.deletedAt || drawingText(latest) !== drawingText(item)) return;
    const normalized = unit(vector);
    this.db.prepare('INSERT INTO gallery_vectors VALUES (?,?,?,?) ON CONFLICT(drawing_id) DO UPDATE SET model=excluded.model,content=excluded.content,vector=excluded.vector')
      .run(item.id, model, drawingText(item), new Uint8Array(normalized.buffer));
  }
  similar(model: string, query: Float32Array, threshold: number) {
    const scores = new Map<string, number>(); if (!this.exists()) return scores;
    for (const row of this.db.prepare('SELECT * FROM gallery_vectors WHERE model=?').all(model)) {
      const vector = new Float32Array(Uint8Array.from(row.vector as Uint8Array).buffer);
      const score = closestLine([unit(query)], [{ line: '', vector }]).similarity;
      if (score >= threshold) scores.set(String(row.drawing_id), score);
    }
    return scores;
  }
}
