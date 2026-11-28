import { constants, inflateSync } from 'node:zlib';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/** What a model may take in beyond text and images, in the names a model's `input` declares them by. */
export const MEDIA_MODALITIES = ['audio', 'video', 'pdf'] as const;
export type MediaModality = typeof MEDIA_MODALITIES[number];
export type InputModality = 'text' | 'image' | MediaModality;
export const INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', ...MEDIA_MODALITIES];

/**
 * Audio, video, or a document the model is to hear, watch, or read for itself (ADR-0029). It stays in the working
 * context while the thought that perceives it runs and is folded like an image when the thought ends.
 */
export interface MediaContent {
  type: 'media';
  mimeType: string;
  /** Base64, as an image's bytes are. */
  data: string;
  /** Playing time of audio or video. */
  seconds?: number;
  /** Pages of a document. */
  pages?: number;
}
/** What an observation or a tool result may hold. */
export type ContentBlock = TextContent | ImageContent | MediaContent;

export function isMedia(block: unknown): block is MediaContent {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'media';
}

/** The media among a message's content, whose declared type in Pi's messages knows only text and images. */
export const mediaIn = (content: readonly unknown[]): MediaContent[] => content.filter(isMedia);

/** The modality a model must take to perceive this type, or none when no model is handed it as it is. */
export function mediaModality(mimeType: string): MediaModality | undefined {
  const type = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  return type.startsWith('audio/') ? 'audio' : type.startsWith('video/') ? 'video' : type === 'application/pdf' ? 'pdf' : undefined;
}

const nouns: Record<MediaModality, string> = { audio: 'audio', video: 'video', pdf: 'document' };
const mediaNoun = (block: MediaContent) => { const modality = mediaModality(block.mimeType); return modality ? nouns[modality] : `file (${block.mimeType})`; };

/** A few words for what a media block was, for the note that replaces it: `12s audio`, `3-page document`. */
export function describeMedia(block: MediaContent): string {
  const noun = mediaNoun(block); const modality = mediaModality(block.mimeType);
  if (block.seconds !== undefined && (modality === 'audio' || modality === 'video')) return `${Math.max(1, Math.round(block.seconds))}s ${noun}`;
  if (block.pages !== undefined && modality === 'pdf') return `${block.pages}-page ${noun}`;
  return noun;
}

const AUDIO_TOKENS_PER_SECOND = 32;
/** A frame a second at the default resolution, with the audio track. */
const VIDEO_TOKENS_PER_SECOND = 100;
/** A page of text: the page as an image and the words on it. A nearly blank page costs about half. */
const DOCUMENT_TOKENS_PER_PAGE = 1100;

/**
 * What a media block costs the context. Gemini bills audio and video by the second and a document by the page, never
 * by size, so whoever attaches media should say how long it is; without that the size stands in at a bitrate typical
 * of chat media. The measured usage of a request corrects the estimate afterwards.
 */
export function mediaTokens(block: MediaContent): number {
  const bytes = block.data.length * 0.75;
  const modality = mediaModality(block.mimeType);
  if (modality === 'audio') return Math.ceil((block.seconds ?? bytes / 4_000) * AUDIO_TOKENS_PER_SECOND) + 8;
  if (modality === 'video') return Math.ceil((block.seconds ?? bytes / 62_500) * VIDEO_TOKENS_PER_SECOND) + 8;
  return Math.ceil(block.pages ?? Math.max(1, bytes / 100_000)) * DOCUMENT_TOKENS_PER_PAGE + 8;
}

/** How a transport is handed a media block: disguised as the inline data an image is, or as it stands for a transport of ours. */
export type MediaCarriage = 'inline' | 'native';

/** What the model reads in place of media it cannot take, in the words Pi uses for an image a model cannot see. */
export function mediaPlaceholder(block: MediaContent): TextContent {
  const modality = mediaModality(block.mimeType);
  return { type: 'text', text: `(${describeMedia(block)} omitted: model does not support ${modality ? nouns[modality] : 'this file type'})` };
}

/**
 * Messages as one model's transport takes them. Media the model takes goes the way its transport carries it; the rest
 * becomes a line of text, so a context that holds media can be sent to any model.
 */
export function outboundMessages<T extends { role: string; content?: unknown }>(messages: T[], carriage: (modality: MediaModality) => MediaCarriage | undefined): T[] {
  let changed = false;
  const outbound = messages.map(message => {
    if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content) || !message.content.some(isMedia)) return message;
    const content = (message.content as unknown[]).map(block => {
      if (!isMedia(block)) return block;
      const modality = mediaModality(block.mimeType);
      const how = modality && carriage(modality);
      if (how === 'native') return block;
      changed = true;
      return how === 'inline' ? { type: 'image' as const, data: block.data, mimeType: block.mimeType } : mediaPlaceholder(block);
    });
    return { ...message, content };
  });
  return changed ? outbound : messages;
}

