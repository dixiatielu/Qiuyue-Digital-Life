import { inflateRawSync } from 'node:zlib';
import { Type } from 'typebox';
import type { EnvironmentEvent } from '../domain.js';
import type { SocialAdapter } from '../platform.js';
import type { Store } from '../store.js';
import type { Config } from '../config.js';
import type { LifePlugin } from '../plugins.js';
import type { ThoughtContext } from '../tool-runtime.js';
import { emojiLabel } from '../record.js';
import { publicFetch } from '../web.js';

/** A QQ system face as SnowLuma's catalog lists it; url is an archive holding its pictures. */
export interface Face { name: string; url?: string }

const FACE_CAPTION = 'QQ system face';
/** Labels a face's picture; folding recognizes it, so view_face is named for seeing it again. */
const faceCaption = (id: string, names: Record<string, string>) => `${FACE_CAPTION} ${emojiLabel(id, names)}, as it looks:`;

/** System faces an event shows: face segments in a message and the emoji of a reaction. */
export function faceIds(event: EnvironmentEvent): string[] {
  const segments = event.kind === 'message' && Array.isArray(event.payload.message) ? event.payload.message as { type?: string; data?: { id?: unknown } }[] : [];
  const likes = Array.isArray(event.payload.likes) ? event.payload.likes as { emoji_id?: unknown }[] : [];
  return [...segments.filter(segment => segment.type === 'face').map(segment => segment.data?.id), ...likes.map(like => like.emoji_id)].map(String).filter(id => /^\d+$/.test(id));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** One stored or deflated file from a zip archive. */
export function unzip(archive: Buffer, name: string): Buffer | undefined {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > archive.length) return;
  let at = archive.readUInt32LE(end + 16);
  for (let count = archive.readUInt16LE(end + 10); count > 0 && at + 46 <= archive.length && archive.readUInt32LE(at) === 0x02014b50; count--) {
    const method = archive.readUInt16LE(at + 10), size = archive.readUInt32LE(at + 20), length = archive.readUInt16LE(at + 28);
    if (archive.toString('utf8', at + 46, at + 46 + length) === name) {
      const local = archive.readUInt32LE(at + 42);
      if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) return;
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const data = archive.subarray(start, start + size);
      return method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 5_000_000 }) : undefined;
    }
    at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
}

/** QQ system faces: names, so faces and reactions read as what they are, and pictures, since a name rarely says what a face shows. */
export class FaceCatalog {
  private tried = 0;
  private loading?: Promise<Record<string, Face>>;
  /** A picture once read, or when it last failed. */
  private pictures = new Map<string, Buffer | number>();
  constructor(private store: Store, private social: SocialAdapter, private request = publicFetch) {}
  known(): Record<string, Face> { return this.store.setting('faces', {}); }
  knownNames(): Record<string, string> { return Object.fromEntries(Object.entries(this.known()).map(([id, face]) => [id, face.name])); }
  /** The catalog is read from SnowLuma once and kept; a failed read is retried later. */
  async load(signal?: AbortSignal): Promise<Record<string, Face>> {
    if (this.loading) return this.loading;
    const known = this.known();
    if (Object.keys(known).length || Date.now() - this.tried < 600_000) return known;
    this.tried = Date.now();
    this.loading = this.read(known, signal).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async read(known: Record<string, Face>, signal?: AbortSignal): Promise<Record<string, Face>> {
    try {
      const catalog = await this.social.execute('fetch_sys_faces', {}, signal) as { packs?: { emojis?: { q_sid?: unknown; q_des?: unknown; url?: unknown }[] }[] } | null;
      const faces: Record<string, Face> = Object.fromEntries((catalog?.packs ?? []).flatMap(pack => pack.emojis ?? []).filter(face => /^\d+$/.test(String(face.q_sid)) && face.q_des)
        .map(face => [String(face.q_sid), { name: String(face.q_des).replace(/^\//, ''), ...(typeof face.url === 'string' ? { url: face.url } : {}) }]));
      if (Object.keys(faces).length) this.store.setSetting('faces', faces);
      return faces;
    } catch { if (signal?.aborted) this.tried = 0; return known; }
  }
  async names(signal?: AbortSignal): Promise<Record<string, string>> {
    return Object.fromEntries(Object.entries(await this.load(signal)).map(([id, face]) => [id, face.name]));
  }
  /** The face's still picture, <id>/png/<id>.png in its archive. A failed read is retried after a while, so a thought is not kept waiting on it. */
  async image(id: string, signal?: AbortSignal): Promise<Buffer> {
    const known = this.pictures.get(id);
    if (known instanceof Buffer) return known;
    if (typeof known === 'number' && Date.now() - known < 600_000) throw new Error('The picture of this face could not be read just now; try again later.');
    const url = (await this.load(signal))[id]?.url;
    if (!url) throw new Error('This face is not in the system face catalog, or it has no picture.');
    try {
      const picture = unzip((await this.request(url, { timeoutMs: 5_000, maxBytes: 2_000_000, signal })).data, `${id}/png/${id}.png`);
      if (!picture?.subarray(0, 8).equals(PNG)) throw new Error('The face archive holds no readable picture.');
      this.pictures.set(id, picture);
      return picture;
    } catch (error) { if (!signal?.aborted) this.pictures.set(id, Date.now()); throw error; }
  }
}

export function qqFacesPlugin(config: Config, faces: FaceCatalog): LifePlugin {
  const shown = new WeakMap<ThoughtContext, Set<string>>();
  return {
    id: 'qq-faces', enabled: () => config.plugins['qq-faces'] !== false,
    tools: runtime => [{
      ...runtime.tool('view_face', "See what a QQ system face looks like, by the ID in a face segment, a reaction's emoji_id, or set_group_reaction's code. A face's name often says little about what it shows or how people use it.", Type.Object({ id: Type.String({ description: 'Face ID', pattern: '^\\d{1,6}$' }) }), async (args, signal) => {
        const picture = await faces.image(args.id, signal);
        const names = await faces.names(signal);
        runtime.check(signal);
        return { content: [{ type: 'text', text: faceCaption(args.id, names) }, { type: 'image', data: picture.toString('base64'), mimeType: 'image/png' }], details: {} };
      }),
      insertBefore: 'inspect_actions',
    }],
    reviewTools: ['view_face'],
    emojiNames: (events, signal) => events === undefined || events.some(event => faceIds(event).length || event.kind === 'rest_backlog') ? faces.names(signal) : {},
    knownEmojiNames: () => faces.knownNames(),
    supplementalImages: (events, thought) => {
      const seen = shown.get(thought) ?? new Set<string>(); shown.set(thought, seen);
      const names = faces.knownNames();
      return [...new Set(events.flatMap(faceIds))].filter(id => names[id] && !seen.has(id)).map(id => ({
        label: faceCaption(id, names), unavailable: '', deferred: '', autoView: true,
        load: async signal => ({ data: await faces.image(id, signal), mimeType: 'image/png' }),
        onShown: () => { seen.add(id); },
      }));
    },
    imageViewer: label => label.startsWith(FACE_CAPTION) ? 'view_face' : undefined,
  };
}
