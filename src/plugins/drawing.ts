import { environmentCredential, type CredentialReader } from '../credentials.js';
import sharp from 'sharp';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { errorText } from '../domain.js';
import { eventRef, type Store } from '../store.js';
import type { LifePlugin } from '../plugins.js';
import type { ToolRuntime } from '../tool-runtime.js';
import { ui } from '../ui-language.js';
import { DrawingLibrary, drawingIdPattern, resolveDrawingMedia, type DrawingReference, type DrawingSource } from './gallery-store.js';

export const MAX_REFERENCE_IMAGES = 5;
export interface ReferenceImageData { data: Buffer; mimeType: string; filename?: string }
export interface PaintOptions { images?: ReferenceImageData[]; transparentBackground?: boolean }
export interface PreparedReference {
  reference: DrawingReference;
  load(signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string }> | { data: Buffer; mimeType: string };
}

/** Generates one image from a description, optionally guided by reference images. */
export interface Painter { readonly model: string; paint(prompt: string, signal?: AbortSignal, options?: PaintOptions): Promise<Buffer> }

/** An OpenAI-compatible /images/generations and /images/edits endpoint. A gateway may ignore optional parameters, so only what is needed is sent. */
export class ImageClient implements Painter {
  constructor(private config: Config['drawing'], private request: typeof fetch = fetch, private credential: CredentialReader = environmentCredential) {}
  get model() { return this.config.model; }
  async paint(prompt: string, signal?: AbortSignal, options?: PaintOptions): Promise<Buffer> {
    const key = this.credential(this.config.apiKeyEnv);
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const timeout = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]);
    const images = options?.images ?? [];
    let response: Response;
    if (images.length) {
      const form = new FormData();
      form.append('model', this.config.model);
      form.append('prompt', prompt);
      form.append('n', '1');
      if (options?.transparentBackground) form.append('background', 'transparent');
      // OpenAI's /images/edits takes `image` for one file and `image[]` for multiple files.
      const field = images.length === 1 ? 'image' : 'image[]';
      images.forEach((image, index) => {
        const ext = extensions[image.mimeType] ?? 'png';
        form.append(field, new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.filename ?? `reference-${index + 1}.${ext}`);
      });
      response = await this.request(`${base}/images/edits`, {
        method: 'POST',
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        body: form,
        signal: timeout,
      });
    } else {
      response = await this.request(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: this.config.model, prompt, n: 1, ...(options?.transparentBackground ? { background: 'transparent' } : {}) }),
        signal: timeout,
      });
    }
    if (!response.ok) {
      // A refusal by the endpoint's safety system says why in error.message, which she needs to understand it.
      const reason = await response.json().then((body: { error?: { message?: unknown } } | null) => body?.error?.message, () => undefined);
      throw new Error(`The image request failed: HTTP ${response.status}${typeof reason === 'string' && reason ? `: ${reason.slice(0, 500)}` : '.'}`);
    }
    const body = await response.json() as { data?: { b64_json?: unknown }[] } | null;
    const data = body?.data?.[0]?.b64_json;
    if (typeof data !== 'string' || !data) throw new Error('The image response has no image data.');
    return Buffer.from(data, 'base64');
  }
}

const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** What the bytes are, from their signature; an endpoint's stated format is not always what it sends. */
export function imageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
}
function isGif(data: Buffer): boolean {
  const header = data.subarray(0, 6).toString('latin1');
  return header === 'GIF87a' || header === 'GIF89a';
}
/** Normalize a reference image to PNG/JPEG/WebP accepted by /images/edits; GIF stickers are converted from their first frame to PNG. */
export async function prepareReferenceImage(data: Buffer, index = 0): Promise<ReferenceImageData> {
  const detected = imageType(data);
  if (detected) return { data, mimeType: detected, filename: `reference-${index + 1}.${extensions[detected]!}` };
  if (isGif(data)) {
    const png = await sharp(data, { limitInputPixels: 80_000_000 }).png().toBuffer();
    return { data: png, mimeType: 'image/png', filename: `reference-${index + 1}.png` };
  }
  throw new Error(`Reference image ${index + 1} is not a supported PNG, JPEG, WebP, or GIF image.`);
}
function formatReference(ref: DrawingReference, index: number): string {
  const target = ref.drawingId ? ref.drawingId : ref.url !== undefined ? `${ref.url} from ${eventRef(ref.eventId!)}` : `image ${ref.index} from ${eventRef(ref.eventId!)}`;
  return `Image ${index + 1}: ${target}`;
}
type UnderWay = Record<string, { prompt: string; startedAt: number; model: string; sources: string[]; context: DrawingSource[]; references?: DrawingReference[]; transparentBackground?: boolean }>;