/** Whether a line of text is the label of media attached from an event, which `view_event_media` can bring back. */
export const EVENT_MEDIA_VIEWER = 'view_event_media';
const eventMediaLabel = /^(?:The following is )?(?:voice|audio|video|document) \d+ from /i;
export const labelsEventMedia = (text: string) => eventMediaLabel.test(text);

const MP3_KBPS = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MP3_HZ = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] } as const;
/** A Layer III frame header at this offset: its bit rate and the length of its frame. */
function mp3Frame(data: Uint8Array, at: number): { kbps: number; length: number } | undefined {
  if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1]! & 0xe0) !== 0xe0) return;
  const version = data[at + 1]! >> 3 & 3; const layer = data[at + 1]! >> 1 & 3; const rate = data[at + 2]! >> 4; const hz = data[at + 2]! >> 2 & 3;
  // MPEG-1 is 3, MPEG-2 is 2 and MPEG-2.5 is 0; the other bit patterns are not a frame header.
  if (version === 1 || layer !== 1 || rate === 0 || rate === 15 || hz === 3) return;
  const kbps = MP3_KBPS[version === 3 ? 1 : 2][rate]!;
  return { kbps, length: Math.floor((version === 3 ? 144_000 : 72_000) * kbps / MP3_HZ[version as 0 | 2 | 3][hz]!) + (data[at + 2]! >> 1 & 1) };
}
/** Playing time of an MP3 from its bit rate. A transcoder writes a constant rate; a variable one makes this a rough figure. */
export function mp3Seconds(data: Uint8Array): number | undefined {
  // An ID3v2 tag, where there is one, comes before the first frame and gives its own length.
  let start = 0;
  if (data.length > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) start = 10 + ((data[6]! & 0x7f) << 21 | (data[7]! & 0x7f) << 14 | (data[8]! & 0x7f) << 7 | data[9]! & 0x7f);
  for (let at = start; at + 4 <= data.length && at < start + 65_536; at++) {
    const first = mp3Frame(data, at);
    if (!first) continue;
    // An encoder's first frame is often an information frame at a rate of its own, so the second speaks for the audio.
    const frame = mp3Frame(data, at + first.length) ?? first;
    return (data.length - at) * 8 / (frame.kbps * 1000);
  }
}
/** Playing time of an MP4 or QuickTime file from its movie header. */
export function mp4Seconds(data: Buffer): number | undefined {
  const box = (from: number, to: number, type: string): [number, number] | undefined => {
    for (let at = from; at + 8 <= to;) {
      let size = data.readUInt32BE(at); let header = 8;
      if (size === 1) { if (at + 16 > to) return; size = Number(data.readBigUInt64BE(at + 8)); header = 16; }
      else if (size === 0) size = to - at;
      if (size < header || at + size > to) return;
      if (data.toString('latin1', at + 4, at + 8) === type) return [at + header, at + size];
      at += size;
    }
  };
  const movie = box(0, data.length, 'moov'); const header = movie && box(movie[0], movie[1], 'mvhd');
  if (!header) return;
  const [at, end] = header; const wide = data[at] === 1;
  if (at + (wide ? 32 : 20) > end) return;
  const timescale = data.readUInt32BE(at + (wide ? 20 : 12));
  const duration = wide ? Number(data.readBigUInt64BE(at + 24)) : data.readUInt32BE(at + 16);
  return timescale ? duration / timescale : undefined;
}
// A page-tree node names its type and its count in one dictionary, in either order, with the list of its kids often between them.
const pageCount = /\/Type\s*\/Pages\b(?:(?!>>)[^]){0,100000}?\/Count\s+(\d+)|\/Count\s+(\d+)(?:(?!>>)[^]){0,100000}?\/Type\s*\/Pages\b/g;
/**
 * Pages of a PDF: the largest count any node of its page tree gives. Newer files keep the tree in compressed object
 * streams, which are inflated to look; a file that hides it some other way gives no count.
 */
export function pdfPages(data: Buffer): number | undefined {
  let pages: number | undefined;
  const look = (text: string) => { for (const match of text.matchAll(pageCount)) { const count = Number(match[1] ?? match[2]); if (count > (pages ?? 0)) pages = count; } };
  const text = data.toString('latin1');
  look(text);
  for (const match of text.matchAll(/\/Type\s*\/ObjStm\b/g)) {
    const from = text.indexOf('stream', match.index); const to = from < 0 ? -1 : text.indexOf('endstream', from);
    if (to < 0) continue;
    // The keyword is followed by a line end, and the data may be followed by one.
    const start = from + 6 + (text[from + 6] === '\r' ? 2 : 1);
    try { look(inflateSync(data.subarray(start, to), { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1')); } catch { /* another filter, or not a stream after all */ }
  }
  return pages;
}
/** How long media plays, where its own bytes say; a platform that says so itself is believed first. */
export function mediaSeconds(data: Buffer, mimeType: string): number | undefined {
  const type = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'audio/mpeg' || type === 'audio/mp3') return mp3Seconds(data);
  if (type === 'video/mp4' || type === 'video/quicktime' || type === 'audio/mp4' || type === 'audio/x-m4a') return mp4Seconds(data);
}
