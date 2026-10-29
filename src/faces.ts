import { inflateRawSync } from 'node:zlib';
import type { EnvironmentEvent } from './domain.js';
import type { SocialAdapter } from './snowluma.js';
import type { Store } from './store.js';
import { FACE_CAPTION } from './context.js';
import { publicFetch } from './web.js';

/** A QQ system face as SnowLuma's catalog lists it; url is an archive holding its pictures. */
export interface Face { name: string; url?: string }

/** A face by ID and, when known, name. Larger codes are Unicode emoji. */
export function faceLabel(id: unknown, names: Record<string, string>): string {
  const code = String(id);
  let name = names[code];
  if (!name && Number(code) >= 1000) { try { name = String.fromCodePoint(Number(code)); } catch { /* not a code point */ } }
  return name ? `${code} ${name}` : code;
}
/** Labels a face's picture; folding recognizes it, so view_face is named for seeing it again. */
export const faceCaption = (id: string, names: Record<string, string>) => `${FACE_CAPTION} ${faceLabel(id, names)}, as it looks:`;

/** System faces an event shows: face segments in a message and the emoji of a reaction. */
export function faceIds(event: EnvironmentEvent): string[] {
  const segments = event.kind === 'message' && Array.isArray(event.payload.message) ? event.payload.message as { type?: string; data?: { id?: unknown } }[] : [];
  const likes = Array.isArray(event.payload.likes) ? event.payload.likes as { emoji_id?: unknown }[] : [];
  return [...segments.filter(segment => segment.type === 'face').map(segment => segment.data?.id), ...likes.map(like => like.emoji_id)].map(String).filter(id => /^\d+$/.test(id));
}
/** A copy of an event payload whose faces and reactions carry their names. */
export function nameFaces(payload: Record<string, any>, names: Record<string, string>): Record<string, any> {
  const named = (id: unknown) => names[String(id)];
  return {
    ...payload,
    ...(Array.isArray(payload.message) ? { message: payload.message.map((segment: any) => segment?.type === 'face' && named(segment.data?.id) ? { ...segment, data: { ...segment.data, name: named(segment.data.id) } } : segment) } : {}),
    ...(Array.isArray(payload.likes) ? { likes: payload.likes.map((like: any) => named(like?.emoji_id) ? { ...like, name: named(like.emoji_id) } : like) } : {}),
  };
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
  /** A picture once read, or when it last failed. */
  private pictures = new Map<string, Buffer | number>();
  constructor(private store: Store, private social: SocialAdapter) {}
  /** The catalog is read from SnowLuma once and kept; a failed read is retried later. */
  async load(signal?: AbortSignal): Promise<Record<string, Face>> {
    const known = this.store.faces();
    if (Object.keys(known).length || Date.now() - this.tried < 600_000) return known;
    this.tried = Date.now();
    try {
      const catalog = await this.social.execute('fetch_sys_faces', {}, signal) as { packs?: { emojis?: { q_sid?: unknown; q_des?: unknown; url?: unknown }[] }[] } | null;
      const faces: Record<string, Face> = Object.fromEntries((catalog?.packs ?? []).flatMap(pack => pack.emojis ?? []).filter(face => /^\d+$/.test(String(face.q_sid)) && face.q_des)
        .map(face => [String(face.q_sid), { name: String(face.q_des).replace(/^\//, ''), ...(typeof face.url === 'string' ? { url: face.url } : {}) }]));
      if (Object.keys(faces).length) this.store.setFaces(faces);
      return faces;
    } catch { return known; }
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
      const picture = unzip((await publicFetch(url, { timeoutMs: 5_000, maxBytes: 2_000_000, signal })).data, `${id}/png/${id}.png`);
      if (!picture?.subarray(0, 8).equals(PNG)) throw new Error('The face archive holds no readable picture.');
      this.pictures.set(id, picture);
      return picture;
    } catch (error) { if (!signal?.aborted) this.pictures.set(id, Date.now()); throw error; }
  }
}
