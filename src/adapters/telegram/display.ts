import {
  displayImageUrl,
  displayTextParts,
  type DisplayImageUrlResolver,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayProjector,
} from '../../display-message.js';

const SEND_OPERATIONS = new Set([
  'sendMessage', 'sendPhoto', 'sendAnimation', 'sendSticker', 'sendDocument', 'sendVideo', 'sendVoice', 'sendAudio',
]);

function telegramNativeMessage(payload: Record<string, any>): Record<string, any> | undefined {
  const message = payload.message ?? payload.edited_message ?? payload.channel_post ?? payload.edited_channel_post ?? payload.business_message ?? payload.edited_business_message;
  return message && typeof message === 'object' && !Array.isArray(message) ? message : undefined;
}

export function telegramOutgoingMessage(
  kind: string,
  args: Record<string, unknown>,
  imageUrl: DisplayImageUrlResolver = displayImageUrl,
): DisplayMessage | undefined {
  const operation = kind.split('__').at(-1)!;
  if (!SEND_OPERATIONS.has(operation)) return;
  const parts: DisplayMessagePart[] = displayTextParts(args.text ?? args.caption);
  if (operation === 'sendPhoto' || operation === 'sendSticker') {
    parts.push({ kind: 'image', text: '', url: imageUrl(args.photo ?? args.sticker) });
  } else if (operation !== 'sendMessage') {
    parts.push({ kind: 'attachment', text: operation.replace('send', '') });
  }
  return { direction: 'outgoing', parts };
}

export const telegramDisplayProjector: DisplayProjector = {
  platform: 'telegram',
  projectEvent(event) {
    if (event.source?.platform !== 'telegram') return;
    const nativeMessage = telegramNativeMessage(event.payload as Record<string, any>);
    const sourceName = event.source.conversationName || (typeof nativeMessage?.chat?.title === 'string' ? nativeMessage.chat.title : undefined);
    let message: DisplayMessage | undefined;
    if (event.kind === 'message') {
      const parts: DisplayMessagePart[] = [];
      if (nativeMessage?.reply_to_message) {
        const snippet = String(nativeMessage.reply_to_message.text ?? nativeMessage.reply_to_message.caption ?? nativeMessage.reply_to_message.message_id ?? '');
        parts.push({ kind: 'reply', text: snippet.slice(0, 120) });
      }
      const text = typeof nativeMessage?.text === 'string' ? nativeMessage.text : typeof nativeMessage?.caption === 'string' ? nativeMessage.caption : undefined;
      if (text) parts.push({ kind: 'text', text: text.slice(0, 8000) });
      if (nativeMessage) {
        if (nativeMessage.photo || nativeMessage.sticker) {
          parts.push({ kind: 'image', text: String(nativeMessage.sticker?.emoji ?? '') });
        } else {
          for (const kind of ['video', 'voice', 'audio', 'document', 'animation'] as const) {
            if (nativeMessage[kind]) {
              const partKind = kind === 'video' ? 'video' : kind === 'voice' ? 'record' : kind === 'document' ? 'file' : 'attachment';
              parts.push({ kind: partKind, text: String(nativeMessage[kind].file_name ?? kind) });
            }
          }
        }
      }
      if (!parts.length && event.text) parts.push({ kind: 'text', text: event.text.slice(0, 8000) });
      message = { direction: event.source.own ? 'outgoing' : 'incoming', parts };
    }
    return {
      sender: event.source.actorName ?? event.source.actor,
      sourceName,
      ...(message ? { message } : {}),
    };
  },
  projectAction(action, imageUrl) {
    const message = telegramOutgoingMessage(action.kind, action.args, imageUrl);
    const source = action.conversation ?? (action.args.chat_id !== undefined ? String(action.args.chat_id) : undefined);
    if (!message && action.args.chat_id === undefined && !action.conversation?.startsWith('telegram:')) return;
    return {
      source,
      ...(message ? { message } : {}),
    };
  },
};
