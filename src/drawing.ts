import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { errorText } from './domain.js';
import type { Store } from './store.js';

/** Paints one picture from a description. */
export interface Painter { readonly model: string; paint(prompt: string, signal?: AbortSignal): Promise<Buffer> }

/** An OpenAI-compatible /images/generations endpoint. A gateway may ignore size, quality, and format, so the endpoint's defaults are taken as they come. */
export class ImageClient implements Painter {
  constructor(private config: Config['drawing'], private request: typeof fetch = fetch) {}
  get model() { return this.config.model; }
  async paint(prompt: string, signal?: AbortSignal): Promise<Buffer> {
    const key = process.env[this.config.apiKeyEnv];
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
type UnderWay = Record<string, { prompt: string; startedAt: number }>;

/**
 * Drawings (ADR-0018): each is painted apart from the thought that started it, since painting takes half a minute or more, and comes back
 * as a drawing event with the picture. Its file is kept, and its ID, drawing:<uuid>, stands for it wherever an image file goes.
 */
export class Drawings {
  private running = new Map<string, AbortController>();
  private work = new Set<Promise<void>>();
  private stopping = false;
  constructor(private store: Store, private painter: Painter, private dir: string, private retentionDays: number) {}
  start(prompt: string, sources: string[]) {
    if (this.stopping) throw new Error('The program is shutting down; drawing is unavailable.');
    const id = `drawing:${crypto.randomUUID()}`; const startedAt = Date.now();
    // Kept until it finishes, so a drawing a restart cut short is reported rather than awaited forever.
    this.store.setSetting('drawingsUnderWay', { ...this.store.setting<UnderWay>('drawingsUnderWay'), [id]: { prompt, startedAt } });
    const controller = new AbortController(); this.running.set(id, controller);
    const work = this.paint(id, prompt, startedAt, sources, controller.signal).finally(() => { this.running.delete(id); this.work.delete(work); });
    this.work.add(work);
    return { drawingId: id, status: 'drawing' };
  }
  private async paint(id: string, prompt: string, startedAt: number, sources: string[], signal: AbortSignal) {
    let failure: string | undefined;
    try {
      const data = await this.painter.paint(prompt, signal);
      const type = imageType(data);
      if (!type) throw new Error('The image endpoint returned data that is not a PNG, JPEG, or WebP image.');
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${drawingId.exec(id)![1]}.${extensions[type]}`), data);
    } catch (error) {
      // Cut short by shutdown, it stays under way and is reported at the next start.
      if (this.stopping) return;
      failure = errorText(error);
    }
    this.store.transaction(() => {
      const { [id]: _done, ...rest } = this.store.setting<UnderWay>('drawingsUnderWay');
      this.store.setSetting('drawingsUnderWay', rest);
      this.finish(id, prompt, startedAt, sources, failure);
    });
  }
  private finish(id: string, prompt: string, startedAt: number, sources: string[], failure?: string) {
    const text = failure === undefined
      ? `Your drawing ${id} is finished; it follows as an image. Its description was: ${prompt}\nTo send or use it, put ${id} where an image file goes: the file of an image segment in send_group_msg or send_private_msg, an entry of images in send_qzone_msg, or the file of add_custom_face.`
      : `Your drawing ${id} could not be finished: ${failure}\nIts description was: ${prompt}`;
    this.store.receive({ key: id, kind: 'drawing', at: Date.now(), text, payload: { drawingId: id, prompt, startedAt, sources, ...(failure !== undefined ? { error: failure } : {}) } });
  }
  /** Report drawings a restart cut short, and remove files older than retention, whose events are gone. */
  recover() {
    const underWay = this.store.setting<UnderWay>('drawingsUnderWay');
    this.store.transaction(() => {
      for (const [id, { prompt, startedAt }] of Object.entries(underWay)) this.finish(id, prompt, startedAt, [], 'The program restarted while it was being painted.');
      this.store.setSetting('drawingsUnderWay', {});
    });
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return; }
    const before = Date.now() - this.retentionDays * 86_400_000;
    for (const name of names) { const path = join(this.dir, name); if (statSync(path).mtimeMs < before) rmSync(path, { force: true }); }
  }
  image(id: string): { data: Buffer; mimeType: string } | undefined {
    const uuid = drawingId.exec(id)?.[1];
    if (!uuid) return;
    for (const [mimeType, extension] of Object.entries(extensions)) {
      try { return { data: readFileSync(join(this.dir, `${uuid}.${extension}`)), mimeType }; } catch {}
    }
  }
  /** Arguments as sent: every drawing ID among them becomes its picture as base64:// data, which SnowLuma accepts wherever it takes an image file. */
  resolve(value: unknown): unknown {
    if (typeof value === 'string') {
      if (!drawingId.test(value)) return value;
      const picture = this.image(value);
      if (!picture) throw new Error(`Drawing ${value} does not exist or has been removed.`);
      return `base64://${picture.data.toString('base64')}`;
    }
    if (Array.isArray(value)) return value.map(item => this.resolve(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolve(item)]));
    return value;
  }
  async stop() { this.stopping = true; for (const controller of this.running.values()) controller.abort(); await Promise.allSettled(this.work); }
}
