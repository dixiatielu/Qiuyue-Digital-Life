import { parseConversationRef, parsePersonRef } from '../identity.js';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Memory } from '../domain.js';
import { developmentKinds } from '../domain.js';
import { DrawingLibrary, type DrawingQuery } from '../plugins/gallery-store.js';

type Row = Record<string, any>;
const parse = (value: unknown) => JSON.parse(String(value));
const memoryRow = (db: DatabaseSync, row: Row): Memory => ({
  id: row.id, kind: row.kind, title: row.title, content: row.content, importance: row.importance, subjects: parse(row.subjects), conversations: parse(row.conversations_json),
  fictional: Boolean(row.fictional), sources: db.prepare('SELECT source_id FROM sources WHERE owner_id=?').all(row.id).map(item => String(item.source_id)),
  supersedes: row.supersedes ?? undefined, ...(row.scope ? { scope: row.scope } : {}), active: Boolean(row.active), createdAt: row.created_at,
});
/** Trace rows written while a model call is about to start or under way, before the live view shows the thought as busy. */
const inFlight = (kind: string) => kind === 'context_budget' || kind === 'model_request_started' || kind.startsWith('observation_');

interface UsageGroup {
  owner: string; purpose: string; provider: string; model: string; api: string;
  calls: number; success: number; errors: number; aborted: number; unfinished: number; unknownUsage: number;
  measuredCalls: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null;
}

/**
 * Reads the life database without the daemon lease and never writes to it, so the page can look while the daemon runs or after it stops.
 * Changes to memory go through the management commands instead (ADR-0003).
 */
