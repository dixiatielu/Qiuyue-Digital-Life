import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { developmentKinds, type Action, type EnvironmentEvent, type Memory, type MemoryKind } from '../domain.js';

export const json = (value: unknown) => JSON.stringify(value);
export const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
/** Match JSON Schema's character counts, including for supplementary Unicode characters. */
export const characters = (value: string): number => [...value].length;
export const makeId = (prefix: string) => `${prefix}:${randomUUID()}`;
export const digest = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex');

/** Memories and events carry evidence on to what cites them; a plan, pursuit, or the activity cites only what its thought had in view. */
export const carriesEvidence = (recordId: string) => recordId.startsWith('m:') || recordId.startsWith('e:');
/** A memory and the memories resting on it, through memories alone: what merely had it in view when a plan was set does not rest on it. */
export const restingOnSql = "dependent(id) AS (SELECT ? UNION SELECT owner_id FROM sources JOIN dependent ON source_id=dependent.id WHERE owner_id LIKE 'm:%')";
/** While the digital life rests, group chat not addressed to it waits instead of starting or steering a thought (ADR-0016). */
export const restHoldsSql = "(kind='message' OR kind LIKE 'notice:%') AND json_extract(source,'$.conversationType') IN ('group','channel','thread') AND addressed=0";
/** Backward-compatible transport check: prefer canonical source.attention='transport', while still matching historical heartbeat rows. */
export const transportEventSql = "(coalesce(json_extract(source,'$.attention'),'')='transport' OR kind='meta_event:heartbeat' OR kind LIKE 'meta_event:heartbeat:%')";
/** Backward-compatible ephemeral check: prefer canonical source.ephemeral=true, while still matching historical typing rows. */
export const nonEphemeralEventSql = "coalesce(json_extract(source,'$.ephemeral'),0)=0 AND kind!='notice:notify:input_status'";
/** Parameters: whether life wakes may be claimed, then whether the digital life rests. */
export const claimableSql = `status='pending' AND (?=1 OR coalesce(json_extract(payload,'$.wakeKind'),'')!='life') AND (?=0 OR NOT (${restHoldsSql}))`;
/** Memories spontaneous recall may bring up: current ones, apart from development, which is supplied by scope (ADR-0012). */
export const recallableSql = `active=1 AND kind NOT IN (${developmentKinds.map(kind => `'${kind}'`).join(',')})`;
/** Internal scheduling events cannot supply external evidence. */
export const programEvents = new Set(['wake', 'memory_maintenance', 'memory_revision', 'perception_gap', 'rest_backlog']);

/** Chat records cite events by the first eight characters of their ID. */
export const eventRef = (eventId: string) => `#${eventId.slice(2, 10)}`;

/** The items of content written as one numbered or bulleted list under at most one heading line; undefined when it is anything else. */
export function listItems(content: string): string[] | undefined {
  const lines = content.split(/\r?\n|\\n/).map(line => line.trim()).filter(Boolean);
  const marker = /^(?:\d+\s*[.、)）:：]|[-*•·])\s*/;
  const body = marker.test(lines[0] ?? '') ? lines : lines.slice(1);
  if (body.length < 2 || !body.every(line => marker.test(line))) return;
  const items = body.map(line => line.replace(marker, '').trim());
  return items.every(Boolean) ? items : undefined;
}

