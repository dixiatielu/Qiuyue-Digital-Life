import { requireConversationRef } from './identity.js';
import { eventChat, type Action, type EnvironmentEvent } from './domain.js';
import { eventRef, type Store } from './store.js';
import { textTokens } from './context.js';
import {
  RECORD_LINE_LIMIT,
  clipRecordText,
  emojiLabel,
  recordClock,
  recordDay,
  recordDetails,
  recordTime,
  type ChatRecordContext,
  type ChatRecordFormatter,
  type ChatRecordPage,
  type ChatRecordSession,
} from './record-format.js';
import { builtinRecordFormatters } from './adapters/record.js';

export {
  clipRecordText,
  emojiLabel,
  recordTime,
  type ChatRecordContext,
  type ChatRecordFormatter,
  type ChatRecordPage,
  type ChatRecordSession,
};

/** How an observation shows a chat: a thought acts on what it sees, so each person comes with their ID and each message with its message_id, and text runs up to limit characters. */
interface Observed { limit: number }

/** Fallback session for platforms without a dedicated ChatRecordFormatter. */
class GenericChatRecordSession implements ChatRecordSession {
  private people = new Map<string, string>();
  constructor(private readonly ctx: ChatRecordContext) {}
  heading(): string {
    const name = this.ctx.identity.type !== 'private' ? this.ctx.store.conversationName(this.ctx.conversation) : undefined;
    return name ? `${name} [${this.ctx.conversation}]:` : `${this.ctx.conversation}:`;
  }
  title(): string {
    const name = this.ctx.identity.type !== 'private' ? this.ctx.store.conversationName(this.ctx.conversation) : undefined;
    return name ? `Chat record of ${name} (${this.ctx.conversation})` : `Chat record of ${this.ctx.conversation}`;
  }
  legend(page: ChatRecordPage): string {
    if (!page.lines.length) return '';
    const people = [...this.people].map(([ref, name]) => `${name}=${ref}`).join(', ');
    return `Conversation: ${this.ctx.conversation}. People: ${people || 'none'}; "me" is you. Times are +08:00. #xxxxxxxx refs can be cited as sources and opened with read_event or view_event_image.`;
  }
  render(events: EnvironmentEvent[], actions: Action[], today = ''): ChatRecordPage {
    for (const event of events) {
      if (event.source?.actor && !event.source.own) {
        const label = event.source.actorName || event.source.actor;
        if (!this.people.has(event.source.actor)) this.people.set(event.source.actor, label);
      }
    }
    const limit = this.ctx.observed?.limit ?? RECORD_LINE_LIMIT;
    const items = [
      ...events.map(event => ({
        at: event.at,
        text: `${eventRef(event.id)} [${event.kind}] ${event.source?.own ? 'me' : [event.source?.actorName, event.source?.actor].filter(Boolean).join(' ')}: ${clipRecordText(event.text, eventRef(event.id), limit)}`,
      })),
      ...actions.map(action => {
        const caption = this.ctx.actionCaption?.(action);
        return {
          at: action.createdAt,
          text: caption !== undefined
            ? `${action.id} ${caption}`
            : `${action.id} me: ${action.kind} ${clipRecordText(JSON.stringify(action.args), action.id, limit)} → ${clipRecordText(JSON.stringify(action.result), action.id, limit)}`,
        };
      }),
    ].sort((a, b) => a.at - b.at);
    return {
      lines: items.map(item => `${recordDay(item.at) === today ? '' : `${recordDay(item.at)} `}${recordClock(item.at)} ${item.text}`),
      last: items.at(-1)?.at,
    };
  }
}

/** Render one conversation faithfully and in order; what to learn from it is left to the reader. */
export class ChatRecord {
  private readonly session: ChatRecordSession;
  /** faces names platform system faces by ID, so reactions read as what they show. */
  constructor(
    private store: Store,
    private conversation: string,
    faces: Record<string, string> = {},
    observed?: Observed,
    actionCaption?: (action: Action) => string | undefined,
    extraFormatters: readonly ChatRecordFormatter[] = [],
  ) {
    const identity = requireConversationRef(conversation);
    const context: ChatRecordContext = { store, conversation, identity, faces, observed, actionCaption };
    const formatters = extraFormatters.length ? [...extraFormatters, ...builtinRecordFormatters] : builtinRecordFormatters;
    const formatter = formatters.find(item => item.platform === identity.platform && (item.matches?.(identity) ?? true));
    this.session = formatter ? formatter.create(context) : new GenericChatRecordSession(context);
  }

