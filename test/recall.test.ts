import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, type Message } from '@earendil-works/pi-ai';
import { Store } from '../src/store.js';
import { handleControl } from '../src/control.js';
import { EmbeddingClient, SemanticRecall, memoryLines, queryText, type Embedder } from '../src/recall.js';
import { config, event, fixture } from './helpers.js';

const updates = (messages: Message[]) => messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')
  ? [JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>')))] : []);

/** One dimension per topic word and a shared baseline, so texts on the same topic are alike (0.745 or more) and others are not (0.447 or less). */
function topics(model = 'topics', fail?: (texts: string[]) => Error | undefined): Embedder & { calls: string[][] } {
  const words = ['夜曲', '新番', '小笼包', '天气'];
  const calls: string[][] = [];
  return {
    model, calls,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      calls.push(texts);
      const error = fail?.(texts); if (error) throw error;
      return texts.map(text => Float32Array.from([...words.map(word => text.includes(word) ? 1 : 0), 0.5]));
    },
  };
}
function embeddingConfig(changes: Partial<ReturnType<typeof config>['embedding']> = {}) {
  const cfg = config();
  cfg.embedding = { ...cfg.embedding, enabled: true, baseUrl: 'https://embed.example/v1', model: 'topics', selfNames: ['秋月', '秋月姐姐'], ...changes };
  return cfg;
}
/** Each memory rests on its own source, so forgetting one leaves the others. */
const remember = (store: Store, title: string, content: string, kind: 'note' | 'experience' | 'habit' = 'note') =>
  store.writeMemory({ kind, title, content, importance: 5, sources: [event(store, `source of ${title}`).id] }, false);
const vectorRows = (store: Store) => store.db.prepare('SELECT memory_id, model FROM memory_vectors ORDER BY memory_id, chunk').all().map(row => [String(row.memory_id), String(row.model)]);

test('memories are embedded line by line, and messages without placeholders, mentions, or her names', () => {
  assert.deepEqual(memoryLines({ content: '傍晚的群聊小记：\n1. 群友们聊新番聊得很热闹，大家都在追\\n2. 太好了\r\n3. 地铁说下次带小笼包来群里分享' }), ['1. 群友们聊新番聊得很热闹，大家都在追', '3. 地铁说下次带小笼包来群里分享']);
  assert.deepEqual(memoryLines({ content: ' 短句 ' }), ['短句']);
  assert.equal(queryText('[Quoted message -42][@900] 秋月姐姐你看[face 212][face 9999][image]这个', { 212: '托腮' }, ['秋月', '秋月姐姐']), '你看 托腮 这个');
  assert.equal(queryText('[face 1][record]', {}, []), '');
});

test('what people say calls up the memory and line it is about, never development, their shared group alone, or her own messages', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  const song = remember(store, '日记', '晚上的小记：\n1. 练夜曲的副歌又破音了，有点烦\n2. 群友们一直在聊新番，聊得很热闹');
  const lunch = remember(store, '午饭', '地铁请大家吃小笼包，说下次还请', 'experience');
  const habit = remember(store, '习惯', '有人提到夜曲时我会多说两句', 'habit');
  const embedder = topics();
  const recall = new SemanticRecall(embeddingConfig(), store, embedder);
  const one = new SemanticRecall(embeddingConfig({ limit: 1 }), store, topics());
  try {
    recall.start(); await recall.idle();
    // Development is embedded for deliberate search, though it is supplied by scope and never called to mind.
    assert.deepEqual(new Set(vectorRows(store).map(([id]) => id)), new Set([song.id, lunch.id, habit.id]));
    assert.ok(embedder.calls.flat().includes('日记：1. 练夜曲的副歌又破音了，有点烦'));
    const asked = event(store, '秋月姐姐，昨天那首夜曲练得怎么样了');
    const mine = store.receive({ key: 'mine', kind: 'message', at: Date.now(), text: '小笼包真好吃', groupId: 100, actorId: 900, payload: {} })!;
    const chat = event(store, '今天随便聊聊');
    await recall.idle();
    assert.ok(embedder.calls.flat().includes('，昨天那首夜曲练得怎么样了'));
    assert.ok(!embedder.calls.flat().includes('小笼包真好吃'));
    assert.deepEqual(recall.recall([asked]).map(item => [item.memory.id, item.line]), [[song.id, '1. 练夜曲的副歌又破音了，有点烦']]);
    // Every message here and both memories share group 100; only what is said brings one up.
    assert.deepEqual(recall.recall([chat, mine]), []);
    one.start(); await one.idle();
    const both = event(store, '夜曲练完去吃小笼包吧');
    await Promise.all([recall.idle(), one.idle()]);
    assert.deepEqual(new Set(recall.recall([both]).map(item => item.memory.id)), new Set([song.id, lunch.id]));
    assert.equal(one.recall([both]).length, 1);
    assert.deepEqual(one.recall([asked]), [], 'a message that arrived before it started was never embedded');
  } finally { await Promise.all([recall.stop(), one.stop()]); store.close(); }
});