/** A handle for what was written without a title, such as an entry split from a list: its opening clause, or its start where that is too short to look for it by. */
export function entryTitle(item: string): string {
  const opening = (item.split(/[，。；：,;:!?！？（(「]/, 1)[0] ?? '').trim();
  const title = [...([...opening].length >= 4 ? opening : item.trim())];
  return title.length > 30 ? `${title.slice(0, 30).join('')}…` : title.join('');
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
      : value;
export const actionFingerprint = (kind: string, args: Record<string, unknown>) => digest({ kind, args: canonical(args) });

/** What a revision reaches; see Store.revisionReach. */
export interface RevisionReach { withdrawn: { id: string; kind: string; title: string }[]; cites: { id: string; kind: string; title: string }[] }
/** What bounds the digital life's own writes: one entry of development, the entries of one kind in a scope, or about a person, together, and one experience. */
export interface DevelopmentLimits { entryChars: number; scopeChars: number; experienceChars?: number }
/** A memory to go back over, with the stretch of each chat its events come from. */
export interface Revisit { memory: Memory; spans: { conversation: string; from: number; to: number; events: number }[] }
export interface MemoryInput { kind: MemoryKind; title: string; content: string; importance: number; subjects?: string[]; sources: string[]; supersedes?: string; scope?: string; fictional?: boolean }
/** Local receive times of claimable events: the earliest waking one, the latest of any kind, and the earliest ambient one. */
export interface PendingTiming { first?: number; last?: number; ambient?: number }
export type StoreNotice =
  | { kind: 'environment'; event: EnvironmentEvent }
  | { kind: 'action'; action: Action }
  | { kind: 'trace'; at: number; id: number; name: string; data: unknown }
  | { kind: 'state' };

export function initStoreSchema(db: DatabaseSync, lifeEnabled: boolean) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='events'").get() && Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 2) {
    db.close();
    throw new Error('Database identity format needs migration. Stop the daemon and run identities migrate --config <path>.');
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT, received_at INTEGER, addressed INTEGER NOT NULL DEFAULT 0, source TEXT, conversation_ref TEXT, actor_ref TEXT, ambient_flag INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS events_pending ON events(status, at);
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, importance INTEGER NOT NULL, subjects TEXT NOT NULL, conversations_json TEXT NOT NULL, fictional INTEGER NOT NULL, supersedes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, scope TEXT);
    CREATE TABLE IF NOT EXISTS sources(owner_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(owner_id,source_id));
    CREATE INDEX IF NOT EXISTS source_dependents ON sources(source_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(id,title,content) VALUES(new.id,new.title,new.content); END;
    CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE id=old.id; END;
    CREATE TABLE IF NOT EXISTS memory_vectors(memory_id TEXT NOT NULL, chunk INTEGER NOT NULL, model TEXT NOT NULL, line TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(memory_id,chunk));
    CREATE TRIGGER IF NOT EXISTS memory_vectors_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_vectors WHERE memory_id=old.id; END;
    CREATE TABLE IF NOT EXISTS memory_recalls(memory_id TEXT PRIMARY KEY, spontaneous INTEGER NOT NULL DEFAULT 0, deliberate INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS memory_recalls_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_recalls WHERE memory_id=old.id; END;
    CREATE TABLE IF NOT EXISTS memory_revisits(memory_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS memory_revisits_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_revisits WHERE memory_id=old.id; END;
    CREATE TABLE IF NOT EXISTS tombstones(source_key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS wakes(id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', rest INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS pursuits(id TEXT PRIMARY KEY, title TEXT NOT NULL, progress TEXT NOT NULL, fictional INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, action_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL, source_ids TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, conversation TEXT);
    CREATE INDEX IF NOT EXISTS action_fingerprint ON actions(fingerprint,status);
    CREATE TABLE IF NOT EXISTS action_triggers(action_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(action_id,event_id));
    CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, at INTEGER NOT NULL, run_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_time ON calls(at);
    CREATE INDEX IF NOT EXISTS actions_time ON actions(created_at);
    CREATE TABLE IF NOT EXISTS trace(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS context_records(id TEXT PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL, source_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS working_context(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  db.exec('CREATE INDEX IF NOT EXISTS event_conversation ON events(conversation_ref,at); CREATE INDEX IF NOT EXISTS event_actor ON events(actor_ref,at); CREATE INDEX IF NOT EXISTS action_conversation ON actions(conversation,created_at)');
  // sentMessage runs for every quoted message and lifeWakesSince once a minute while idle; without these each scanned its whole table.
  db.exec("CREATE INDEX IF NOT EXISTS action_message ON actions(json_extract(result,'$.message_id')) WHERE status='success'; CREATE INDEX IF NOT EXISTS event_wakes ON events(at) WHERE kind='wake'; CREATE INDEX IF NOT EXISTS trace_time ON trace(at)");
  for (const [key, value] of Object.entries({ paused: false, lifeEnabled, generation: 0, activity: '', reflectionWatermark: 0, processedTotal: 0, reviewMarks: {}, restingSince: null })) {
    db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, json(value));
  }
  db.exec('PRAGMA user_version=2');
}
