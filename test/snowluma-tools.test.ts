import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { SNOWLUMA_ACTIONS, SnowLumaApiError } from '@snowluma/sdk';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { allowedSnowLumaAction, findSnowLumaAction, snowlumaCatalog } from '../src/snowluma-catalog.js';
import { loadConfig } from '../src/config.js';
import { event, fixture } from './helpers.js';

test('generated native tools expose canonical SDK names and schemas directly', async () => {
  const f = fixture();
  f.brain.thought.lifeOnly = false;
  try {
    assert.equal(snowlumaCatalog.length, 209);
    assert.ok(snowlumaCatalog.every(action => (SNOWLUMA_ACTIONS as readonly string[]).includes(action.name)));
    assert.equal(new Set(snowlumaCatalog.map(action => action.name)).size, snowlumaCatalog.length);
    for (const action of snowlumaCatalog) {
      Compile(action.inputSchema);
      assert.match(action.name, /^[a-zA-Z0-9_-]{1,64}$/);
      const tool = f.tools.current().find(tool => tool.name === action.name)!;
      assert.ok(tool, action.name); assert.deepEqual(tool.parameters, action.inputSchema);
      if (!['send_group_msg', 'send_private_msg', 'set_group_reaction', 'group_poke', 'get_msg', 'fetch_custom_face_detail', 'send_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_msg', 'get_qzone_feeds', 'get_qzone_msg_detail', 'send_qzone_msg', 'like_qzone', 'comment_qzone', 'get_ai_characters', 'send_group_ai_record'].includes(action.name)) assert.equal(tool.description, action.summary ?? action.name);
      assert.equal(findSnowLumaAction(action.name), action);
    }
  } finally { f.store.close(); }
});

test('common social tools include guidance for real identifiers and space visibility', () => {
  const f = fixture();
  try {
    const descriptions = new Map(f.tools.current().map(tool => [tool.name, tool.description]));
    for (const name of ['fetch_custom_face_detail', 'send_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_msg', 'get_qzone_feeds', 'get_qzone_msg_detail', 'send_qzone_msg', 'like_qzone', 'comment_qzone']) {
      assert.match(descriptions.get(name)!, new RegExp(`SnowLuma native interface ${name}`));
    }
    assert.match(descriptions.get('send_custom_face')!, /fetch_custom_face_detail.*actual/);
    assert.match(descriptions.get('add_custom_face')!, /successful save.*emoji_id.*modify_custom_face/);
    assert.match(descriptions.get('modify_custom_face')!, /desc.*actual image.*emoji_id/);
    assert.match(descriptions.get('delete_msg')!, /negative values may also be valid/);
    assert.match(descriptions.get('send_qzone_msg')!, /default is visible to everyone.*64 means only yourself.*target_uins/);
    assert.match(descriptions.get('comment_qzone')!, /parent comment ID.*reply_uin.*reply_name/);
  } finally { f.store.close(); }
});

test('tool discovery supports common wording, category browsing and an empty-result recovery path', async () => {
  const f = fixture();
  f.brain.thought.lifeOnly = false;
  try {
    assert.ok(f.tools.current().some(tool => tool.name === 'send_private_msg'));
    const search = f.tools.current().find(tool => tool.name === 'search_snowluma_tools')!;
    const find = async (args: Record<string, unknown>) => JSON.parse((await search.execute('search', args)).content[0]!.text!);
    for (const [query, expected] of [['帮我发私信', 'send_private_msg'], ['撤销消息', 'delete_msg'], ['查看群友列表', 'get_group_member_list'], ['get_forward_msg', 'get_forward_msg'], ['send private message', 'send_private_msg'], ['list group members', 'get_group_member_list']]) {
      assert.ok((await find({ query })).actions.some((action: { name: string }) => action.name === expected), query);
    }
    const missing = await find({ query: 'Martian weather' });
    assert.equal(missing.total, 0);
    const messageCategory = findSnowLumaAction('send_group_msg').category;
    assert.ok(messageCategory);
    assert.ok(missing.categories.includes(messageCategory));
    assert.match(missing.hint, /category/);
    const page = await find({ category: messageCategory, limit: 2 });
    assert.equal(page.actions.length, 2);
    assert.equal(page.nextOffset, 2);
    assert.ok(page.actions.every((action: { category: string }) => action.category === messageCategory));
    f.cfg.snowluma.tools = { allow: '*', deny: ['send_private_msg'] };
    assert.ok(!f.tools.current().some(tool => tool.name === 'send_private_msg'));
    assert.equal((await find({ query: 'send_private_msg' })).actions[0].allowed, false);
  } finally { f.store.close(); }
});

