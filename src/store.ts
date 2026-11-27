import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { validateSource, type ConversationType, type PlatformIdentity } from './identity.js';
import { isHeartbeat, type Action, type EnvironmentEvent, type LifeSettings, type Memory, type MemoryKind, type Pursuit, type Wake } from './domain.js';
import { contextRecordId, persistableMessage, type ContextCheckpoint } from './context.js';
import {
  actionFingerprint,
  claimableSql,
  digest,
  entryTitle,
  eventRef,
  initStoreSchema,
  json,
  makeId,
  parse,
  restHoldsSql,
  transportEventSql,
  type DevelopmentLimits,
  type MemoryInput,
  type PendingTiming,
  type RevisionReach,
  type Revisit,
  type StoreNotice,
} from './store/schema.js';
import { readActionRow, readEvent, readEventRow } from './store/queries.js';
import { MemoryStore } from './store/memory.js';
import { ConversationStore } from './store/conversations.js';

export {
  actionFingerprint,
  digest,
  entryTitle,
  eventRef,
  type DevelopmentLimits,
  type MemoryInput,
  type PendingTiming,
  type RevisionReach,
  type Revisit,
  type StoreNotice,
};

export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(notice: StoreNotice) => void>();
  private notices: StoreNotice[] = [];
  private readonly memories: MemoryStore;
  private readonly conversations: ConversationStore;

  constructor(path: string, lifeEnabled = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (path !== ':memory:' && existsSync(`${path}.identities.lock`)) throw new Error('Identity migration is in progress.');
    this.db = new DatabaseSync(path);
    initStoreSchema(this.db, lifeEnabled);
    this.memories = new MemoryStore(this);
    this.conversations = new ConversationStore({
      db: this.db,
      transaction: work => this.transaction(work),
      notify: notice => this.notify(notice),
      log: (kind, data) => this.log(kind, data),
    });
  }
  close() { this.db.close(); }
  bindPlatformAccount(instance: string, identity: PlatformIdentity) {
    this.transaction(() => {
      const accounts = this.setting<Record<string, PlatformIdentity>>('platformAccounts', {});
      const previous = accounts[instance];
      if (previous && (previous.platform !== identity.platform || previous.accountId !== identity.accountId)) throw new Error(`Adapter ${instance} belongs to another platform account; use a new instance ID.`);
      this.setSetting('platformAccounts', { ...accounts, [instance]: identity });
    });
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
  setting<T>(key: string): T;
  setting<T>(key: string, fallback: T): T;
  setting<T>(key: string, fallback?: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row && arguments.length > 1) return fallback!;
    return parse<T>(row!.value);
  }
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
  /** A new management generation ends whatever is in flight. The saved working context ends with the old one too, unless the change leaves what it holds untouched, as pausing, resuming, and the life switch do (ADR-0004). */
  bumpGeneration(carryContext = false) {
    const next = this.setting<number>('generation') + 1;
    if (carryContext) this.db.prepare('UPDATE working_context SET generation=? WHERE id=1 AND generation=?').run(next, next - 1);
    this.setSetting('generation', next);
  }
  log(kind: string, data: unknown) { const at = Date.now(); const row = this.db.prepare('INSERT INTO trace(at,kind,data) VALUES (?,?,?)').run(at, kind, json(data)); this.notify({ kind: 'trace', at, id: Number(row.lastInsertRowid), name: kind, data }); }
  logs(limit = 30) { return this.db.prepare('SELECT * FROM trace ORDER BY id DESC LIMIT ?').all(limit).map(row => ({ id: Number(row.id), at: Number(row.at), kind: String(row.kind), data: parse(row.data) })); }
  visibleHistory() {
    return {
      events: this.db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 30').all().reverse().map(readEventRow),
      messages: this.db.prepare("SELECT id,at,message FROM context_records WHERE json_extract(message,'$.role') IN ('assistant','toolResult') ORDER BY at DESC,rowid DESC LIMIT 40").all().reverse().map(row => ({ id: String(row.id), at: Number(row.at), message: parse<AgentMessage>(row.message) })),
      actions: this.actions().reverse(),
      logs: this.logs(20).reverse(),
    };
  }
  archiveContext(messages: AgentMessage[], sources: string[]): string[] {
    const write = () => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO context_records VALUES (?,?,?,?)');
      const cited = json(sources);
      return messages.map(message => {
        const saved = persistableMessage(message); const recordId = contextRecordId(saved);
        insert.run(recordId, Date.now(), json(saved), cited);
        return recordId;
      });
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  contextRecord(recordId: string): { id: string; message: AgentMessage; sources: string[] } | undefined {
    const row = this.db.prepare('SELECT * FROM context_records WHERE id=?').get(recordId);
    return row ? { id: recordId, message: parse(row.message), sources: parse(row.source_ids) } : undefined;
  }
  /** Latest archived assistant messages by insertion order (rowid B-tree), for reusing valid thought signatures when seeding a fresh context. */
  recentAssistantMessages(limit = 200): AgentMessage[] {
    return this.db.prepare('SELECT message FROM context_records ORDER BY rowid DESC LIMIT ?').all(limit)
      .map(row => parse<AgentMessage>(row.message))
      .filter(message => message.role === 'assistant');
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
      for (const batch of batches) this.markObserved(batch);
      for (const compacted of compactions) this.log('context_compacted', compacted);
    });
  }
  receive(input: Omit<EnvironmentEvent, 'id' | 'status' | 'receivedAt'>, processed = false): EnvironmentEvent | undefined {
    if ('groupId' in input || 'actorId' in input) throw new Error('Use canonical event.source identifiers.');
    if (input.source) validateSource(input.source);
    if ((input.kind === 'message' || input.kind.startsWith('notice:') || input.kind.startsWith('request:')) && !input.source) throw new Error('Platform events require a canonical source.');
    processed ||= isHeartbeat(input.kind) || input.source?.attention === 'transport';
    if (this.db.prepare('SELECT 1 FROM tombstones WHERE source_key=?').get(input.key)) return;
    const eventId = makeId('e'); const receivedAt = Date.now();
    const result = this.db.prepare('INSERT OR IGNORE INTO events(id,source_key,kind,at,text,payload,status,received_at,addressed,source,conversation_ref,actor_ref,ambient_flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(eventId, input.key, input.kind, input.at, input.text, json(input.payload), processed ? 'processed' : 'pending', receivedAt, Number(input.source?.addressed ?? false), input.source ? json(input.source) : null, input.source?.conversation ?? null, input.source?.actor ?? null, Number(input.source?.attention === 'ambient'));
    if (!result.changes) return;
    const event: EnvironmentEvent = { ...input, id: eventId, status: processed ? 'processed' : 'pending', receivedAt };
    this.notify({ kind: 'environment', event }); return event;
  }
  /** Resolve a #xxxxxxxx reference from a chat record to its full event ID, also when written without # or lengthened into a full ID that does not exist (ADR-0019); other IDs pass through. */
  resolve(reference: string): string {
    const lengthened = /^e:([0-9a-f]{8})-/.exec(reference);
    if (lengthened && !this.event(reference)) {
      const matches = this.eventsStarting(lengthened[1]!);
      return matches.length === 1 ? matches[0]! : reference;
    }
    const digits = /^#?([0-9a-f]{8})$/.exec(reference)?.[1];
    if (!digits) return reference;
    const matches = this.eventsStarting(digits);
    if (matches.length !== 1) throw new Error(matches.length ? `Reference #${digits} is ambiguous; use the full event ID.` : `Reference ${reference} does not exist or has been deleted.`);
    return matches[0]!;
  }
  private eventsStarting(digits: string): string[] { return this.db.prepare('SELECT id FROM events WHERE id>=? AND id<? LIMIT 2').all(`e:${digits}`, `e:${digits}~`).map(row => String(row.id)); }
  event(eventId: string): EnvironmentEvent | undefined { return readEvent(this.db, eventId); }
  /** A review's prompt is perceived by the review alone, which has it as its observation (ADR-0012). */
  recent(limit: number): EnvironmentEvent[] { return this.db.prepare(`SELECT * FROM events WHERE status='processed' AND NOT ${transportEventSql} AND kind!='memory_maintenance' ORDER BY at DESC LIMIT ?`).all(limit).reverse().map(readEventRow); }
  claim(limit: number, allowLife = true, resting = false): { batchId: string; events: EnvironmentEvent[] } | undefined {
    return this.transaction(() => {
      const claimed = this.db.prepare(`SELECT * FROM events WHERE ${claimableSql} AND kind!='rest_backlog' ORDER BY at,rowid LIMIT ?`).all(allowLife ? 1 : 0, resting ? 1 : 0, limit);
      const backlogs = this.db.prepare("SELECT * FROM events WHERE status='pending' AND kind='rest_backlog' ORDER BY at,rowid").all();
      if (!claimed.length && !backlogs.length) return;
      const life = (row: Record<string, any>) => row.kind === 'wake' && parse<Record<string, unknown>>(row.payload).wakeKind === 'life';
      const cut = claimed.findIndex(row => life(row) !== life(claimed[0]!));
      const rows = cut < 0 ? claimed : claimed.slice(0, cut);
      rows.push(...backlogs);
      const batchId = makeId('b');
      for (const row of rows) this.db.prepare("UPDATE events SET status='processing',batch_id=? WHERE id=?").run(batchId, String(row.id));
      this.notifyEvents(rows.map(row => String(row.id)));
      return { batchId, events: rows.map(readEventRow) };
    });
  }
  acknowledge(batchId: string) { this.transaction(() => this.markObserved(batchId)); }
  private batch(batchId: string): string[] { return this.db.prepare("SELECT id FROM events WHERE status='processing' AND batch_id=?").all(batchId).map(row => String(row.id)); }
  private markObserved(batchId: string) {
    const ids = this.batch(batchId);
    const count = Number(this.db.prepare("UPDATE events SET status='processed',batch_id=NULL WHERE status='processing' AND batch_id=?").run(batchId).changes);
    this.setSetting('processedTotal', this.processedCount() + count);
    this.notifyEvents(ids);
  }
  private notifyEvents(ids: string[]) { for (const id of ids) { const event = this.event(id); if (event) this.notify({ kind: 'environment', event }); } }
  releaseBatch(batchId: string) { const ids = this.batch(batchId); this.db.prepare("UPDATE events SET status='pending',batch_id=NULL WHERE status='processing' AND batch_id=?").run(batchId); this.notifyEvents(ids); }
  releaseClaims() { const ids = this.db.prepare("SELECT id FROM events WHERE status='processing'").all().map(row => String(row.id)); this.db.prepare("UPDATE events SET status='pending',batch_id=NULL WHERE status='processing'").run(); this.notifyEvents(ids); }
  recover() {
    this.transaction(() => {
      // Transport events queued by older versions must not wake the model or advance reflection counters.
      this.db.prepare(`UPDATE events SET status='processed',batch_id=NULL WHERE status IN ('pending','processing') AND ${transportEventSql}`).run();
      this.releaseClaims();
      const pending = this.db.prepare("SELECT id FROM actions WHERE status='pending'").all();
      this.db.prepare("UPDATE actions SET status='unknown',result=? WHERE status='pending'").run(json({ reason: 'Process interrupted; the remote outcome is unconfirmed' }));
      for (const row of pending) this.notify({ kind: 'action', action: this.actionById(String(row.id))! });
      if (this.db.prepare("SELECT kind FROM trace WHERE kind IN ('review_started','review_finished','review_stopped') ORDER BY id DESC LIMIT 1").get()?.kind === 'review_started') this.log('review_stopped', { message: 'Process interrupted' });
      this.notify({ kind: 'state' });
    });
  }
  pendingTiming(allowLife = true, resting = false): PendingTiming {
    const row = this.db.prepare(`SELECT min(CASE WHEN ambient_flag THEN NULL ELSE coalesce(received_at,0) END) AS first, max(coalesce(received_at,0)) AS last, min(CASE WHEN ambient_flag THEN coalesce(received_at,0) END) AS ambient FROM events WHERE ${claimableSql}`).get(allowLife ? 1 : 0, resting ? 1 : 0)!;
    const time = (value: unknown) => value == null ? undefined : Number(value);
    return { first: time(row.first), last: time(row.last), ambient: time(row.ambient) };
  }
  pending() { return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE status='pending'").get()!.n); }
  processedCount() { return this.setting<number>('processedTotal'); }

  retain(days: number, now = Date.now()): number {
    const before = now - days * 86_400_000;
    this.db.prepare('DELETE FROM working_context WHERE updated_at<?').run(before);
    this.db.prepare("DELETE FROM context_records WHERE at<? AND id NOT IN (SELECT j.value FROM working_context,json_each(json_extract(data,'$.messageIds')) j)").run(before);
    this.transaction(() => {
      const ended = "SELECT id FROM wakes WHERE status IN ('done','cancelled') AND due_at<?1 UNION ALL SELECT id FROM pursuits WHERE status!='active' AND updated_at<?1";
      this.db.prepare(`DELETE FROM sources WHERE owner_id IN (${ended}) OR source_id IN (${ended})`).run(before);
      this.db.prepare("DELETE FROM wakes WHERE status IN ('done','cancelled') AND due_at<?").run(before);
      this.db.prepare("DELETE FROM pursuits WHERE status!='active' AND updated_at<?").run(before);
    });
    this.db.prepare('DELETE FROM trace WHERE at<?').run(before); this.db.prepare('DELETE FROM calls WHERE at<?').run(before);
    const unresolved = this.db.prepare("SELECT rowid FROM actions WHERE status IN ('pending','unknown')").all();
    const guarded = new Set(unresolved.flatMap(row => parse<unknown[]>(this.db.prepare('SELECT source_ids FROM actions WHERE rowid=?').get(Number(row.rowid))!.source_ids)).filter(source => typeof source === 'string'));
    return Number(this.db.prepare("DELETE FROM events WHERE status='processed' AND at<? AND NOT EXISTS (SELECT 1 FROM sources WHERE source_id=events.id) AND id NOT IN (SELECT value FROM json_each(?))").run(before, json([...guarded])).changes);
  }

  schedule(title: string, kind: Wake['kind'], dueAt: number, sources: string[] = [], rest = false): Wake {
    if (!Number.isFinite(dueAt)) throw new Error('Invalid wake time.');
    if (this.wakes().length >= 100) throw new Error('The 100 unfinished activity limit has been reached; organize existing commitments and plans first.');
    const wakeId = makeId('w');
    this.transaction(() => {
      this.db.prepare('INSERT INTO wakes(id,title,kind,due_at,rest) VALUES (?,?,?,?,?)').run(wakeId, title, kind, dueAt, rest ? 1 : 0);
      for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(wakeId, source);
    });
    return { id: wakeId, title, kind, dueAt, status: 'pending', ...(rest ? { rest } : {}) };
  }
  wakes(): Wake[] { return this.db.prepare("SELECT * FROM wakes WHERE status IN ('pending','queued') ORDER BY due_at").all().map(row => ({ id: String(row.id), title: String(row.title), kind: row.kind as Wake['kind'], dueAt: Number(row.due_at), status: row.status as Wake['status'], ...(row.rest ? { rest: true } : {}) })); }
  finishWake(wakeId: string, status: 'done' | 'cancelled') { if (!this.db.prepare('UPDATE wakes SET status=? WHERE id=?').run(status, wakeId).changes) throw new Error('Activity does not exist.'); }
  pastLifePlans(limit: number): Wake[] { return this.db.prepare("SELECT * FROM wakes WHERE kind='life' AND status IN ('done','cancelled') ORDER BY due_at DESC LIMIT ?").all(limit).map(row => ({ id: String(row.id), title: String(row.title), kind: 'life', dueAt: Number(row.due_at), status: row.status as Wake['status'] })); }
  private pursuitRow(row: Record<string, any>): Pursuit { return { id: row.id, title: row.title, progress: row.progress, fictional: Boolean(row.fictional), status: row.status, startedAt: row.started_at, updatedAt: row.updated_at }; }
  pursuits(): Pursuit[] { return this.db.prepare("SELECT * FROM pursuits WHERE status='active' ORDER BY updated_at DESC,rowid DESC").all().map(row => this.pursuitRow(row)); }
  updatePursuit(input: { id?: string; title: string; progress: string; fictional: boolean }, sources: string[], allowFiction: boolean): Pursuit {
    if (!input.title.trim() || input.title.length > 200 || !input.progress.trim() || input.progress.length > 1000) throw new Error('A pursuit needs a title of at most 200 characters and progress of at most 1000.');
    return this.transaction(() => {
      const previous = input.id ? this.db.prepare("SELECT * FROM pursuits WHERE id=? AND status='active'").get(input.id) : undefined;
      if (input.id && !previous) throw new Error('No active pursuit has this ID.');
      const fictional = input.fictional || Boolean(previous?.fictional);
      if (fictional && !allowFiction) throw new Error('Fictional daily life is disabled; fictional pursuits cannot be kept.');
      const now = Date.now();
      let pursuitId = input.id;
      if (pursuitId) this.db.prepare('UPDATE pursuits SET title=?,progress=?,fictional=?,updated_at=? WHERE id=?').run(input.title, input.progress, fictional ? 1 : 0, now, pursuitId);
      else {
        if (this.pursuits().length >= 8) throw new Error('Eight pursuits are already under way; finish or drop one first.');
        pursuitId = makeId('p');
        this.db.prepare('INSERT INTO pursuits VALUES (?,?,?,?,?,?,?)').run(pursuitId, input.title, input.progress, fictional ? 1 : 0, 'active', now, now);
      }
      for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(pursuitId, source);
      this.notify({ kind: 'state' });
      return this.pursuitRow(this.db.prepare('SELECT * FROM pursuits WHERE id=?').get(pursuitId)!);
    });
  }
  finishPursuit(pursuitId: string, status: 'done' | 'dropped') {
    if (!this.db.prepare("UPDATE pursuits SET status=?,updated_at=? WHERE id=? AND status='active'").run(status, Date.now(), pursuitId).changes) throw new Error('No active pursuit has this ID.');
    this.notify({ kind: 'state' });
  }
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
  resting(now = Date.now()): boolean { return this.settings().lifeEnabled && this.db.prepare("SELECT 1 FROM wakes WHERE rest=1 AND status='pending' AND due_at>? LIMIT 1").get(now) !== undefined; }
  restHeld(): EnvironmentEvent[] { return this.db.prepare(`SELECT * FROM events WHERE status='pending' AND ${restHoldsSql} ORDER BY at,rowid`).all().map(readEventRow); }
  setAside(eventIds: string[]) {
    const write = () => {
      for (const eventId of eventIds) this.db.prepare("UPDATE events SET status='processed',batch_id=NULL WHERE id=? AND status='pending'").run(eventId);
      this.notifyEvents(eventIds);
    };
    if (this.db.isTransaction) write(); else this.transaction(write);
  }
  lastHeard(): number | undefined {
    const row = this.db.prepare("SELECT coalesce(received_at,at) AS at FROM events WHERE (kind='message' OR kind LIKE 'notice:%' OR kind LIKE 'request:%') AND json_extract(source,'$.own')=0 AND NOT ambient_flag ORDER BY rowid DESC LIMIT 1").get();
    return row ? Number(row.at) : undefined;
  }
  lifeWakesSince(since: number): { at: number; freeTime: boolean }[] {
    return this.db.prepare("SELECT at, json_extract(payload,'$.freeTime') AS free FROM events WHERE kind='wake' AND json_extract(payload,'$.wakeKind')='life' AND at>=? ORDER BY at").all(since).map(row => ({ at: Number(row.at), freeTime: Boolean(row.free) }));
  }
  reviewMark(conversation: string, now = Date.now()): number { return Math.max(this.setting<Record<string, number>>('reviewMarks')[conversation] ?? 0, now - 86_400_000); }
  markReviewed(conversation: string, through: number) {
    const marks = this.setting<Record<string, number>>('reviewMarks');
    if (through > (marks[conversation] ?? 0)) this.setSetting('reviewMarks', { ...marks, [conversation]: through });
  }

  // Memory domain delegates
  memory(memoryId: string): Memory | undefined { return this.memories.memory(memoryId); }
  inspectMemoryWrite(input: Partial<MemoryInput>, limits?: DevelopmentLimits) { return this.memories.inspectMemoryWrite(input, limits); }
  writeMemory(input: MemoryInput, allowFiction: boolean, limits?: DevelopmentLimits, keepDependents = false): Memory { return this.memories.writeMemory(input, allowFiction, limits, keepDependents); }
  activeMemories(memoryIds: string[]): Set<string> { return this.memories.activeMemories(memoryIds); }
  revisionReach(memoryId: string): RevisionReach { return this.memories.revisionReach(memoryId); }
  noticeRevisions(revisions: { memory: Memory; reach: RevisionReach }[]) { return this.memories.noticeRevisions(revisions); }
  development(scopes: string[]): Memory[] { return this.memories.development(scopes); }
  retireMemory(memoryId: string): Memory { return this.memories.retireMemory(memoryId); }
  splitDevelopment(entryChars: number): number { return this.memories.splitDevelopment(entryChars); }
  search(query: string, limit = 8, subjects: string[] = [], historical = false): Memory[] { return this.memories.search(query, limit, subjects, historical); }
  noteRecalled(how: 'spontaneous' | 'deliberate', memories: { id: string; similarity?: number }[], detail: { runId?: string; reviewing?: boolean } = {}) { return this.memories.noteRecalled(how, memories, detail); }
  recalls(memoryId: string) { return this.memories.recalls(memoryId); }
  recallableIds() { return this.memories.recallableIds(); }
  searchableIds(historical: boolean) { return this.memories.searchableIds(historical); }
  dropOtherVectors(model: string) { return this.memories.dropOtherVectors(model); }
  memoryVectors(model: string) { return this.memories.memoryVectors(model); }
  unindexedMemories(model: string, limit: number) { return this.memories.unindexedMemories(model, limit); }
  saveMemoryVectors(memoryId: string, model: string, lines: { line: string; vector: Float32Array }[]) { return this.memories.saveMemoryVectors(memoryId, model, lines); }
  forgetPlan(root: string) { return this.memories.forgetPlan(root); }
  forget(root: string) { return this.memories.forget(root); }
  revisitDue(limit: number, experienceChars: number, now = Date.now()) { return this.memories.revisitDue(limit, experienceChars, now); }
  notedSince(at: number) { return this.memories.notedSince(at); }
  revisitPending(experienceChars: number) { return this.memories.revisitPending(experienceChars); }
  markRevisited(memoryIds: string[], now = Date.now()) { return this.memories.markRevisited(memoryIds, now); }
  randomMemory(kinds: MemoryKind[], before = Number.MAX_SAFE_INTEGER) { return this.memories.randomMemory(kinds, before); }
  lastMemoryAt(kind: MemoryKind) { return this.memories.lastMemoryAt(kind); }

  // Conversation, action ledger, and budget delegates
  latestGroupMessage(conversation: string) { return this.conversations.latestGroupMessage(conversation); }
  reviewBacklog(now = Date.now()) { return this.conversations.reviewBacklog(now); }
  impressionsIn(chats: { conversation: string; since: number; until?: number }[], limit: number) { return this.conversations.impressionsIn(chats, limit); }
  conversationRecord(conversation: string, from: number, limit: number, until = Number.MAX_SAFE_INTEGER) { return this.conversations.conversationRecord(conversation, from, limit, until); }
  conversationMatches(conversation: string, limit: number, match: { query?: string; person?: string }) { return this.conversations.conversationMatches(conversation, limit, match); }
  messageById(conversation: string, messageId: string | number) { return this.conversations.messageById(conversation, messageId); }
  sentMessage(messageId: string | number, account: PlatformIdentity) { return this.conversations.sentMessage(messageId, account); }
  latestSender(person: string) { return this.conversations.latestSender(person); }
  latestActorName(person: string) { return this.conversations.latestActorName(person); }
  conversationName(conversation: string) { return this.conversations.conversationName(conversation); }
  groupName(conversation: string) { return this.conversations.conversationName(conversation); }
  latestConversationActivity(conversation: string) { return this.conversations.latestConversationActivity(conversation); }
  activeConversations(account: PlatformIdentity, types: readonly ConversationType[], limit = 10) { return this.conversations.activeConversations(account, types, limit); }
  action(row: Record<string, any>): Action { return readActionRow(row); }
  actions(limit = 20): Action[] { return this.conversations.actions(limit); }
  actionById(actionId: string): Action | undefined { return this.conversations.actionById(actionId); }
  actionTriggers(actionId: string) { return this.conversations.actionTriggers(actionId); }
  recentConversationEvents(conversation: string, beforeAt: number, limit: number) { return this.conversations.recentConversationEvents(conversation, beforeAt, limit); }
  lastSuccessfulAction(kind: string) { return this.conversations.lastSuccessfulAction(kind); }
  lastExperienced(kinds: string[]) { return this.conversations.lastExperienced(kinds); }
  beginAction(key: string, kind: string, args: Record<string, unknown>, sources: string[], triggers: string[] = [], hourlyLimit?: number | null, conversation?: string) { return this.conversations.beginAction(key, kind, args, sources, triggers, hourlyLimit, conversation); }
  finishAction(actionId: string, status: Action['status'], result: unknown, conversation?: string) { return this.conversations.finishAction(actionId, status, result, conversation); }
  hourlyActions(now = Date.now()) { return this.conversations.hourlyActions(now); }
  dailyCalls(now = Date.now()) { return this.conversations.dailyCalls(now); }
  chargeCall(runId: string, limit: number | null) { return this.conversations.chargeCall(runId, limit); }

  status() { return { ...this.settings(), pendingEvents: this.pending(), modelCallsToday: this.dailyCalls(), actionsThisHour: this.hourlyActions(), memories: this.db.prepare('SELECT count(*) AS n FROM memories').get()!.n, wakes: this.wakes(), pursuits: this.pursuits(), actions: this.actions() }; }
}
