import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { cachedEmbedder, replay, type ReplayCase } from '../src/replay.js';
import { qqEvent } from './helpers.js';
import { topics, embeddingConfig } from './embedding-helpers.js';
import { SemanticRecall } from '../src/recall.js';

const DAY = 86_400_000;
test('a replay asks what was in view at a past moment, with the memories held then, and reads the database only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-replay-')); const path = join(dir, 'life.sqlite');
  const cfg = embeddingConfig(); cfg.embedding.limit = 1; cfg.development.personChars = 8;
  const store = new Store(path); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  const start = Date.now() - 10 * DAY;
  const said = (text: string, day: number, actorId = 7) => store.receive(qqEvent({ key: crypto.randomUUID(), kind: 'message', at: start + day * DAY, text, groupId: 100, actorId, payload: { message_type: 'group', sender: { user_id: actorId }, message: [{ type: 'text', data: { text } }] } }, store), true)!;
  /** Written on a given day, which the store itself would stamp as now. */
  const remembered = (day: number, input: Parameters<Store['writeMemory']>[0]) => { const memory = store.writeMemory(input, false); store.db.prepare('UPDATE memories SET created_at=? WHERE id=?').run(start + day * DAY, memory.id); return memory; };
  const note = (day: number, title: string, content: string, source: string, supersedes?: string) => remembered(day, { kind: 'experience', title, content, importance: 5, sources: [source], supersedes });
  try {
    const sang = said('夜曲的副歌我唱破音了', 0); const ate = said('地铁请吃小笼包', 0); const rain = said('今天的天气真差', 0); const untold = said('她说下周去看新番的首映', 0);
    const song = note(1, '练歌', '练夜曲的副歌又破音了', sang.id);
    const songLater = note(5, '练歌', '夜曲的副歌已经练顺了', sang.id, song.id);
    const lunch = note(1, '午饭', '天气好，地铁请大家吃小笼包，说下次还请', ate.id);
    const weather = note(1, '下雨', '那天的天气很差，淋了雨', rain.id);
    const impression = remembered(1, { kind: 'impression', title: 'P7', content: '爱聊夜曲', importance: 5, scope: 'person:qq:user:7', sources: [sang.id] });
    const lives = remembered(1, { kind: 'impression', title: '住处', content: '住在成都，离学校很近', importance: 3, scope: 'person:qq:user:7', sources: [sang.id] });
    const habit = remembered(1, { kind: 'habit', title: '少说', content: '一句就够', importance: 5, sources: [sang.id] });
    store.retireMemory(habit.id); store.db.prepare("UPDATE trace SET at=? WHERE kind='memory_retired'").run(start + 3 * DAY);
    const embedder = topics();
    const indexing = new SemanticRecall(cfg, store, embedder); indexing.start(); await indexing.idle(); await indexing.stop();
    const asked = said('那首夜曲你练得怎么样了', 2); const askedLater = said('夜曲练顺了吗', 6); const stranger = said('夜曲和小笼包哪个好', 2, 8); const quiet = said('在吗', 2, 8); const film = said('新番首映去了吗', 6, 8);
    const before = store.db.prepare('SELECT count(*) AS n FROM memories').get()!.n; const eventsBefore = store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
    store.close();
    const cases: ReplayCase[] = [
      // Named by its later version: the one held on day 2 is the first, which what he says calls to mind.
      { id: 'recalled', triggers: [asked.id], gold: [songLater.id], did: 'used' },
      // Named by the first version: on day 6 the version that replaced it is the one held.
      { id: 'later-version', triggers: [askedLater.id], gold: [song.id] },
      // The impression of the speaker comes with the thought, whatever is said.
      { id: 'supplied', triggers: [quiet.id, asked.id], gold: [impression.id] },
      // Less important than what comes whole about him, it comes as a title, one read away.
      { id: 'listed', triggers: [quiet.id, asked.id], gold: [lives.id] },
      // Two memories are alike to what is said and one may come up; the other is still found by a search for its words.
      { id: 'findable', triggers: [stranger.id], gold: [lunch.id], query: '小笼包' },
      // Held, but nothing said calls it up and its words are not searched for.
      { id: 'missed', triggers: [quiet.id], gold: [weather.id], did: 'missed' },
      // A habit retired on day 3 was held on day 2 and not on day 6.
      { id: 'habit-held', triggers: [quiet.id], gold: [habit.id] },
      { id: 'habit-retired', triggers: [film.id], gold: [habit.id] },
      // It was said and never kept.
      { id: 'unrecorded', triggers: [film.id], gold: [], where: [untold.id], did: 'missed', note: 'said once, never saved' },
      // A memory written after the moment replayed was not held then.
      { id: 'not-yet', triggers: [asked.id], gold: [weather.id], at: start + 12 * 3_600_000 },
    ];
    const calls = embedder.calls.length;
    const report = await replay(path, cfg, cachedEmbedder(embedder, join(dir, 'vectors.json')), cases);
    const result = Object.fromEntries(report.results.map(item => [item.id, item]));
    assert.deepEqual(Object.fromEntries(report.results.map(item => [item.id, item.outcome])), { recalled: 'recalled', 'later-version': 'recalled', supplied: 'supplied', listed: 'listed', findable: 'findable', missed: 'missed', 'habit-held': 'supplied', 'habit-retired': 'unrecorded', unrecorded: 'unrecorded', 'not-yet': 'unrecorded' });
    assert.deepEqual(report.outcomes, { supplied: 2, recalled: 2, listed: 1, findable: 1, missed: 1, unrecorded: 3 });
    assert.deepEqual([report.cases, report.threshold, report.limit], [10, cfg.embedding.threshold, 1]);
    // What she did at the time is set beside what the replay finds, and the labeller's notes stay out of the report.
    assert.deepEqual(report.byDid, { used: { recalled: 1 }, missed: { missed: 1, unrecorded: 1 } });
    assert.doesNotMatch(JSON.stringify(report), /never saved/);
    // One version is held at a time, and what comes to mind beside it is counted as other.
    assert.deepEqual([result.recalled!.held, result.recalled!.recalled, result.recalled!.other, result.recalled!.rank], [1, 1, 0, 1]);
    assert.equal(result['later-version']!.held, 1);
    assert.ok(result.recalled!.similarity! >= cfg.embedding.threshold);
    assert.deepEqual([result.findable!.recalled, result.findable!.other, result.findable!.searchRank], [1, 1, 1]);
    assert.ok(result.findable!.rank! >= 1 && result.missed!.similarity! < cfg.embedding.threshold);
    // Only what was said is embedded, once: a second run asks the endpoint nothing and reports the same.
    const asking = embedder.calls.length; assert.ok(asking > calls);
    assert.deepEqual(await replay(path, cfg, cachedEmbedder(embedder, join(dir, 'vectors.json')), cases), report);
    assert.equal(embedder.calls.length, asking);
    // The report carries no words of a memory or a message, and the database is as it was.
    assert.doesNotMatch(JSON.stringify(report), /夜曲|小笼包|天气|新番/);
    assert.doesNotMatch(readFileSync(join(dir, 'vectors.json'), 'utf8'), /夜曲/);
    const after = new Store(path);
    try {
      assert.equal(after.db.prepare('SELECT count(*) AS n FROM memories').get()!.n, before); assert.equal(after.db.prepare('SELECT count(*) AS n FROM events').get()!.n, eventsBefore);
      assert.equal(after.memory(song.id)?.active, false); assert.equal(after.memory(lunch.id)?.active, true);
    } finally { after.close(); }
    await assert.rejects(replay(path, cfg, embedder, [{ id: 'gone', triggers: ['e:none'], gold: [] }]), /Case gone: event e:none does not exist/);
    await assert.rejects(replay(path, cfg, topics('another-model'), cases), /holds no memory vectors for another-model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