test('names outside the catalog cannot be found or described and canonical schemas omit duplicate fields', async () => {
  const f = fixture();
  f.brain.thought.lifeOnly = false;
  try {
    const names = new Set(snowlumaCatalog.map(action => action.name));
    const load = f.tools.current().find(tool => tool.name === 'load_snowluma_tools')!;
    for (const name of SNOWLUMA_ACTIONS.filter(name => !names.has(name))) {
      assert.throws(() => findSnowLumaAction(name), /Unknown/);
      await assert.rejects(load.execute('load', { names: [name] }), /Unknown/);
    }
    assert.doesNotMatch(JSON.stringify(snowlumaCatalog), /"aliases"|兼容/);
    const notice = findSnowLumaAction('_get_group_notice').returnsSchema as any;
    assert.ok(notice.items.properties.message.properties.image);
    assert.ok(!notice.items.properties.message.properties.images);
    assert.ok(!notice.items.properties.message.required.includes('images'));
    const task = findSnowLumaAction('create_flash_task').returnsSchema as any;
    assert.ok(task.properties.fileset_id); assert.ok(!task.properties.task_id);
    assert.ok(!task.required.includes('task_id'));
    const credentials = findSnowLumaAction('get_credentials').returnsSchema as any;
    assert.ok(credentials.properties.token); assert.ok(!credentials.properties.csrf_token);
    assert.ok(!credentials.required.includes('csrf_token'));
    assert.ok(!(findSnowLumaAction('fetch_custom_face_detail').returnsSchema as any).items.properties.resId);
    assert.ok(!findSnowLumaAction('get_group_share_link').inputSchema.properties.src_id);
    const user = findSnowLumaAction('get_stranger_info').returnsSchema as any;
    assert.ok(user.properties.qq_level); assert.ok(user.properties.extStatus);
    for (const name of ['qqLevel', 'level', 'ext_status', 'is_vip']) assert.ok(!user.properties[name]);
  } finally { f.store.close(); }
});

