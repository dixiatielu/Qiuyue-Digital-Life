import { Type } from 'typebox';
import type { Config } from '../config.js';
import type { SemanticSource } from '../embedding.js';
import { errorText } from '../domain.js';
import type { LifePlugin } from '../plugins.js';
import type { Store } from '../store.js';
import { DrawingLibrary, drawingIdPattern, drawingText, validateDrawingQuery, type DrawingQuery } from './gallery-store.js';

/** Indexing belongs to this plugin instance; disposal and a failed reload leave no duplicate workers. */
export class GalleryRecall {
  private controller = new AbortController();
  private work?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private paused = false;
  private rejected = new Set<string>();
  constructor(private library: DrawingLibrary, private semantics: SemanticSource, private store: Store, private threshold: number) {}
  index() {
    if (this.paused || this.controller.signal.aborted || this.work) return;
    clearTimeout(this.retry);
    this.work = this.drain().catch(error => {
      if (this.controller.signal.aborted) return;
      this.store.log('recall_error', { stage: 'gallery', message: errorText(error) });
      if (!this.paused) { this.retry = setTimeout(() => this.index(), 60_000); this.retry.unref(); }
    }).finally(() => { this.work = undefined; });
  }
  private async drain() {
    while (!this.paused && !this.controller.signal.aborted) {
      const item = this.library.unindexed(this.semantics.model).find(item => !this.rejected.has(`${item.id}:${drawingText(item)}`));
      if (!item) return;
      try {
        const [vector] = await this.semantics.embed([drawingText(item)], this.controller.signal);
        this.controller.signal.throwIfAborted();
        this.library.saveVector(item, this.semantics.model, vector!);
      } catch (error) {
        if ([400, 413, 422].includes((error as { status?: number }).status ?? 0)) { this.rejected.add(`${item.id}:${drawingText(item)}`); continue; }
        throw error;
      }
    }
  }
  async search(options: DrawingQuery, signal?: AbortSignal) {
    validateDrawingQuery(options);
    if (options.query?.trim()) {
      try {
        const [query] = await this.semantics.embed([options.query], AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]));
        this.controller.signal.throwIfAborted(); signal?.throwIfAborted();
        return { ...this.library.search(options, this.library.similar(this.semantics.model, query!, this.threshold)), retrieval: 'hybrid' };
      } catch (error) {
        this.controller.signal.throwIfAborted(); signal?.throwIfAborted();
        return { ...this.library.search(options), retrieval: 'keywords', semanticUnavailable: true };
      }
    }
    return { ...this.library.search(options), retrieval: 'recent' };
  }
  quiesce() { this.paused = true; clearTimeout(this.retry); return () => { this.paused = false; this.index(); }; }
  async idle() { await this.work; }
  async stop() { this.paused = true; clearTimeout(this.retry); this.controller.abort(); await this.work; }
}

