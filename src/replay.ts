import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { EnvironmentEvent } from './domain.js';
import { developmentKinds } from './domain.js';
import { closestLine, type Embedder, type Line } from './embedding.js';
import { SemanticRecall, memoriesInView, queryText } from './recall.js';
import { Store } from './store.js';

/**
 * A past moment and what should have been in view then. triggers are the events the thought observed. gold names the memories
 * that hold what it needed, in any version, and any one of them in view is enough; whoever labels a case reads a memory before
 * naming it, since a memory that cites an event need not say what happened there. A case with no gold is one where nothing
 * held said it. where records the events it happened in, and note anything else, for the labeller alone. query is what a
 * deliberate search would have asked; without it the triggers' own words are searched. did is what the digital life actually
 * did with it at the time, in the labeller's words, such as used, missed, or wrong; the report counts outcomes under each.
 */
export interface ReplayCase { id: string; triggers: string[]; gold: string[]; where?: string[]; query?: string; at?: number; did?: string; note?: string }
/**
 * supplied: came with the thought as development. recalled: came to mind by itself. findable: not in view, but a deliberate
 * search finds it. missed: a memory of it was held, and none of those reach it. unrecorded: no memory held then said it.
 */
export type ReplayOutcome = 'supplied' | 'recalled' | 'findable' | 'missed' | 'unrecorded';
export interface ReplayResult {
  id: string; at: number; outcome: ReplayOutcome; did?: string;
  /** Versions of the named memories held at that moment. */
  held: number;
  /** What came to mind by itself, and how much of it the case did not name. */
  recalled: number; other: number;
  /** Among everything that could come to mind then: how alike the closest held memory was to what was said, and its place. */
  similarity?: number; rank?: number;
  /** Its place in the deliberate search, when found. */
  searchRank?: number;
}
export interface ReplayReport { cases: number; threshold: number; limit: number; outcomes: Record<ReplayOutcome, number>; byDid: Record<string, Partial<Record<ReplayOutcome, number>>>; results: ReplayResult[] }

/** Vectors of texts already embedded are kept beside the cases, so a second run asks the endpoint nothing and compares like with like. */
export function cachedEmbedder(inner: Embedder, path: string): Embedder {
  const cache: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const key = (text: string) => createHash('sha256').update(`${inner.model}\n${text}`).digest('hex');
  return {
    model: inner.model,
    async embed(texts, signal) {
      const missing = [...new Set(texts.filter(text => !cache[key(text)]))];
      if (missing.length) {
        const vectors = await inner.embed(missing, signal);
        missing.forEach((text, index) => { cache[key(text)] = Buffer.from(vectors[index]!.buffer, vectors[index]!.byteOffset, vectors[index]!.byteLength).toString('base64'); });
        writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
      }
      return texts.map(text => { const bytes = Buffer.from(cache[key(text)]!, 'base64'); return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice(); });
    },
  };
}

/**
 * Ask of past moments what a thought would have had of memory in view, with the memories held then and the code a thought runs
 * now. The database is only read: its memories and their vectors are copied into memory, and for each case those not yet
 * written, already replaced, or retired by then are set aside. A memory withdrawn together with one it rested on is counted
 * as leaving when that one was replaced. Nothing is printed of what a memory or a message says.
 */