test('all interfaces are callable and detail queries leave the model tool prefix unchanged across turns and restart', async () => {
  const f = fixture(); let prefix: ReturnType<typeof getCurrentTools> = [];
  try {
    event(f.store, 'Look at Qzone and forwarded messages');
    f.faux.setResponses([
      context => { prefix = structuredClone(getCurrentTools(context.messages)); assert.ok(prefix.some(tool => tool.name === 'get_forward_msg')); return answer(call('search_snowluma_tools', { query: 'get_forward_msg' })); },
      context => { assert.ok(JSON.stringify(context).includes(findSnowLumaAction('get_forward_msg').summary!)); return answer(call('load_snowluma_tools', { names: ['get_forward_msg', 'get_qzone_msg_list'] })); },
      context => {
        assert.deepEqual(getCurrentTools(context.messages), prefix);
        assert.match(JSON.stringify(context.messages.at(-1)), /inputSchema/);
        assert.ok(context.messages.length && JSON.stringify(context).length < f.cfg.limits.contextTokens * 8);
        return answer([call('get_forward_msg', { id: 'forward:1' }), call('get_qzone_msg_list', { target_uin: 7, num: 5 })]);
      },
      answer(call('load_snowluma_tools', { names: ['get_group_member_info'] })),
      context => {
        assert.deepEqual(getCurrentTools(context.messages), prefix);
        return answer('Observe first');
      },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(f.sent.map(item => item.kind), ['get_forward_msg', 'get_qzone_msg_list']);
    assert.equal(f.store.actions().length, 0);
    assert.ok(f.store.recent(10).some(item => item.kind === 'snowluma:get_forward_msg'));
    f.restart(); event(f.store, 'A new run');
    f.faux.setResponses([context => { assert.deepEqual(getCurrentTools(context.messages), prefix); return answer('Rest'); }]);
    await f.brain.run(f.store.claim(10)!);
  } finally { f.store.close(); }
});

test('native sends preserve rich messages, optional fields, private targets and raw results', async () => {
  const f = fixture();
  const message = [{ type: 'image', data: { file: 'base64://aGVsbG8=', summary: 'Image' } }, { type: 'face', data: { id: '14' } }];
  try {
    event(f.store);
    f.faux.setResponses([
      answer(call('send_group_msg', { group_id: 999, message, auto_escape: false, custom_field: { keep: true } })),
      context => {
        const result = context.messages.filter(item => item.role === 'toolResult').at(-1)!;
        assert.equal(result.content[0]?.type, 'text');
        assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { message_id: -42 });
        return answer(call('load_snowluma_tools', { names: ['send_private_msg'] }));
      },
      answer(call('send_private_msg', { user_id: 7, message: 'Private greeting' })), answer('Done'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(f.sent[0], { kind: 'send_group_msg', args: { group_id: 999, message, auto_escape: false, custom_field: { keep: true } } });
    assert.deepEqual(f.sent[1], { kind: 'send_private_msg', args: { user_id: 7, message: 'Private greeting' } });
    assert.equal(f.store.actions().length, 2);
  } finally { f.store.close(); }
});

test('Qzone images are sent as JPEG, and the action records the URL actually sent', async () => {
  const f = fixture();
  const avif = 'https://m.qpic.cn/psc?/V52K/bqQf!/b&ek=1&pt=0&bo=QAZV!&t=8&tl=17&vuin=900#sce=5-1-1&rf=v1';
  const jpeg = 'https://m.qpic.cn/psc?/V52K/bqQf!/b&ek=1&pt=0&bo=QAZV!&tl=17&vuin=900#sce=5-1-1&rf=v1';
  const node = (file: string) => [{ type: 'node', data: { content: [{ type: 'image', data: { url: file } }, { type: 'text', data: { text: 't=5' } }] } }];
  try {
    event(f.store);
    f.faux.setResponses([
      answer(call('send_private_msg', { user_id: 7, message: [{ type: 'image', data: { file: avif } }] })),
      answer(call('send_private_forward_msg', { user_id: 7, messages: node('https://a1.qpic.cn/psc?/x!/c&t=5') })),
      answer(call('send_group_msg', { group_id: 100, message: [{ type: 'image', data: { file: 'https://example.com/a.png?t=8' } }] })),
      answer('Done'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(f.sent[0]!.args.message, [{ type: 'image', data: { file: jpeg } }]);
    assert.deepEqual(f.sent[1]!.args.messages, node('https://a1.qpic.cn/psc?/x!/c'));
    assert.deepEqual(f.sent[2]!.args.message, [{ type: 'image', data: { file: 'https://example.com/a.png?t=8' } }]);
    assert.deepEqual(f.store.actions().find(action => action.kind === 'send_private_msg')!.args, { user_id: 7, message: [{ type: 'image', data: { file: jpeg } }] });
  } finally { f.store.close(); }
});

test('a received image already saved as a sticker is seen as one, and saving it again says so', async () => {
  const md5 = 'FB1708EDC2A2803B6CA831085EBEAC29'; const market = 'ff862d42053a56c468834db523978ecb';
  const saved = `900_0_0_0_${md5}_0_0`; const marketSaved = '900_0_0_0_A02AC0D33A8A95F1C6E9D322F5EC0F6F_0_0';
  const f = fixture({ execute: async (kind: string, args: Record<string, unknown>) => kind === 'add_custom_face' ? { emoji_id: String(args.file).includes(market) ? marketSaved : saved } : null });
  f.brain.thought.lifeOnly = false;
  try {
    assert.equal(f.store.savedSticker({ file: `${md5}.jpg` }), undefined);
    let adds: unknown[] = [];
    event(f.store);
    f.faux.setResponses([
      answer(call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=1' })),
      answer(call('modify_custom_face', { emoji_id: saved, desc: 'Two dolls bopping, for silly joy' })),
      // The same image under another URL, as QQ signs each delivery anew.
      answer(call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=b&rkey=2' })),
      answer(call('add_custom_face', { file: `https://gxh.vip.qq.com/club/item/parcel/item/ff/${market}/raw300.gif` })),
      context => { adds = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'add_custom_face'); return answer('Done'); },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(adds.length, 3);
    assert.doesNotMatch(JSON.stringify(adds[0]), /alreadySaved/);
    assert.match(JSON.stringify(adds[1]), /\\"alreadySaved\\":true,\\"desc\\":\\"Two dolls bopping, for silly joy\\"/);
    assert.doesNotMatch(JSON.stringify(adds[2]), /alreadySaved/);
    // A received image is matched by the MD5 it is named by, a market face by its emoji_id.
    const prompts: string[] = [];
    const image = f.store.receive({ key: 'image', kind: 'message', at: Date.now(), text: '[image]', groupId: 100, actorId: 7, payload: { message: [
      { type: 'image', data: { file: `${md5.toLowerCase()}.jpg`, summary: '[动画表情]' } },
      { type: 'image', data: { file: `ff-${market}.gif`, emoji_id: market, summary: '[嘿嘿]' } },
      { type: 'image', data: { file: 'CA3BD9F231FC29304CE90BB45EB88482.jpg' } },
    ] } })!;
    f.faux.setResponses([context => { prompts.push(JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')))); return answer('Nice'); }]);
    await f.brain.run(f.store.claim(10)!);
    assert.ok(prompts[0]!.includes(`Image 0 in event ${image.id} (already your saved sticker ${saved}: Two dolls bopping, for silly joy) has no readable URL`));
    assert.ok(prompts[0]!.includes(`Image 1 in event ${image.id} (already your saved sticker ${marketSaved}) has no readable URL`));
    assert.ok(prompts[0]!.includes(`Image 2 in event ${image.id} has no readable URL`));
    const deleted = f.store.beginAction(crypto.randomUUID(), 'delete_custom_face', { emoji_id: saved }, []).action;
    f.store.finishAction(deleted.id, 'success', null);
    assert.equal(f.store.savedSticker({ file: `${md5}.jpg` }), undefined);
    assert.equal(f.store.savedSticker({ emoji_id: market })?.emojiId, marketSaved);
  } finally { f.store.close(); }
});

test('permissions use exact action names, hide denied tools and block detail queries or direct invocation', async () => {
  const f = fixture();
  f.brain.thought.lifeOnly = false;
  try {
    f.cfg.snowluma.tools = { allow: '*', deny: ['fetch_ptt_text', 'send_group_msg', 'send_packet'] };
    assert.ok(!f.tools.current().some(tool => tool.name === 'send_group_msg'));
    assert.equal(allowedSnowLumaAction(findSnowLumaAction('fetch_ptt_text'), f.cfg.snowluma.tools), false);
    assert.equal(allowedSnowLumaAction(findSnowLumaAction('send_packet'), f.cfg.snowluma.tools), false);
    const load = f.tools.current().find(tool => tool.name === 'load_snowluma_tools')!;
    await assert.rejects(load.execute('load', { names: ['fetch_ptt_text'] }), /not enabled/);
    f.cfg.snowluma.tools = { allow: [], deny: [] };
    assert.ok(!f.tools.current().some(tool => snowlumaCatalog.some(action => action.name === tool.name)));
    event(f.store); f.faux.setResponses([answer(call('send_group_msg', { group_id: 100, message: 'Must not run' })), answer('Rest')]);
    await f.brain.run(f.store.claim(10)!); assert.equal(f.sent.length, 0);
  } finally { f.store.close(); }
});

test('unknown writes remain deduplicated at the budget limit and read queries still work', async () => {
  const attempted: string[] = [];
  const f = fixture({ execute: async action => { attempted.push(action); if (action === 'send_group_msg') throw new Error('receipt lost'); return { message_id: -42 }; } });
  f.cfg.limits.actionsPerHour = 1;
  try {
    event(f.store); f.faux.setResponses([
      answer(call('send_group_msg', { group_id: 100, message: 'Hello' })),
      answer(call('get_msg', { message_id: -42 })),
      answer(call('send_group_msg', { message: 'Hello', group_id: 100 })),
      answer(call('group_poke', { group_id: 100, user_id: 7 })), answer('Done'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(attempted, ['send_group_msg', 'get_msg']);
    assert.equal(f.store.actions()[0]?.status, 'unknown'); assert.equal(f.store.hourlyActions(), 1);
  } finally { f.store.close(); }
});

test('native failures retain SnowLuma error envelopes and definite failure outcomes', async () => {
  const response = { status: 'failed' as const, retcode: 1403, data: { reason: 'denied' }, wording: 'Permission denied' };
  const f = fixture({ execute: async () => { throw new SnowLumaApiError(response); } });
  try {
    event(f.store); f.faux.setResponses([
      answer(call('group_poke', { group_id: 100, user_id: 7 })),
      context => { assert.match(JSON.stringify(context), /Permission denied/); return answer(call('get_msg', { message_id: -42 })); }, answer('Done'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.store.actions()[0]?.status, 'failed'); assert.deepEqual(f.store.actions()[0]?.result, response);
  } finally { f.store.close(); }
});

test('large native results are retained with provenance and can be read in chunks', async () => {
  const raw = { group_id: 100, message_id: -42, content: 'Large result '.repeat(10000) };
  const f = fixture({ execute: async () => raw });
  try {
    event(f.store); f.faux.setResponses([
      answer(call('get_msg', { message_id: -42 })),
      context => {
        const result = context.messages.filter(item => item.role === 'toolResult').at(-1)!;
        assert.match(JSON.stringify(result), /Result truncated/);
        assert.ok(JSON.stringify(result).length < 14000);
        const source = f.store.recent(10).find(item => item.kind === 'snowluma:get_msg')!;
        assert.deepEqual(source.payload.result, raw);
        return answer(call('read_event', { id: source.id, offset: 8000 }));
      },
      context => {
        const lastResult = context.messages.findLast(message => message.role === 'toolResult');
        assert.equal(lastResult?.role, 'toolResult');
        if (lastResult?.role === 'toolResult') {
          assert.equal(lastResult.toolName, 'read_event');
          assert.ok(context.messages.some(message => message.role === 'assistant' && message.content.some(item => item.type === 'toolCall' && item.id === lastResult.toolCallId)));
        }
        return answer('Done');
      },
    ]);
    await f.brain.run(f.store.claim(10)!);
  } finally { f.store.close(); }
});

test('configuration validates native permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-native-config-'));
  const path = join(dir, 'config.json');
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, raw.personaFile), readFileSync(new URL('../persona.example.md', import.meta.url)));
  try {
    writeFileSync(path, JSON.stringify(raw)); assert.equal(loadConfig(path).snowluma.tools.allow, '*');
    raw.snowluma.groups = []; writeFileSync(path, JSON.stringify(raw)); assert.deepEqual(loadConfig(path).snowluma.groups, []);
    raw.snowluma.groups = [-1]; writeFileSync(path, JSON.stringify(raw)); assert.throws(() => loadConfig(path), /group IDs for history recovery/);
    raw.snowluma.groups = [];
    raw.snowluma.tools.allow = ['made_up_action']; writeFileSync(path, JSON.stringify(raw)); assert.throws(() => loadConfig(path), /Unknown/);
    raw.snowluma.tools.allow = []; raw.snowluma.tools.deny = ['ocr_image']; writeFileSync(path, JSON.stringify(raw)); assert.deepEqual(loadConfig(path).snowluma.tools.allow, []);
    const names = new Set(snowlumaCatalog.map(action => action.name));
    for (const name of SNOWLUMA_ACTIONS.filter(name => !names.has(name))) {
      raw.snowluma.tools.deny = [name]; writeFileSync(path, JSON.stringify(raw)); assert.throws(() => loadConfig(path), /Unknown/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('usage budgets default to unlimited, support explicit caps, and reject invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-budget-config-'));
  const path = join(dir, 'config.json');
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, raw.personaFile), readFileSync(new URL('../persona.example.md', import.meta.url)));
  const load = () => { writeFileSync(path, JSON.stringify(raw)); return loadConfig(path); };
  try {
    delete raw.limits.modelCallsPerDay; delete raw.limits.actionsPerHour;
    delete raw.limits.runTimeoutMs; delete raw.limits.maxTurnsPerRun;
    const defaults = load();
    assert.equal(defaults.limits.modelCallsPerDay, null); assert.equal(defaults.limits.actionsPerHour, null);
    assert.equal(defaults.limits.runTimeoutMs, null); assert.equal(defaults.limits.maxTurnsPerRun, null);
    raw.limits.modelCallsPerDay = 200; raw.limits.actionsPerHour = 30;
    raw.limits.runTimeoutMs = 120000; raw.limits.maxTurnsPerRun = 12;
    const capped = load();
    assert.equal(capped.limits.modelCallsPerDay, 200); assert.equal(capped.limits.actionsPerHour, 30);
    assert.equal(capped.limits.runTimeoutMs, 120000); assert.equal(capped.limits.maxTurnsPerRun, 12);
    raw.limits.modelCallsPerDay = null; raw.limits.actionsPerHour = null;
    raw.limits.runTimeoutMs = null; raw.limits.maxTurnsPerRun = null;
    const unlimited = load();
    assert.equal(unlimited.limits.modelCallsPerDay, null); assert.equal(unlimited.limits.actionsPerHour, null);
    assert.equal(unlimited.limits.runTimeoutMs, null); assert.equal(unlimited.limits.maxTurnsPerRun, null);
    for (const name of ['modelCallsPerDay', 'actionsPerHour', 'runTimeoutMs', 'maxTurnsPerRun']) {
      for (const value of [0, -1, 1.5, 'unlimited', false, Number.MAX_SAFE_INTEGER + 1]) {
        raw.limits[name] = value;
        assert.throws(load, new RegExp(name));
      }
      raw.limits[name] = null;
    }
    raw.limits.outputReserveTokens = null; assert.throws(load, /outputReserveTokens/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
