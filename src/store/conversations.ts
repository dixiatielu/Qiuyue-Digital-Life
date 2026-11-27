import type { DatabaseSync } from 'node:sqlite';
import type { Action, EnvironmentEvent } from '../domain.js';
import { parsePersonRef, personRef, requireConversationRef, type ConversationType, type PlatformIdentity } from '../identity.js';
import {
  readActionById,
  readActionRow,
  readActions,
  readConversationName,
  readEventRow,
  readLatestActorName,
  readLatestSender,
  recordFilter,
} from './queries.js';
import { actionFingerprint, json, makeId, parse, type StoreNotice } from './schema.js';

export interface StoreConversationHost {
  readonly db: DatabaseSync;
  transaction<T>(work: () => T): T;
  notify(notice: StoreNotice): void;
  log(kind: string, data: unknown): void;
}

/** Conversation records, activity queries, action ledger (ADR-0008), and rate/call budgets. */
export class ConversationStore {
  constructor(private readonly host: StoreConversationHost) {}
  private get db() { return this.host.db; }

  latestGroupMessage(conversation: string): number | undefined {
    const row = this.db.prepare(`SELECT coalesce(json_extract(source,'$.messageId'), json_extract(payload,'$.message_id')) AS message_id FROM events WHERE conversation_ref=? AND kind='message' ORDER BY at DESC LIMIT 1`).get(conversation);
    return row?.message_id == null ? undefined : Number(row.message_id);
  }

  /** Conversations with messages from others that review has not read yet. */
  reviewBacklog(now = Date.now()): { conversation: string; messages: number; since: number }[] {
    return this.db.prepare(`WITH marks AS (SELECT key AS conversation, value AS at FROM json_each((SELECT value FROM settings WHERE key='reviewMarks')))
      SELECT c.conversation, count(*) AS messages, min(c.at) AS since FROM (SELECT conversation_ref AS conversation, at FROM events WHERE kind='message' AND conversation_ref IS NOT NULL AND json_extract(source,'$.own')=0) c
      LEFT JOIN marks m USING(conversation) WHERE c.at>=max(coalesce(m.at,0),?) GROUP BY c.conversation ORDER BY messages DESC`).all(now - 86_400_000)
      .map(row => ({ conversation: String(row.conversation), messages: Number(row.messages), since: Number(row.since) }));
  }

