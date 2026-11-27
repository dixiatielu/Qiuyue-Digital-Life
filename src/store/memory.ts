import type { DatabaseSync } from 'node:sqlite';
import { isDevelopment, type EnvironmentEvent, type LifeSettings, type Memory, type MemoryKind, type Pursuit, type Wake } from '../domain.js';
import { parseConversationRef, parsePersonRef } from '../identity.js';
import { readEvent, readMemory, readMemoryRow } from './queries.js';
import {
  carriesEvidence,
  characters,
  entryTitle,
  json,
  listItems,
  makeId,
  parse,
  programEvents,
  recallableSql,
  restingOnSql,
  type DevelopmentLimits,
  type MemoryInput,
  type RevisionReach,
  type Revisit,
} from './schema.js';

export interface StoreMemoryHost {
  readonly db: DatabaseSync;
  transaction<T>(work: () => T): T;
  setting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  settings(): LifeSettings;
  bumpGeneration(carryContext?: boolean): void;
  log(kind: string, data: unknown): void;
  resolve(reference: string): string;
  receive(input: Omit<EnvironmentEvent, 'id' | 'status' | 'receivedAt'>, processed?: boolean): EnvironmentEvent | undefined;
  wakes(): Wake[];
  pursuits(): Pursuit[];
}

/** Memory writes, development scopes, recall vectors, forgetting cascades (ADR-0003), and review revisits. */
export class MemoryStore {
  constructor(private readonly host: StoreMemoryHost) {}
  private get db() { return this.host.db; }

  memory(memoryId: string): Memory | undefined { return readMemory(this.db, memoryId); }

  /** Check independent source and size errors together, even when a tool call is missing another required field. Never writes. */
  inspectMemoryWrite(input: Partial<MemoryInput>, limits?: DevelopmentLimits) {
    const sources = new Set<string>(); const problems: string[] = [];
    if (Array.isArray(input.sources)) for (const ref of new Set(input.sources)) {
      if (typeof ref !== 'string' || !ref.length || ref.length > 100) { problems.push('Each source must be a non-empty event or memory ID of at most 100 characters.'); continue; }
      try {
        const source = this.host.resolve(ref); const event = readEvent(this.db, source); const memory = this.memory(source);
        if (!event && !memory) problems.push(`Source does not exist or has been deleted: ${ref}`);
        else if (memory && !memory.active) {
          const current = this.currentVersion(source);
          problems.push(`Source has been revised; read its current version first: ${ref}${current ? `. ${current}` : ''}`);
        } else sources.add(source);
      } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
    }
    // An experience that tells one thing comes to mind as that thing, and can be checked against the events of it alone (ADR-0027).
    if (limits?.experienceChars && input.kind === 'experience' && typeof input.content === 'string' && characters(input.content) > limits.experienceChars) problems.push(`An experience tells one thing that happened in at most ${limits.experienceChars} characters, under a title that names it; this content has ${characters(input.content)}. Save each thing as an experience of its own, with the events of that thing in its sources, and leave out what is not worth keeping. A long text of your own belongs in a note.${input.supersedes ? ' To break up a longer experience, supersede it with one of the things it tells and write the others as new experiences.' : ''}`);
    if (limits && input.kind && isDevelopment(input.kind) && typeof input.content === 'string') {
      const scope = input.scope ?? (input.kind === 'impression' ? undefined : 'global');
      // An entry that says one thing can be revised, checked against its own evidence, and retired alone (ADR-0025).
      if (characters(input.content) > limits.entryChars) problems.push(`${input.kind === 'impression' ? 'An' : 'A'} ${input.kind} entry says one thing in at most ${limits.entryChars} characters, so that it can be revised alone; this content has ${characters(input.content)}. Save each point as an entry of its own, with the evidence for that point in its sources. What happened that showed it to you belongs in sources or an experience, not in the entry.${input.supersedes ? ' To break up a longer entry, supersede it with one of its points and write the others as new entries.' : ''}`);
      if (typeof scope === 'string') {
        const cap = limits.scopeChars;
        // Each kind has its own budget in a scope; replacing an entry frees its old content.
        const used = this.db.prepare('SELECT content FROM memories WHERE active=1 AND scope=? AND kind=? AND id IS NOT ?').all(scope, input.kind, typeof input.supersedes === 'string' ? input.supersedes : null).reduce((sum, row) => sum + characters(String(row.content)), 0);
        const length = characters(input.content);
        if (used + length > cap) problems.push(`Your ${input.kind}s in ${scope} would reach ${used + length} characters, above the limit of ${cap}; retire entries you no longer see with retire_memory, or fold entries that say the same thing into one with supersedes, first. This write has room for ${Math.max(0, cap - used)} characters; its content has ${length}. Shorten it before retrying.`);
      }
    }
    return { sources: [...sources], problems };
  }

