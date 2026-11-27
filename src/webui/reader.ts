import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { alive } from './process.js';
import type { Memory } from '../domain.js';
import { DrawingLibrary, type DrawingQuery } from '../plugins/gallery-store.js';
import {
  readDaemonActivity,
  readDevelopmentMemories,
  readMemoryCounts,
  readMemoryDetail,
  readModelUsage,
  readSetting,
  readTraceRows,
  readWorkingContextMeta,
  type UsageGroup,
} from '../store/queries.js';

/**
 * Reads the life database without the daemon lease and never writes to it, so the page can look while the daemon runs or after it stops.
 * Shares read-only SQL queries with Store via src/store/queries.ts; changes to memory go through management commands (ADR-0003, ADR-0020).
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
  private gallery<T>(dir: string, work: (library: DrawingLibrary) => T, fallback: T) {
    return this.read(db => work(new DrawingLibrary(db, readSetting<string>(db, 'galleryDirectory') ?? dir)), fallback);
  }
  drawings(dir: string, query: DrawingQuery) {
    return this.gallery(dir, library => ({ ...library.search(query), stats: library.stats() }), { items: [], total: 0, nextOffset: null, stats: { total: 0, bytes: 0, archived: 0, missing: 0, needsDescription: 0 } });
  }
  drawing(dir: string, id: string) { return this.gallery(dir, library => library.detail(id), undefined); }
  drawingImage(dir: string, id: string, thumbnail = false) {
    return this.gallery(dir, library => library.get(id) ? library.image(id, thumbnail) : undefined, undefined);
  }
  daemon(): { pid: number } | undefined { return this.read(db => readSetting<{ pid: number }>(db, 'daemon'), undefined); }
  /** The working context the next start would continue, if its identity and the current management generation still match. */
  workingContext() { return this.read(db => readWorkingContextMeta(db), undefined); }
  /** What a restart now would cut short: a review under way, or a model call the live view may not show yet. */
  activity(now = Date.now()) {
    return this.read(db => readDaemonActivity(db, now, alive), { reviewing: undefined, lastTrace: undefined, callStarting: false });
  }
  /** The digital life's own development in use, by kind and scope (ADR-0012). */
  development(): (Memory & { scopeName?: string })[] {
    return this.read(db => readDevelopmentMemories(db), []);
  }
  /** A memory with the versions it replaced and the records it rests on. */
  memory(memoryId: string) { return this.read(db => readMemoryDetail(db, memoryId), undefined); }
  counts(): Record<string, number> { return this.read(db => readMemoryCounts(db), {}); }
  /** Each calls row is one charged attempt; turn/summary traces are deliberately not counted again. */
  modelUsage(now = Date.now()) {
    return this.read(db => readModelUsage(db, now), { since: now - 86_400_000, until: now, total: 0, unclassified: 0, cost: null, groups: [] as UsageGroup[] });
  }
  trace(limit: number) { return this.read(db => readTraceRows(db, limit), []); }
}
