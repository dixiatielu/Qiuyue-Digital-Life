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
const DOCUMENT_TOKENS_PER_PAGE = 560;

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