  /**
   * Limits bound the digital life's own development writes; operator corrections pass none. A revision withdraws what rested on
   * the old version unless it only goes back over how a memory is kept (ADR-0027), which leaves what rested on it in place.
   */
  writeMemory(input: MemoryInput, allowFiction: boolean, limits?: DevelopmentLimits, keepDependents = false): Memory {
    if (!input.content.trim() || characters(input.content) > 12_000 || characters(input.title) > 200) throw new Error('Memory content is empty or too long.');
    if (!['experience', 'understanding', 'fiction', 'note'].includes(input.kind) && !isDevelopment(input.kind)) throw new Error('Unknown memory type.');
    if (!Number.isInteger(input.importance) || input.importance < 1 || input.importance > 10) throw new Error('Importance must be between 1 and 10.');
    // A review and a conversation may revise the same version; the later one merges into what the first wrote (ADR-0012).
    const previous = input.supersedes ? this.memory(input.supersedes) : undefined;
    if (input.supersedes && (!previous || !previous.active)) {
      const current = previous && this.currentVersion(previous.id);
      throw new Error(current ? `The memory to revise has already been revised. ${current} Revise that version instead, keeping what it added.` : 'The memory to revise does not exist or has already been revised.');
    }
    const { sources, problems } = this.inspectMemoryWrite(input, limits);
    if (problems.length) throw new Error(problems.join('\n'));
    const scope = isDevelopment(input.kind) ? input.scope ?? (input.kind === 'impression' ? undefined : 'global') : undefined;
    let subjects = input.subjects ?? [];
    if (isDevelopment(input.kind)) {
      if (!scope || !(input.kind === 'impression' ? parsePersonRef(scope.slice('person:'.length)) && scope.startsWith('person:') : scope === 'global' || scope.startsWith('conversation:') && parseConversationRef(scope.slice('conversation:'.length)))) throw new Error('A habit or practice scope is global (the default) or conversation:<canonical ref>; an impression scope is person:<platform>:user:<id>.');
      if (input.kind === 'impression') subjects = [...new Set([...subjects, scope.slice('person:'.length)])];
      // Self-description drawn only from its own output would feed back into every later thought.
      if (input.kind !== 'practice' && !this.restsOnOthers(sources)) throw new Error('A habit or impression cannot rest only on your own messages, notes, or judgments; cite how others acted or responded.');
    }
    // A diary entry about a fictional day is fiction too, whatever its kind.
    let fictional = input.kind === 'fiction' || input.fictional === true;
    if (!sources.length && !fictional) throw new Error('A memory must reference IDs of actual experiences or existing memories.');
    const conversations = new Set<string>();
    for (const source of sources) {
      const event = readEvent(this.db, source); const memory = this.memory(source);
      if (event?.source?.conversation) conversations.add(event.source.conversation);
      for (const chat of memory?.conversations ?? []) conversations.add(chat);
      fictional ||= memory?.fictional ?? false;
    }
    if (fictional && !allowFiction) throw new Error('Fictional daily life is disabled; fictional experiences and derived content cannot be saved.');
    for (const chat of previous?.conversations ?? []) conversations.add(chat);
    fictional ||= previous?.fictional ?? false;
    if (fictional && !allowFiction) throw new Error('Fictional daily life and revisions must retain their fictional sources.');
    const memoryId = makeId('m');
    this.host.transaction(() => {
      this.db.prepare('INSERT INTO memories(id,kind,title,content,importance,subjects,conversations_json,fictional,supersedes,active,created_at,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(memoryId, input.kind, input.title, input.content, input.importance, json(subjects), json([...conversations]), fictional ? 1 : 0, input.supersedes ?? null, 1, Date.now(), scope ?? null);
      for (const source of sources) this.db.prepare('INSERT INTO sources VALUES (?,?)').run(memoryId, source);
      if (previous) {
        // A correction invalidates dependent interpretations, while preserving their history.
        if (keepDependents) this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(previous.id);
        else this.db.prepare(`WITH RECURSIVE ${restingOnSql} UPDATE memories SET active=0 WHERE id IN (SELECT id FROM dependent) AND id!=?`).run(previous.id, memoryId);
        this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(memoryId, previous.id);
      }
      this.host.log('memory_written', { id: memoryId, kind: input.kind, supersedes: input.supersedes, ...(scope ? { scope } : {}) });
    });
    return this.memory(memoryId)!;
  }

  /** The version that replaced a revised memory and still holds, described for whoever would revise or cite the old one. */
  private currentVersion(memoryId: string): string | undefined {
    const rows = this.db.prepare('WITH RECURSIVE later(id) AS (SELECT ? UNION SELECT memories.id FROM memories JOIN later ON memories.supersedes=later.id) SELECT * FROM memories WHERE active=1 AND id IN (SELECT id FROM later) ORDER BY created_at DESC,rowid DESC').all(memoryId);
    if (!rows.length) return;
    // A list split into entries holds as all of them (ADR-0025).
    if (rows.length > 1) return `It was split into ${rows.length} entries, which hold now: ${rows.reverse().map(row => `${row.id} (${row.title})`).join('; ')}. The one you mean is among them.`;
    const current = readMemoryRow(this.db, rows[0]!);
    return `Its current version is ${current.id} (${current.title}): ${current.content}`;
  }

  /** Which of these memories are current. */
  activeMemories(memoryIds: string[]): Set<string> {
    return new Set(this.db.prepare('SELECT id FROM memories WHERE active=1 AND id IN (SELECT value FROM json_each(?))').all(json(memoryIds)).map(row => String(row.id)));
  }

  /** What revising a memory reaches: the memories resting on it, which leave everyday recall with it, and the plans, pursuits, and activity under way that cite any of them. */
  revisionReach(memoryId: string): RevisionReach {
    const resting = json(this.db.prepare(`WITH RECURSIVE ${restingOnSql} SELECT id FROM dependent`).all(memoryId).map(row => String(row.id)));
    const withdrawn = this.db.prepare('SELECT id, kind, title FROM memories WHERE active=1 AND id!=? AND id IN (SELECT value FROM json_each(?))').all(memoryId, resting).map(row => ({ id: String(row.id), kind: String(row.kind), title: String(row.title) }));
    const reached = new Set(this.db.prepare('SELECT DISTINCT owner_id FROM sources WHERE source_id IN (SELECT value FROM json_each(?))').all(resting).map(row => String(row.owner_id)));
    const activity = this.host.settings().activity;
    const cites = [
      ...this.host.wakes().filter(wake => reached.has(wake.id)).map(wake => ({ id: wake.id, kind: wake.kind, title: wake.title })),
      ...this.host.pursuits().filter(pursuit => reached.has(pursuit.id)).map(pursuit => ({ id: pursuit.id, kind: 'pursuit', title: pursuit.title })),
      ...(activity && reached.has('state:activity') ? [{ id: 'state:activity', kind: 'activity', title: activity }] : []),
    ];
    return { withdrawn, cites };
  }

  /** Revisions the digital life did not make in a thought of its own, such as an operator correction or what a review handed on, come to it as one event, with what they reached. Its own revisions report this in their result. */
  noticeRevisions(revisions: { memory: Memory; reach: RevisionReach }[]) {
    const held = revisions.filter(({ memory }) => this.memory(memory.id));
    if (!held.length) return;
    const list = (items: { id: string; title: string }[]) => items.map(item => `${item.id} (${item.title})`).join('; ');
    const once = <T extends { id: string }>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()];
    const withdrawn = once(held.flatMap(({ reach }) => reach.withdrawn)); const cites = once(held.flatMap(({ reach }) => reach.cites));
    const one = held.length === 1;
    const replaced = held.map(({ memory }) => `${memory.id} replaces ${memory.supersedes}`).join('; ');
    this.host.transaction(() => {
      const revision = this.host.receive({ key: `revision:${held.map(({ memory }) => memory.id).join(',')}`, kind: 'memory_revision', at: Date.now(), text: `${one ? 'An understanding was' : 'Understandings were'} revised outside your thoughts: ${replaced}.${withdrawn.length ? ` Memories resting on the old ${one ? 'version' : 'versions'} have left everyday recall: ${list(withdrawn)}.` : ''}${cites.length ? ` What is under way cites ${one ? 'it' : 'them'}: ${list(cites)}; check whether it still holds.` : ''}`, payload: { revisions: held.map(({ memory }) => ({ memoryId: memory.id, supersedes: memory.supersedes ?? null })), withdrawn, cites } });
      if (revision) for (const { memory } of held) this.db.prepare('INSERT INTO sources VALUES (?,?)').run(revision.id, memory.id);
    });
  }

