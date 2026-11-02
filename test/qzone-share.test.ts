import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowLumaApiError } from '@snowluma/sdk';
import { fixture } from './helpers.js';

const post = (tid: string) => ({ cell_common: { feed_id: tid }, cell_operation: { share_outside: { share_access_resource: { resource_id: `v2_${tid}`, busi_id: 'qzone_feed' } } }, cell_feed_transfer: `transfer-${tid}` });
// The card is sent as the exact text Qzone signed, escapes included.
const card = '{"app":"com.tencent.miniapp.lua","meta":{"miniapp":{"legacyUrl":"https://mobile.qzone.qq.com/l?a=311\\u0026i=bb"}},"config":{"token":"t"}}';
const notice = '你的空间有权限，如继续分享，该内容可通过链接查看。';

function qzone(options: { share?: () => unknown; send?: (action: string) => unknown } = {}) {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const social = { execute: async (action: string, args: Record<string, unknown>) => {
    calls.push({ action, args });
    if (action === 'get_qzone_public_feeds') return { feeds: [post('aa'), post('bb')], next_cursor: 'c' };
    if (action === 'get_qzone_feed_detail') {
      if (args.tid === 'gone') throw new SnowLumaApiError({ status: 'failed', retcode: 100, data: null, wording: 'qzone GetFeedDetail failed' });
      return { feed: post(String(args.tid)), attach_info: null };
    }
    if (action === 'get_qzone_share_ark') {
      if (options.share) return options.share();
      // Qzone asks to confirm sharing from a restricted space, as it does for her own posts.
      const own = (args.feed as ReturnType<typeof post>).cell_common.feed_id === 'own';
      return { ark: card, requires_confirmation: own, notice: own ? notice : null };
    }
    return options.send ? options.send(action) : { message_id: -7 };
  } };
  const f = fixture(social);
  f.brain.thought.lifeOnly = false;
  const run = (name: string, args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === name)!.execute('call', args);
  return { f, calls, run };
}

test('a listed post is shared as the card SnowLuma has Qzone sign, found in the result that listed it', async () => {
  const { f, calls, run } = qzone();
  try {
    const source = (await run('get_qzone_public_feeds', {})).details.sourceId;
    const shared = await run('share_qzone_feed', { tid: 'bb', source, user_id: 7 });
    assert.deepEqual(calls.slice(1), [{ action: 'get_qzone_share_ark', args: { feed: post('bb') } }, { action: 'send_private_msg', args: { user_id: 7, message: [{ type: 'json', data: { data: card } }] } }]);
    const action = f.store.actions().find(item => item.kind === 'share_qzone_feed')!;
    assert.deepEqual([action.status, action.args, action.result], ['success', { user_id: 7, tid: 'bb' }, { receipt: { message_id: -7 }, card }]);
    assert.deepEqual(JSON.parse((shared.content[0] as { text: string }).text), action.result);
    assert.ok(action.sources.includes(f.store.resolve(source)));
    await assert.rejects(run('share_qzone_feed', { tid: 'zz', source, user_id: 7 }), /does not appear/);
    await assert.rejects(run('share_qzone_feed', { tid: 'bb', source, user_id: 7, group_id: 100 }), /exactly one/);
    assert.equal(f.store.actions().filter(item => item.kind === 'share_qzone_feed').length, 1);
  } finally { f.store.close(); }
});

test('your own post is read by its tid and shared with Qzone\'s notice, and a missing one fails without sending', async () => {
  const { f, calls, run } = qzone();
  try {
    await run('share_qzone_feed', { tid: 'own', group_id: 100 });
    assert.deepEqual(calls, [
      { action: 'get_qzone_feed_detail', args: { tid: 'own' } },
      { action: 'get_qzone_share_ark', args: { feed: post('own') } },
      { action: 'send_group_msg', args: { group_id: 100, message: [{ type: 'json', data: { data: card } }] } },
    ]);
    assert.deepEqual(f.store.actions()[0]!.result, { receipt: { message_id: -7 }, card, notice });
    await assert.rejects(run('share_qzone_feed', { tid: 'gone', user_id: 7 }), /"outcome":"failed"/);
    assert.match(JSON.stringify(f.store.actions().find(item => item.args.tid === 'gone')!.result), /GetFeedDetail failed/);
    assert.equal(calls.filter(item => item.action.startsWith('send_')).length, 1);
  } finally { f.store.close(); }
});

test('a refused share fails before sending, and an unconfirmed send is not repeated', async () => {
  const refused = qzone({ share: () => { throw new SnowLumaApiError({ status: 'failed', retcode: 100, data: null, wording: '该空间动态暂不支持分享' }); } });
  try {
    await assert.rejects(refused.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /暂不支持分享/);
    assert.equal(refused.f.store.actions()[0]!.status, 'failed');
    assert.ok(!refused.calls.some(item => item.action.startsWith('send_')));
  } finally { refused.f.store.close(); }
  const lost = qzone({ send: () => { throw new Error('receipt lost'); } });
  try {
    await assert.rejects(lost.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /"outcome":"unknown"/);
    await assert.rejects(lost.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /"reused":true/);
    assert.equal(lost.calls.filter(item => item.action === 'send_private_msg').length, 1);
    assert.equal(lost.calls.filter(item => item.action === 'get_qzone_share_ark').length, 1);
    assert.deepEqual(lost.f.store.actions()[0]!.result, { error: { message: 'receipt lost' }, card, notice });
  } finally { lost.f.store.close(); }
});

test('sharing is offered only while get_qzone_share_ark and a send interface are enabled', () => {
  const { f } = qzone();
  try {
    const offered = () => f.tools.current().some(tool => tool.name === 'share_qzone_feed');
    assert.ok(offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['get_qzone_share_ark'] }; assert.ok(!offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['get_cookies'] }; assert.ok(offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['send_private_msg'] }; assert.ok(offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['send_private_msg', 'send_group_msg'] }; assert.ok(!offered());
  } finally { f.store.close(); }
});
