import type { Action, EnvironmentEvent } from './domain.js';
import type { requireConversationRef } from './identity.js';
import type { Store } from './store.js';

const ZONE_OFFSET = 8 * 3_600_000;
export const RECORD_LINE_LIMIT = 300;
export const RECORD_QUOTE_LIMIT = 40;

/** Asia/Shanghai wall-clock time; the record is read in the same zone as runtime_data. */
const local = (at: number) => new Date(at + ZONE_OFFSET).toISOString();
export const recordTime = (at: number) => local(at).replace('Z', '+08:00');
export const recordClock = (at: number) => local(at).slice(11, 19);
export const recordDay = (at: number) => local(at).slice(0, 10);

/** An emoji's native ID and any supplied name; larger IDs can be Unicode code points. */
export function emojiLabel(id: unknown, names: Record<string, string>): string {
  const code = String(id);
  let name = names[code];
  if (!name && Number(code) >= 1000) { try { name = String.fromCodePoint(Number(code)); } catch { /* not a code point */ } }
  return name ? `${code} ${name}` : code;
}

export const actionOperation = (action: Action): string =>
  action.kind.includes('__') ? action.kind.slice(action.kind.indexOf('__') + 2) : action.kind;

export function clipRecordText(text: string, ref?: string, limit = RECORD_LINE_LIMIT): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > limit ? `${flat.slice(0, limit)}… [+${flat.length - limit} chars${ref ? `; read_event ${ref}` : ''}]` : flat;
}

/** What else an event carries, such as a request's flag or a changed card, so a line leaves out nothing a thought may act on. */
export function recordDetails(payload: Record<string, unknown>, said: ReadonlySet<string>): string {
  const rest = Object.entries(payload).filter(([key, value]) => !said.has(key) && value !== undefined);
  return rest.length ? ` ${JSON.stringify(Object.fromEntries(rest))}` : '';
}

export interface ChatRecordPage {
  lines: string[];
  last?: number;
}

export interface ChatRecordContext {
  readonly store: Store;
  readonly conversation: string;
  readonly identity: ReturnType<typeof requireConversationRef>;
  readonly faces: Record<string, string>;
  readonly observed?: { limit: number };
  readonly actionCaption?: (action: Action) => string | undefined;
}

export interface ChatRecordSession {
  heading(): string;
  title(): string;
  legend(page: ChatRecordPage): string;
  render(events: EnvironmentEvent[], actions: Action[], today?: string): ChatRecordPage;
}

export interface ChatRecordFormatter {
  /** Platform identifier this formatter handles (e.g. 'qq', 'telegram'). */
  readonly platform: string;
  /** Optional filter when a formatter only handles certain conversation types. */
  matches?(identity: ReturnType<typeof requireConversationRef>): boolean;
  create(context: ChatRecordContext): ChatRecordSession;
}
