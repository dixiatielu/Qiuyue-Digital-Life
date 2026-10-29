import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Action, DevelopmentKind, EnvironmentEvent, LifeSettings, Memory, MemoryKind, Wake } from './domain.js';
import { isAmbient, isDevelopment, isHeartbeat } from './domain.js';
import { contextRecordId, persistableMessage, type ContextCheckpoint } from './context.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const id = (prefix: string) => `${prefix}:${randomUUID()}`;
export const digest = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex');
const claimable = "status='pending' AND (?=1 OR coalesce(json_extract(payload,'$.wakeKind'),'')!='life')";
/** Habits and practices hold everywhere unless they belong to one group alone; what one person wants of it belongs to its impression of them. */
const developmentScopes: Record<DevelopmentKind, RegExp> = { habit: /^(global|group:\d+)$/, practice: /^(global|group:\d+)$/, impression: /^person:\d+$/ };
/** A conversation is group:<id> or private:<qq>; its record is what happened there. */
export function conversationOf(value: string): { type: 'group' | 'private'; id: number } {
  const match = /^(group|private):(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('A conversation is group:<group ID> or private:<QQ ID>.');
  return { type: match[1] as 'group' | 'private', id: Number(match[2]) };
}
/** Chat records cite events by the first eight characters of their ID. */
export const eventRef = (eventId: string) => `#${eventId.slice(2, 10)}`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;

/** Local receive times of claimable events: the earliest waking one, the latest of any kind, and the earliest ambient one. */
export interface PendingTiming { first?: number; last?: number; ambient?: number }
export type StoreNotice =
  | { kind: 'environment'; event: EnvironmentEvent }
  | { kind: 'action'; action: Action }
  | { kind: 'trace'; at: number; id: number; name: string; data: unknown }
  | { kind: 'state' };

export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(notice: StoreNotice) => void>();
  private notices: StoreNotice[] = [];
  constructor(path: string, lifeEnabled = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.function('ambient', { deterministic: true }, kind => isAmbient(String(kind)) ? 1 : 0);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, group_id INTEGER, actor_id INTEGER, text TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT, received_at INTEGER);
      CREATE INDEX IF NOT EXISTS events_pending ON events(status, at);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, importance INTEGER NOT NULL, subjects TEXT NOT NULL, groups_json TEXT NOT NULL, fictional INTEGER NOT NULL, supersedes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(owner_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(owner_id,source_id));
      CREATE INDEX IF NOT EXISTS source_dependents ON sources(source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(id,title,content) VALUES(new.id,new.title,new.content); END;
      CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE id=old.id; END;
      CREATE TABLE IF NOT EXISTS tombstones(source_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS wakes(id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, action_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL, source_ids TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS action_fingerprint ON actions(fingerprint,status);
      CREATE TABLE IF NOT EXISTS action_triggers(action_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(action_id,event_id));
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, at INTEGER NOT NULL, run_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_time ON calls(at);
      CREATE INDEX IF NOT EXISTS actions_time ON actions(created_at);
      CREATE TABLE IF NOT EXISTS trace(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_records(id TEXT PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL, source_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS working_context(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, generation INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // Source timestamps have second precision and remote clocks; scheduling needs the local receive time.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='received_at'").get()) this.db.exec('ALTER TABLE events ADD COLUMN received_at INTEGER');
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('memories') WHERE name='scope'").get()) this.db.exec('ALTER TABLE memories ADD COLUMN scope TEXT');
    for (const [key, value] of Object.entries({ paused: false, lifeEnabled, generation: 0, activity: '', reflectionWatermark: 0, processedTotal: 0, reviewMarks: {} })) this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, json(value));
  }
  close() { this.db.close(); }
  bindAccount(selfId: number) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='selfId'").get();
    if (row && parse<number>(row.value) !== selfId) throw new Error('This database belongs to another QQ account; check the configured account and database path.');
    this.setSetting('selfId', selfId);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const start = this.notices.length;
    let value: T;
    try { value = work(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); this.notices.length = start; throw error; }
    const committed = this.notices.splice(start);
    for (const notice of committed) this.notify(notice);
    return value;
  }
  subscribe(listener: (notice: StoreNotice) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(notice: StoreNotice) {
    if (this.db.isTransaction) { this.notices.push(notice); return; }
    // Observability must never turn a committed operation into a failed action.
    for (const listener of this.listeners) { try { listener(notice); } catch {} }
  }
  setting<T>(key: string): T { return parse<T>(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)!.value); }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, json(value)); this.notify({ kind: 'state' }); }
  acquireDaemon(): () => void {
    const owner = crypto.randomUUID();
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM settings WHERE key='daemon'").get();
      if (row) {
        const previous = parse<{ pid: number }>(row.value);
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error(`This digital life already has a daemon (PID ${previous.pid}); a second instance cannot start.`);
      }
      this.setSetting('daemon', { pid: process.pid, owner });
    });
    return () => { const row = this.db.prepare("SELECT value FROM settings WHERE key='daemon'").get(); if (row && parse<{ owner: string }>(row.value).owner === owner) this.db.prepare("DELETE FROM settings WHERE key='daemon'").run(); };
  }
  setActivity(activity: string, sources: string[]) {
    this.transaction(() => {
      this.setSetting('activity', activity);
      this.db.prepare("DELETE FROM sources WHERE owner_id='state:activity'").run();
      for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run('state:activity', source);
    });
  }
  settings(): LifeSettings { return { paused: this.setting('paused'), lifeEnabled: this.setting('lifeEnabled'), generation: this.setting('generation'), activity: this.setting('activity') }; }
  bumpGeneration() { this.setSetting('generation', this.setting<number>('generation') + 1); }
  log(kind: string, data: unknown) { const at = Date.now(); const row = this.db.prepare('INSERT INTO trace(at,kind,data) VALUES (?,?,?)').run(at, kind, json(data)); this.notify({ kind: 'trace', at, id: Number(row.lastInsertRowid), name: kind, data }); }
  logs(limit = 30) { return this.db.prepare('SELECT * FROM trace ORDER BY id DESC LIMIT ?').all(limit).map(row => ({ id: Number(row.id), at: Number(row.at), kind: String(row.kind), data: parse(row.data) })); }
  visibleHistory() {
    return {
      events: this.db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 30').all().reverse().map(row => this.eventRow(row)),
      messages: this.db.prepare("SELECT id,at,message FROM context_records WHERE json_extract(message,'$.role') IN ('assistant','toolResult') ORDER BY at DESC,rowid DESC LIMIT 40").all().reverse().map(row => ({ id: String(row.id), at: Number(row.at), message: parse<AgentMessage>(row.message) })),
      actions: this.actions().reverse(),
      logs: this.logs(20).reverse(),
    };
  }
  archiveContext(messages: AgentMessage[], sources: string[]): string[] {
    const write = () => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO context_records VALUES (?,?,?,?)');
      return messages.map(message => {
        const saved = persistableMessage(message); const recordId = contextRecordId(saved);
        insert.run(recordId, Date.now(), json(saved), json(sources));
        return recordId;
      });
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  contextRecord(recordId: string): { id: string; message: AgentMessage; sources: string[] } | undefined {
    const row = this.db.prepare('SELECT * FROM context_records WHERE id=?').get(recordId);
    return row ? { id: recordId, message: parse(row.message), sources: parse(row.source_ids) } : undefined;
  }
  loadContext(identity: string): ContextCheckpoint | undefined {
    const row = this.db.prepare('SELECT * FROM working_context WHERE id=1 AND identity=? AND generation=?').get(identity, this.settings().generation);
    if (!row) return;
    const data = parse<Omit<ContextCheckpoint, 'messages'> & { messageIds: string[] }>(row.data);
    const records = data.messageIds.map(recordId => this.contextRecord(recordId));
    if (records.some(record => !record)) return;
    return { ...data, messages: records.map(record => record!.message) };
  }
  saveContext(checkpoint: ContextCheckpoint, batches: string[] = [], compactions: Record<string, unknown>[] = []) {
    this.transaction(() => {
      if (checkpoint.generation !== this.settings().generation || this.settings().paused) throw new Error('Management state changed; the old working context cannot be saved.');
      const messageIds = this.archiveContext(checkpoint.messages, checkpoint.sources);
      const { messages: _messages, ...data } = checkpoint;
      this.db.prepare('INSERT INTO working_context VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,generation=excluded.generation,data=excluded.data,updated_at=excluded.updated_at').run(checkpoint.identity, checkpoint.generation, json({ ...data, messageIds }), Date.now());
      for (const batch of batches) {
        const ids = this.db.prepare('SELECT id FROM events WHERE batch_id=?').all(batch).map(row => String(row.id));
        const count = Number(this.db.prepare("UPDATE events SET status='processed',batch_id=NULL WHERE batch_id=?").run(batch).changes);
        this.setSetting('processedTotal', this.processedCount() + count);
        this.notifyEvents(ids);
      }
      for (const compacted of compactions) this.log('context_compacted', compacted);
    });
  }
  receive(input: Omit<EnvironmentEvent, 'id' | 'status' | 'receivedAt'>, processed = false): EnvironmentEvent | undefined {
    processed ||= isHeartbeat(input.kind);
    if (this.db.prepare('SELECT 1 FROM tombstones WHERE source_key=?').get(input.key)) return;
    const eventId = id('e'); const receivedAt = Date.now();
    const result = this.db.prepare('INSERT OR IGNORE INTO events(id,source_key,kind,at,group_id,actor_id,text,payload,status,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(eventId, input.key, input.kind, input.at, input.groupId ?? null, input.actorId ?? null, input.text, json(input.payload), processed ? 'processed' : 'pending', receivedAt);
    if (!result.changes) return;
    const event: EnvironmentEvent = { ...input, id: eventId, status: processed ? 'processed' : 'pending', receivedAt };
    this.notify({ kind: 'environment', event }); return event;
  }
  /** Resolve a #xxxxxxxx reference from a chat record to its full event ID; other IDs pass through. */
  resolve(reference: string): string {
    if (!/^#[0-9a-f]{8}$/.test(reference)) return reference;
    const rows = this.db.prepare('SELECT id FROM events WHERE id>=? AND id<? LIMIT 2').all(`e:${reference.slice(1)}`, `e:${reference.slice(1)}~`);
    if (rows.length !== 1) throw new Error(rows.length ? `Reference ${reference} is ambiguous; use the full event ID.` : `Reference ${reference} does not exist or has been deleted.`);
    return String(rows[0]!.id);
  }
  private eventRow(row: Record<string, any>): EnvironmentEvent { return { id: row.id, key: row.source_key, kind: row.kind, at: row.at, groupId: row.group_id ?? undefined, actorId: row.actor_id ?? undefined, text: row.text, payload: parse(row.payload), status: row.status, receivedAt: row.received_at ?? undefined }; }
  event(eventId: string): EnvironmentEvent | undefined { const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId); return row ? this.eventRow(row) : undefined; }
  recent(limit: number): EnvironmentEvent[] { return this.db.prepare("SELECT * FROM events WHERE status='processed' AND kind!='meta_event:heartbeat' AND kind NOT LIKE 'meta_event:heartbeat:%' ORDER BY at DESC LIMIT ?").all(limit).reverse().map(row => this.eventRow(row)); }
  claim(limit: number, allowLife = true): { batchId: string; events: EnvironmentEvent[] } | undefined {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM events WHERE ${claimable} ORDER BY at,rowid LIMIT ?`).all(allowLife ? 1 : 0, limit);
      if (!rows.length) return;
      const batchId = id('b');
      for (const row of rows) this.db.prepare("UPDATE events SET status='processing',batch_id=? WHERE id=?").run(batchId, String(row.id));
      this.notifyEvents(rows.map(row => String(row.id)));
      return { batchId, events: rows.map(row => this.eventRow(row)) };
    });
  }
  acknowledge(batchId: string) {
    this.transaction(() => {
      const ids = this.db.prepare('SELECT id FROM events WHERE batch_id=?').all(batchId).map(row => String(row.id));
      const count = Number(this.db.prepare("UPDATE events SET status='processed',batch_id=NULL WHERE batch_id=?").run(batchId).changes);
      this.setSetting('processedTotal', this.processedCount() + count);
      this.notifyEvents(ids);
    });
  }
  private notifyEvents(ids: string[]) { for (const id of ids) { const event = this.event(id); if (event) this.notify({ kind: 'environment', event }); } }
  releaseBatch(batchId: string) { const ids = this.db.prepare('SELECT id FROM events WHERE batch_id=?').all(batchId).map(row => String(row.id)); this.db.prepare("UPDATE events SET status='pending',batch_id=NULL WHERE batch_id=?").run(batchId); this.notifyEvents(ids); }
  releaseClaims() { const ids = this.db.prepare("SELECT id FROM events WHERE status='processing'").all().map(row => String(row.id)); this.db.prepare("UPDATE events SET status='pending',batch_id=NULL WHERE status='processing'").run(); this.notifyEvents(ids); }
  recover() {
    this.transaction(() => {
      // Heartbeats queued by older versions must not wake the model or advance reflection counters.
      this.db.prepare("UPDATE events SET status='processed',batch_id=NULL WHERE status!='processed' AND (kind='meta_event:heartbeat' OR kind LIKE 'meta_event:heartbeat:%')").run();
      this.releaseClaims();
      const pending = this.db.prepare("SELECT id FROM actions WHERE status='pending'").all();
      this.db.prepare("UPDATE actions SET status='unknown',result=? WHERE status='pending'").run(json({ reason: 'Process interrupted; the remote outcome is unconfirmed' }));
      for (const row of pending) this.notify({ kind: 'action', action: this.actionById(String(row.id))! });
      this.notify({ kind: 'state' });
    });
  }
  pendingTiming(allowLife = true): PendingTiming {
    // Rows from before received_at existed count as long overdue.
    const row = this.db.prepare(`SELECT min(CASE WHEN ambient(kind) THEN NULL ELSE coalesce(received_at,0) END) AS first, max(coalesce(received_at,0)) AS last, min(CASE WHEN ambient(kind) THEN coalesce(received_at,0) END) AS ambient FROM events WHERE ${claimable}`).get(allowLife ? 1 : 0)!;
    const time = (value: unknown) => value == null ? undefined : Number(value);
    return { first: time(row.first), last: time(row.last), ambient: time(row.ambient) };
  }
  pending() { return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE status='pending'").get()!.n); }
  processedCount() { return this.setting<number>('processedTotal'); }
  latestGroupMessage(groupId: number): number | undefined {
    const row = this.db.prepare("SELECT json_extract(payload,'$.message_id') AS message_id FROM events WHERE group_id=? AND kind='message' ORDER BY at DESC LIMIT 1").get(groupId);
    return row?.message_id == null ? undefined : Number(row.message_id);
  }
  private memoryRow(row: Record<string, any>): Memory {
    return { id: row.id, kind: row.kind, title: row.title, content: row.content, importance: row.importance, subjects: parse(row.subjects), groups: parse(row.groups_json), fictional: Boolean(row.fictional), sources: this.db.prepare('SELECT source_id FROM sources WHERE owner_id=?').all(row.id).map(x => String(x.source_id)), supersedes: row.supersedes ?? undefined, ...(row.scope ? { scope: row.scope } : {}), active: Boolean(row.active), createdAt: row.created_at };
  }
  memory(memoryId: string): Memory | undefined { const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId); return row ? this.memoryRow(row) : undefined; }
  /** Limits bound the digital life's own development writes; operator corrections pass none. */
  writeMemory(input: { kind: MemoryKind; title: string; content: string; importance: number; subjects?: string[]; sources: string[]; supersedes?: string; scope?: string }, allowFiction: boolean, limits?: { scopeChars: number; personChars: number }): Memory {
    if (!input.content.trim() || input.content.length > 12_000 || input.title.length > 200) throw new Error('Memory content is empty or too long.');
    if (!['experience', 'understanding', 'fiction', 'note'].includes(input.kind) && !isDevelopment(input.kind)) throw new Error('Unknown memory type.');
    if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 10) throw new Error('Importance must be between 1 and 10.');
    const sources = [...new Set(input.sources.map(source => this.resolve(source)))];
    const scope = isDevelopment(input.kind) ? input.scope ?? (input.kind === 'impression' ? undefined : 'global') : undefined;
    let subjects = input.subjects ?? [];
    if (isDevelopment(input.kind)) {
      if (!scope || !developmentScopes[input.kind].test(scope)) throw new Error('A habit or practice scope is global (the default) or group:<id> for what belongs to that group alone; an impression scope is person:<qq>.');
      if (input.kind === 'impression') {
        const existing = this.db.prepare("SELECT id FROM memories WHERE active=1 AND kind='impression' AND scope=? AND id IS NOT ?").get(scope, input.supersedes ?? null);
        if (existing) throw new Error(`An impression of this person already exists (${existing.id}); revise it with supersedes.`);
        subjects = [...new Set([...subjects, scope.slice('person:'.length)])];
      }
      // Self-description drawn only from its own output would feed back into every later thought.
      if (input.kind !== 'practice' && sources.every(source => this.ownMessage(source))) throw new Error('A habit or impression cannot rest only on your own messages; cite how others acted or responded.');
      if (limits) {
        const cap = scope.startsWith('person:') ? limits.personChars : limits.scopeChars;
        // Habits and practices are bounded apart, so what it observes cannot crowd out what it keeps.
        const used = Number(this.db.prepare('SELECT coalesce(sum(length(content)),0) AS n FROM memories WHERE active=1 AND scope=? AND kind=? AND id IS NOT ?').get(scope, input.kind, input.supersedes ?? null)!.n);
        if (used + input.content.length > cap) throw new Error(`Your ${input.kind}s in ${scope} would reach ${used + input.content.length} characters, above the limit of ${cap}; merge entries with supersedes or retire some with retire_memory first.`);
      }
    }
    if (!sources.length && input.kind !== 'fiction') throw new Error('A memory must reference IDs of actual experiences or existing memories.');
    let fictional = input.kind === 'fiction';
    const groups = new Set<number>();
    for (const source of sources) {
      const event = this.event(source); const memory = this.memory(source);
      if (!event && !memory) throw new Error(`Source does not exist or has been deleted: ${source}`);
      if (memory && !memory.active) throw new Error(`Source has been revised; read its current version first: ${source}`);
      if (event?.groupId) groups.add(event.groupId);
      for (const group of memory?.groups ?? []) groups.add(group);
      fictional ||= memory?.fictional ?? false;
    }
    if (fictional && !allowFiction) throw new Error('Fictional daily life is disabled; fictional experiences and derived content cannot be saved.');
    const previous = input.supersedes ? this.memory(input.supersedes) : undefined;
    if (input.supersedes && (!previous || !previous.active)) throw new Error('The memory to revise does not exist or has already been revised.');
    for (const group of previous?.groups ?? []) groups.add(group);
    fictional ||= previous?.fictional ?? false;
    if (fictional && !allowFiction) throw new Error('Fictional daily life and revisions must retain their fictional sources.');
    const memoryId = id('m');
    this.transaction(() => {
      this.db.prepare('INSERT INTO memories(id,kind,title,content,importance,subjects,groups_json,fictional,supersedes,active,created_at,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(memoryId, input.kind, input.title, input.content, input.importance, json(subjects), json([...groups]), fictional ? 1 : 0, input.supersedes ?? null, 1, Date.now(), scope ?? null);
      for (const source of sources) this.db.prepare('INSERT INTO sources VALUES (?,?)').run(memoryId, source);
      if (previous) {
        // A correction invalidates dependent interpretations, while preserving their history.
        this.db.prepare(`WITH RECURSIVE dependent(id) AS (SELECT ? UNION SELECT owner_id FROM sources JOIN dependent ON source_id=dependent.id)
          UPDATE memories SET active=0 WHERE id IN (SELECT id FROM dependent) AND id!=?`).run(previous.id, memoryId);
        this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(memoryId, previous.id);
        const revision = this.receive({ key: `revision:${memoryId}`, kind: 'memory_revision', at: Date.now(), text: 'An understanding has been revised; interpretations depending on the old understanding have been removed from everyday recall. Check affected activities and commitments.', payload: { memoryId, supersedes: previous.id } });
        if (revision) this.db.prepare('INSERT INTO sources VALUES (?,?)').run(revision.id, memoryId);
      }
      this.log('memory_written', { id: memoryId, kind: input.kind, supersedes: input.supersedes, ...(scope ? { scope } : {}) });
    });
    return this.memory(memoryId)!;
  }
  private ownMessage(source: string): boolean {
    const event = this.event(source); if (!event) return false;
    const self = this.db.prepare("SELECT value FROM settings WHERE key='selfId'").get();
    return event.kind.startsWith('snowluma:send_') || (event.kind === 'message' && self !== undefined && event.actorId === parse<number>(self.value));
  }
  /** Development that applies in any of the given scopes, oldest first. */
  development(scopes: string[]): Memory[] {
    if (!scopes.length) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE active=1 AND scope IN (${scopes.map(() => '?').join(',')}) ORDER BY created_at,rowid`).all(...scopes).map(row => this.memoryRow(row));
  }
  /** Development that no longer holds leaves everyday use; its history remains. */
  retireMemory(memoryId: string): Memory {
    const memory = this.memory(memoryId);
    if (!memory?.active || !isDevelopment(memory.kind)) throw new Error('Only a current habit, practice, or impression can be retired.');
    this.transaction(() => { this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(memoryId); this.log('memory_retired', { id: memoryId, kind: memory.kind, scope: memory.scope }); });
    return { ...memory, active: false };
  }
  search(query: string, limit = 8, subjects: string[] = [], groups: number[] = [], historical = false, exclude: readonly MemoryKind[] = []): Memory[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 30);
    const candidates = new Map<string, Record<string, any>>();
    const active = historical ? '' : ' AND active=1';
    for (const row of this.db.prepare(`SELECT * FROM memories WHERE 1=1${active} ORDER BY importance DESC,created_at DESC LIMIT 200`).all()) candidates.set(String(row.id), row);
    for (const term of terms) {
      for (const row of this.db.prepare(`SELECT * FROM memories WHERE (instr(lower(title),?)>0 OR instr(lower(content),?)>0)${active} LIMIT 100`).all(term, term)) candidates.set(String(row.id), row);
      for (const row of this.db.prepare(`SELECT * FROM memories WHERE EXISTS (SELECT 1 FROM json_each(subjects) WHERE instr(lower(value),?)>0)${active} LIMIT 100`).all(term)) candidates.set(String(row.id), row);
      if (term.length >= 3) for (const row of this.db.prepare(`SELECT m.* FROM memories m JOIN memories_fts f ON f.id=m.id WHERE memories_fts MATCH ?${active} LIMIT 100`).all(`"${term.replaceAll('"', '""')}"`)) candidates.set(String(row.id), row);
    }
    for (const subject of subjects) for (const row of this.db.prepare(`SELECT * FROM memories WHERE EXISTS (SELECT 1 FROM json_each(subjects) WHERE value=?)${active}`).all(subject)) candidates.set(String(row.id), row);
    const now = Date.now();
    return [...candidates.values()].map(row => {
      const memory = this.memoryRow(row);
      const text = `${memory.title} ${memory.content}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term) || memory.subjects.some(subject => subject.toLowerCase().includes(term))).length;
      const person = memory.subjects.some(x => subjects.includes(x)) ? 8 : 0;
      const place = memory.groups.some(x => groups.includes(x)) ? 2 : 0;
      const recency = Math.exp(-(now - memory.createdAt) / (30 * 86_400_000));
      return { memory, score: matches * 5 + person + place + memory.importance / 3 + recency, relevant: !query.trim() || matches > 0 || person > 0 || place > 0 };
    }).filter(x => x.relevant && !exclude.includes(x.memory.kind)).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.memory);
  }
  forgetPlan(root: string): string[] {
    if (!this.memory(root) && !this.event(root)) throw new Error('Record does not exist.');
    const selected = new Set<string>([root]);
    // Explicit forgetting includes original evidence, preventing re-extraction from it.
    const ancestors = [root];
    while (ancestors.length) for (const row of this.db.prepare('SELECT source_id FROM sources WHERE owner_id=?').all(ancestors.pop()!)) {
      const source = String(row.source_id);
      if (!selected.has(source)) { selected.add(source); ancestors.push(source); }
    }
    const dependents = [...selected];
    while (dependents.length) for (const row of this.db.prepare('SELECT owner_id FROM sources WHERE source_id=?').all(dependents.pop()!)) {
      const child = String(row.owner_id);
      if (!selected.has(child)) { selected.add(child); dependents.push(child); }
    }
    return [...selected];
  }
  forget(root: string): string[] {
    const selected = this.forgetPlan(root);
    this.transaction(() => {
      for (const selectedId of selected) {
        const event = this.event(selectedId);
        if (event) this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(event.key);
        this.db.prepare('DELETE FROM sources WHERE owner_id=? OR source_id=?').run(selectedId, selectedId);
        this.db.prepare('DELETE FROM memories WHERE id=?').run(selectedId);
        this.db.prepare('DELETE FROM events WHERE id=?').run(selectedId);
        this.db.prepare('DELETE FROM wakes WHERE id=?').run(selectedId);
        if (selectedId === 'state:activity') this.setSetting('activity', '');
      }
      // Action results can contain the original message text; retain only outcome metadata.
      for (const row of this.db.prepare('SELECT * FROM actions').all()) if (parse<string[]>(row.source_ids).some(x => selected.includes(x))) this.db.prepare("UPDATE actions SET args='{}',result=?,source_ids='[]' WHERE id=?").run(json({ redacted: true }), String(row.id));
      this.db.exec('DELETE FROM working_context; DELETE FROM context_records;');
      this.bumpGeneration(); this.log('memory_forgotten', { ids: selected });
    });
    return selected;
  }
  retain(days: number, now = Date.now()): number {
    this.db.prepare('DELETE FROM working_context WHERE updated_at<?').run(now - days * 86_400_000);
    this.db.prepare("DELETE FROM context_records WHERE at<? AND id NOT IN (SELECT j.value FROM working_context,json_each(json_extract(data,'$.messageIds')) j)").run(now - days * 86_400_000);
    return Number(this.db.prepare(`DELETE FROM events WHERE status='processed' AND at<? AND NOT EXISTS (SELECT 1 FROM sources WHERE source_id=events.id) AND NOT EXISTS (SELECT 1 FROM actions,json_each(actions.source_ids) j WHERE j.value=events.id AND actions.status IN ('pending','unknown'))`).run(now - days * 86_400_000).changes);
  }
  schedule(title: string, kind: Wake['kind'], dueAt: number, sources: string[] = []): Wake {
    if (!Number.isFinite(dueAt)) throw new Error('Invalid wake time.');
    if (this.wakes().length >= 100) throw new Error('The 100 unfinished activity limit has been reached; organize existing commitments and plans first.');
    const wakeId = id('w');
    this.transaction(() => {
      this.db.prepare('INSERT INTO wakes(id,title,kind,due_at) VALUES (?,?,?,?)').run(wakeId, title, kind, dueAt);
      for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(wakeId, source);
    });
    return { id: wakeId, title, kind, dueAt, status: 'pending' };
  }
  wakes(): Wake[] { return this.db.prepare("SELECT * FROM wakes WHERE status IN ('pending','queued') ORDER BY due_at").all().map(row => ({ id: String(row.id), title: String(row.title), kind: row.kind as Wake['kind'], dueAt: Number(row.due_at), status: row.status as Wake['status'] })); }
  finishWake(wakeId: string, status: 'done' | 'cancelled') { if (!this.db.prepare('UPDATE wakes SET status=? WHERE id=?').run(status, wakeId).changes) throw new Error('Activity does not exist.'); }
  enqueueDue(now = Date.now()) {
    const settings = this.settings(); if (settings.paused) return;
    this.transaction(() => {
      for (const wake of this.wakes()) if (wake.status === 'pending' && wake.dueAt <= now && (wake.kind !== 'life' || settings.lifeEnabled)) {
        const event = this.receive({ key: wake.id, kind: 'wake', at: now, text: `Activity due (decide whether it is still appropriate now): ${wake.title}`, payload: { wakeId: wake.id, wakeKind: wake.kind, dueAt: wake.dueAt } });
        if (event) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(event.id, wake.id);
        this.db.prepare("UPDATE wakes SET status='queued' WHERE id=?").run(wake.id);
      }
    });
  }
  /** Where review stopped reading a conversation: the time of its first unread item. Review looks back at most a day. */
  reviewMark(conversation: string, now = Date.now()): number { return Math.max(this.setting<Record<string, number>>('reviewMarks')[conversation] ?? 0, now - 86_400_000); }
  markReviewed(conversation: string, through: number) {
    const marks = this.setting<Record<string, number>>('reviewMarks');
    if (through > (marks[conversation] ?? 0)) this.setSetting('reviewMarks', { ...marks, [conversation]: through });
  }
  /** Conversations with messages from others that review has not read yet. */
  reviewBacklog(selfId: number, now = Date.now()): { conversation: string; messages: number; since: number }[] {
    return this.db.prepare(`WITH marks AS (SELECT key AS conversation, value AS at FROM json_each((SELECT value FROM settings WHERE key='reviewMarks')))
      SELECT c.conversation, count(*) AS messages, min(c.at) AS since FROM (SELECT CASE WHEN group_id IS NOT NULL THEN 'group:'||group_id ELSE 'private:'||actor_id END AS conversation, at FROM events WHERE kind='message' AND actor_id IS NOT NULL AND actor_id!=?) c
      LEFT JOIN marks m USING(conversation) WHERE c.at>=max(coalesce(m.at,0),?) GROUP BY c.conversation ORDER BY messages DESC`).all(selfId, now - 86_400_000)
      .map(row => ({ conversation: String(row.conversation), messages: Number(row.messages), since: Number(row.since) }));
  }
  /** People with an impression who spoke in these conversations since the given times, latest first. */
  impressionsIn(chats: { conversation: string; since: number }[], selfId: number, limit: number): number[] {
    const last = new Map<number, number>();
    for (const chat of chats) {
      const filter = this.recordFilter(chat.conversation);
      for (const row of this.db.prepare(`SELECT actor_id, max(at) AS at FROM events WHERE ${filter.events} AND kind='message' AND at>=? AND actor_id!=? AND EXISTS (SELECT 1 FROM memories WHERE active=1 AND kind='impression' AND scope='person:'||events.actor_id) GROUP BY actor_id`).all(filter.target, chat.since, selfId)) {
        last.set(Number(row.actor_id), Math.max(last.get(Number(row.actor_id)) ?? 0, Number(row.at)));
      }
    }
    return [...last].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([person]) => person);
  }
  private recordFilter(conversation: string) {
    const { type, id: target } = conversationOf(conversation);
    // Typing notices say nothing about how anyone talks; reactions, recalls, and pokes do.
    return { target, events: `${type === 'group' ? 'group_id=?' : 'group_id IS NULL AND actor_id=?'} AND (kind='message' OR kind LIKE 'notice:%') AND kind!='notice:notify:input_status'`, actions: `status='success' AND ${type === 'group' ? "CAST(json_extract(args,'$.group_id') AS INTEGER)=?" : "json_extract(args,'$.group_id') IS NULL AND CAST(json_extract(args,'$.user_id') AS INTEGER)=?"}` };
  }
  /** A page of one conversation from a time on: messages and notices, with this account's completed actions there. Events sharing the last time stay together. */
  conversationRecord(conversation: string, from: number, limit: number): { events: EnvironmentEvent[]; actions: Action[]; complete: boolean } {
    const filter = this.recordFilter(conversation);
    const edge = this.db.prepare(`SELECT at FROM events WHERE ${filter.events} AND at>=? ORDER BY at,rowid LIMIT 1 OFFSET ?`).get(filter.target, from, limit - 1);
    const end = edge ? Number(edge.at) : Number.MAX_SAFE_INTEGER;
    return {
      events: this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND at>=? AND at<=? ORDER BY at,rowid`).all(filter.target, from, end).map(row => this.eventRow(row)),
      actions: this.db.prepare(`SELECT * FROM actions WHERE ${filter.actions} AND created_at>=? AND created_at<=? ORDER BY created_at`).all(filter.target, from, end).map(row => this.action(row)),
      complete: !edge,
    };
  }
  /** The latest items of one conversation containing a phrase or written by one person. */
  conversationMatches(conversation: string, limit: number, match: { query?: string; person?: number; selfId: number }): { events: EnvironmentEvent[]; actions: Action[] } {
    const filter = this.recordFilter(conversation);
    const query = match.query?.toLowerCase();
    const mine = match.person === match.selfId;
    const events = mine ? [] : this.db.prepare(`SELECT * FROM events WHERE ${filter.events}${query ? ' AND instr(lower(text),?)>0' : ''}${match.person ? ' AND actor_id=?' : ''} ORDER BY at DESC,rowid DESC LIMIT ?`).all(filter.target, ...(query ? [query] : []), ...(match.person ? [match.person] : []), limit).map(row => this.eventRow(row));
    const actions = match.person && !mine ? [] : this.db.prepare(`SELECT * FROM actions WHERE ${filter.actions}${query ? ' AND instr(lower(args),?)>0' : ''} ORDER BY created_at DESC LIMIT ?`).all(filter.target, ...(query ? [query] : []), limit).map(row => this.action(row));
    return { events: events.reverse(), actions: actions.reverse() };
  }
  /** The message a reply or reaction points at, when it is still retained. */
  messageById(conversation: string, messageId: number): EnvironmentEvent | undefined {
    const filter = this.recordFilter(conversation);
    const row = this.db.prepare(`SELECT * FROM events WHERE ${filter.events} AND kind='message' AND json_extract(payload,'$.message_id')=? LIMIT 1`).get(filter.target, messageId);
    return row ? this.eventRow(row) : undefined;
  }
  /** QQ system face names by ID, as last read from SnowLuma; empty until then. */
  faceNames(): Record<string, string> { const row = this.db.prepare("SELECT value FROM settings WHERE key='faceNames'").get(); return row ? parse(row.value) : {}; }
  setFaceNames(names: Record<string, string>) { this.setSetting('faceNames', names); }
  /** The description last given to a saved sticker. */
  stickerNote(emojiId: string): string | undefined {
    const row = this.db.prepare("SELECT json_extract(args,'$.desc') AS note FROM actions WHERE kind='modify_custom_face' AND status='success' AND json_extract(args,'$.emoji_id')=? ORDER BY created_at DESC LIMIT 1").get(emojiId);
    return row?.note ? String(row.note) : undefined;
  }
  /** Whether a sticker was saved, apart from one save of it, and not deleted since. */
  stickerSaved(emojiId: string, except?: string): boolean {
    const added = this.db.prepare("SELECT max(created_at) AS at FROM actions WHERE kind='add_custom_face' AND status='success' AND json_extract(result,'$.emoji_id')=? AND id IS NOT ?").get(emojiId, except ?? null)?.at;
    return added != null && !this.db.prepare("SELECT 1 FROM actions WHERE kind='delete_custom_face' AND status='success' AND json_extract(args,'$.emoji_id')=? AND created_at>=?").get(emojiId, added);
  }
  /** The saved sticker a received image already is. QQ names a saved image by its MD5, which a received image carries as its file name; a market face is known by the emoji_id in the URL it was saved from. */
  savedSticker(image: Record<string, unknown>): { emojiId: string; desc?: string } | undefined {
    const md5 = /^([0-9a-f]{32})\.\w+$/i.exec(String(image.file ?? ''))?.[1];
    const market = /^[0-9a-f]{32}$/i.test(String(image.emoji_id ?? '')) ? String(image.emoji_id) : undefined;
    if (!md5 && !market) return;
    const row = this.db.prepare(`SELECT json_extract(result,'$.emoji_id') AS id FROM actions WHERE kind='add_custom_face' AND status='success' AND ${md5 ? "instr(upper(json_extract(result,'$.emoji_id')), ?)" : "instr(json_extract(args,'$.file'), ?)"} ORDER BY created_at DESC LIMIT 1`).get(md5 ? `_${md5.toUpperCase()}_` : market!);
    const emojiId = row?.id == null ? undefined : String(row.id);
    return emojiId && this.stickerSaved(emojiId) ? { emojiId, desc: this.stickerNote(emojiId) } : undefined;
  }
  sentMessage(messageId: number): boolean { return !!this.db.prepare("SELECT 1 FROM actions WHERE status='success' AND json_extract(result,'$.message_id')=? LIMIT 1").get(messageId); }
  /** The latest group card or nickname someone used, and a group's latest name. */
  latestSender(userId: number): { card?: string; nickname?: string } | undefined {
    const row = this.db.prepare("SELECT json_extract(payload,'$.sender') AS sender FROM events WHERE kind='message' AND actor_id=? AND json_extract(payload,'$.sender') IS NOT NULL ORDER BY at DESC LIMIT 1").get(userId);
    return row ? parse(row.sender) : undefined;
  }
  groupName(groupId: number): string | undefined {
    const row = this.db.prepare("SELECT json_extract(payload,'$.group_name') AS name FROM events WHERE group_id=? AND kind='message' AND json_extract(payload,'$.group_name') IS NOT NULL ORDER BY at DESC LIMIT 1").get(groupId);
    return row ? String(row.name) : undefined;
  }
  action(row: Record<string, any>): Action { return { id: row.id, key: row.action_key, fingerprint: row.fingerprint, kind: row.kind, args: parse(row.args), sources: parse(row.source_ids), status: row.status, result: row.result ? parse(row.result) : null, createdAt: row.created_at }; }
  actions(limit = 20): Action[] { return this.db.prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT ?').all(limit).map(row => this.action(row)); }
  actionById(actionId: string): Action | undefined { const row = this.db.prepare('SELECT * FROM actions WHERE id=?').get(actionId); return row ? this.action(row) : undefined; }
  lastMemoryAt(kind: MemoryKind): number | undefined { const row = this.db.prepare('SELECT max(created_at) AS at FROM memories WHERE kind=?').get(kind); return row?.at == null ? undefined : Number(row.at); }
  lastSuccessfulAction(kind: string): Action | undefined { const row = this.db.prepare("SELECT * FROM actions WHERE kind=? AND status='success' ORDER BY created_at DESC LIMIT 1").get(kind); return row ? this.action(row) : undefined; }
  /** Latest time each experience kind was recorded; read-only tool calls leave an experience but no action. */
  lastExperienced(kinds: string[]): Record<string, number> {
    if (!kinds.length) return {};
    const rows = this.db.prepare(`SELECT kind, max(at) AS at FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) GROUP BY kind`).all(...kinds);
    return Object.fromEntries(rows.map(row => [String(row.kind), Number(row.at)]));
  }
  beginAction(key: string, kind: string, args: Record<string, unknown>, sources: string[], triggers: string[] = [], hourlyLimit?: number | null): { action: Action; fresh: boolean } {
    return this.transaction(() => {
      const fingerprint = digest({ kind, args: canonical(args) });
      const existing = this.db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('The same action key cannot be used for different actions.');
        return { action: this.action(existing), fresh: false };
      }
      const unknown = this.db.prepare("SELECT * FROM actions WHERE fingerprint=? AND status IN ('pending','unknown') LIMIT 1").get(fingerprint);
      if (unknown) return { action: this.action(unknown), fresh: false };
      // Replaying the same observation after an abort must not repeat a completed action,
      // even when the runtime assigns a fresh key. New events may produce the same text.
      for (const trigger of triggers) {
        const completed = this.db.prepare("SELECT a.* FROM actions a JOIN action_triggers t ON t.action_id=a.id WHERE a.fingerprint=? AND a.status='success' AND t.event_id=? LIMIT 1").get(fingerprint, trigger);
        if (completed) return { action: this.action(completed), fresh: false };
      }
      if (hourlyLimit != null && this.hourlyActions() >= hourlyLimit) throw new Error('The external action rate limit has been reached.');
      const actionId = id('a');
      this.db.prepare('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?)').run(actionId, key, fingerprint, kind, json(args), json(sources), 'pending', null, Date.now());
      for (const trigger of triggers) this.db.prepare('INSERT OR IGNORE INTO action_triggers VALUES (?,?)').run(actionId, trigger);
      const action = this.action(this.db.prepare('SELECT * FROM actions WHERE id=?').get(actionId)!);
      this.notify({ kind: 'action', action }); return { action, fresh: true };
    });
  }
  finishAction(actionId: string, status: Action['status'], result: unknown) {
    const existing = this.db.prepare('SELECT result FROM actions WHERE id=?').get(actionId);
    const redacted = existing?.result && parse<{ redacted?: boolean }>(existing.result).redacted;
    this.db.prepare('UPDATE actions SET status=?,result=? WHERE id=?').run(status, json(redacted ? { redacted: true } : result), actionId);
    this.log('action_result', { id: actionId, status });
    const action = this.actionById(actionId); if (action) this.notify({ kind: 'action', action });
  }
  hourlyActions(now = Date.now()) { return Number(this.db.prepare('SELECT count(*) AS n FROM actions WHERE created_at>?').get(now - 3_600_000)!.n); }
  dailyCalls(now = Date.now()) { return Number(this.db.prepare("SELECT count(*) AS n FROM calls WHERE at>=?").get(Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000)!.n); }
  chargeCall(runId: string, limit: number | null) { this.transaction(() => { if (limit !== null && this.dailyCalls() >= limit) throw new Error('The daily model call budget has been exhausted.'); this.db.prepare('INSERT INTO calls VALUES (?,?,?)').run(id('call'), Date.now(), runId); }); }
  status() { return { ...this.settings(), pendingEvents: this.pending(), modelCallsToday: this.dailyCalls(), actionsThisHour: this.hourlyActions(), memories: this.db.prepare('SELECT count(*) AS n FROM memories').get()!.n, wakes: this.wakes(), actions: this.actions() }; }
}