export async function replay(databasePath: string, config: Config, embedder: Embedder, cases: ReplayCase[]): Promise<ReplayReport> {
  const live = new DatabaseSync(databasePath, { readOnly: true });
  const store = new Store(':memory:');
  const recall = new SemanticRecall(config, store, embedder);
  try {
    const memories = live.prepare('SELECT * FROM memories').all();
    const links = live.prepare("SELECT owner_id, source_id FROM sources WHERE owner_id LIKE 'm:%'").all().map(row => [String(row.owner_id), String(row.source_id)] as const);
    const insert = store.db.prepare('INSERT INTO memories(id,kind,title,content,importance,subjects,conversations_json,fictional,supersedes,active,created_at,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    store.transaction(() => {
      for (const row of memories) insert.run(row.id!, row.kind!, row.title!, row.content!, row.importance!, row.subjects!, row.conversations_json!, row.fictional!, row.supersedes ?? null, row.active!, row.created_at!, row.scope ?? null);
      for (const [owner, source] of links) store.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(owner, source);
      const vector = store.db.prepare('INSERT INTO memory_vectors VALUES (?,?,?,?,?)');
      for (const row of live.prepare('SELECT * FROM memory_vectors WHERE model=?').iterate(embedder.model)) vector.run(row.memory_id!, row.chunk!, row.model!, row.line!, row.vector!);
      const accounts = live.prepare("SELECT value FROM settings WHERE key='platformAccounts'").get();
      if (accounts) store.setSetting('platformAccounts', JSON.parse(String(accounts.value)));
    });
    // When each memory was held: from when it was written until it was replaced, retired, or withdrawn.
    const sourcesOf = new Map<string, string[]>();
    for (const [owner, source] of links) sourcesOf.set(owner, [...sourcesOf.get(owner) ?? [], source]);
    const written = new Map(memories.map(row => [String(row.id), Number(row.created_at)]));
    const replaced = new Map<string, number>();
    for (const row of memories) if (row.supersedes) replaced.set(String(row.supersedes), Math.min(replaced.get(String(row.supersedes)) ?? Infinity, Number(row.created_at)));
    const retired = new Map(live.prepare("SELECT json_extract(data,'$.id') AS id, min(at) AS at FROM trace WHERE kind='memory_retired' GROUP BY 1").all().map(row => [String(row.id), Number(row.at)]));
    const until = new Map<string, number>();
    for (const row of memories) {
      const memoryId = String(row.id);
      const ends = [replaced.get(memoryId), retired.get(memoryId)].filter((at): at is number => at !== undefined);
      if (!ends.length && !row.active) ends.push(Math.min(...(sourcesOf.get(memoryId) ?? []).map(source => replaced.get(source) ?? Infinity), Infinity));
      // One whose leaving cannot be dated is taken as never held, rather than as held throughout.
      if (ends.length) until.set(memoryId, Math.min(...ends) === Infinity ? 0 : Math.min(...ends));
    }
    const heldAt = (memoryId: string, at: number) => written.get(memoryId)! < at && (until.get(memoryId) ?? Infinity) > at;
    const replacedBy = new Map<string, string[]>();
    for (const row of memories) if (row.supersedes) replacedBy.set(String(row.supersedes), [...replacedBy.get(String(row.supersedes)) ?? [], String(row.id)]);
    const earlier = new Map(memories.map(row => [String(row.id), row.supersedes ? String(row.supersedes) : undefined]));
    /** Every version of a memory: those it replaced and those that replaced it. */
    const versions = (memoryId: string) => {
      const family = new Set<string>(); const next = [memoryId];
      while (next.length) { const current = next.pop()!; if (family.has(current)) continue; family.add(current); next.push(...replacedBy.get(current) ?? []); if (earlier.get(current)) next.push(earlier.get(current)!); }
      return family;
    };
    // Without the vectors the daemon made, every memory would be embedded again, by a model it was not recalled with.
    if (memories.length && !store.memoryVectors(embedder.model).length) throw new Error(`The database holds no memory vectors for ${embedder.model}; replay with the embedding model the daemon uses.`);
    recall.start(); await recall.idle();
    const lines = new Map<string, Line[]>();
    for (const { memoryId, line, vector } of store.memoryVectors(embedder.model)) lines.set(memoryId, [...lines.get(memoryId) ?? [], { line, vector }]);
    // What can come to mind by itself: everything but development, which comes by scope.
    const development = new Set<string>(developmentKinds);
    const recallable = memories.filter(row => !development.has(String(row.kind)) && lines.has(String(row.id))).map(row => String(row.id));
    const setHeld = store.db.prepare('UPDATE memories SET active=? WHERE id=?');
    const eventRow = live.prepare('SELECT * FROM events WHERE id=?');
    const results: ReplayResult[] = [];
    const clock = Date.now;
    for (const item of cases) {
      const rows = item.triggers.map(trigger => { const row = eventRow.get(trigger); if (!row) throw new Error(`Case ${item.id}: event ${trigger} does not exist.`); return row; });
      const at = item.at ?? Math.min(...rows.map(row => Number(row.at)));
      store.transaction(() => { for (const row of memories) setHeld.run(heldAt(String(row.id), at) ? 1 : 0, String(row.id)); });
      // Recency in a search is counted from the moment replayed, not from today.
      Date.now = () => at;
      try {
        const events = rows.map(row => store.receive({ key: `replay:${item.id}:${row.id}`, kind: String(row.kind), at: Number(row.at), text: String(row.text), payload: JSON.parse(String(row.payload)), ...(row.source ? { source: JSON.parse(String(row.source)) } : {}) }, true)).filter((event): event is EnvironmentEvent => event !== undefined);
        await recall.idle();
        const view = memoriesInView(config, store, recall, events);
        const held = new Set(item.gold.flatMap(gold => [...versions(gold)]).filter(memoryId => written.has(memoryId) && heldAt(memoryId, at)));
        const recalled = view.recalled.map(found => found.memory.id);
        const result: ReplayResult = { id: item.id, at, outcome: 'unrecorded', ...(item.did ? { did: item.did } : {}), held: held.size, recalled: recalled.length, other: recalled.filter(memoryId => !held.has(memoryId)).length };
        if (held.size) {
          const queries = recall.queries(events);
          const ranked = recallable.filter(memoryId => heldAt(memoryId, at))
            .map(memoryId => ({ memoryId, similarity: queries.length ? closestLine(queries, lines.get(memoryId)!).similarity : -1 })).sort((a, b) => b.similarity - a.similarity);
          const place = ranked.findIndex(entry => held.has(entry.memoryId));
          if (place >= 0 && queries.length) { result.similarity = Math.round(ranked[place]!.similarity * 1000) / 1000; result.rank = place + 1; }
          const query = item.query ?? events.map(event => queryText(event.text, {}, config.embedding.selfNames)).join(' ');
          const searched = (await recall.search(query.slice(0, 500), config.memory.recallLimit)).map(memory => memory.id);
          const searchPlace = searched.findIndex(memoryId => held.has(memoryId));
          if (searchPlace >= 0) result.searchRank = searchPlace + 1;
          result.outcome = view.development.some(memory => held.has(memory.id)) ? 'supplied' : recalled.some(memoryId => held.has(memoryId)) ? 'recalled' : searchPlace >= 0 ? 'findable' : 'missed';
        }
        results.push(result);
      } finally { Date.now = clock; }
    }
    // A failed embedding leaves a thought without recall and says so only in the trace; a replay that went on would count that as memory missed.
    const failed = store.logs(1000).find(log => log.kind === 'recall_error');
    if (failed) throw new Error(`Embedding failed during the replay, so its results are not kept: ${JSON.stringify(failed.data)}`);
    const outcomes: Record<ReplayOutcome, number> = { supplied: 0, recalled: 0, findable: 0, missed: 0, unrecorded: 0 };
    const byDid: ReplayReport['byDid'] = {};
    for (const result of results) { outcomes[result.outcome]++; if (result.did) (byDid[result.did] ??= {})[result.outcome] = (byDid[result.did]![result.outcome] ?? 0) + 1; }
    return { cases: results.length, threshold: config.embedding.threshold, limit: config.embedding.limit, outcomes, byDid, results };
  } finally { await recall.stop(); store.close(); live.close(); }
}
