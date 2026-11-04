import { beginAction } from './helpers.js';
import { qqEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Store } from '../src/store.js';
import { DrawingLibrary } from '../src/plugins/gallery-store.js';
import { galleryPlugin, GalleryRecall } from '../src/plugins/gallery.js';
import { Drawings, drawingPlugin } from '../src/plugins/drawing.js';
import { LifeReader } from '../src/webui/reader.js';
import { deferred, event, fixture } from './helpers.js';
import type { SemanticSource } from '../src/embedding.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const id = () => `drawing:${crypto.randomUUID()}`;
const json = (result: any) => JSON.parse(result.content[0].text);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-gallery-'));
  const store = new Store(join(dir, 'life.sqlite'));
  const library = new DrawingLibrary(store.db, join(dir, 'images')); library.initialize();
  const save = async (prompt: string, options: { createdAt?: number; sources?: ReturnType<DrawingLibrary['sources']> } = {}) => {
    const key = id(); await library.save(key, png, 'png', { prompt, model: 'test-image-model', createdAt: Date.now(), sources: [], ...options }); return key;
  };
  return { dir, store, library, save, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a generated image is searchable and reusable after restart and original events expire', async () => {
  const h = setup();
  const f = fixture(undefined, h.store, undefined, (store, cfg) => {
    cfg.drawing.dir = h.library.dir;
    return [drawingPlugin(new Drawings(store, { model: 'actual-model', paint: async () => png }, h.library.dir)), galleryPlugin(cfg, store)];
  });
  try {
    await f.plugins.start(); f.brain.thought.lifeOnly = false;
    const source = event(h.store, '画一张雨夜街景', 100); f.brain.thought.triggers = new Set([source.id]);
    const run = (name: string, args: any) => f.tools.current().find(tool => tool.name === name)!.execute('test', args);
    const result = json(await run('imagen', { prompt: '雨夜街景，蓝色灯光，水彩' }));
    await f.plugins.installed().find(plugin => plugin.id === 'drawing')!.idle!();
    const item = h.library.get(result.drawingId)!;
    assert.equal(item.model, 'actual-model'); assert.equal(item.sources[0]?.conversation, "qq:900:group:100");
    assert.equal(item.sources[0]?.person, 'qq:user:7');
    await assert.rejects(run('update_drawing', { id: item.id, description: 'Two cats' }), /View the drawing/);
    assert.equal((await run('view_drawing', { id: item.id })).content[1]?.type, 'image');
    await run('update_drawing', { id: item.id, title: '蓝色雨夜', description: '雨中街道，蓝色灯光，没有人物', tags: ['夜景', '水彩'], favorite: true });
    h.store.db.exec("UPDATE events SET status='processed'"); h.store.retain(1, Date.now() + 10 * 86_400_000);
    assert.equal(h.store.event(source.id), undefined);
    assert.equal(json(await run('search_drawings', { query: '把那张雨夜街道找出来', person: 'qq:user:7' })).items[0].id, item.id);
    const viewed = await run('view_drawing', { id: item.id }); assert.equal(viewed.content[1]?.type, 'image');
    await run("qq_main__send_group_msg", { group_id: 100, message: [{ type: 'image', data: { file: item.id } }] });
    assert.equal(h.library.usage(item.id)[0]?.status, 'success');
    await f.plugins.stop();
    const reopened = new Store(join(h.dir, 'life.sqlite'));
    try {
      const saved = new DrawingLibrary(reopened.db, h.library.dir);
      assert.equal(saved.get(item.id)?.description, '雨中街道，蓝色灯光，没有人物');
      assert.deepEqual(saved.image(item.id)?.data, png);
      assert.equal(saved.search({ favorite: true }).total, 1);
    } finally { reopened.close(); }
  } finally { await f.plugins.stop(); h.close(); }
});