test('a correction replaces what is recalled, forgetting removes vectors, a restart reuses them, and another model starts over', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  const song = remember(store, '日记', '练夜曲的副歌又破音了，有点烦');
  const lunch = remember(store, '午饭', '地铁请大家吃小笼包，说下次还请');
  let recall = new SemanticRecall(embeddingConfig(), store, topics());
  try {
    recall.start(); await recall.idle();
    const corrected = handleControl(store, { args: ['memory', 'correct', song.id, '练夜曲终于不破音了，开心'] }) as { id: string };
    const asked = event(store, '夜曲练得怎么样');
    await recall.idle();
    assert.deepEqual(recall.recall([asked]).map(item => item.memory.id), [corrected.id]);
    store.forget(corrected.id);
    assert.deepEqual(vectorRows(store), [[lunch.id, 'topics']]);
    assert.deepEqual(recall.recall([asked]), []);
    await recall.stop();
    const again = topics();
    recall = new SemanticRecall(embeddingConfig(), store, again); recall.start(); await recall.idle();
    assert.deepEqual(again.calls, [], 'vectors saved before a restart are reused');
    const food = event(store, '下次还吃小笼包'); await recall.idle();
    assert.deepEqual(recall.recall([food]).map(item => item.memory.id), [lunch.id]);
    assert.deepEqual(again.calls, [['下次还吃小笼包']]);
    await recall.stop();
    const other = topics('other');
    recall = new SemanticRecall(embeddingConfig({ model: 'other' }), store, other); recall.start(); await recall.idle();
    assert.deepEqual(vectorRows(store), [[lunch.id, 'other']]);
    assert.deepEqual(other.calls, [['午饭：地铁请大家吃小笼包，说下次还请']]);
  } finally { await recall.stop(); store.close(); }
});

test('an unreachable endpoint leaves thoughts without recall and logs once, and a rejected memory does not hold up the rest', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  let down = true;
  const embedder = topics('topics', texts => down ? new Error('connect ECONNREFUSED') : texts.some(text => text.includes('坏')) ? Object.assign(new Error('HTTP 400'), { status: 400 }) : undefined);
  const errors = () => store.logs(50).filter(log => log.kind === 'recall_error').map(log => log.data as { stage: string; memoryId?: string });
  let recall = new SemanticRecall(embeddingConfig(), store, embedder);
  try {
    recall.start(); await recall.idle();
    const first = event(store, '夜曲练得怎么样'); const second = event(store, '小笼包好吃吗');
    await recall.idle();
    assert.deepEqual(recall.recall([first, second]), []);
    assert.deepEqual(errors().map(error => error.stage), ['message']);
    // Indexing still tries, and messages wait out the pause rather than each failing again.
    const song = remember(store, '日记', '练夜曲的副歌又破音了，有点烦');
    await recall.idle();
    assert.deepEqual(errors().map(error => error.stage), ['memory', 'message']);
    assert.equal(embedder.calls.length, 2);
    await recall.stop();
    down = false;
    const bad = remember(store, '坏日记', '这一条的内容会被接口拒绝掉');
    recall = new SemanticRecall(embeddingConfig(), store, embedder); recall.start(); await recall.idle();
    assert.deepEqual(vectorRows(store).map(([id]) => id), [song.id]);
    assert.equal(errors()[0]?.memoryId, bad.id);
  } finally { await recall.stop(); store.close(); }
});

