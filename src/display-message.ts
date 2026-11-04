import { fromCQString } from '@snowluma/sdk';

/** A small, inert message projection. Never includes image bytes or arbitrary native payloads. */
export interface DisplayMessagePart {
  kind: 'text' | 'image' | 'mention' | 'reply' | 'face' | 'record' | 'video' | 'file' | 'forward' | 'card' | 'attachment';
  text: string;
  url?: string;
}
export interface DisplayMessage { direction: 'incoming' | 'outgoing'; parts: DisplayMessagePart[] }

export function displayImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  if (/^drawing:[a-f0-9-]+$/i.test(value)) return `/api/gallery/${encodeURIComponent(value)}/image`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    // Telegram download URLs embed the bot credential; never put them in a browser.
    if (/\/bot\d+:/i.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

export function displayMessageParts(message: unknown, fallback = ''): DisplayMessagePart[] {
  if (typeof message === 'string') {
    if (!message.includes('[CQ:')) return [{ kind: 'text', text: message }];
    try { message = fromCQString(message).toSegments(); } catch { return [{ kind: 'text', text: message as string }]; }
  }
  if (!Array.isArray(message) || !message.length) return fallback ? [{ kind: 'text', text: fallback }] : [];
  return message.slice(0, 80).map((part): DisplayMessagePart => {
    const data = part?.data ?? {};
    const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 8000) : '';
    switch (part?.type) {
      case 'text': return { kind: 'text', text: text(data.text) };
      case 'image': case 'mface': return { kind: 'image', text: text(data.summary), url: displayImageUrl(data.url) ?? displayImageUrl(data.file) };
      case 'at': return { kind: 'mention', text: text(data.name || data.qq) };
      case 'reply': return { kind: 'reply', text: text(data.text || data.id) };
      case 'face': return { kind: 'face', text: text(data.name || data.id) };
      case 'record': case 'video': case 'file': case 'forward': return { kind: part.type, text: text(data.name || data.summary) };
      case 'json': {
        let title = '';
        try { title = text(JSON.parse(String(data.data)).prompt); } catch { /* The original stays in details. */ }
        return { kind: 'card', text: title };
      }
      default: return { kind: 'attachment', text: text(part?.type) };
    }
  });
}

export function outgoingMessage(kind: string, args: Record<string, unknown>): DisplayMessage | undefined {
  const operation = kind.split('__').at(-1)!;
  if (['send_group_msg', 'send_private_msg', 'send_msg'].includes(operation)) return { direction: 'outgoing', parts: displayMessageParts(args.message) };
  if (['sendMessage', 'sendPhoto', 'sendAnimation', 'sendSticker', 'sendDocument', 'sendVideo', 'sendVoice', 'sendAudio'].includes(operation)) {
    const parts = displayMessageParts(args.text ?? args.caption);
    if (operation === 'sendPhoto' || operation === 'sendSticker') parts.push({ kind: 'image', text: '', url: displayImageUrl(args.photo ?? args.sticker) });
    else if (operation !== 'sendMessage') parts.push({ kind: 'attachment', text: operation.replace('send', '') });
    return { direction: 'outgoing', parts };
  }
}