export class LifeReader {
  constructor(private path: string) {}
  private read<T>(work: (db: DatabaseSync) => T, fallback: T): T {
    if (!existsSync(this.path)) return fallback;
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 2) throw new Error('Database identity format needs migration. Stop the daemon and run identities migrate --config <path>.');
      db.exec('PRAGMA busy_timeout=2000'); return work(db);
    } finally { db.close(); }
  }
  private setting(db: DatabaseSync, key: string) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? parse(row.value) : undefined; }
  private gallery<T>(dir: string, work: (library: DrawingLibrary) => T, fallback: T) {
    return this.read(db => work(new DrawingLibrary(db, this.setting(db, 'galleryDirectory') ?? dir)), fallback);
  }
  drawings(dir: string, query: DrawingQuery) {
    return this.gallery(dir, library => ({ ...library.search(query), stats: library.stats() }), { items: [], total: 0, nextOffset: null, stats: { total: 0, bytes: 0, archived: 0, missing: 0, needsDescription: 0 } });
  }
  drawing(dir: string, id: string) { return this.gallery(dir, library => library.detail(id), undefined); }
  drawingImage(dir: string, id: string, thumbnail = false) {
    return this.gallery(dir, library => library.get(id) ? library.image(id, thumbnail) : undefined, undefined);
  }
  daemon(): { pid: number } | undefined { return this.read(db => this.setting(db, 'daemon'), undefined); }
  /** The working context the next start would continue, if its identity and the current management generation still match. */
  workingContext(): { identity: string; generation: number; current: boolean; updatedAt: number } | undefined {
    return this.read(db => {
      const row = db.prepare('SELECT identity, generation, updated_at FROM working_context WHERE id=1').get();
      if (!row) return undefined;
      return { identity: String(row.identity), generation: Number(row.generation), current: Number(row.generation) === this.setting(db, 'generation'), updatedAt: Number(row.updated_at) };
    }, undefined);
  }
  /** What a restart now would cut short: a review under way, or a model call the live view may not show yet. */
  activity(now = Date.now()) {
    return this.read(db => {
      const review = db.prepare("SELECT kind, at FROM trace WHERE kind IN ('review_started','review_finished','review_stopped') ORDER BY id DESC LIMIT 1").get();
      const last = db.prepare('SELECT kind, at FROM trace ORDER BY id DESC LIMIT 1').get();
      return {
        reviewing: review?.kind === 'review_started' ? Number(review.at) : undefined,
        lastTrace: last ? { kind: String(last.kind), at: Number(last.at) } : undefined,
        callStarting: Boolean(last && inFlight(String(last.kind)) && now - Number(last.at) < 20_000),
      };
    }, { reviewing: undefined, lastTrace: undefined, callStarting: false });
  }
  /** The digital life's own development in use, by kind and scope (ADR-0012). */
  development(): (Memory & { scopeName?: string })[] {
    return this.read(db => db.prepare(`SELECT * FROM memories WHERE active=1 AND kind IN (${developmentKinds.map(() => '?').join(',')}) ORDER BY kind, scope, created_at DESC`).all(...developmentKinds).map(row => {
      const memory = memoryRow(db, row);
      return { ...memory, ...(memory.scope ? { scopeName: this.scopeName(db, memory.scope) } : {}) };
    }), []);
  }
  private scopeName(db: DatabaseSync, scope: string): string | undefined {
    if (scope.startsWith('conversation:')) {
      const chat = scope.slice('conversation:'.length);
      if (!parseConversationRef(chat)) return;
      const row = db.prepare("SELECT json_extract(payload,'$.group_name') AS name FROM events WHERE conversation_ref=? AND json_extract(payload,'$.group_name') IS NOT NULL ORDER BY at DESC LIMIT 1").get(chat);
      return row?.name ? String(row.name) : undefined;
    }
    if (scope.startsWith('person:')) {
      const person = scope.slice('person:'.length);
      if (!parsePersonRef(person)) return;
      const row = db.prepare("SELECT json_extract(source,'$.actorName') AS name, json_extract(payload,'$.sender') AS sender FROM events WHERE actor_ref=? AND (json_extract(source,'$.actorName') IS NOT NULL OR json_extract(payload,'$.sender') IS NOT NULL) ORDER BY at DESC LIMIT 1").get(person);
      const sender = row?.sender ? parse(row.sender) : undefined;
      return row?.name ? String(row.name) : sender?.card || sender?.nickname || undefined;
    }
  }

  /** A memory with the versions it replaced and the records it rests on. */
  memory(memoryId: string) {
    return this.read(db => {
      const row = db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId);
      if (!row) return undefined;
      const memory = memoryRow(db, row);
      const versions: Memory[] = [];
      for (let previous = memory.supersedes; previous && versions.length < 50;) {
        const older = db.prepare('SELECT * FROM memories WHERE id=?').get(previous);
        if (!older) break;
        const version = memoryRow(db, older);
        versions.push(version); previous = version.supersedes;
      }
      const sources = memory.sources.map(id => {
        const event = db.prepare('SELECT id, kind, at, text FROM events WHERE id=?').get(id);
        if (event) return { id, kind: String(event.kind), at: Number(event.at), text: String(event.text).slice(0, 600) };
        const source = db.prepare('SELECT id, kind, title, created_at FROM memories WHERE id=?').get(id);
        return source ? { id, kind: String(source.kind), at: Number(source.created_at), text: String(source.title) } : { id, kind: 'missing', at: 0, text: '' };
      });
      return { memory, versions, sources, ...(memory.scope ? { scopeName: this.scopeName(db, memory.scope) } : {}) };
    }, undefined);
  }
  counts(): Record<string, number> {
    return this.read(db => Object.fromEntries(db.prepare('SELECT kind, count(*) AS n FROM memories WHERE active=1 GROUP BY kind').all().map(row => [String(row.kind), Number(row.n)])), {});
  }
  /** Each calls row is one charged attempt; turn/summary traces are deliberately not counted again. */
  modelUsage(now = Date.now()) {
    const since = now - 86_400_000;
    return this.read(db => {
      const requests = new Map<string, Row>();
      for (const row of db.prepare("SELECT data FROM trace WHERE at>=? AND kind IN ('model_request_started','model_request_finished') ORDER BY id").all(since)) {
        const item = parse(row.data);
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
    }, { since, until: now, total: 0, unclassified: 0, cost: null, groups: [] as UsageGroup[] });
  }
  trace(limit: number) {
    return this.read(db => db.prepare('SELECT id, at, kind, data FROM trace ORDER BY id DESC LIMIT ?').all(limit).map(row => ({ id: Number(row.id), at: Number(row.at), kind: String(row.kind), data: String(row.data).slice(0, 2000) })), []);
  }
}