  /** Events an observation brings from this conversation, under a heading naming it; a date is given only when it is not today. */
  observe(events: EnvironmentEvent[]): string {
    const heading = this.session.heading();
    return [heading, ...this.session.render(events, [], recordDay(Date.now())).lines].join('\n');
  }

  /** Read forward from a time; reports the time of the first item not included. */
  page(from: number, limit: number): { text: string; next?: number; through?: number } {
    const { events, actions, complete } = this.store.conversationRecord(this.conversation, from, limit);
    const page = this.session.render(events, actions);
    const next = page.last === undefined ? undefined : page.last + 1;
    const header = page.lines.length ? `${this.session.title()}, from ${recordTime(from)}:` : `${this.session.title()}: nothing from ${recordTime(from)} on.`;
    const footer = complete ? 'This is the end of the record so far.' : `More follows: read_chat_record with from="${recordTime(next!)}".`;
    return { text: [header, this.session.legend(page), ...page.lines, footer].filter(Boolean).join('\n'), next: complete ? undefined : next, through: next };
  }

  /** Everything from one time through another, as it happened. Beyond budget tokens, the earliest lines are left out and counted. */
  span(from: number, until: number, budget: number): { text: string; omitted: number } {
    const { events, actions } = this.store.conversationRecord(this.conversation, from, Number.MAX_SAFE_INTEGER, until);
    const { lines } = this.session.render(events, actions);
    let omitted = 0; let tokens = lines.reduce((sum, line) => sum + textTokens(line) + 1, 0);
    while (omitted < lines.length && tokens > budget) tokens -= textTokens(lines[omitted++]!) + 1;
    const kept = lines.slice(omitted);
    return { text: [`${this.session.title()}, from ${recordTime(from)} through ${recordTime(until)}:`, this.session.legend({ lines: kept }), ...(kept.length ? kept : ['(nothing)'])].filter(Boolean).join('\n'), omitted };
  }

  /** The latest items containing a phrase or written by one person, in order. */
  matches(limit: number, match: { query?: string; person?: string }): string {
    const { events, actions } = this.store.conversationMatches(this.conversation, limit, match);
    const page = this.session.render(events, actions);
    const what = [match.query && `containing "${match.query}"`, match.person && `from ${match.person}`].filter(Boolean).join(' and ');
    return [`${this.session.title()}: latest items ${what}.`, this.session.legend(page), ...(page.lines.length ? page.lines : ['(none)'])].filter(Boolean).join('\n');
  }
}

/** Fields a non-chat pushed event already says, by its kind or envelope. */
const pushKeys = new Set(['time', 'self_id', 'post_type', 'notice_type', 'request_type', 'meta_event_type', 'sub_type']);

/**
 * The events of one observation as lines: each chat's events in the form of its record, and the program's own events, such as wakes,
 * notes, and requests, one line each, in the order each first appears. Text runs up to limit characters before read_event is needed.
 */
export function observationText(
  store: Store,
  events: EnvironmentEvent[],
  faces: Record<string, string>,
  limit: number,
  extraFormatters: readonly ChatRecordFormatter[] = [],
): string {
  const groups = new Map<string, EnvironmentEvent[]>();
  for (const event of events) { const key = eventChat(event) ?? event.id; groups.set(key, [...groups.get(key) ?? [], event]); }
  const today = recordDay(Date.now());
  return [...groups].map(([key, items]) => {
    if (key !== items[0]!.id) return new ChatRecord(store, key, faces, { limit }, undefined, extraFormatters).observe(items);
    const event = items[0]!; const ref = eventRef(event.id);
    const pushed = typeof event.payload.post_type === 'string';
    // A push's text only repeats its kind. A review's prompt is its instructions, which must arrive whole.
    const text = pushed && event.kind.includes(event.text) ? '' : ` ${event.kind === 'memory_maintenance' ? event.text : clipRecordText(event.text, ref, limit)}`;
    const extra = event.kind === 'wake' || pushed ? recordDetails(event.payload, pushKeys) : '';
    return `${recordDay(event.at) === today ? '' : `${recordDay(event.at)} `}${recordClock(event.at)} ${ref} [${event.kind}]${event.source?.actor ? ` ${event.source.actor}` : ''}${text}${extra}`;
  }).join('\n');
}