  /** People with an impression who spoke in these conversations since the given times, and no later than until where one is given, latest first. */
  impressionsIn(chats: { conversation: string; since: number; until?: number }[], limit: number): string[] {
    const last = new Map<string, number>();
    for (const chat of chats) {
      const filter = recordFilter(chat.conversation);
      for (const row of this.db.prepare(`SELECT actor_ref AS person, max(at) AS at FROM events WHERE ${filter.events} AND kind='message' AND at>=? AND at<=? AND json_extract(source,'$.own')=0 AND EXISTS (SELECT 1 FROM memories WHERE active=1 AND kind='impression' AND scope='person:'||events.actor_ref) GROUP BY person`).all(filter.target, chat.since, chat.until ?? Number.MAX_SAFE_INTEGER)) {
        const person = String(row.person);
        last.set(person, Math.max(last.get(person) ?? 0, Number(row.at)));
      }
    }
    return [...last].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([person]) => person);
  }

  /** A page of one conversation from a time on: messages and notices, with this account's completed actions there. Events sharing the last time stay together. */
  conversationRecord(conversation: string, from: number, limit: number, until = Number.MAX_SAFE_INTEGER): { events: EnvironmentEvent[]; actions: Action[]; complete: boolean } {
    const filter = recordFilter(conversation);
    const edge = this.db.prepare(`SELECT at FROM events WHERE ${filter.events} AND at>=? AND at<=? ORDER BY at,rowid LIMIT 1 OFFSET ?`).get(filter.target, from, until, limit - 1);
    const end = edge ? Number(edge.at) : until;
    return {
      events: this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND at>=? AND at<=? ORDER BY at,rowid`).all(filter.target, from, end).map(readEventRow),
      actions: this.db.prepare(`SELECT * FROM actions WHERE ${filter.actions} AND created_at>=? AND created_at<=? ORDER BY created_at`).all(filter.target, from, end).map(readActionRow),
      complete: !edge,
    };
  }

  /** The latest items of one conversation containing a phrase or written by one person. */
  conversationMatches(conversation: string, limit: number, match: { query?: string; person?: string }): { events: EnvironmentEvent[]; actions: Action[] } {
    const filter = recordFilter(conversation);
    const query = match.query?.toLowerCase();
    if (match.person && match.person !== 'self' && !parsePersonRef(match.person)) throw new Error('Use self or a canonical person reference.');
    const identity = requireConversationRef(conversation);
    const mine = match.person === 'self' || identity && match.person === personRef(identity.platform, identity.accountId);
    const events = mine ? [] : this.db.prepare(`SELECT * FROM events WHERE ${filter.events}${query ? ' AND instr(lower(text),?)>0' : ''}${match.person ? ' AND actor_ref=?' : ''} ORDER BY at DESC,rowid DESC LIMIT ?`).all(filter.target, ...(query ? [query] : []), ...(match.person ? [match.person] : []), limit).map(readEventRow);
    const actions = match.person && !mine ? [] : this.db.prepare(`SELECT * FROM actions WHERE ${filter.actions}${query ? ' AND instr(lower(args),?)>0' : ''} ORDER BY created_at DESC LIMIT ?`).all(filter.target, ...(query ? [query] : []), limit).map(readActionRow);
    return { events: events.reverse(), actions: actions.reverse() };
  }

  /** The message a reply or reaction points at, when it is still retained. */
  messageById(conversation: string, messageId: string | number): EnvironmentEvent | undefined {
    const filter = recordFilter(conversation);
    const textId = String(messageId);
    const numericId = Number(messageId);
    const row = Number.isFinite(numericId)
      ? this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND kind='message' AND (json_extract(source,'$.messageId')=? OR json_extract(payload,'$.message_id')=?) ORDER BY at DESC LIMIT 1`).get(filter.target, textId, numericId)
      : this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND kind='message' AND json_extract(source,'$.messageId')=? ORDER BY at DESC LIMIT 1`).get(filter.target, textId);
    return row ? readEventRow(row) : undefined;
  }

  sentMessage(messageId: string | number, account: PlatformIdentity): boolean {
    const numericId = Number(messageId);
    const prefix = `${account.platform}:${encodeURIComponent(account.accountId)}:%`;
    return Number.isFinite(numericId)
      ? !!this.db.prepare("SELECT 1 FROM actions WHERE status='success' AND (json_extract(result,'$.message_id')=? OR json_extract(result,'$.message_id')=?) AND conversation LIKE ? LIMIT 1").get(numericId, String(messageId), prefix)
      : !!this.db.prepare("SELECT 1 FROM actions WHERE status='success' AND json_extract(result,'$.message_id')=? AND conversation LIKE ? LIMIT 1").get(String(messageId), prefix);
  }

  latestSender(person: string) { return readLatestSender(this.db, person); }
  latestActorName(person: string) { return readLatestActorName(this.db, person); }
  conversationName(conversation: string) { return readConversationName(this.db, conversation); }

  /** Latest message timestamp and known conversation name, using the conversation index. */
  latestConversationActivity(conversation: string): { at: number; name?: string } | undefined {
    const row = this.db.prepare("SELECT at, coalesce(json_extract(source,'$.conversationName'), json_extract(payload,'$.group_name')) AS name FROM events WHERE conversation_ref=? AND kind='message' ORDER BY at DESC LIMIT 1").get(conversation);
    if (!row) return;
    const name = row.name ? String(row.name) : this.conversationName(conversation);
    return { at: Number(row.at), ...(name ? { name } : {}) };
  }

  /** Recent active conversations for one platform account, filtered by conversation type. */
  activeConversations(account: PlatformIdentity, types: readonly ConversationType[], limit = 10): string[] {
    if (!types.length || limit <= 0) return [];
    const prefix = `${account.platform}:${encodeURIComponent(account.accountId)}:%`;
    return this.db.prepare(`SELECT conversation_ref FROM events WHERE kind='message' AND conversation_ref LIKE ? AND json_extract(source,'$.conversationType') IN (${types.map(() => '?').join(',')}) GROUP BY conversation_ref ORDER BY max(at) DESC LIMIT ?`).all(prefix, ...types, limit).map(row => String(row.conversation_ref));
  }

  actions(limit = 20): Action[] { return readActions(this.db, limit); }
  actionById(actionId: string): Action | undefined { return readActionById(this.db, actionId); }

  /** Processed non-own events that triggered a completed action, in chronological order. */
  actionTriggers(actionId: string): EnvironmentEvent[] {
    return this.db.prepare("SELECT e.* FROM action_triggers t JOIN events e ON e.id=t.event_id WHERE t.action_id=? AND e.status='processed' AND coalesce(json_extract(e.source,'$.own'),0)=0 ORDER BY e.at,e.rowid").all(actionId).map(readEventRow);
  }

  /** Latest processed non-own chat events in one conversation up to a timestamp, for seeding historical turns after a context reset. */
  recentConversationEvents(conversation: string, beforeAt: number, limit: number): EnvironmentEvent[] {
    const filter = recordFilter(conversation);
    return this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND status='processed' AND at<=? AND coalesce(json_extract(source,'$.own'),0)=0 ORDER BY at DESC,rowid DESC LIMIT ?`).all(filter.target, beforeAt, limit).reverse().map(readEventRow);
  }

  lastSuccessfulAction(kind: string): Action | undefined {
    const row = this.db.prepare("SELECT * FROM actions WHERE kind=? AND status='success' ORDER BY created_at DESC LIMIT 1").get(kind);
    return row ? readActionRow(row) : undefined;
  }

  /** Latest time each experience kind was recorded; read-only tool calls leave an experience but no action. */
  lastExperienced(kinds: string[]): Record<string, number> {
    if (!kinds.length) return {};
    const rows = this.db.prepare(`SELECT kind, max(at) AS at FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) GROUP BY kind`).all(...kinds);
    return Object.fromEntries(rows.map(row => [String(row.kind), Number(row.at)]));
  }

  beginAction(key: string, kind: string, args: Record<string, unknown>, sources: string[], triggers: string[] = [], hourlyLimit?: number | null, conversation?: string): { action: Action; fresh: boolean } {
    if (conversation) requireConversationRef(conversation);
    return this.host.transaction(() => {
      const fingerprint = actionFingerprint(kind, args);
      const existing = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('The same action key cannot be used for different actions.');
        return { action: readActionRow(existing), fresh: false };
      }
      const unknown = this.db.prepare("SELECT * FROM actions WHERE fingerprint=? AND status IN ('pending','unknown') LIMIT 1").get(fingerprint);
      if (unknown) return { action: readActionRow(unknown), fresh: false };
      for (const trigger of triggers) {
        const completed = this.db.prepare("SELECT a.* FROM actions a JOIN action_triggers t ON t.action_id=a.id WHERE a.fingerprint=? AND a.status='success' AND t.event_id=? LIMIT 1").get(fingerprint, trigger);
        if (completed) return { action: readActionRow(completed), fresh: false };
      }
      if (hourlyLimit != null && this.hourlyActions() >= hourlyLimit) throw new Error('The external action rate limit has been reached.');
      const actionId = makeId('a');
      this.db.prepare('INSERT INTO actions(id,action_key,fingerprint,kind,args,source_ids,status,result,created_at,conversation) VALUES (?,?,?,?,?,?,?,?,?,?)').run(actionId, key, fingerprint, kind, json(args), json(sources), 'pending', null, Date.now(), conversation ?? null);
      for (const trigger of triggers) this.db.prepare('INSERT OR IGNORE INTO action_triggers VALUES (?,?)').run(actionId, trigger);
      const action = readActionRow(this.db.prepare('SELECT * FROM actions WHERE id=?').get(actionId)!);
      this.host.notify({ kind: 'action', action }); return { action, fresh: true };
    });
  }

  finishAction(actionId: string, status: Action['status'], result: unknown, conversation?: string) {
    const existing = this.db.prepare('SELECT result FROM actions WHERE id=?').get(actionId);
    const redacted = existing?.result && parse<{ redacted?: boolean }>(existing.result).redacted;
    this.db.prepare('UPDATE actions SET status=?,result=?,conversation=coalesce(?,conversation) WHERE id=?').run(status, json(redacted ? { redacted: true } : result), conversation ?? null, actionId);
    this.host.log('action_result', { id: actionId, status });
    const action = this.actionById(actionId); if (action) this.host.notify({ kind: 'action', action });
  }

  hourlyActions(now = Date.now()) { return Number(this.db.prepare('SELECT count(*) AS n FROM actions WHERE created_at>?').get(now - 3_600_000)!.n); }
  dailyCalls(now = Date.now()) { return Number(this.db.prepare("SELECT count(*) AS n FROM calls WHERE at>=?").get(Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000)!.n); }
  chargeCall(runId: string, limit: number | null) {
    return this.host.transaction(() => {
      if (limit !== null && this.dailyCalls() >= limit) throw new Error('The daily model call budget has been exhausted.');
      const callId = makeId('call');
      this.db.prepare('INSERT INTO calls VALUES (?,?,?)').run(callId, Date.now(), runId);
      return callId;
    });
  }
}
