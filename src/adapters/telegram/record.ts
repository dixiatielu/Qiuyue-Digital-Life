import type { Action, EnvironmentEvent } from '../../domain.js';
import { parsePersonRef, personRef, requireConversationRef } from '../../identity.js';
import { eventRef } from '../../store.js';
import {
  RECORD_QUOTE_LIMIT,
  actionOperation,
  clipRecordText,
  recordClock,
  recordDay,
  type ChatRecordContext,
  type ChatRecordFormatter,
  type ChatRecordPage,
  type ChatRecordSession,
} from '../../record-format.js';

type Item = { at: number; event?: EnvironmentEvent; action?: Action };

const SEND_OPERATIONS = new Set([
  'sendMessage', 'sendPhoto', 'sendAnimation', 'sendSticker', 'sendDocument', 'sendVideo', 'sendVideoNote',
  'sendVoice', 'sendAudio', 'sendMediaGroup', 'sendLocation', 'sendVenue', 'sendContact', 'sendPoll', 'sendDice',
  'forwardMessage', 'copyMessage',
]);

const isSend = (action?: Action) => !!action && SEND_OPERATIONS.has(actionOperation(action));

function telegramMessageOf(payload: Record<string, any>): { kind: string; message: Record<string, any> } | undefined {
  for (const kind of ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message', 'edited_business_message'] as const) {
    const value = payload[kind];
    if (value && typeof value === 'object' && !Array.isArray(value)) return { kind, message: value as Record<string, any> };
  }
}

function telegramReactionsText(reactions: unknown): string {
  if (!Array.isArray(reactions) || !reactions.length) return '';
  return reactions.map((item: any) => {
    if (item?.type === 'emoji' && item.emoji) return String(item.emoji);
    if (item?.type === 'custom_emoji' && item.custom_emoji_id) return `[custom emoji ${item.custom_emoji_id}]`;
    if (item?.type === 'paid') return '[star]';
    return '[reaction]';
  }).join('');
}

function actionResultMessageIds(action: Action): string[] {
  const result = action.result as Record<string, any> | Record<string, any>[] | null;
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.filter(item => item?.message_id != null).map(item => String(item.message_id));
}

function telegramActorId(event: EnvironmentEvent): string | undefined {
  const parsed = event.source?.actor && parsePersonRef(event.source.actor);
  if (parsed) return parsed.id;
  const payload = event.payload as Record<string, any>;
  const from = telegramMessageOf(payload)?.message.from ?? payload.message_reaction?.user ?? payload.callback_query?.from;
  return from?.id != null ? String(from.id) : undefined;
}

class TelegramChatRecordSession implements ChatRecordSession {
  private names = new Map<string, string>();
  constructor(private readonly ctx: ChatRecordContext) {}

