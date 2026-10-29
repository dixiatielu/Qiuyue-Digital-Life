import type { Action, EnvironmentEvent } from './domain.js';
import { conversationOf, eventRef, type Store } from './store.js';
import { faceLabel } from './faces.js';

const ZONE_OFFSET = 8 * 3_600_000;
const LINE_LIMIT = 300;
const QUOTE_LIMIT = 40;
/** Asia/Shanghai wall-clock time; the record is read in the same zone as runtime_data. */
const local = (at: number) => new Date(at + ZONE_OFFSET).toISOString();
export const recordTime = (at: number) => local(at).replace('Z', '+08:00');
const clock = (at: number) => local(at).slice(11, 19);
const day = (at: number) => local(at).slice(0, 10);

type Item = { at: number; event?: EnvironmentEvent; action?: Action };
interface Page { lines: string[]; last?: number }

/** Render one conversation faithfully and in order; what to learn from it is left to the reader. */
export class ChatRecord {
  private names = new Map<number, string>();
  /** faces names QQ system faces by ID, so reactions read as what they show. */
  constructor(private store: Store, private selfId: number, private conversation: string, private faces: Record<string, string> = {}) { conversationOf(conversation); }

  /** Read forward from a time; reports the time of the first item not included. */
  page(from: number, limit: number): { text: string; next?: number; through?: number } {
    const { events, actions, complete } = this.store.conversationRecord(this.conversation, from, limit);
    const page = this.render(events, actions);
    const next = page.last === undefined ? undefined : page.last + 1;
    const header = page.lines.length ? `${this.title()}, from ${recordTime(from)}:` : `${this.title()}: nothing from ${recordTime(from)} on.`;
    const footer = complete ? 'This is the end of the record so far.' : `More follows: read_chat_record with from="${recordTime(next!)}".`;
    return { text: [header, this.legend(page), ...page.lines, footer].filter(Boolean).join('\n'), next: complete ? undefined : next, through: next };
  }

  /** The latest items containing a phrase or written by one person, in order. */
  matches(limit: number, match: { query?: string; person?: number }): string {
    const { events, actions } = this.store.conversationMatches(this.conversation, limit, { ...match, selfId: this.selfId });
    const page = this.render(events, actions);
    const what = [match.query && `containing "${match.query}"`, match.person && `from ${this.name(match.person)}`].filter(Boolean).join(' and ');
    return [`${this.title()}: latest items ${what}.`, this.legend(page), ...(page.lines.length ? page.lines : ['(none)'])].filter(Boolean).join('\n');
  }