/**
 * Generated images (ADR-0018): each is generated apart from the thought that started it, since generation takes half a minute or more,
 * and comes back as a drawing event with the picture. Its file is kept, and its ID, drawing:<uuid>, stands for it wherever an image file goes.
 */
export class Drawings {
  private running = new Map<string, AbortController>();
  private work = new Set<Promise<void>>();
  private stopping = false;
  private library: DrawingLibrary;
  constructor(private store: Store, private painter: Painter, dir: string) { this.library = new DrawingLibrary(store.db, dir); }
  start(prompt: string, sources: string[], options?: { references?: PreparedReference[]; transparentBackground?: boolean }) {
    if (this.stopping) throw new Error('The program is shutting down; image generation is unavailable.');
    const prepared = options?.references ?? [];
    if (prepared.length > MAX_REFERENCE_IMAGES) throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images may be included.`);
    const transparentBackground = options?.transparentBackground === true ? true : undefined;
    const references = prepared.length ? prepared.map(item => item.reference) : undefined;
    const uniqueSources = [...new Set(sources)];
    const id = `drawing:${crypto.randomUUID()}`; const startedAt = Date.now();
    const context = this.library.sources(uniqueSources);
    // Kept until it finishes, so a drawing a restart cut short is reported rather than awaited forever.
    this.store.setSetting('drawingsUnderWay', {
      ...this.store.setting<UnderWay>('drawingsUnderWay', {}),
      [id]: { prompt, startedAt, model: this.painter.model, sources: uniqueSources, context, ...(references ? { references } : {}), ...(transparentBackground ? { transparentBackground } : {}) },
    });
    const controller = new AbortController(); this.running.set(id, controller);
    const work = this.paint(id, prompt, startedAt, uniqueSources, context, prepared, transparentBackground, controller.signal).finally(() => { this.running.delete(id); this.work.delete(work); });
    this.work.add(work);
    return { drawingId: id, status: 'drawing', ...(references ? { referenceCount: references.length } : {}), ...(transparentBackground ? { transparentBackground } : {}) };
  }
  private async paint(id: string, prompt: string, startedAt: number, sources: string[], context: DrawingSource[], prepared: PreparedReference[], transparentBackground: boolean | undefined, signal: AbortSignal) {
    const references = prepared.length ? prepared.map(item => item.reference) : undefined;
    let failure: string | undefined;
    try {
      const images: ReferenceImageData[] = [];
      for (const [index, item] of prepared.entries()) {
        signal.throwIfAborted();
        try {
          const loaded = await item.load(signal);
          signal.throwIfAborted();
          images.push(await prepareReferenceImage(loaded.data, index));
        } catch (error) {
          if (this.stopping) return;
          throw new Error(`Could not load reference image ${index + 1}: ${errorText(error)}`);
        }
      }
      const paintOptions: PaintOptions | undefined = images.length || transparentBackground
        ? { ...(images.length ? { images } : {}), ...(transparentBackground ? { transparentBackground } : {}) }
        : undefined;
      const data = await this.painter.paint(prompt, signal, paintOptions);
      const type = imageType(data);
      if (!type) throw new Error('The image endpoint returned data that is not a PNG, JPEG, or WebP image.');
      await this.library.save(id, data, extensions[type]!, {
        prompt, model: this.painter.model, createdAt: Date.now(), sources: context,
        ...(references ? { references } : {}), ...(transparentBackground ? { transparentBackground } : {}),
      });
    } catch (error) {
      // Cut short by shutdown, it stays under way and is reported at the next start.
      if (this.stopping) return;
      failure = errorText(error);
    }
    this.store.transaction(() => {
      const { [id]: _done, ...rest } = this.store.setting<UnderWay>('drawingsUnderWay', {});
      this.store.setSetting('drawingsUnderWay', rest);
      this.finish(id, prompt, startedAt, sources, failure, references, transparentBackground);
    });
  }
  private finish(id: string, prompt: string, startedAt: number, sources: string[], failure?: string, references?: DrawingReference[], transparentBackground?: boolean) {
    const refLine = references?.length ? `\nReferenced images: ${references.map(formatReference).join('; ')}` : '';
    const text = failure === undefined
      ? `Your generated image ${id} is ready; it follows as an image. Its description was: ${prompt}${refLine}\nTo send or use it, put ${id} where an image file goes: the file of an image segment in send_group_msg or send_private_msg, an entry of images in send_qzone_msg, or the file of add_custom_face.`
      : `Your image ${id} could not be generated: ${failure}\nIts description was: ${prompt}${refLine}`;
    this.store.receive({
      key: id, kind: 'drawing', at: Date.now(), text,
      payload: {
        origin: 'self', drawingId: id, prompt, model: this.library.get(id)?.model, startedAt, sources,
        ...(references?.length ? { references } : {}), ...(transparentBackground ? { transparentBackground } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
      },
    });
  }
  /** Keep completed images across event retention, and reconcile interrupted work with durable files. */
  async recover() {
    this.library.initialize();
    const underWay = this.store.setting<UnderWay>('drawingsUnderWay', {});
    for (const [id, item] of Object.entries(underWay)) await this.library.recoverGeneration(id, {
      prompt: item.prompt, model: item.model, createdAt: item.startedAt, sources: item.context,
      ...(item.references?.length ? { references: item.references } : {}),
      ...(item.transparentBackground ? { transparentBackground: true } : {}),
    });
    this.store.transaction(() => {
      for (const [id, { prompt, startedAt, sources, references, transparentBackground }] of Object.entries(underWay)) {
        this.finish(id, prompt, startedAt, sources, this.library.image(id) ? undefined : 'The program restarted while the image was being generated.', references, transparentBackground);
      }
      this.store.setSetting('drawingsUnderWay', {});
    });
  }
  image(id: string) { return this.library.image(id); }
  media(id: string) { return this.library.media(id); }
  markSeen(id: string) { this.library.markSeen(id); }
  async stop() { this.stopping = true; for (const controller of this.running.values()) controller.abort(); await Promise.allSettled(this.work); }
  async idle() { await Promise.allSettled(this.work); }
}

function resolveReferences(
  drawings: Drawings,
  runtime: ToolRuntime,
  items: { drawingId?: string; event?: string; index?: number; url?: string }[] | undefined,
): { prepared: PreparedReference[]; eventIds: string[] } {
  if (!items?.length) return { prepared: [], eventIds: [] };
  if (items.length > MAX_REFERENCE_IMAGES) throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images may be included.`);
  const prepared: PreparedReference[] = [];
  const eventIds: string[] = [];
  for (const [i, item] of items.entries()) {
    const hasDrawing = item.drawingId !== undefined;
    const hasEvent = item.event !== undefined || item.index !== undefined || item.url !== undefined;
    if (hasDrawing === hasEvent) throw new Error(`Reference image ${i + 1} must specify either drawingId or event (with index or url), not both.`);
    if (hasDrawing) {
      const id = item.drawingId!;
      if (!drawingIdPattern.test(id)) throw new Error(`Reference image ${i + 1} has an invalid drawingId.`);
      const picture = drawings.image(id);
      if (!picture) throw new Error(`Image ${id} does not exist or has been removed.`);
      prepared.push({ reference: { drawingId: id }, load: () => picture });
    } else {
      if (!item.event) throw new Error(`Reference image ${i + 1} needs an event ID when using index or url.`);
      const resolved = runtime.resolveEventImage({ id: item.event, index: item.index, url: item.url });
      if (resolved.event.kind === 'drawing' && item.index === 0) {
        const refDrawingId = String(resolved.event.payload.drawingId ?? '');
        if (!drawings.image(refDrawingId)) throw new Error(resolved.unavailable);
      }
      eventIds.push(resolved.event.id);
      prepared.push({
        reference: item.url !== undefined
          ? { eventId: resolved.event.id, url: resolved.url! }
          : { eventId: resolved.event.id, index: item.index! },
        load: signal => resolved.load(signal),
      });
    }
  }
  return { prepared, eventIds };
}

