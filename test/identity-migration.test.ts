import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateIdentities } from '../src/identity-migration.js';
import { loadConfig } from '../src/config.js';
import { Store, actionFingerprint } from '../src/store.js';
import { LifeReader } from '../src/webui/reader.js';
import { StickerStore } from '../src/plugins/stickers-store.js';
import { normalizeEvent } from '../src/adapters/snowluma/index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-identities-'));
  const configPath = join(dir, 'config.json'); const path = join(dir, 'life.sqlite');
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  delete raw.adapters; raw.snowluma = { selfId: 900, groups: [100], tools: { allow: '*', deny: ['delete_msg'] } };
  raw.database = 'life.sqlite'; raw.plugins = { 'qq-stickers': false }; raw.personaFile = 'persona.md';
  writeFileSync(join(dir, 'persona.md'), 'Qiuyue'); writeFileSync(configPath, JSON.stringify(raw));
  const db = new DatabaseSync(path); db.exec(readFileSync(new URL('./identity-v1.sql', import.meta.url), 'utf8'));
  const set = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  set('selfId', 900); set('generation', 4); set('reviewMarks', { 'group:100': 12, 'qq:900:group:100': 14 });
  db.prepare("INSERT INTO events(id,source_key,kind,at,group_id,actor_id,text,payload,status) VALUES ('e:one','native-key','message',1000,100,7,'hello',?,'processed')").run(JSON.stringify({ message_id: 9, group_name: 'Friends', sender: { nickname: 'Seven' }, message: [{ type: 'text', data: { text: 'hello' } }] }));
  db.prepare("INSERT INTO memories(id,kind,title,content,importance,subjects,groups_json,fictional,created_at,scope) VALUES ('m:one','practice','Habit','Chats',3,'[\"7\"]','[100]',0,1000,'group:100')").run();
  db.exec("INSERT INTO sources VALUES ('m:one','e:one'); INSERT INTO wakes(id,title,kind,due_at) VALUES ('w:one','Promise','commitment',9999); INSERT INTO sources VALUES ('w:one','m:one'); INSERT INTO tombstones VALUES ('forgotten-native-key');");
  for (const [id, kind, args, status, result] of [
    ['a:unknown', 'send_group_msg', { group_id: 100, message: 'hello' }, 'unknown', { reason: 'connection lost' }],
    ['a:pending', 'send_private_msg', { user_id: 7, message: 'later' }, 'pending', null],
    ['a:done', 'send_group_msg', { group_id: 100, message: 'done' }, 'success', { message_id: 11 }],
    ['a:sticker', 'add_custom_face', { file: 'https://example.com/sticker.png' }, 'success', { emoji_id: 'saved' }],
    ['a:description', 'modify_custom_face', { emoji_id: 'saved', desc: 'Happy' }, 'success', {}],
  ] as const) db.prepare('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(id, id, actionFingerprint(kind, args), kind, JSON.stringify(args), '["e:one"]', status, JSON.stringify(result), 1000);
  db.exec("INSERT INTO action_triggers VALUES ('a:done','e:one'); INSERT INTO working_context VALUES (1,'old',4,'{}',1000); CREATE TABLE gallery_drawings(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  db.prepare('INSERT INTO gallery_drawings VALUES (?,?)').run('drawing:test', JSON.stringify({ sources: [{ id: 'e:one', person: '7', conversation: 'group:100' }] }));
  return { dir, db, path, raw, configPath, set, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('offline migration preserves provenance, receipts and deduplication, and removes runtime legacy identities', async () => {
  const f = fixture();
  try {
    assert.throws(() => loadConfig(f.configPath), /identities migrate/);
    assert.throws(() => new Store(f.path), /identity format needs migration/);
    assert.throws(() => new LifeReader(f.path).development(), /identity format needs migration/);
    f.db.exec("INSERT INTO events(id,source_key,kind,at,text,payload,status) VALUES ('e:send','send-receipt','snowluma:send_group_msg',1001,'sent','{\"result\":{\"message_id\":11}}','processed')");
    f.db.exec("INSERT INTO events(id,source_key,kind,at,text,payload,status) VALUES ('e:drawing','drawing-key','drawing',1002,'painted','{}','processed')");
    const reading = { id: 'video', title: 'Clouds', sourceId: 'e:one', cursor: { part: 2 }, note: 'Try later', saved: true, platformFavorite: { saved: false, checkedAt: 1234 } };
    for (const plugin of ['bilibili', 'xiaohongshu']) f.set(`plugin:${plugin}:history`, [reading, { id: 'old-bookmark', saved: true }]);
    const result = await migrateIdentities(f.configPath);
    assert.equal(result.migrated, true); assert.ok(existsSync(result.databaseBackup!)); assert.ok(existsSync(result.configBackup!));
    const config = loadConfig(f.configPath); assert.equal('snowluma' in config, false); assert.equal(config.adapters[0]!.accountId, '900');
    assert.deepEqual(config.plugins, { 'qq-main-qq-stickers': false });
    const store = new Store(f.path);
    try {
      assert.equal(store.event('e:one')!.source!.conversation, 'qq:900:group:100');
      assert.equal(store.event('e:one')!.source!.actor, 'qq:user:7');
      assert.equal(store.event('e:one')!.key, 'native-key');
      assert.equal(store.event('e:send')!.kind, 'adapter:qq_main:send_group_msg');
      assert.equal(store.event('e:send')!.payload.origin, 'self');
      assert.equal(store.event('e:drawing')!.payload.origin, 'self');
      assert.throws(() => store.writeMemory({ kind: 'habit', title: 'From drawing', content: 'Only my work', importance: 3, sources: ['e:drawing'] }, false), /cannot rest only on your own/);
      const { saved: _obsolete, ...currentReading } = reading;
      for (const plugin of ['bilibili', 'xiaohongshu']) assert.deepEqual(store.setting(`plugin:${plugin}:history`), [currentReading, { id: 'old-bookmark' }]);
      assert.throws(() => store.writeMemory({ kind: 'habit', title: 'From myself', content: 'Only my own send', importance: 3, sources: ['e:send'] }, false), /cannot rest only on your own/);
      assert.deepEqual(store.memory('m:one')!.sources, ['e:one']);
      assert.deepEqual(store.memory('m:one')!.conversations, ['qq:900:group:100']);
      assert.deepEqual(store.memory('m:one')!.subjects, ['qq:user:7']);
      assert.equal(store.memory('m:one')!.scope, 'conversation:qq:900:group:100');
      assert.equal(new LifeReader(f.path).development()[0]!.scopeName, 'Friends');
      assert.deepEqual(store.setting('reviewMarks'), { 'qq:900:group:100': 14 });
      assert.deepEqual(store.beginAction('new', 'qq_main__send_group_msg', { group_id: 100, message: 'hello' }, []).action.id, 'a:unknown');
      assert.equal(store.beginAction('retry', 'qq_main__send_group_msg', { group_id: 100, message: 'done' }, [], ['e:one']).action.id, 'a:done');
      assert.equal(store.beginAction('pending', 'qq_main__send_private_msg', { user_id: 7, message: 'later' }, []).action.id, 'a:pending');
      assert.equal(store.actionById('a:pending')!.status, 'pending');
      assert.deepEqual(new StickerStore(store, config.adapters[0]!).savedStickers(), [{ emojiId: 'saved', desc: 'Happy' }]);
      assert.equal(store.wakes()[0]!.id, 'w:one');
      assert.ok(store.db.prepare("SELECT 1 FROM sources WHERE owner_id='w:one' AND source_id='m:one'").get());
      assert.ok(store.db.prepare("SELECT 1 FROM tombstones WHERE source_key='forgotten-native-key'").get());
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM context_records WHERE message LIKE '%Archived pre-migration working context%'").get()!.n, 1);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM working_context').get()!.n, 0);
      assert.equal(store.db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name IN ('actor_id','group_id')").get(), undefined);
      assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT data FROM gallery_drawings').get()!.data)).sources, [{ id: 'e:one', person: 'qq:user:7', conversation: 'qq:900:group:100' }]);
      assert.throws(() => store.conversationRecord('group:100', 0, 10), /canonical/);
    } finally { store.close(); }
    assert.deepEqual(await migrateIdentities(f.configPath), { migrated: false });
  } finally { f.close(); }
});
test('migration keeps existing named accounts, canonical receipts and their account boundaries', async () => {
  const f = fixture();
  try {
    const connection = f.raw.snowluma;
    const adapters = [900, 901].map(account => ({ ...connection, selfId: undefined, id: account === 900 ? 'qq_main' : 'other', driver: 'snowluma', accountId: String(account) }));
    writeFileSync(f.configPath, JSON.stringify({ ...f.raw, snowluma: undefined, adapters, plugins: {} }));
    const source = { platform: 'qq', accountId: '901', instance: 'other', conversation: 'qq:901:group:100', conversationType: 'group', actor: 'qq:user:8', own: false, addressed: false, attention: 'normal' };
    f.db.prepare("INSERT INTO events(id,source_key,kind,at,text,payload,source) VALUES ('e:other','other-key','message',1001,'other','{}',?)").run(JSON.stringify(source));
    const args = { group_id: 100, message: 'hello' };
    f.db.prepare("INSERT INTO actions VALUES ('a:other','other-key',?,'other__send_group_msg',?,'[]','unknown','{}',1001,'qq:901:group:100')").run(actionFingerprint('other__send_group_msg', args), JSON.stringify(args));
    f.db.exec("INSERT INTO events(id,source_key,kind,at,group_id,actor_id,text,payload) VALUES ('e:reply','reply','message',1002,100,7,'reply','{\"message\":[{\"type\":\"reply\",\"data\":{\"id\":77}}]}')");
    f.db.exec("INSERT INTO actions VALUES ('a:other-sent','other-sent','old-fingerprint','other__send_group_msg','{\"group_id\":100,\"message\":\"other\"}','[]','success','{\"message_id\":77}',1002,'qq:901:group:100')");
    await migrateIdentities(f.configPath);
    const store = new Store(f.path);
    try {
      assert.deepEqual(store.event('e:other')!.source, source);
      assert.equal(store.event('e:reply')!.source!.addressed, false, 'another account’s receipt is not a reply to this account');
      assert.equal(store.beginAction('retry-other', 'other__send_group_msg', args, []).action.id, 'a:other');
      assert.equal(store.beginAction('retry-main', 'qq_main__send_group_msg', args, []).action.id, 'a:unknown');
      assert.deepEqual(store.conversationRecord('qq:901:group:100', 0, 10).events.map(event => event.id), ['e:other']);
    } finally { store.close(); }
  } finally { f.close(); }
});

test('migration rejects changed account bindings and concurrent migration locks', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path + '.identities.lock', '');
    await assert.rejects(migrateIdentities(f.configPath), /EEXIST/);
    assert.ok(existsSync(f.path + '.identities.lock'), 'another migration owns the lock');
    rmSync(f.path + '.identities.lock');
    f.set('platformAccounts', { qq_main: { platform: 'qq', accountId: '901' } });
    await assert.rejects(migrateIdentities(f.configPath), /another platform account/);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 0);
  } finally { f.close(); }
});