  private title() {
    const { type, id } = conversationOf(this.conversation);
    if (type === 'private') return `Chat record of the private chat with ${this.name(id)} (${id})`;
    const name = this.store.groupName(id);
    return `Chat record of group ${id}${name ? ` (${name})` : ''}`;
  }
  private legend(page: Page) {
    if (!page.lines.length) return '';
    const people = [...this.names].filter(([id]) => id !== this.selfId).map(([id, name]) => `${name}=${id}`).join(', ');
    return `People: ${people || 'none'}; "me" is you. Times are +08:00. #xxxxxxxx refs can be cited as sources and opened with read_event or view_event_image.`;
  }
  private name(userId: number): string {
    if (userId === this.selfId) return 'me';
    let name = this.names.get(userId);
    if (name === undefined) {
      const sender = this.store.latestSender(userId);
      name = String(sender?.card || sender?.nickname || userId);
      // Two people sharing a display name must stay distinguishable.
      if ([...this.names.values()].includes(name)) name = `${name}(${userId})`;
      this.names.set(userId, name);
    }
    return name;
  }
  private render(events: EnvironmentEvent[], actions: Action[]): Page {
    for (const event of events) {
      const sender = event.payload.sender as { card?: string; nickname?: string } | undefined;
      const name = sender?.card || sender?.nickname;
      if (event.actorId !== undefined && event.actorId !== this.selfId && name && !this.names.has(event.actorId) && ![...this.names.values()].includes(name)) this.names.set(event.actorId, name);
    }
    // Echoes of this account's sends and reactions duplicate the actions that made them.
    const sent = new Set(actions.filter(isSend).map(action => Number((action.result as { message_id?: unknown } | null)?.message_id)));
    const reacted = new Set(actions.filter(action => action.kind === 'set_group_reaction').map(action => `${action.args.message_id}:${action.args.code}`));
    const echo = (event: EnvironmentEvent) => event.kind === 'message' ? event.actorId === this.selfId && sent.has(Number(event.payload.message_id))
      : event.kind.startsWith('notice:group_msg_emoji_like:') && Number(event.payload.operator_id ?? event.actorId) === this.selfId && Array.isArray(event.payload.likes) && event.payload.likes.every((like: { emoji_id?: unknown }) => reacted.has(`${event.payload.message_id}:${like.emoji_id}`));
    const items: Item[] = [
      ...events.filter(event => !echo(event)).map(event => ({ at: event.at, event })),
      ...actions.map(action => ({ at: action.createdAt, action })),
    ].sort((a, b) => a.at - b.at);
    // Reactions join the line of the message they react to; everything else stays in time order.
    const messages = new Map<number, number>();
    const lines: string[] = [];
    let date = '';
    for (const item of items) {
      const reaction = this.reaction(item);
      const line = reaction && messages.get(reaction.messageId);
      if (line !== undefined) { lines[line] += `\n  ↳ ${reaction!.text}`; continue; }
      if (day(item.at) !== date) { date = day(item.at); lines.push(`— ${date} —`); }
      lines.push(`${clock(item.at)} ${reaction ? `${reaction.text} to ${this.target(reaction.messageId, true)}` : this.line(item)}`);
      const messageId = item.event?.kind === 'message' ? Number(item.event.payload.message_id) : isSend(item.action) ? Number((item.action!.result as { message_id?: unknown } | null)?.message_id) : NaN;
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
      const who = this.name(Number(event.payload.operator_id ?? event.actorId));
      return { messageId: Number(event.payload.message_id), text: `${who} ${event.kind.endsWith(':remove') ? 'removed reaction' : 'reacted'} ${likes.map(like => `[emoji ${faceLabel(like.emoji_id, this.faces)}]`).join('') || '[emoji]'}` };
    }
    if (action?.kind === 'set_group_reaction') return { messageId: Number(action.args.message_id), text: `me ${action.args.is_set === false ? 'removed reaction' : 'reacted'} [emoji ${faceLabel(action.args.code, this.faces)}]` };
  }
  /** quote adds the start of the message, for a reaction shown apart from it. */
  private target(messageId: number, quote = false): string {
    const event = this.store.messageById(this.conversation, messageId);
    if (event && event.actorId !== this.selfId) {
      const text = quote ? this.segments(Array.isArray(event.payload.message) ? event.payload.message : event.text).replace(/\s+/g, ' ') : '';
      return `${eventRef(event.id)} (${this.name(event.actorId ?? 0)}${text ? `: ${text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text}` : ''})`;
    }
    if (event) return 'my message';
    return this.store.sentMessage(messageId) ? 'my message' : `message ${messageId}`;
  }
  private line(item: Item): string {
    const { event, action } = item;
    if (action) return this.actionLine(action);
    const ref = eventRef(event!.id);
    const who = this.name(event!.actorId ?? 0);
    const payload = event!.payload;
    if (event!.kind === 'message') return `${ref} ${who}: ${clip(this.segments(Array.isArray(payload.message) ? payload.message : event!.text), ref)}`;
    if (event!.kind === 'notice:group_recall:' || event!.kind === 'notice:friend_recall:') {
      const operator = this.name(Number(payload.operator_id ?? event!.actorId));
      return `${ref} ${operator} recalled ${Number(payload.operator_id) === Number(payload.user_id) || payload.operator_id == null ? 'their' : `${this.name(Number(payload.user_id))}'s`} message ${this.target(Number(payload.message_id))}`;
    }
    if (event!.kind === 'notice:notify:poke') return `${ref} ${who} ${String(payload.action || 'poked')} ${this.name(Number(payload.target_id))}${String(payload.suffix ?? '')}`;
    const target = payload.target_id ?? payload.operator_id;
    return `${ref} [${event!.kind}] ${who}${target != null && Number(target) !== event!.actorId ? ` → ${this.name(Number(target))}` : ''}${payload.duration ? ` (${payload.duration}s)` : ''}`;
  }
  private actionLine(action: Action): string {
    const args = action.args;
    if (action.kind === 'send_group_msg' || action.kind === 'send_private_msg') return `me: ${clip(this.segments(args.message))}`;
    if (action.kind === 'send_custom_face') { const note = this.store.stickerNote(String(args.emoji_id ?? '')); return `me: [saved sticker${note ? `: ${clip(note)}` : ''}]`; }
    if (action.kind === 'send_group_ai_record') return `me: [AI voice] ${clip(String(args.text ?? ''))}`;
    if (['group_poke', 'friend_poke', 'send_poke'].includes(action.kind)) return `me poked ${this.name(Number(args.user_id ?? args.target_id))}`;
    if (action.kind === 'delete_msg') return `me recalled ${this.target(Number(args.message_id))}`;
    return `me used ${action.kind}`;
  }
  private segments(message: unknown): string {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    return message.map((segment: { type?: string; data?: Record<string, any> }) => {
      const data = segment.data ?? {};
      switch (segment.type) {
        case 'text': return String(data.text ?? '');
        case 'at': return data.qq === 'all' ? '@all ' : `@${this.name(Number(data.qq))} `;
        case 'reply': return `[reply to ${this.target(Number(data.id))}] `;
        case 'image': return data.summary && data.summary !== '[图片]' ? `[image ${data.summary}]` : '[image]';
        case 'face': return `[face ${faceLabel(data.id, this.faces)}]`;
        case 'mface': return `[sticker ${data.summary ?? ''}]`;
        case 'record': return '[voice]';
        case 'video': return '[video]';
        case 'file': return `[file ${data.name ?? ''}]`;
        case 'forward': return '[forwarded chat]';
        case 'json': { try { return `[card ${JSON.parse(String(data.data)).prompt ?? ''}]`; } catch { return '[card]'; } }
        default: return `[${segment.type}]`;
      }
    }).join('').trim();
  }
}

const isSend = (action?: Action) => !!action && ['send_group_msg', 'send_private_msg', 'send_custom_face', 'send_group_ai_record'].includes(action.kind);
function clip(text: string, ref?: string) {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT)}… [+${flat.length - LINE_LIMIT} chars${ref ? `; read_event ${ref}` : ''}]` : flat;
}