const id = Type.String({ pattern: drawingIdPattern.source, description: 'Permanent drawing:<uuid> ID' });
const tags = Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 });
export function galleryPlugin(config: Config, store: Store, semantics?: SemanticSource): LifePlugin {
  const library = new DrawingLibrary(store.db, config.drawing.dir);
  const recall = semantics ? new GalleryRecall(library, semantics, store, config.embedding.searchThreshold) : undefined;
  let unsubscribe: (() => void) | undefined;
  const changed = (id: string) => { store.log('gallery_changed', { id }); recall?.index(); };
  return {
    id: 'gallery', enabled: () => config.plugins.gallery !== false,
    reviewTools: ['search_drawings', 'view_drawing'],
    tools: runtime => [
      runtime.jsonTool('search_drawings', 'Find your saved images by subject, style, colors, creation prompt, or origin. Search before recreating an old image someone asks for. With no query, browse recent works. Results contain permanent IDs and text, not pictures; use view_drawing to inspect a candidate. Preserve the original social context when deciding where to share it.', Type.Object({
        query: Type.Optional(Type.String({ maxLength: 500 })), from: Type.Optional(Type.String({ description: 'Inclusive ISO time with timezone' })), to: Type.Optional(Type.String({ description: 'Inclusive ISO time with timezone' })),
        person: Type.Optional(Type.String({ description: 'Canonical person reference involved in the creation' })), conversation: Type.Optional(Type.String({ description: 'Canonical conversation reference of the creation' })),
        tags: Type.Optional(tags), favorite: Type.Optional(Type.Boolean()), includeArchived: Type.Optional(Type.Boolean()), needsDescription: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }), async (args, signal) => {
        const result = recall ? await recall.search(args, signal) : { ...library.search(args), retrieval: 'keywords' };
        runtime.check(signal); return result;
      }),
      runtime.tool('view_drawing', 'View one of your saved images, its original prompt, creation context and actual usage outcomes. Works even after its original chat record expires. A prompt says what was requested; only the attached image shows the result. Use its permanent ID in existing message image files, Qzone images or add_custom_face.', Type.Object({ id }), args => {
        const item = library.detail(args.id); if (!item) throw new Error('Drawing does not exist.');
        const detail = { ...item, uses: item.uses.slice(0, 20), totalUses: item.uses.length };
        const picture = library.image(args.id);
        if (!picture) return { content: [{ type: 'text', text: JSON.stringify({ ...detail, message: 'The image is unavailable or deleted; it cannot be viewed or reused.' }) }], details: {} };
        library.markSeen(args.id);
        return { content: [{ type: 'text', text: `Your saved image ${args.id}\n${JSON.stringify(detail)}` }, { type: 'image', data: picture.data.toString('base64'), mimeType: picture.mimeType }], details: {} };
      }),
      runtime.jsonTool('update_drawing', 'Organize one of your images: title it, describe what you actually saw, add tags or a personal note, favorite it, or archive it out of default searches. View it before writing a visual description; do not infer the result from its prompt. This never changes the image or its original prompt. Archived works can be restored with archived:false.', Type.Object({
        id, title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), description: Type.Optional(Type.String({ maxLength: 2000 })), tags: Type.Optional(tags), note: Type.Optional(Type.String({ maxLength: 2000 })),
        favorite: Type.Optional(Type.Boolean()), archived: Type.Optional(Type.Boolean()),
      }), ({ id, ...changes }) => { const item = library.update(id, changes, undefined, true); changed(id); return { id, revision: item.revision }; }),
    ],
    observation: events => events.some(event => event.kind === 'drawing' && event.payload.error === undefined)
      ? ['Your completed images are saved in your gallery. After seeing the actual picture, you may use update_drawing to give it a title, description and tags for finding it later.'] : [],
    // The generator supplies the completion picture while enabled; the gallery can still show old events when it is off.
    images: event => {
      if (event.kind !== 'drawing' || (config.drawing.enabled && config.plugins.drawing !== false)) return [];
      const id = String(event.payload.drawingId);
      return [{ label: `Your saved image ${id}`, unavailable: `Image ${id} is unavailable.`, deferred: `Use view_drawing with id ${id} to see this image.`,
        autoView: event.payload.error === undefined, load: () => library.image(id), onShown: () => library.markSeen(id) }];
    },
    imageViewer: label => { const match = /drawing:[0-9a-f-]{36}/.exec(label); return match ? `view_drawing with id ${match[0]}` : undefined; },
    resolveMedia: value => {
      if (!drawingIdPattern.test(value)) return;
      const picture = library.image(value); if (!picture) throw new Error(`Image ${value} does not exist or has been removed.`);
      return `base64://${picture.data.toString('base64')}`;
    },
    manage: (command, args) => {
      if (typeof args.id !== 'string' || !Number.isSafeInteger(args.revision)) throw new Error('A drawing ID and revision are required.');
      if (command === 'update') { const item = library.update(args.id, args.changes, args.revision); changed(args.id); return item; }
      if (command === 'delete') { const result = library.delete(args.id, args.revision); changed(args.id); return result; }
      throw new Error('Unknown gallery management command.');
    },
    start: async () => {
      library.initialize(); library.recoverDeletions();
      unsubscribe = store.subscribe(notice => { if (notice.kind === 'environment' && notice.event.kind === 'drawing') recall?.index(); });
      recall?.index();
    },
    quiesce: () => recall?.quiesce() ?? (() => {}), idle: async () => { await recall?.idle(); },
    stop: async () => { unsubscribe?.(); await recall?.stop(); },
  };
}