  heading(): string {
    const { type, id } = this.ctx.identity;
    const name = type !== 'private' ? this.ctx.store.conversationName(this.ctx.conversation) : undefined;
    const label = type === 'private'
      ? `Private chat with ${this.name(id)}:`
      : `${type[0]!.toUpperCase()}${type.slice(1)} ${id}${name ? ` (${name})` : ''}:`;
    return `${label} [${this.ctx.conversation}]`;
  }
  title(): string {
    const { type, id } = this.ctx.identity;
    if (type === 'private') return `Chat record of the private chat with ${this.name(id)} (${id})`;
    const name = this.ctx.store.conversationName(this.ctx.conversation);
    return `Chat record of ${type} ${id}${name ? ` (${name})` : ''}`;
  }
  legend(page: ChatRecordPage): string {
    if (!page.lines.length) return '';
    const people = [...this.names]
      .filter(([id]) => id !== this.ctx.identity.accountId)
      .map(([id, name]) => `${name}=${personRef('telegram', id)}`)
      .join(', ');
    return `Conversation: ${this.ctx.conversation}. People: ${people || 'none'}; "me" is you. Times are +08:00. #xxxxxxxx refs can be cited as sources and opened with read_event or view_event_image.`;
  }
  private name(userId: string, hinted?: string): string {
    if (userId === this.ctx.identity.accountId) return 'me';
    let existing = this.names.get(userId);
    if (existing === undefined) {
      const base = hinted || this.ctx.store.latestActorName(personRef('telegram', userId)) || userId;
      existing = this.ctx.observed
        ? (base !== userId ? `${base}(${userId})` : userId)
        : ([...this.names.values()].includes(base) ? `${base}(${userId})` : base);
      this.names.set(userId, existing);
    }
    return existing;
  }
  render(events: EnvironmentEvent[], actions: Action[], today = ''): ChatRecordPage {
    for (const event of events) {
      const actorId = telegramActorId(event);
      const label = event.source?.actorName;
      if (actorId && actorId !== this.ctx.identity.accountId && label && !this.names.has(actorId) && (this.ctx.observed || ![...this.names.values()].includes(label))) {
        this.names.set(actorId, this.ctx.observed ? `${label}(${actorId})` : label);
      }
    }
    const sent = new Set(actions.filter(isSend).flatMap(actionResultMessageIds));
    const reacted = new Set(actions.filter(action => actionOperation(action) === 'setMessageReaction').map(action => `${action.args.message_id}:${telegramReactionsText(action.args.reaction)}`));
    const echo = (event: EnvironmentEvent) => {
      if (event.kind === 'message') {
        const id = event.source?.messageId ?? telegramMessageOf(event.payload as Record<string, any>)?.message.message_id;
        return event.source?.own === true && id != null && sent.has(String(id));
      }
      if (event.kind === 'notice:message_reaction' && event.source?.own === true) {
        const mr = (event.payload as Record<string, any>).message_reaction;
        return mr?.message_id != null && reacted.has(`${mr.message_id}:${telegramReactionsText(mr.new_reaction)}`);
      }
      return false;
    };
    const items: Item[] = [
      ...events.filter(event => !echo(event)).map(event => ({ at: event.at, event })),
      ...actions.map(action => ({ at: action.createdAt, action })),
    ].sort((a, b) => a.at - b.at);
    const messages = new Map<string, number>();
    const lines: string[] = [];
    let date = today;
    for (const item of items) {
      const reaction = this.reaction(item);
      const line = reaction && messages.get(reaction.messageId);
      if (line !== undefined) { lines[line] += `\n  ↳ ${reaction!.text}`; continue; }
      if (recordDay(item.at) !== date) { date = recordDay(item.at); lines.push(`— ${date} —`); }
      lines.push(`${recordClock(item.at)} ${reaction ? `${reaction.text} to ${this.target(reaction.messageId, true)}${this.messageId(reaction.messageId)}` : this.line(item)}`);
      if (item.event?.kind === 'message') {
        const id = item.event.source?.messageId ?? telegramMessageOf(item.event.payload as Record<string, any>)?.message.message_id;
        if (id != null) messages.set(String(id), lines.length - 1);
      } else if (isSend(item.action)) {
        for (const id of actionResultMessageIds(item.action!)) messages.set(id, lines.length - 1);
      }
    }
    const times = [...events.map(event => event.at), ...actions.map(action => action.createdAt)];
    return { lines, last: times.length ? Math.max(...times) : undefined };
  }
  private reaction(item: Item): { messageId: string; text: string } | undefined {
    const { event, action } = item;
    if (event?.kind === 'notice:message_reaction') {
      const mr = (event.payload as Record<string, any>).message_reaction;
      if (mr?.message_id == null) return;
      const actorId = telegramActorId(event);
      const who = event.source?.own ? 'me' : actorId ? this.name(actorId, event.source?.actorName) : (mr.actor_chat?.title || 'someone');
      const emojis = telegramReactionsText(mr.new_reaction);
      return { messageId: String(mr.message_id), text: emojis ? `${who} reacted ${emojis}` : `${who} removed reaction` };
    }
    if (action && actionOperation(action) === 'setMessageReaction' && action.args.message_id != null) {
      const emojis = telegramReactionsText(action.args.reaction);
      return { messageId: String(action.args.message_id), text: emojis ? `me reacted ${emojis}` : 'me removed reaction' };
    }
  }
  private target(messageId: string, quote = false, fallbackReply?: Record<string, any>): string {
    const event = this.ctx.store.messageById(this.ctx.conversation, messageId);
    if (event && !event.source?.own) {
      const actorId = telegramActorId(event);
      const who = actorId ? this.name(actorId, event.source?.actorName) : 'someone';
      const body = quote ? this.messageBody(event).replace(/\s+/g, ' ') : '';
      return `${eventRef(event.id)} (${who}${body ? `: ${body.length > RECORD_QUOTE_LIMIT ? `${body.slice(0, RECORD_QUOTE_LIMIT)}…` : body}` : ''})`;
    }
    if (event) return 'my message';
    if (this.ctx.store.sentMessage(messageId, requireConversationRef(this.ctx.conversation))) return 'my message';
    if (fallbackReply) {
      const from = fallbackReply.from;
      const who = from?.id != null
        ? this.name(String(from.id), [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username)
        : undefined;
      const snippet = String(fallbackReply.text ?? fallbackReply.caption ?? '').replace(/\s+/g, ' ');
      if (who || snippet) {
        const clipped = snippet.length > RECORD_QUOTE_LIMIT ? `${snippet.slice(0, RECORD_QUOTE_LIMIT)}…` : snippet;
        return `message ${messageId} (${[who, clipped].filter(Boolean).join(': ')})`;
      }
    }
    return `message ${messageId}`;
  }
  private messageId(id: string | undefined) {
    return this.ctx.observed && id ? ` [message_id ${id}]` : '';
  }
  private messageBody(event: EnvironmentEvent): string {
    const found = telegramMessageOf(event.payload as Record<string, any>);
    if (!found) return event.text;
    const { kind, message } = found;
    const parts: string[] = [];
    if (kind.startsWith('edited_')) parts.push('(edited)');
    if (message.reply_to_message?.message_id != null) {
      parts.push(`[reply to ${this.target(String(message.reply_to_message.message_id), false, message.reply_to_message)}]`);
    }
    if (message.photo) parts.push(this.ctx.observed ? '[image 0]' : '[image]');
    else if (message.sticker) parts.push(`[sticker${message.sticker.emoji ? ` ${message.sticker.emoji}` : ''}]`);
    else if (message.animation) parts.push('[animation]');
    // An observation numbers what view_event_media can play; a message holds one such thing (ADR-0029).
    else if (message.video) parts.push(this.ctx.observed ? '[video 0]' : '[video]');
    else if (message.video_note) parts.push(this.ctx.observed ? '[video 0, a video note]' : '[video note]');
    else if (message.voice) parts.push(this.ctx.observed ? '[voice 0]' : '[voice]');
    else if (message.audio) parts.push(`[audio${this.ctx.observed ? ' 0' : ''}${message.audio.title ? ` ${message.audio.title}` : ''}]`);
    else if (message.document) parts.push(`[file${message.document.file_name ? ` ${message.document.file_name}` : ''}]`);
    else if (message.location) parts.push('[location]');
    else if (message.poll) parts.push(`[poll${message.poll.question ? ` ${message.poll.question}` : ''}]`);
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    if (text) parts.push(text);
    return parts.join(' ').trim() || event.text;
  }
  private line(item: Item): string {
    const { event, action } = item;
    if (action) return this.actionLine(action);
    const ref = eventRef(event!.id);
    const actorId = telegramActorId(event!);
    const who = event!.source?.own ? 'me' : actorId ? this.name(actorId, event!.source?.actorName) : (event!.source?.actorName || 'someone');
    if (event!.kind === 'message') {
      const id = event!.source?.messageId ?? (telegramMessageOf(event!.payload as Record<string, any>)?.message.message_id != null ? String(telegramMessageOf(event!.payload as Record<string, any>)!.message.message_id) : undefined);
      return `${ref}${this.messageId(id)} ${who}: ${clipRecordText(this.messageBody(event!), ref, this.ctx.observed?.limit)}`;
    }
    if (event!.kind === 'notice:callback_query') {
      const data = (event!.payload as Record<string, any>).callback_query?.data;
      return `${ref} ${who} tapped button "${clipRecordText(String(data ?? event!.text), ref, this.ctx.observed?.limit)}"`;
    }
    return `${ref} [${event!.kind}] ${who}: ${clipRecordText(event!.text, ref, this.ctx.observed?.limit)}`;
  }
  private actionLine(action: Action): string {
    const caption = this.ctx.actionCaption?.(action);
    if (caption !== undefined) return caption;
    const args = action.args;
    const kind = actionOperation(action);
    const replyId = (args.reply_parameters as { message_id?: unknown } | undefined)?.message_id ?? args.reply_to_message_id;
    const reply = replyId != null ? `[reply to ${this.target(String(replyId))}] ` : '';
    const captionText = typeof args.caption === 'string' && args.caption ? ` ${clipRecordText(args.caption)}` : '';
    if (kind === 'sendMessage') return `me: ${reply}${clipRecordText(String(args.text ?? ''))}`;
    if (kind === 'sendPhoto') return `me: ${reply}[image]${captionText}`;
    if (kind === 'sendSticker') return `me: ${reply}[sticker]`;
    if (kind === 'sendAnimation') return `me: ${reply}[animation]${captionText}`;
    if (kind === 'sendDocument') return `me: ${reply}[file]${captionText}`;
    if (kind === 'sendVideo') return `me: ${reply}[video]${captionText}`;
    if (kind === 'sendVideoNote') return `me: ${reply}[video note]`;
    if (kind === 'sendVoice') return `me: ${reply}[voice]${captionText}`;
    if (kind === 'sendAudio') return `me: ${reply}[audio]${captionText}`;
    if (kind === 'sendMediaGroup') return `me: ${reply}[media group (${Array.isArray(args.media) ? args.media.length : 0})]`;
    if (kind === 'sendPoll') return `me: ${reply}[poll ${clipRecordText(String(args.question ?? ''))}]`;
    if (kind === 'forwardMessage') return `me forwarded message ${args.message_id}`;
    if (kind === 'copyMessage') return `me copied message ${args.message_id}`;
    if (kind === 'editMessageText') return `me edited message ${args.message_id}: ${clipRecordText(String(args.text ?? ''))}`;
    if (kind === 'deleteMessage' || kind === 'deleteMessages') return `me deleted ${args.message_id != null ? this.target(String(args.message_id)) : `messages ${JSON.stringify(args.message_ids)}`}`;
    return `me used ${kind}`;
  }
}

export const telegramChatRecordFormatter: ChatRecordFormatter = {
  platform: 'telegram',
  create: context => new TelegramChatRecordSession(context),
};
