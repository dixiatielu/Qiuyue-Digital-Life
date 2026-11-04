import { environmentCredential, type CredentialReader } from '../credentials.js';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { errorText } from '../domain.js';
import { eventRef, type Store } from '../store.js';
import type { LifePlugin } from '../plugins.js';
import { ui } from '../ui-language.js';
import { DrawingLibrary, type DrawingSource } from './gallery-store.js';

/** Generates one image from a description. */
export interface Painter { readonly model: string; paint(prompt: string, signal?: AbortSignal): Promise<Buffer> }

/** An OpenAI-compatible /images/generations endpoint. A gateway may ignore size, quality, and format, so the endpoint's defaults are taken as they come. */
export class ImageClient implements Painter {
  constructor(private config: Config['drawing'], private request: typeof fetch = fetch, private credential: CredentialReader = environmentCredential) {}
  get model() { return this.config.model; }
  async paint(prompt: string, signal?: AbortSignal): Promise<Buffer> {
    const key = this.credential(this.config.apiKeyEnv);
    const response = await this.request(`${this.config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.config.model, prompt, n: 1 }),
      signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]),
    });
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
const drawingId = /^drawing:([0-9a-f-]{36})$/;
type UnderWay = Record<string, { prompt: string; startedAt: number; model: string; sources: string[]; context: DrawingSource[] }>;

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
  start(prompt: string, sources: string[]) {
    if (this.stopping) throw new Error('The program is shutting down; image generation is unavailable.');
    const id = `drawing:${crypto.randomUUID()}`; const startedAt = Date.now();
    const context = this.library.sources(sources);
    // Kept until it finishes, so a drawing a restart cut short is reported rather than awaited forever.
    this.store.setSetting('drawingsUnderWay', { ...this.store.setting<UnderWay>('drawingsUnderWay', {}), [id]: { prompt, startedAt, model: this.painter.model, sources, context } });
    const controller = new AbortController(); this.running.set(id, controller);
    const work = this.paint(id, prompt, startedAt, sources, context, controller.signal).finally(() => { this.running.delete(id); this.work.delete(work); });
    this.work.add(work);
    return { drawingId: id, status: 'drawing' };
  }
  private async paint(id: string, prompt: string, startedAt: number, sources: string[], context: DrawingSource[], signal: AbortSignal) {
    let failure: string | undefined;
    try {
      const data = await this.painter.paint(prompt, signal);
      const type = imageType(data);
      if (!type) throw new Error('The image endpoint returned data that is not a PNG, JPEG, or WebP image.');
      await this.library.save(id, data, extensions[type]!, { prompt, model: this.painter.model, createdAt: Date.now(), sources: context });
    } catch (error) {
      // Cut short by shutdown, it stays under way and is reported at the next start.
      if (this.stopping) return;
      failure = errorText(error);
    }
    this.store.transaction(() => {
      const { [id]: _done, ...rest } = this.store.setting<UnderWay>('drawingsUnderWay', {});
      this.store.setSetting('drawingsUnderWay', rest);
      this.finish(id, prompt, startedAt, sources, failure);
    });
  }
  private finish(id: string, prompt: string, startedAt: number, sources: string[], failure?: string) {
    const text = failure === undefined
      ? `Your generated image ${id} is ready; it follows as an image. Its description was: ${prompt}\nTo send or use it, put ${id} where an image file goes: the file of an image segment in send_group_msg or send_private_msg, an entry of images in send_qzone_msg, or the file of add_custom_face.`
      : `Your image ${id} could not be generated: ${failure}\nIts description was: ${prompt}`;
    this.store.receive({ key: id, kind: 'drawing', at: Date.now(), text, payload: { origin: 'self', drawingId: id, prompt, model: this.library.get(id)?.model, startedAt, sources, ...(failure !== undefined ? { error: failure } : {}) } });
  }
  /** Keep completed images across event retention, and reconcile interrupted work with durable files. */
  async recover() {
    this.library.initialize();
    const underWay = this.store.setting<UnderWay>('drawingsUnderWay', {});
    for (const [id, item] of Object.entries(underWay)) await this.library.recoverGeneration(id, {
      prompt: item.prompt, model: item.model, createdAt: item.startedAt, sources: item.context,
    });
    this.store.transaction(() => {
      for (const [id, { prompt, startedAt, sources }] of Object.entries(underWay)) this.finish(id, prompt, startedAt, sources, this.library.image(id) ? undefined : 'The program restarted while the image was being generated.');
      this.store.setSetting('drawingsUnderWay', {});
    });
  }
  image(id: string) { return this.library.image(id); }
  markSeen(id: string) { this.library.markSeen(id); }
  async stop() { this.stopping = true; for (const controller of this.running.values()) controller.abort(); await Promise.allSettled(this.work); }
  async idle() { await Promise.allSettled(this.work); }
}

export function drawingEnabled(config: Config) { return config.drawing.enabled && config.plugins.drawing !== false; }
export function drawingCredentialProblems(config: Config, credential: CredentialReader = environmentCredential): string[] {
  return drawingEnabled(config) && !credential(config.drawing.apiKeyEnv)
    ? [ui(`Missing ${config.drawing.apiKeyEnv} for image generation.`, `缺少图像生成所需的 ${config.drawing.apiKeyEnv}。`)] : [];
}
export function drawingPlugin(drawings: Drawings, enabled: () => boolean = () => true): LifePlugin {
  return {
    id: 'drawing', enabled,
    tools: runtime => [runtime.jsonTool('imagen', "Generate an image from a text description, including photorealistic photos, illustrations, stickers, diagrams, or other images: something you want to create, or what someone asked for if you want to. Generation takes half a minute or more, so this returns at once and the generated image comes to you later as a drawing observation with its picture; carry on meanwhile. The image generator sees only this description, not your conversation or reference images, so describe the subject, composition, visual style, lighting, colors, and any text in full. Once you have seen it, send or use it by putting its returned drawing ID where an image file goes.", Type.Object({ prompt: Type.String({ description: 'A complete description of the image to generate, including its visual style (such as photorealistic or illustrated)', minLength: 1, maxLength: 4000 }) }), args => drawings.start(args.prompt, [...runtime.context().triggers]))],
    activities: [{ activity: 'Generate an image', tools: ['imagen'], instructions: 'You can draw something of your own choosing, or accept a request if you want to. Generation runs in the background and the result arrives as an observation. See the finished picture before deciding whether to share it, post it, or keep it for yourself.' }],
    experienceKinds: { imagen: 'drawing' },
    images: event => {
      if (event.kind !== 'drawing') return [];
      const id = String(event.payload.drawingId); const ref = eventRef(event.id);
      return [{ label: `The following is your generated image ${id} from ${ref}`, unavailable: `There is no picture, or its file has been removed: ${id}.`, deferred: `Your generated image ${id} from ${ref} was not loaded due to the context limit; use view_event_image with index 0 to view it.`, autoView: event.payload.error === undefined, load: () => drawings.image(id), onShown: () => drawings.markSeen(id) }];
    },
    resolveMedia: value => {
      if (!drawingId.test(value)) return;
      const picture = drawings.image(value);
      if (!picture) throw new Error(`Image ${value} does not exist or has been removed.`);
      return `base64://${picture.data.toString('base64')}`;
    },
    start: () => drawings.recover(), stop: () => drawings.stop(), idle: () => drawings.idle(),
  };
}
