import type { Action, EnvironmentEvent } from '../../domain.js';
import { parsePersonRef, personRef, requireConversationRef } from '../../identity.js';
import { eventRef } from '../../store.js';
import {
  RECORD_QUOTE_LIMIT,
  actionOperation,
  clipRecordText,
  emojiLabel,
  recordClock,
  recordDay,
  recordDetails,
  type ChatRecordContext,
  type ChatRecordFormatter,
  type ChatRecordPage,
  type ChatRecordSession,
} from '../../record-format.js';

type Item = { at: number; event?: EnvironmentEvent; action?: Action };

const qqActor = (event: EnvironmentEvent) => {
  const actor = event.source?.actor && parsePersonRef(event.source.actor);
  return actor ? Number(actor.id) : undefined;
};
const isSend = (action?: Action) =>
  !!action && ['send_group_msg', 'send_private_msg', 'send_custom_face', 'send_group_ai_record'].includes(actionOperation(action));

/** Fields a line already says, by its kind, time, conversation, people, or message. */
const pushKeys = new Set(['time', 'self_id', 'post_type', 'notice_type', 'request_type', 'meta_event_type', 'sub_type']);
const chatKeys = new Set([...pushKeys, 'group_id', 'user_id', 'operator_id', 'target_id', 'sender_id', 'duration']);

