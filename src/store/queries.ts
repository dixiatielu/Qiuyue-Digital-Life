import type { DatabaseSync } from 'node:sqlite';
import { developmentKinds, type Action, type EnvironmentEvent, type Memory } from '../domain.js';
import { parseConversationRef, parsePersonRef, requireConversationRef } from '../identity.js';
import { nonEphemeralEventSql, parse } from './schema.js';

type Row = Record<string, any>;

/** Trace rows written while a model call is about to start or under way, before the live view shows the thought as busy. */
const inFlightTrace = (kind: string) => kind === 'context_budget' || kind === 'model_request_started' || kind.startsWith('observation_');

export interface UsageGroup {
  owner: string; purpose: string; provider: string; model: string; api: string;
  calls: number; success: number; errors: number; aborted: number; unfinished: number; unknownUsage: number;
  measuredCalls: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null;
}

export function readSetting<T>(db: DatabaseSync, key: string): T | undefined;
export function readSetting<T>(db: DatabaseSync, key: string, fallback: T): T;
export function readSetting<T>(db: DatabaseSync, key: string, fallback?: T): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  return parse<T>(row.value);
}

export function readEventRow(row: Row): EnvironmentEvent {
  return {
    id: row.id, key: row.source_key, kind: row.kind, at: row.at, text: row.text, payload: parse(row.payload),
    status: row.status, receivedAt: row.received_at ?? undefined, ...(row.source ? { source: parse(row.source) } : {}),
  };
}

export function readEvent(db: DatabaseSync, eventId: string): EnvironmentEvent | undefined {
  const row = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  return row ? readEventRow(row) : undefined;
}

export function readMemoryRow(db: DatabaseSync, row: Row): Memory {
  return {
    id: row.id, kind: row.kind, title: row.title, content: row.content, importance: row.importance,
    subjects: parse(row.subjects), conversations: parse(row.conversations_json), fictional: Boolean(row.fictional),
    sources: db.prepare('SELECT source_id FROM sources WHERE owner_id=?').all(row.id).map(item => String(item.source_id)),
    supersedes: row.supersedes ?? undefined, ...(row.scope ? { scope: row.scope } : {}),
    active: Boolean(row.active), createdAt: row.created_at,
  };
}

export function readMemory(db: DatabaseSync, memoryId: string): Memory | undefined {
  const row = db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId);
  return row ? readMemoryRow(db, row) : undefined;
}

export function readActionRow(row: Row): Action {
  return {
    id: row.id, key: row.action_key, fingerprint: row.fingerprint, kind: row.kind, args: parse(row.args),
    sources: parse(row.source_ids), status: row.status, result: row.result ? parse(row.result) : null,
    createdAt: row.created_at, ...(row.conversation ? { conversation: row.conversation } : {}),
  };
}

export function readActions(db: DatabaseSync, limit = 20): Action[] {
  return db.prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT ?').all(limit).map(readActionRow);
}

export function readActionById(db: DatabaseSync, actionId: string): Action | undefined {
  const row = db.prepare('SELECT * FROM actions WHERE id=?').get(actionId);
  return row ? readActionRow(row) : undefined;
}

export function recordFilter(conversation: string): { target: string; events: string; actions: string } {
  requireConversationRef(conversation);
  return {
    target: conversation,
    events: `conversation_ref=? AND ${nonEphemeralEventSql} AND (kind='message' OR kind LIKE 'notice:%' OR kind LIKE 'request:%') AND coalesce(json_extract(source,'$.attention'),'')!='transport'`,
    actions: "status='success' AND conversation=?",
  };
}

export function readLatestSender(db: DatabaseSync, person: string): { card?: string; nickname?: string } | undefined {
  const row = db.prepare("SELECT json_extract(source,'$.actorName') AS name, json_extract(payload,'$.sender') AS sender FROM events WHERE actor_ref=? AND (json_extract(source,'$.actorName') IS NOT NULL OR json_extract(payload,'$.sender') IS NOT NULL) ORDER BY at DESC LIMIT 1").get(person);
  return row ? row.name ? { nickname: String(row.name) } : parse(row.sender) : undefined;
}

export function readLatestActorName(db: DatabaseSync, person: string): string | undefined {
  const sender = readLatestSender(db, person);
  return sender?.card || sender?.nickname || undefined;
}

/** Known human-readable name for a conversation, preferring normalized source.conversationName over legacy payload.group_name. */
export function readConversationName(db: DatabaseSync, conversation: string): string | undefined {
  const row = db.prepare("SELECT coalesce(json_extract(source,'$.conversationName'), json_extract(payload,'$.group_name')) AS name FROM events WHERE conversation_ref=? AND (json_extract(source,'$.conversationName') IS NOT NULL OR json_extract(payload,'$.group_name') IS NOT NULL) ORDER BY at DESC LIMIT 1").get(conversation);
  return row?.name ? String(row.name) : undefined;
}

export function readScopeName(db: DatabaseSync, scope: string): string | undefined {
  if (scope.startsWith('conversation:')) {
    const chat = scope.slice('conversation:'.length);
    if (!parseConversationRef(chat)) return;
    return readConversationName(db, chat);
  }
  if (scope.startsWith('person:')) {
    const person = scope.slice('person:'.length);
    if (!parsePersonRef(person)) return;
    return readLatestActorName(db, person);
  }
}

