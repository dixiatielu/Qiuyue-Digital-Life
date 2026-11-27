import { fromCQString } from '@snowluma/sdk';
import {
  displayImageUrl,
  type DisplayImageUrlResolver,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayProjector,
} from '../../display-message.js';
import { ui } from '../../ui-language.js';

const SEND_OPERATIONS = new Set(['send_group_msg', 'send_private_msg', 'send_msg']);

/** Parse OneBot segment arrays or CQ strings into inert display parts; never carries image bytes. */
export function snowlumaMessageParts(
  message: unknown,
  fallback = '',
  imageUrl: DisplayImageUrlResolver = displayImageUrl,
): DisplayMessagePart[] {
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
      case 'image': case 'mface': return { kind: 'image', text: text(data.summary), url: imageUrl(data.url) ?? imageUrl(data.file) };
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

export function snowlumaOutgoingMessage(
  kind: string,
  args: Record<string, unknown>,
  imageUrl: DisplayImageUrlResolver = displayImageUrl,
): DisplayMessage | undefined {
  const operation = kind.split('__').at(-1)!;
  if (!SEND_OPERATIONS.has(operation)) return;
  return { direction: 'outgoing', parts: snowlumaMessageParts(args.message, '', imageUrl) };
}

export const snowlumaDisplayProjector: DisplayProjector = {
  platform: 'qq',
  projectEvent(event, imageUrl) {
    if (event.source && event.source.platform !== 'qq') return;
    const payload = event.payload as Record<string, any>;
    if (!event.source && typeof payload.post_type !== 'string') return;
    const sender = payload.sender as { card?: string; nickname?: string } | undefined;
    const senderName = event.source?.actorName || sender?.card || sender?.nickname || event.source?.actor;
    const sourceName = event.source?.conversationName || (typeof payload.group_name === 'string' ? payload.group_name : undefined);
    const parts = event.kind === 'message' ? snowlumaMessageParts(payload.message, event.text, imageUrl) : undefined;
    return {
      sender: senderName,
      sourceName,
      ...(parts ? { message: { direction: event.source?.own ? 'outgoing' : 'incoming', parts } } : {}),
    };
  },
  projectAction(action, imageUrl) {
    const message = snowlumaOutgoingMessage(action.kind, action.args, imageUrl);
    const source = action.args.group_id
      ? ui(`Group ${action.args.group_id}`, `群 ${action.args.group_id}`)
      : action.args.user_id
        ? ui(`Private chat ${action.args.user_id}`, `私聊 ${action.args.user_id}`)
        : undefined;
    if (!message && !source && !action.conversation?.startsWith('qq:')) return;
    return {
      source: source ?? action.conversation,
      ...(message ? { message } : {}),
    };
  },
};