test('startup uses only the catalog and finishes interrupted deletions without importing old files or events', async () => {
  const h = setup();
  const f = fixture(undefined, h.store, undefined, (store, cfg) => { cfg.drawing.dir = h.library.dir; return [galleryPlugin(cfg, store)]; });
  try {
    const kept = await h.save('Already cataloged'), deleted = await h.save('Deleted work');
    const old = id(), orphan = id();
    writeFileSync(join(h.library.dir, `${old.slice(8)}.png`), png);
    writeFileSync(join(h.library.dir, `${orphan.slice(8)}.png`), png);
    h.store.receive({ key: old, kind: 'drawing', at: 1000, text: 'Old work', payload: { drawingId: old, prompt: 'A cat' } });
    // Simulate interruption after the deletion tombstone was committed, before file removal.
    h.library.delete(deleted, 1);
    writeFileSync(join(h.library.dir, `${deleted.slice(8)}.png`), png);
    mkdirSync(join(h.library.dir, 'thumbnails'), { recursive: true });
    writeFileSync(join(h.library.dir, 'thumbnails', `${deleted.slice(8)}.webp`), png);
    await f.plugins.start();
    assert.equal(h.library.all().length, 2);
    assert.deepEqual(h.library.image(kept)?.data, png);
    assert.equal(h.library.get(old), undefined); assert.equal(h.library.image(old), undefined);
    assert.equal(h.library.get(orphan), undefined); assert.equal(h.library.image(orphan), undefined);
    assert.ok(existsSync(join(h.library.dir, `${orphan.slice(8)}.png`)), 'unregistered files are left untouched');
    assert.ok(h.library.get(deleted)?.deletedAt); assert.equal(h.library.image(deleted), undefined);
    assert.equal(existsSync(join(h.library.dir, `${deleted.slice(8)}.png`)), false);
    assert.equal(existsSync(join(h.library.dir, 'thumbnails', `${deleted.slice(8)}.webp`)), false);
    h.library.recoverDeletions(); assert.equal(h.library.search({}).total, 1);
  } finally { await f.plugins.stop(); h.close(); }
});

test('a tracked generation interrupted after file commit recovers its catalog and completion exactly once', async () => {
  const h = setup();
  const drawings = new Drawings(h.store, { model: 'new-model', paint: async () => png }, h.library.dir);
  try {
    const key = id(), sources = [{ id: 'e:source', person: 'qq:user:7', conversation: 'qq:900:group:100', text: 'A fox' }];
    h.store.setSetting('drawingsUnderWay', { [key]: { prompt: 'A fox', model: 'original-model', startedAt: 1234, sources: ['e:source'], context: sources } });
    mkdirSync(h.library.dir, { recursive: true });
    writeFileSync(join(h.library.dir, `${key.slice(8)}.png`), png);
    await drawings.recover();
    assert.equal(h.library.get(key)?.model, 'original-model');
    assert.equal(h.library.get(key)?.createdAt, 1234); assert.deepEqual(h.library.get(key)?.sources, sources);
    assert.deepEqual(drawings.image(key)?.data, png);
    const observation = h.store.claim(20)!.events[0]!;
    assert.equal(observation.payload.error, undefined); assert.equal(observation.payload.origin, 'self');
    assert.deepEqual(observation.payload.sources, ['e:source']);
    assert.deepEqual(h.store.setting('drawingsUnderWay'), {});
    await drawings.recover(); assert.equal(h.library.all().length, 1);
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='drawing'").get()!.n, 1);
    // A tracked task may still refer to an explicitly deleted work; recovery never resurrects it.
    h.library.delete(key, 1);
    writeFileSync(join(h.library.dir, `${key.slice(8)}.png`), png);
    await h.library.recoverGeneration(key, { prompt: 'A fox', model: 'original-model', createdAt: 1234, sources });
    assert.ok(h.library.get(key)?.deletedAt); assert.equal(drawings.image(key), undefined);
  } finally { await drawings.stop(); h.close(); }
});

test('filters, archives, missing files and edits keep search results accurate', async () => {
  const h = setup();
  try {
    const a = await h.save('窗边的猫', { createdAt: 1000, sources: [{ id: 'old', person: 'qq:user:7', conversation: "qq:900:private:7" }] });
    const b = await h.save('窗边的花', { createdAt: 2000 });
    h.library.update(a, { title: '小猫', tags: ['水彩'], favorite: true }, 1);
    assert.equal(h.library.search({ query: '窗边', limit: 1 }).nextOffset, 1);
    assert.equal(h.library.search({ person: 'qq:user:7', conversation: "qq:900:private:7", tags: ['水彩'], favorite: true }).items[0]?.id, a);
    assert.equal(h.library.search({ from: new Date(1500).toISOString() }).items[0]?.id, b);
    h.library.update(a, { archived: true }, 2); assert.equal(h.library.search({ query: '猫' }).total, 0);
    assert.equal(h.library.search({ query: '猫', includeArchived: true }).total, 1);
    assert.throws(() => h.library.update(a, { title: 'stale' }, 1), /changed/);
    assert.throws(() => h.library.update(a, { prompt: 'not editable' } as any), /editable/);
    assert.throws(() => h.library.search({ from: 'yesterday' }), /ISO/);
    rmSync(join(h.library.dir, `${b.slice(8)}.png`));
    assert.equal(h.library.search({}).items[0]?.available, false); assert.equal(h.library.stats().missing, 1);
    assert.equal(h.library.image('drawing:../../config'), undefined);
  } finally { h.close(); }
});