const referenceImage = Type.Object({
  drawingId: Type.Optional(Type.String({ pattern: drawingIdPattern.source, description: 'Permanent drawing:<uuid> ID of one of your saved gallery images' })),
  event: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Event ID or #xxxxxxxx ref containing the image (same as view_event_image)' })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: 'Image index (starting at 0) in event, for a message image or drawing event' })),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Exact image URL present in event, such as a Qzone post, note, or sticker detail' })),
});

export function drawingEnabled(config: Config) { return config.drawing.enabled && config.plugins.drawing !== false; }
export function drawingCredentialProblems(config: Config, credential: CredentialReader = environmentCredential): string[] {
  return drawingEnabled(config) && !credential(config.drawing.apiKeyEnv)
    ? [ui(`Missing ${config.drawing.apiKeyEnv} for image generation.`, `缺少图像生成所需的 ${config.drawing.apiKeyEnv}。`)] : [];
}
export function drawingPlugin(drawings: Drawings, enabled: () => boolean = () => true): LifePlugin {
  return {
    id: 'drawing', enabled,
    tools: runtime => [runtime.jsonTool(
      'imagen',
      "Generate a new image from a text description, or edit or create a new image using reference images (photorealistic photos, illustrations, stickers, diagrams, etc.): something you want to create, or what someone asked for if you want to. Generation takes half a minute or more, so this returns at once and the finished image comes to you later as a drawing observation with its picture; carry on meanwhile. Omit images to generate from scratch; pass images (up to 5, in order as Image 1, Image 2, ...) to edit an image, transfer its style, combine references, or generate a new image inspired by them. Each reference can be one of your saved gallery images (drawingId) or an image from any event you can view (event with index or exact url, as in view_event_image). View an image with view_event_image or view_drawing before referencing it if you have not seen it yet. The image generator sees only your prompt and the images you pass here—not your conversation—so describe subject, composition, style, lighting, colors, and any text in full; when referencing or editing images, name each image's role (Image 1, Image 2, ...) and state clearly what to keep and what to change. Set transparent_background true only when transparency is needed (such as stickers or cutouts). Once you have seen the finished picture, send or use it by putting its returned drawing ID where an image file goes.",
      Type.Object({
        prompt: Type.String({ description: 'A complete description of the image to generate, or clear editing/reference instructions naming Image 1, Image 2, ... and stating what to keep and what to change', minLength: 1, maxLength: 4000 }),
        images: Type.Optional(Type.Array(referenceImage, { maxItems: MAX_REFERENCE_IMAGES, description: 'Optional reference images (up to 5, ordered as Image 1, Image 2, ...) for editing, style transfer, composition, or generating a new image from references. Omit for text-to-image. Each item specifies either drawingId or event with exactly one of index or url.' })),
        transparent_background: Type.Optional(Type.Boolean({ description: 'Set true only when a transparent background is needed (such as stickers, cutouts, or icons); omit or set false otherwise. For edits, existing transparency is preserved unless requested otherwise.' })),
      }),
      args => {
        const { prepared, eventIds } = resolveReferences(drawings, runtime, args.images);
        for (const eventId of eventIds) runtime.context().sources.add(eventId);
        return drawings.start(args.prompt, [...runtime.context().triggers, ...eventIds], {
          ...(prepared.length ? { references: prepared } : {}),
          ...(args.transparent_background ? { transparentBackground: true } : {}),
        });
      },
    )],
    activities: [{ activity: 'Generate or edit an image', tools: ['imagen'], instructions: 'You can create an image from scratch, or edit or build on your own gallery works or pictures from your chats and feeds, on your own initiative or when someone asks if you want to. Generation runs in the background and the result arrives as an observation. See the finished picture before deciding whether to share it, post it, or keep it for yourself.' }],
    experienceKinds: { imagen: 'drawing' },
    images: event => {
      if (event.kind !== 'drawing') return [];
      const id = String(event.payload.drawingId); const ref = eventRef(event.id);
      return [{ label: `The following is your generated image ${id} from ${ref}`, unavailable: `There is no picture, or its file has been removed: ${id}.`, deferred: `Your generated image ${id} from ${ref} was not loaded due to the context limit; use view_event_image with index 0 to view it.`, autoView: event.payload.error === undefined, load: () => drawings.image(id), onShown: () => drawings.markSeen(id) }];
    },
    resolveMedia: value => resolveDrawingMedia(drawings, value),
    start: () => drawings.recover(), stop: () => drawings.stop(), idle: () => drawings.idle(),
  };
}