class SnowLumaChatRecordSession implements ChatRecordSession {
  private names = new Map<number, string>();
  private readonly selfId: number;
  constructor(private readonly ctx: ChatRecordContext) {
    this.selfId = Number(ctx.identity.accountId);
  }
  heading(): string {
    const { type, id } = this.ctx.identity;
    const name = type === 'group' && this.ctx.store.conversationName(this.ctx.conversation);
    const label = type === 'private' ? `Private chat with ${this.name(Number(id))}:` : `Group ${id}${name ? ` (${name})` : ''}:`;
    return `${label} [${this.ctx.conversation}]`;
  }
  title(): string {
    const { type, id } = this.ctx.identity;
    if (type === 'private') return `Chat record of the private chat with ${this.name(Number(id))} (${id})`;
    const name = this.ctx.store.conversationName(this.ctx.conversation);
    return `Chat record of group ${id}${name ? ` (${name})` : ''}`;
  }
  legend(page: ChatRecordPage): string {
    if (!page.lines.length) return '';
    const people = [...this.names].filter(([id]) => id !== this.selfId).map(([id, name]) => `${name}=${personRef('qq', String(id))}`).join(', ');
    return `Conversation: ${this.ctx.conversation}. People: ${people || 'none'}; "me" is you. Times are +08:00. #xxxxxxxx refs can be cited as sources and opened with read_event or view_event_image.`;
  }
  private name(userId: number): string {
    if (userId === this.selfId) return 'me';
    let name = this.names.get(userId);
    if (name === undefined) {
      const sender = this.ctx.store.latestSender(personRef('qq', String(userId)));
      name = String(sender?.card || sender?.nickname || userId);
      // Two people sharing a display name must stay distinguishable; an observation gives everyone's QQ.
      if (this.ctx.observed ? name !== String(userId) : [...this.names.values()].includes(name)) name = `${name}(${userId})`;
      this.names.set(userId, name);
    }
    return name;
  }
  render(events: EnvironmentEvent[], actions: Action[], today = ''): ChatRecordPage {
    for (const event of events) {
      const sender = event.payload.sender as { card?: string; nickname?: string } | undefined;
      const name = event.source?.actorName || sender?.card || sender?.nickname;
      const actor = qqActor(event);
      if (actor !== undefined && actor !== this.selfId && name && !this.names.has(actor) && (this.ctx.observed || ![...this.names.values()].includes(name))) {
        this.names.set(actor, this.ctx.observed ? `${name}(${actor})` : name);
      }
    }
    // Echoes of this account's sends and reactions duplicate the actions that made them.
    const sent = new Set(actions.filter(isSend).map(action => Number((action.result as { message_id?: unknown } | null)?.message_id)));
    const reacted = new Set(actions.filter(action => actionOperation(action) === 'set_group_reaction').map(action => `${action.args.message_id}:${action.args.code}`));
    const echo = (event: EnvironmentEvent) => event.kind === 'message'
      ? qqActor(event) === this.selfId && sent.has(Number(event.source?.messageId ?? event.payload.message_id))
      : event.kind.startsWith('notice:group_msg_emoji_like:')
        && Number(event.payload.operator_id ?? qqActor(event)) === this.selfId
        && Array.isArray(event.payload.likes)
        && event.payload.likes.every((like: { emoji_id?: unknown }) => reacted.has(`${event.payload.message_id}:${like.emoji_id}`));
    const items: Item[] = [
      ...events.filter(event => !echo(event)).map(event => ({ at: event.at, event })),
      ...actions.map(action => ({ at: action.createdAt, action })),
    ].sort((a, b) => a.at - b.at);
    // Reactions join the line of the message they react to; everything else stays in time order.
    const messages = new Map<number, number>();
    const lines: string[] = [];
    let date = today;
    for (const item of items) {
      const reaction = this.reaction(item);
      const line = reaction && messages.get(reaction.messageId);
      if (line !== undefined) { lines[line] += `\n  ↳ ${reaction!.text}`; continue; }
      if (recordDay(item.at) !== date) { date = recordDay(item.at); lines.push(`— ${date} —`); }
      lines.push(`${recordClock(item.at)} ${reaction ? `${reaction.text} to ${this.target(reaction.messageId, true)}${this.messageId(reaction.messageId)}` : this.line(item)}`);
      const messageId = item.event?.kind === 'message'
        ? Number(item.event.source?.messageId ?? item.event.payload.message_id)
        : isSend(item.action)
          ? Number((item.action!.result as { message_id?: unknown } | null)?.message_id)
          : NaN;
      if (Number.isFinite(messageId)) messages.set(messageId, lines.length - 1);
    }
    // Skipped echoes still count, so the next page cannot start inside this one.
    const times = [...events.map(event => event.at), ...actions.map(action => action.createdAt)];
    return { lines, last: times.length ? Math.max(...times) : undefined };
  }
  private reaction(item: Item): { messageId: number; text: string } | undefined {
    const { event, action } = item;
    if (event?.kind.startsWith('notice:group_msg_emoji_like:')) {
      const likes = Array.isArray(event.payload.likes) ? event.payload.likes as { emoji_id?: unknown; count?: unknown }[] : [];
      const who = this.name(Number(event.payload.operator_id ?? qqActor(event)));
      return { messageId: Number(event.payload.message_id), text: `${who} ${event.kind.endsWith(':remove') ? 'removed reaction' : 'reacted'} ${likes.map(like => `[emoji ${emojiLabel(like.emoji_id, this.ctx.faces)}]`).join('') || '[emoji]'}` };
    }
    if (action && actionOperation(action) === 'set_group_reaction') {
      return { messageId: Number(action.args.message_id), text: `me ${action.args.is_set === false ? 'removed reaction' : 'reacted'} [emoji ${emojiLabel(action.args.code, this.ctx.faces)}]` };
    }
  }
  /** quote adds the start of the message, for a reaction shown apart from it. */
  private target(messageId: number, quote = false): string {
    const event = this.ctx.store.messageById(this.ctx.conversation, messageId);
    if (event && qqActor(event) !== this.selfId) {
      const text = quote ? this.segments(Array.isArray(event.payload.message) ? event.payload.message : event.text).replace(/\s+/g, ' ') : '';
      return `${eventRef(event.id)} (${this.name(qqActor(event) ?? 0)}${text ? `: ${text.length > RECORD_QUOTE_LIMIT ? `${text.slice(0, RECORD_QUOTE_LIMIT)}…` : text}` : ''})`;
    }
    if (event) return 'my message';
    return this.ctx.store.sentMessage(messageId, requireConversationRef(this.ctx.conversation)) ? 'my message' : `message ${messageId}`;
  }
  private line(item: Item): string {
    const { event, action } = item;
    if (action) return this.actionLine(action);
    const ref = eventRef(event!.id);
    const payload = event!.payload;
    const who = payload.post_type === 'message_sent' ? 'me' : this.name(qqActor(event!) ?? 0);
    if (event!.kind === 'message') return `${ref}${this.messageId(Number(event!.source?.messageId ?? payload.message_id))} ${who}: ${clipRecordText(this.segments(Array.isArray(payload.message) ? payload.message : event!.text), ref, this.ctx.observed?.limit)}`;
    if (event!.kind === 'notice:notify:input_status') return `${ref} ${who} is typing`;
    if (event!.kind === 'notice:group_recall:' || event!.kind === 'notice:friend_recall:') {
      const operator = this.name(Number(payload.operator_id ?? qqActor(event!)));
      return `${ref} ${operator} recalled ${Number(payload.operator_id) === Number(payload.user_id) || payload.operator_id == null ? 'their' : `${this.name(Number(payload.user_id))}'s`} message ${this.target(Number(payload.message_id))}`;
    }
    if (event!.kind === 'notice:notify:poke') return `${ref} ${who} ${String(payload.action || 'poked')} ${this.name(Number(payload.target_id))}${String(payload.suffix ?? '')}`;
    const target = payload.target_id ?? payload.operator_id;
    return `${ref} [${event!.kind}] ${who}${target != null && Number(target) !== qqActor(event!) ? ` → ${this.name(Number(target))}` : ''}${payload.duration ? ` (${payload.duration}s)` : ''}${this.ctx.observed ? recordDetails(payload, chatKeys) : ''}`;
  }
  /** The message_id an observation gives with a message, for replying to it, reacting to it, or recalling it. */
  private messageId(messageId: number) { return this.ctx.observed && Number.isFinite(messageId) ? ` [message_id ${messageId}]` : ''; }
  private actionLine(action: Action): string {
    const caption = this.ctx.actionCaption?.(action);
    if (caption !== undefined) return caption;
    const args = action.args;
    const kind = actionOperation(action);
    if (kind === 'send_group_msg' || kind === 'send_private_msg') return `me: ${clipRecordText(this.segments(args.message))}`;
    if (kind === 'send_custom_face') return 'me: [saved sticker]';
    if (kind === 'send_group_ai_record') return `me: [AI voice] ${clipRecordText(String(args.text ?? ''))}`;
    if (['group_poke', 'friend_poke', 'send_poke'].includes(kind)) return `me poked ${this.name(Number(args.user_id ?? args.target_id))}`;
    if (kind === 'delete_msg') return `me recalled ${this.target(Number(args.message_id))}`;
    return `me used ${kind}`;
  }
  private segments(message: unknown): string {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    // An observation numbers images as the pictures that follow it are labeled.
    let images = 0;
    // Voice and video are numbered together, as view_event_media counts them (ADR-0029).
    let media = 0;
    return message.map((segment: { type?: string; data?: Record<string, any> }) => {
      const data = segment.data ?? {};
      switch (segment.type) {
        case 'text': return String(data.text ?? '');
        case 'at': return data.qq === 'all' ? '@all ' : `@${this.name(Number(data.qq))} `;
        case 'reply': return `[reply to ${this.target(Number(data.id))}] `;
        case 'image': { const image = this.ctx.observed ? `image ${images++}` : 'image'; return data.summary && data.summary !== '[图片]' ? `[${image} ${data.summary}]` : `[${image}]`; }
        case 'face': return `[face ${emojiLabel(data.id, this.ctx.faces)}]`;
        case 'mface': return `[sticker ${data.summary ?? ''}]`;
        case 'record': return this.ctx.observed ? `[voice ${media++}]` : '[voice]';
        case 'video': return this.ctx.observed ? `[video ${media++}]` : '[video]';
        case 'file': return `[file ${data.name ?? ''}]`;
        case 'forward': return this.ctx.observed && data.id ? `[forwarded chat ${data.id}]` : '[forwarded chat]';
        case 'json': { try { return `[card ${JSON.parse(String(data.data)).prompt ?? ''}]`; } catch { return '[card]'; } }
        default: return `[${segment.type}]`;
      }
    }).join('').trim();
  }
}

export const snowlumaChatRecordFormatter: ChatRecordFormatter = {
  platform: 'qq',
  matches: identity => identity.type === 'group' || identity.type === 'private',
  create: context => new SnowLumaChatRecordSession(context),
};
