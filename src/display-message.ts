import type { Action, EnvironmentEvent } from './domain.js';
import { parseConversationRef } from './identity.js';

/** A small, inert message projection. Never includes image bytes or arbitrary native payloads. */
export interface DisplayMessagePart {
  kind: 'text' | 'image' | 'mention' | 'reply' | 'face' | 'record' | 'video' | 'file' | 'forward' | 'card' | 'attachment';
  text: string;
  url?: string;
}
export interface DisplayMessage { direction: 'incoming' | 'outgoing'; parts: DisplayMessagePart[] }

export interface EventDisplayProjection {
  sender?: string;
  sourceName?: string;
  message?: DisplayMessage;
}
export interface ActionDisplayProjection {
  source?: string;
  message?: DisplayMessage;
}
export type DisplayImageUrlResolver = (value: unknown) => string | undefined;
export type MediaPreviewResolver = (value: string) => string | undefined;

export interface DisplayProjector {
  /** Platform identifier handled by this projector (e.g. 'qq', 'telegram'), or undefined to inspect any platform. */
  readonly platform?: string;
  projectEvent?(event: EnvironmentEvent, imageUrl: DisplayImageUrlResolver): EventDisplayProjection | undefined;
  projectAction?(action: Action, imageUrl: DisplayImageUrlResolver): ActionDisplayProjection | undefined;
}

const defaultPreview: MediaPreviewResolver = value =>
  /^drawing:[a-f0-9-]+$/i.test(value) ? `/api/gallery/${encodeURIComponent(value)}/image` : undefined;

export function displayImageUrl(value: unknown, preview?: MediaPreviewResolver): string | undefined {
  if (typeof value !== 'string') return;
  const local = preview?.(value) ?? defaultPreview(value);
  if (local !== undefined) return local;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    // Telegram download URLs embed the bot credential; never put them in a browser.
    if (/\/bot\d+:/i.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

/** Plain text projection for adapters that have no structured segment representation. */
export function displayTextParts(value: unknown, fallback = ''): DisplayMessagePart[] {
  const text = typeof value === 'string' && value ? value : fallback;
  return text ? [{ kind: 'text', text: text.slice(0, 8000) }] : [];
}

/** Sanitize every part URL returned by a projector so untrusted extensions cannot inject unsafe URLs. */
export function sanitizeDisplayMessage(message: DisplayMessage | undefined, imageUrl: DisplayImageUrlResolver): DisplayMessage | undefined {
  if (!message || !Array.isArray(message.parts)) return undefined;
  return {
    direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
    parts: message.parts.slice(0, 80).map(part => ({
      kind: part.kind,
      text: typeof part.text === 'string' ? part.text.slice(0, 8000) : '',
      ...(part.url !== undefined ? { url: imageUrl(part.url) } : {}),
    })),
  };
}

function createImageUrlResolver(preview?: MediaPreviewResolver): { resolve: DisplayImageUrlResolver; sanitize: DisplayImageUrlResolver } {
  const produced = new Set<string>();
  const resolve: DisplayImageUrlResolver = value => {
    const url = displayImageUrl(value, preview);
    if (url !== undefined) produced.add(url);
    return url;
  };
  const sanitize: DisplayImageUrlResolver = value =>
    typeof value === 'string' && produced.has(value) ? value : displayImageUrl(value, preview);
  return { resolve, sanitize };
}

export function projectEventDisplay(
  event: EnvironmentEvent,
  projectors: readonly DisplayProjector[],
  preview?: MediaPreviewResolver,
): EventDisplayProjection {
  const { resolve, sanitize } = createImageUrlResolver(preview);
  const platform = event.source?.platform;
  for (const projector of projectors) {
    if (projector.platform && platform && projector.platform !== platform) continue;
    const projected = projector.projectEvent?.(event, resolve);
    if (!projected) continue;
    return {
      sender: projected.sender ?? event.source?.actorName ?? event.source?.actor,
      sourceName: projected.sourceName ?? event.source?.conversationName,
      ...(projected.message ? { message: sanitizeDisplayMessage(projected.message, sanitize) } : {}),
    };
  }
  return {
    sender: event.source?.actorName ?? event.source?.actor,
    sourceName: event.source?.conversationName,
    ...(event.kind === 'message'
      ? { message: { direction: event.source?.own ? 'outgoing' : 'incoming', parts: displayTextParts(event.text) } }
      : {}),
  };
}

export function projectActionDisplay(
  action: Action,
  projectors: readonly DisplayProjector[],
  preview?: MediaPreviewResolver,
): ActionDisplayProjection {
  const { resolve, sanitize } = createImageUrlResolver(preview);
  const platform = action.conversation ? parseConversationRef(action.conversation)?.platform : undefined;
  for (const projector of projectors) {
    if (projector.platform && platform && projector.platform !== platform) continue;
    const projected = projector.projectAction?.(action, resolve);
    if (!projected) continue;
    return {
      source: projected.source ?? action.conversation,
      ...(projected.message ? { message: sanitizeDisplayMessage(projected.message, sanitize) } : {}),
    };
  }
  return { ...(action.conversation ? { source: action.conversation } : {}) };
}