/** Active development memories with resolved human-readable scope names (ADR-0012). */
export function readDevelopmentMemories(db: DatabaseSync): (Memory & { scopeName?: string })[] {
  return db.prepare(`SELECT * FROM memories WHERE active=1 AND kind IN (${developmentKinds.map(() => '?').join(',')}) ORDER BY kind, scope, created_at DESC`).all(...developmentKinds).map(row => {
    const memory = readMemoryRow(db, row);
    return { ...memory, ...(memory.scope ? { scopeName: readScopeName(db, memory.scope) } : {}) };
  });
}

/** A memory with the versions it replaced and the records it rests on. */
export function readMemoryDetail(db: DatabaseSync, memoryId: string) {
  const row = db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId);
  if (!row) return undefined;
  const memory = readMemoryRow(db, row);
  const versions: Memory[] = [];
  for (let previous = memory.supersedes; previous && versions.length < 50;) {
    const older = db.prepare('SELECT * FROM memories WHERE id=?').get(previous);
    if (!older) break;
    const version = readMemoryRow(db, older);
    versions.push(version);
    previous = version.supersedes;
  }
  const sources = memory.sources.map(id => {
    const event = db.prepare('SELECT id, kind, at, text FROM events WHERE id=?').get(id);
    if (event) return { id, kind: String(event.kind), at: Number(event.at), text: String(event.text).slice(0, 600) };
    const source = db.prepare('SELECT id, kind, title, created_at FROM memories WHERE id=?').get(id);
    return source ? { id, kind: String(source.kind), at: Number(source.created_at), text: String(source.title) } : { id, kind: 'missing', at: 0, text: '' };
  });
  return { memory, versions, sources, ...(memory.scope ? { scopeName: readScopeName(db, memory.scope) } : {}) };
}

export function readMemoryCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(db.prepare('SELECT kind, count(*) AS n FROM memories WHERE active=1 GROUP BY kind').all().map(row => [String(row.kind), Number(row.n)]));
}

/** The working context the next start would continue, if its identity and the current management generation still match. */
export function readWorkingContextMeta(db: DatabaseSync): { identity: string; generation: number; current: boolean; updatedAt: number } | undefined {
  const row = db.prepare('SELECT identity, generation, updated_at FROM working_context WHERE id=1').get();
  if (!row) return undefined;
  return { identity: String(row.identity), generation: Number(row.generation), current: Number(row.generation) === readSetting(db, 'generation'), updatedAt: Number(row.updated_at) };
}

/** What a restart now would cut short: a review under way, or a model call the live view may not show yet. */
export function readDaemonActivity(db: DatabaseSync, now: number, isAlive: (pid: number) => boolean) {
  const review = db.prepare("SELECT kind, at FROM trace WHERE kind IN ('review_started','review_finished','review_stopped') ORDER BY id DESC LIMIT 1").get();
  const last = db.prepare('SELECT kind, at FROM trace ORDER BY id DESC LIMIT 1').get();
  // A daemon that died in the middle of a review left it open in the trace; with no daemon alive, no review is under way.
  const daemon = readSetting<{ pid: number }>(db, 'daemon');
  return {
    reviewing: review?.kind === 'review_started' && daemon && isAlive(daemon.pid) ? Number(review.at) : undefined,
    lastTrace: last ? { kind: String(last.kind), at: Number(last.at) } : undefined,
    callStarting: Boolean(last && inFlightTrace(String(last.kind)) && now - Number(last.at) < 20_000),
  };
}

/** Each calls row is one charged attempt; turn/summary traces are deliberately not counted again. */
export function readModelUsage(db: DatabaseSync, now: number) {
  const since = now - 86_400_000;
  const requests = new Map<string, Row>();
  for (const row of db.prepare("SELECT data FROM trace WHERE at>=? AND kind IN ('model_request_started','model_request_finished') ORDER BY id").all(since)) {
    const item = parse<Row>(row.data);
    if (typeof item.callId === 'string') requests.set(item.callId, item);
  }
  const groups = new Map<string, UsageGroup>();
  let total = 0; let unclassified = 0;
  for (const row of db.prepare('SELECT id FROM calls WHERE at>=? AND at<=?').all(since, now)) {
    total++;
    const item = requests.get(String(row.id));
    if (!item) { unclassified++; continue; }
    const key = JSON.stringify([item.owner, item.purpose, item.provider, item.model, item.api]);
    let group = groups.get(key);
    if (!group) {
      group = { owner: item.owner, purpose: item.purpose, provider: item.provider, model: item.model, api: item.api, calls: 0, success: 0, errors: 0, aborted: 0, unfinished: 0, unknownUsage: 0, measuredCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };
      groups.set(key, group);
    }
    group.calls++;
    if (item.status === 'success') group.success++;
    else if (item.status === 'error') group.errors++;
    else if (item.status === 'aborted') group.aborted++;
    else group.unfinished++;
    const usage = item.usage;
    if (!usage || !['input', 'output', 'cacheRead', 'cacheWrite'].every(field => Number.isFinite(usage[field]) && usage[field] >= 0)) { group.unknownUsage++; continue; }
    group.measuredCalls++;
    group.input += usage.input; group.output += usage.output; group.cacheRead += usage.cacheRead; group.cacheWrite += usage.cacheWrite;
    if (Number.isFinite(usage.reasoning) && usage.reasoning >= 0) group.reasoning = (group.reasoning ?? 0) + usage.reasoning;
  }
  return { since, until: now, total, unclassified, cost: null, groups: [...groups.values()] };
}

export function readTraceRows(db: DatabaseSync, limit: number) {
  return db.prepare('SELECT id, at, kind, data FROM trace ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
    id: Number(row.id), at: Number(row.at), kind: String(row.kind), data: String(row.data).slice(0, 2000),
  }));
}