test('usage preserves failed and unknown outcomes and does not mistake mentioning an ID for sharing', async () => {
  const h = setup();
  try {
    const key = await h.save('a fox');
    for (const status of ['success', 'failed', 'unknown'] as const) {
      const action = beginAction(h.store, crypto.randomUUID(), "qq_main__send_group_msg", { group_id: 100, message: [{ type: 'image', data: { file: key } }] }, [], [status]);
      h.store.finishAction(action.action.id, status, {});
    }
    const mention = beginAction(h.store, 'mention', "qq_main__send_private_msg", { user_id: 7, message: [{ type: 'text', data: { text: key } }] }, [], []);
    h.store.finishAction(mention.action.id, 'success', {});
    assert.deepEqual(h.library.usage(key).map(item => item.status).sort(), ['failed', 'success', 'unknown']);
    assert.equal(h.library.search({}).items[0]?.useCount, 1);
    h.library.delete(key, 1); assert.equal(h.library.usage(key).length, 3);
  } finally { h.close(); }
});

test('semantic search survives wording changes, falls back offline, and invalidates edited/deleted vectors', async () => {
  const h = setup(); let offline = false;
  const semantics: SemanticSource = { model: 'vectors', queries: () => [], embed: async () => { if (offline) throw new Error('offline'); return [new Float32Array([1, 0])]; } };
  const recall = new GalleryRecall(h.library, semantics, h.store, 0.7);
  try {
    const key = await h.save('月光下的湖边'); recall.index(); await recall.idle();
    assert.equal((await recall.search({ query: '安静一点的夜景' })).items[0]?.id, key);
    offline = true;
    const found = await recall.search({ query: '湖边' }); assert.equal(found.retrieval, 'keywords'); assert.equal(found.items[0]?.id, key);
    h.library.update(key, { title: '湖畔' }); assert.equal(h.library.similar('vectors', new Float32Array([1, 0]), 0.7).size, 0);
    offline = false; recall.index(); await recall.idle();
    h.library.delete(key, 2); assert.equal((await recall.search({ query: '夜景' })).total, 0);
  } finally { await recall.stop(); h.close(); }
});

test('an embedding in flight cannot resurrect a deleted entry and quiescing prevents new work', async () => {
  const h = setup(); const pending = deferred<Float32Array[]>(); let calls = 0;
  const semantics: SemanticSource = { model: 'slow', queries: () => [], embed: async () => { calls++; return pending.promise; } };
  const recall = new GalleryRecall(h.library, semantics, h.store, 0.7);
  try {
    const key = await h.save('first'); recall.index();
    const resume = recall.quiesce(); h.library.delete(key, 1); pending.resolve([new Float32Array([1, 0])]); await recall.idle();
    assert.equal(h.library.similar('slow', new Float32Array([1, 0]), 0).size, 0);
    await h.save('second'); recall.index(); assert.equal(calls, 1);
    resume(); await recall.idle(); assert.equal(calls, 2);
  } finally { await recall.stop(); h.close(); }
});

test('read-only browsing and actual thumbnails work with the daemon stopped', async () => {
  const h = setup();
  try {
    const large = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#315f4b' } }).png().toBuffer();
    const key = id(); await h.library.save(key, large, 'png', { prompt: 'forest', model: 'test', createdAt: Date.now(), sources: [] });
    const reader = new LifeReader(join(h.dir, 'life.sqlite'));
    assert.equal(reader.drawings('/wrong-directory', {}).total, 1);
    const thumb = reader.drawingImage('/wrong-directory', key, true)!;
    assert.equal(thumb.mimeType, 'image/webp'); assert.equal((await sharp(thumb.data).metadata()).width, 480);
    assert.equal(reader.drawing('/wrong-directory', key)?.width, 1000);
    assert.deepEqual(reader.drawingImage('/wrong-directory', key)?.data, large);
  } finally { h.close(); }
});

test('gallery remains available with generation disabled, while disabling gallery revokes held tools', async () => {
  const h = setup();
  const f = fixture(undefined, h.store, undefined, (store, cfg) => { cfg.drawing.dir = h.library.dir; return [galleryPlugin(cfg, store)]; });
  try {
    await f.plugins.start(); f.brain.thought.lifeOnly = false;
    const key = await h.save('a fox');
    const tool = f.tools.current().find(tool => tool.name === 'view_drawing')!;
    assert.equal((await tool.execute('view', { id: key })).content[1]?.type, 'image');
    assert.ok(f.plugins.resolveMedia(key)?.toString().startsWith('base64://'));
    f.cfg.plugins.gallery = false; assert.ok(!f.tools.current().some(tool => tool.name === 'view_drawing'));
    await assert.rejects(tool.execute('stale', { id: key }), /disabled/);
    assert.equal(h.library.search({}).total, 1);
  } finally { await f.plugins.stop(); h.close(); }
});