  private ownMessage(source: string): boolean {
    const event = readEvent(this.db, source); if (!event) return false;
    return event.source?.own === true || event.payload.origin === 'self';
  }

  /** Whether the sources, or the memories they cite in turn, reach something it did not produce itself (ADR-0012). */
  private restsOnOthers(sources: string[]): boolean {
    const reached = this.db.prepare("WITH RECURSIVE reach(id) AS (SELECT value FROM json_each(?) UNION SELECT source_id FROM sources JOIN reach ON owner_id=reach.id WHERE owner_id LIKE 'm:%') SELECT id FROM reach").all(json(sources)).map(row => String(row.id));
    return reached.some(source => { const event = readEvent(this.db, source); return event !== undefined && event.payload.origin !== 'self' && !programEvents.has(event.kind) && !this.ownMessage(source); });
  }

  /** Development that applies in any of the given scopes, oldest first. */
  development(scopes: string[]): Memory[] {
    if (!scopes.length) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE active=1 AND scope IN (${scopes.map(() => '?').join(',')}) ORDER BY created_at,rowid`).all(...scopes).map(row => readMemoryRow(this.db, row));
  }

  /** Development that no longer holds leaves everyday use; its history remains. */
  retireMemory(memoryId: string): Memory {
    const memory = this.memory(memoryId);
    if (!memory?.active || !isDevelopment(memory.kind)) throw new Error('Only a current habit, practice, or impression can be retired.');
    const write = () => { this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(memoryId); this.host.log('memory_retired', { id: memoryId, kind: memory.kind, scope: memory.scope }); };
    if (this.db.isTransaction) write(); else this.host.transaction(write);
    return { ...memory, active: false };
  }

  /** Once, split habits, practices, and impressions kept as one numbered list into an entry for each item (ADR-0025, ADR-0026). */
  splitDevelopment(entryChars: number): number {
    return this.host.transaction(() => {
      if (this.host.setting('developmentSplit', false)) return 0;
      const insert = this.db.prepare('INSERT INTO memories(id,kind,title,content,importance,subjects,conversations_json,fictional,supersedes,active,created_at,scope) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)');
      let split = 0;
      for (const row of this.db.prepare("SELECT * FROM memories WHERE active=1 AND kind IN ('habit','practice','impression') ORDER BY created_at,rowid").all()) {
        const items = listItems(String(row.content));
        if (characters(String(row.content)) <= entryChars || !items) continue;
        const ids = items.map(item => {
          const entryId = makeId('m');
          insert.run(entryId, row.kind!, entryTitle(item), item, row.importance!, row.subjects!, row.conversations_json!, row.fictional!, row.id!, row.created_at!, row.scope!);
          this.db.prepare('INSERT INTO sources VALUES (?,?)').run(entryId, String(row.id));
          return entryId;
        });
        this.db.prepare('UPDATE memories SET active=0 WHERE id=?').run(String(row.id));
        this.host.log('development_split', { id: row.id, kind: row.kind, scope: row.scope, entries: ids.length });
        for (const entryId of ids) this.host.log('memory_written', { id: entryId, kind: row.kind, supersedes: row.id, scope: row.scope });
        split++;
      }
      this.host.setSetting('developmentSplit', true);
      return split;
    });
  }

  search(query: string, limit = 8, subjects: string[] = [], historical = false): Memory[] {
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
      const memory = readMemoryRow(this.db, row);
      const text = `${memory.title} ${memory.content}`.toLowerCase();
      const matches = terms.filter(term => text.includes(term) || memory.subjects.some(subject => subject.toLowerCase().includes(term))).length;
      const person = memory.subjects.some(x => subjects.includes(x)) ? 8 : 0;
      const recency = Math.exp(-(now - memory.createdAt) / (30 * 86_400_000));
      return { memory, score: matches * 5 + person + memory.importance / 3 + recency, relevant: !query.trim() || matches > 0 || person > 0 };
    }).filter(x => x.relevant).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.memory);
  }

  noteRecalled(how: 'spontaneous' | 'deliberate', memories: { id: string; similarity?: number }[], detail: { runId?: string; reviewing?: boolean } = {}) {
    if (!memories.length) return;
    const now = Date.now();
    const count = this.db.prepare(`INSERT INTO memory_recalls(memory_id,${how},last_at) SELECT id,1,? FROM memories WHERE id=? ON CONFLICT(memory_id) DO UPDATE SET ${how}=${how}+1,last_at=excluded.last_at`);
    const write = () => {
      for (const memory of memories) count.run(now, memory.id);
      this.host.log('memory_recalled', { how, ...detail, memories: memories.map(({ id, similarity }) => ({ id, ...(similarity === undefined ? {} : { similarity: Math.round(similarity * 1000) / 1000 }) })) });
    };
    if (this.db.isTransaction) write(); else this.host.transaction(write);
  }

  recalls(memoryId: string): { spontaneous: number; deliberate: number; lastAt: number } | undefined {
    const row = this.db.prepare('SELECT * FROM memory_recalls WHERE memory_id=?').get(memoryId);
    return row ? { spontaneous: Number(row.spontaneous), deliberate: Number(row.deliberate), lastAt: Number(row.last_at) } : undefined;
  }

  recallableIds(): Set<string> { return new Set(this.db.prepare(`SELECT id FROM memories WHERE ${recallableSql}`).all().map(row => String(row.id))); }
  searchableIds(historical: boolean): Set<string> { return new Set(this.db.prepare(`SELECT id FROM memories${historical ? '' : ' WHERE active=1'}`).all().map(row => String(row.id))); }
  dropOtherVectors(model: string) { this.db.prepare('DELETE FROM memory_vectors WHERE model!=?').run(model); }
  memoryVectors(model: string): { memoryId: string; line: string; vector: Float32Array }[] {
    return this.db.prepare('SELECT * FROM memory_vectors WHERE model=? ORDER BY memory_id,chunk').all(model)
      .map(row => ({ memoryId: String(row.memory_id), line: String(row.line), vector: new Float32Array(Uint8Array.from(row.vector as Uint8Array).buffer) }));
  }
  unindexedMemories(model: string, limit: number): Memory[] {
    return this.db.prepare(`SELECT * FROM memories WHERE NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id=memories.id AND v.model=?) ORDER BY created_at,rowid LIMIT ?`).all(model, limit).map(row => readMemoryRow(this.db, row));
  }
  saveMemoryVectors(memoryId: string, model: string, lines: { line: string; vector: Float32Array }[]): boolean {
    return this.host.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(memoryId)) return false;
      this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(memoryId);
      const insert = this.db.prepare('INSERT INTO memory_vectors VALUES (?,?,?,?,?)');
      lines.forEach(({ line, vector }, chunk) => insert.run(memoryId, chunk, model, line, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)));
      return true;
    });
  }

  /** What forgetting a record takes with it: evidence, dependent memories, and plans/pursuits/activity that had any of it in view (ADR-0003, ADR-0017). */
  forgetPlan(root: string): string[] {
    if (!this.memory(root) && !readEvent(this.db, root)) throw new Error('Record does not exist.');
    const selected = new Set<string>([root]);
    const sourcesOf = this.db.prepare('SELECT source_id FROM sources WHERE owner_id=?'); const ownersOf = this.db.prepare('SELECT owner_id FROM sources WHERE source_id=?');
    const ancestors = [root];
    while (ancestors.length) {
      const owner = ancestors.pop()!; if (!carriesEvidence(owner)) continue;
      for (const row of sourcesOf.all(owner)) { const source = String(row.source_id); if (!selected.has(source)) { selected.add(source); ancestors.push(source); } }
    }
    const resting = (from: string[]) => {
      const dependents = [...from];
      while (dependents.length) for (const row of ownersOf.all(dependents.pop()!)) {
        const child = String(row.owner_id);
        if (carriesEvidence(child) && !selected.has(child)) { selected.add(child); dependents.push(child); }
      }
    };
    resting([...selected]);
    const inView = [...new Set([...selected].flatMap(item => ownersOf.all(item).map(row => String(row.owner_id))))].filter(owner => !selected.has(owner));
    for (const owner of inView) selected.add(owner);
    resting(inView);
    return [...selected];
  }

  forget(root: string): string[] {
    const selected = this.forgetPlan(root);
    this.host.transaction(() => {
      for (const selectedId of selected) {
        const event = readEvent(this.db, selectedId);
        if (event) this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(event.key);
        this.db.prepare('DELETE FROM sources WHERE owner_id=? OR source_id=?').run(selectedId, selectedId);
        this.db.prepare('DELETE FROM memories WHERE id=?').run(selectedId);
        this.db.prepare('DELETE FROM events WHERE id=?').run(selectedId);
        this.db.prepare('DELETE FROM wakes WHERE id=?').run(selectedId);
        this.db.prepare('DELETE FROM pursuits WHERE id=?').run(selectedId);
        if (selectedId === 'state:activity') this.host.setSetting('activity', '');
      }
      // Action results can contain the original message text; retain only outcome metadata.
      const chosen = new Set(selected); const citing: string[] = [];
      for (const row of this.db.prepare('SELECT id,source_ids FROM actions').iterate()) if (parse<string[]>(row.source_ids).some(x => chosen.has(x))) citing.push(String(row.id));
      for (const actionId of citing) this.db.prepare("UPDATE actions SET args='{}',result=?,source_ids='[]' WHERE id=?").run(json({ redacted: true }), actionId);
      this.db.exec('DELETE FROM working_context; DELETE FROM context_records;');
      this.host.bumpGeneration(); this.host.log('memory_forgotten', { ids: selected });
    });
    return selected;
  }

  revisitDue(limit: number, experienceChars: number, now = Date.now()): Revisit[] {
    const rows = this.db.prepare(`SELECT m.*, coalesce(r.spontaneous+r.deliberate,0) AS recalls FROM memories m LEFT JOIN memory_recalls r ON r.memory_id=m.id
      WHERE m.active=1 AND m.kind='experience' AND m.created_at<? AND NOT EXISTS (SELECT 1 FROM memory_revisits v WHERE v.memory_id=m.id) AND length(m.content)>?
      ORDER BY recalls DESC, m.created_at, m.rowid LIMIT ?`).all(now - 86_400_000, experienceChars, limit);
    const spans = this.db.prepare('SELECT e.conversation_ref AS conversation, min(e.at) AS first, max(e.at) AS last, count(*) AS events FROM sources s JOIN events e ON e.id=s.source_id WHERE s.owner_id=? AND e.conversation_ref IS NOT NULL GROUP BY 1 ORDER BY first');
    return rows.map(row => ({ memory: readMemoryRow(this.db, row), spans: spans.all(String(row.id)).map(span => ({ conversation: String(span.conversation), from: Number(span.first), to: Number(span.last), events: Number(span.events) })) }));
  }

  notedSince(at: number): Memory[] {
    const ids = this.db.prepare("SELECT json_extract(data,'$.id') AS id FROM trace WHERE kind='remembered' AND at>? AND json_extract(data,'$.where')='conversation' ORDER BY id").all(at).map(row => String(row.id));
    return ids.map(memoryId => this.memory(memoryId)).filter((memory): memory is Memory => memory !== undefined && memory.active && !['note', 'fiction'].includes(memory.kind));
  }

  revisitPending(experienceChars: number): boolean {
    return this.db.prepare("SELECT 1 FROM memories m WHERE m.active=1 AND m.kind='experience' AND length(m.content)>? AND NOT EXISTS (SELECT 1 FROM memory_revisits v WHERE v.memory_id=m.id) LIMIT 1").get(experienceChars) !== undefined;
  }

  markRevisited(memoryIds: string[], now = Date.now()) {
    const mark = this.db.prepare('INSERT OR IGNORE INTO memory_revisits SELECT id, ? FROM memories WHERE id=?');
    for (const memoryId of memoryIds) mark.run(now, memoryId);
  }

  randomMemory(kinds: MemoryKind[], before = Number.MAX_SAFE_INTEGER): Memory | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE active=1 AND kind IN (${kinds.map(() => '?').join(',')}) AND created_at<? ORDER BY random() LIMIT 1`).get(...kinds, before);
    return row ? readMemoryRow(this.db, row) : undefined;
  }

  lastMemoryAt(kind: MemoryKind): number | undefined {
    const row = this.db.prepare('SELECT max(created_at) AS at FROM memories WHERE kind=?').get(kind);
    return row?.at == null ? undefined : Number(row.at);
  }
}