test('a deliberate search finds memories by meaning and by exact words, earlier versions on request, and words alone when the endpoint is down', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  let down = false;
  const embedder = topics('topics', () => down ? new Error('connect ECONNREFUSED') : undefined);
  const recall = new SemanticRecall(embeddingConfig(), store, embedder);
  // Every memory here names a topic, so a query without one is unlike all of them.
  const song = remember(store, '日记', '练夜曲的副歌又破音了，有点烦');
  const habit = remember(store, '习惯', '有人提到夜曲时我会多说两句', 'habit');
  const repo = store.writeMemory({ kind: 'note', title: '仓库', content: '地铁开源了 dixiatielu 的仓库，大家顺便聊起新番', importance: 5, subjects: ['1397749594'], sources: [event(store, 'repo').id] }, false);
  try {
    recall.start(); await recall.idle();
    // One run of letters, so text search misses it, while its meaning matches.
    assert.equal(store.search('夜曲练习').length, 0);
    const byMeaning = await recall.search('夜曲练习', 8);
    assert.deepEqual(new Set(byMeaning.map(memory => memory.id)), new Set([song.id, habit.id]));
    assert.equal(byMeaning.find(memory => memory.id === song.id)?.matchedLine, '练夜曲的副歌又破音了，有点烦');
    // Names and QQ numbers come from text search, with no matched line.
    for (const query of ['dixiatielu', '1397749594']) assert.deepEqual((await recall.search(query, 8)).map(memory => [memory.id, memory.matchedLine]), [[repo.id, undefined]]);
    // Found both ways ranks above what only one way finds first: song by meaning, and repo by its name, which its importance puts ahead in text search.
    const both = store.writeMemory({ kind: 'note', title: '伴奏', content: 'dixiatielu 给夜曲写了一段伴奏', importance: 2, sources: [event(store, 'accompaniment').id] }, false);
    await recall.idle();
    const fused = await recall.search('夜曲练习 dixiatielu', 8);
    assert.equal(fused[0]?.id, both.id);
    assert.deepEqual(new Set(fused.map(memory => memory.id)), new Set([both.id, song.id, habit.id, repo.id]));
    const corrected = handleControl(store, { args: ['memory', 'correct', song.id, '练夜曲终于不破音了，开心'] }) as { id: string };
    await recall.idle();
    assert.deepEqual(new Set((await recall.search('夜曲练习', 8)).map(memory => memory.id)), new Set([corrected.id, habit.id, both.id]));
    assert.ok((await recall.search('夜曲练习', 8, [], true)).some(memory => memory.id === song.id));
    await assert.rejects(recall.search('夜曲练习', 8, [], false, AbortSignal.abort()));
    down = true;
    assert.deepEqual(new Set((await recall.search('dixiatielu', 8)).map(memory => memory.id)), new Set([repo.id, both.id]));
    assert.deepEqual(await recall.search('夜曲练习', 8), []);
    assert.equal(store.logs(10).filter(log => log.kind === 'recall_error' && (log.data as { stage: string }).stage === 'search').length, 1);
  } finally { await recall.stop(); store.close(); }
});

test('the recall tool searches by meaning when embedding is on, and records what it found as sources', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  const song = remember(store, '日记', '练夜曲的副歌又破音了，有点烦');
  const recall = new SemanticRecall(embeddingConfig(), store, topics());
  const f = fixture(undefined, store, undefined, recall);
  try {
    recall.start(); await recall.idle();
    const tool = f.tools.current().find(item => item.name === 'recall')!;
    assert.match(tool.description, /by meaning and by exact words/);
    assert.doesNotMatch(fixture().tools.current().find(item => item.name === 'recall')!.description, /by meaning/);
    f.brain.thought.lifeOnly = false; f.brain.thought.generation = store.settings().generation;
    const result = await tool.execute('call-1', { query: '夜曲练习' }, undefined);
    const found = JSON.parse((result.content[0] as { text: string }).text) as { id: string; matchedLine?: string }[];
    assert.deepEqual(found.map(memory => [memory.id, memory.matchedLine]), [[song.id, '练夜曲的副歌又破音了，有点烦']]);
    assert.ok(f.brain.thought.sources.has(song.id));
  } finally { await recall.stop(); store.close(); }
});

test('the embeddings client posts the model and texts and returns vectors in input order', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let reply = (): Response => Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  const client = new EmbeddingClient({ ...embeddingConfig().embedding, baseUrl: 'https://embed.example/v1/', model: 'm', apiKeyEnv: 'TEST_EMBEDDING_KEY' }, (async (url: string, init: RequestInit) => { requests.push({ url, init }); return reply(); }) as typeof fetch);
  process.env.TEST_EMBEDDING_KEY = 'secret';
  try {
    assert.deepEqual((await client.embed(['a', 'b'])).map(vector => [...vector]), [[1, 0], [0, 1]]);
    assert.equal(requests[0]!.url, 'https://embed.example/v1/embeddings');
    assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { model: 'm', input: ['a', 'b'] });
    reply = () => new Response('busy', { status: 503 });
    await assert.rejects(client.embed(['a']), (error: Error & { status?: number }) => error.status === 503 && /HTTP 503/.test(error.message));
    reply = () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    await assert.rejects(client.embed(['a', 'b']), /invalid format/);
    reply = () => Response.json({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }] });
    await assert.rejects(client.embed(['a', 'b']), /invalid format/);
  } finally { delete process.env.TEST_EMBEDDING_KEY; }
});

test('a thought sees the memories its messages call up, with the matching line, instead of everything from the same group', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  const song = remember(store, '日记', '晚上的小记：\n1. 练夜曲的副歌又破音了，有点烦\n2. 群友们一直在聊新番');
  remember(store, '午饭', '地铁请大家吃小笼包，说下次还请');
  const recall = new SemanticRecall(embeddingConfig(), store, topics());
  const f = fixture(undefined, store, undefined, recall);
  try {
    recall.start(); await recall.idle();
    event(store, '那首夜曲你练得怎么样了');
    await recall.idle();
    let seen: unknown;
    f.faux.setResponses([context => { seen = updates(context.messages as Message[]).at(-1)?.recalled; return answer('Remembered'); }]);
    await f.brain.run(store.claim(20)!);
    assert.deepEqual((seen as { id: string; matchedLine: string }[]).map(item => [item.id, item.matchedLine]), [[song.id, '1. 练夜曲的副歌又破音了，有点烦']]);
  } finally { await recall.stop(); store.close(); }
});