test('canonical stores reject old identities at write and query boundaries', () => {
  const store = new Store(':memory:');
  try {
    const config = loadConfig(new URL('../config.example.json', import.meta.url).pathname);
    const account = { ...config.adapters[0]!, accountId: '900' };
    const event = normalizeEvent({ self_id: 900, post_type: 'message', group_id: 100, user_id: 7, message: 'hello' }, account)!;
    assert.throws(() => store.receive({ ...event, groupId: 100 } as any), /canonical/);
    assert.throws(() => store.receive({ ...event, source: undefined }), /canonical/);
    const source = store.receive(event)!;
    for (const scope of ['group:100', 'conversation:qq:900:group:%31%30%30']) assert.throws(() => store.writeMemory({ kind: 'practice', scope, title: 'Old', content: 'Old scope', importance: 3, sources: [source.id] }, false), /canonical/);
    assert.throws(() => store.conversationMatches('qq:900:group:100', 10, { person: '7' }), /canonical/);
    assert.throws(() => store.beginAction('old', 'tool', {}, [], [], null, 'group:100'), /canonical/);
  } finally { store.close(); }
});
test('migration refuses a live daemon and rolls back unresolvable old records', async () => {
  const f = fixture();
  try {
    f.set('daemon', { pid: process.pid });
    await assert.rejects(migrateIdentities(f.configPath), /Stop the daemon/);
    f.db.exec("DELETE FROM settings WHERE key='daemon'");
    f.set('reviewMarks', { malformed: 123 });
    const config = readFileSync(f.configPath, 'utf8');
    await assert.rejects(migrateIdentities(f.configPath), /Cannot migrate conversation/);
    assert.equal(readFileSync(f.configPath, 'utf8'), config);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 0);
    assert.equal(f.db.prepare("SELECT scope FROM memories WHERE id='m:one'").get()!.scope, 'group:100');
    assert.equal(f.db.prepare("SELECT kind FROM actions WHERE id='a:unknown'").get()!.kind, 'send_group_msg');
    assert.equal(existsSync(f.path + '.identities.lock'), false);
  } finally { f.close(); }
});
test('older databases receive missing scheduling and identity columns in the offline migration', async () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE memories SET kind='note'; ALTER TABLE memories DROP COLUMN scope; ALTER TABLE wakes DROP COLUMN rest; ALTER TABLE actions DROP COLUMN conversation; DROP TABLE working_context; DROP TABLE context_records;");
    for (const name of ['source', 'conversation_ref', 'actor_ref', 'ambient_flag', 'addressed', 'received_at']) f.db.exec(`ALTER TABLE events DROP COLUMN ${name}`);
    await migrateIdentities(f.configPath);
    const store = new Store(f.path);
    try {
      assert.equal(store.event('e:one')!.source!.conversation, 'qq:900:group:100');
      assert.equal(store.memory('m:one')!.content, 'Chats');
      assert.equal(store.memory('m:one')!.scope, undefined);
      assert.equal(store.wakes()[0]!.id, 'w:one');
      assert.equal(store.wakes()[0]!.rest, undefined);
      assert.equal(store.actionById('a:unknown')!.conversation, 'qq:900:group:100');
    } finally { store.close(); }
  } finally { f.close(); }
});
test('named QQ sticker ledgers and vectors remain separate for two accounts', () => {
  const store = new Store(':memory:');
  try {
    const a = new StickerStore(store, { id: 'one', accountId: '900' }); const b = new StickerStore(store, { id: 'two', accountId: '901' });
    for (const [instance, desc] of [['one', 'Happy'], ['two', 'Sleepy']]) {
      for (const [operation, args, result] of [['add_custom_face', { file: 'image' }, { emoji_id: 'same-id' }], ['modify_custom_face', { emoji_id: 'same-id', desc }, {}]] as const) {
        const { action } = store.beginAction(`${instance}:${operation}`, `${instance}__${operation}`, args, []); store.finishAction(action.id, 'success', result);
      }
    }
    assert.deepEqual(a.savedStickers(), [{ emojiId: 'same-id', desc: 'Happy' }]); assert.deepEqual(b.savedStickers(), [{ emojiId: 'same-id', desc: 'Sleepy' }]);
    a.saveStickerVectors('same-id', 'model', 'Happy', [{ line: 'Happy', vector: new Float32Array([1, 0]) }]);
    b.saveStickerVectors('same-id', 'model', 'Sleepy', [{ line: 'Sleepy', vector: new Float32Array([0, 1]) }]);
    assert.equal(a.stickerVectors('model')[0]!.line, 'Happy'); assert.equal(b.stickerVectors('model')[0]!.line, 'Sleepy');
  } finally { store.close(); }
});
