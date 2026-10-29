import test from 'node:test';
import assert from 'node:assert/strict';
import { gtk, type QzonePost } from '../src/qzone.js';
import { fixture } from './helpers.js';

const post = (tid: string) => ({ cell_common: { feed_id: tid }, cell_operation: { share_outside: { share_access_resource: { resource_id: `v2_${tid}`, busi_id: 'qzone_feed' } } }, cell_feed_transfer: `transfer-${tid}` });
// The card is sent as the exact text Qzone signed, escapes included.
const card = '{"app":"com.tencent.miniapp.lua","meta":{"miniapp":{"legacyUrl":"https://mobile.qzone.qq.com/l?a=311\\u0026i=bb"}},"config":{"token":"t"}}';

function qzone(options: { createShare?: unknown; send?: (action: string) => unknown } = {}) {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const posts: { method: string; body: any; url: string; headers: Record<string, string> }[] = [];
  const social = { execute: async (action: string, args: Record<string, unknown>) => {
    calls.push({ action, args });
    if (action === 'get_cookies') return { cookies: 'uin=o900; skey=zzz; p_skey=abc' };
    if (action === 'get_qzone_public_feeds') return { feeds: [post('aa'), post('bb')], next_cursor: 'c' };
    return options.send ? options.send(action) : { message_id: -7 };
  } };
  const qzonePost: QzonePost = async (url, body, headers) => {
    const method = new URL(url).pathname.split('/').at(-1)!;
    posts.push({ method, body: JSON.parse(body), url, headers });
    if (method === 'CreateShare') return JSON.stringify(options.createShare ?? { retcode: 0, data: { template_data: card, err: { code: 0, msg: '' } } });
    const page = JSON.parse(body).attach_info;
    return JSON.stringify({ retcode: 0, data: page ? { feeds: [{ feed: post('own') }], has_more: false } : { feeds: [{ feed: post('newer') }], has_more: true, attach_info: 'p2' } });
  };
  const f = fixture(social, undefined, qzonePost);
  f.brain.thought.lifeOnly = false;
  const run = (name: string, args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === name)!.execute('call', args);
  return { f, calls, posts, run };
}

test('a recommended post is shared as the card Qzone signs, found in the result that listed it', async () => {
  const { f, calls, posts, run } = qzone();
  try {
    const source = (await run('get_qzone_public_feeds', {})).details.sourceId;
    const shared = await run('share_qzone_feed', { tid: 'bb', source, user_id: 7 });
    assert.equal(gtk('uin=o900; skey=zzz; p_skey=abc'), 193485963);
    assert.deepEqual(posts.map(item => item.method), ['CreateShare']);
    assert.equal(posts[0]!.url, 'https://h5.qzone.qq.com/http2rpc/gotrpc/v1/trpc.qq.share.Service/CreateShare?g_tk=193485963');
    assert.deepEqual(posts[0]!.body, { info: { busi_id: 'qzone_feed', resource_id: 'v2_bb', template: 'ark_busi_select', busi_data: 'transfer-bb', plat: 1, target: 3 } });
    assert.equal(posts[0]!.headers.Cookie, 'uin=o900; skey=zzz; p_skey=abc');
    assert.deepEqual(JSON.parse(posts[0]!.headers['x-oidb']!), { uint32_command: '0x9409', uint32_service_type: '1' });
    assert.deepEqual(calls.slice(1), [{ action: 'get_cookies', args: { domain: 'qzone.qq.com' } }, { action: 'send_private_msg', args: { user_id: 7, message: [{ type: 'json', data: { data: card } }] } }]);
    const action = f.store.actions().find(item => item.kind === 'share_qzone_feed')!;
    assert.deepEqual([action.status, action.args, action.result], ['success', { user_id: 7, tid: 'bb' }, { receipt: { message_id: -7 }, card }]);
    assert.deepEqual(JSON.parse((shared.content[0] as { text: string }).text), action.result);
    assert.ok(action.sources.includes(f.store.resolve(source)));
    await assert.rejects(run('share_qzone_feed', { tid: 'zz', source, user_id: 7 }), /does not appear/);
    await assert.rejects(run('share_qzone_feed', { tid: 'bb', source, user_id: 7, group_id: 100 }), /exactly one/);
    assert.equal(f.store.actions().filter(item => item.kind === 'share_qzone_feed').length, 1);
  } finally { f.store.close(); }
});

test('your own post is found on your main page, and a missing one fails without sending', async () => {
  const { f, calls, posts, run } = qzone();
  try {
    await run('share_qzone_feed', { tid: 'own', group_id: 100 });
    assert.deepEqual(posts.map(item => [item.method, item.body.host_uin, item.body.attach_info]), [['GetMainPageFeeds', '900', ''], ['GetMainPageFeeds', '900', 'p2'], ['CreateShare', undefined, undefined]]);
    assert.equal(posts[2]!.body.info.resource_id, 'v2_own');
    assert.deepEqual(calls.at(-1), { action: 'send_group_msg', args: { group_id: 100, message: [{ type: 'json', data: { data: card } }] } });
    await assert.rejects(run('share_qzone_feed', { tid: 'gone', user_id: 7 }), /"outcome":"failed"/);
    assert.match(JSON.stringify(f.store.actions().find(item => item.args.tid === 'gone')!.result), /not among your own Qzone posts/);
    assert.equal(calls.filter(item => item.action.startsWith('send_')).length, 1);
  } finally { f.store.close(); }
});

test('a refused share fails before sending, and an unconfirmed send is not repeated', async () => {
  const refused = qzone({ createShare: { retcode: 0, data: { err: { code: 3, msg: '参数错误' } } } });
  try {
    await assert.rejects(refused.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /参数错误/);
    assert.equal(refused.f.store.actions()[0]!.status, 'failed');
    assert.ok(!refused.calls.some(item => item.action.startsWith('send_')));
  } finally { refused.f.store.close(); }
  const lost = qzone({ send: () => { throw new Error('receipt lost'); } });
  try {
    await assert.rejects(lost.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /"outcome":"unknown"/);
    await assert.rejects(lost.run('share_qzone_feed', { tid: 'own', user_id: 7 }), /"reused":true/);
    assert.equal(lost.calls.filter(item => item.action === 'send_private_msg').length, 1);
    assert.equal(lost.posts.filter(item => item.method === 'CreateShare').length, 1);
    assert.deepEqual(lost.f.store.actions()[0]!.result, { error: { message: 'receipt lost' }, card });
  } finally { lost.f.store.close(); }
});

test('sharing is offered only while Qzone cookies and a send interface are enabled', () => {
  const { f } = qzone();
  try {
    const offered = () => f.tools.current().some(tool => tool.name === 'share_qzone_feed');
    assert.ok(offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['get_cookies'] }; assert.ok(!offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['send_private_msg'] }; assert.ok(offered());
    f.cfg.snowluma.tools = { allow: '*', deny: ['send_private_msg', 'send_group_msg'] }; assert.ok(!offered());
  } finally { f.store.close(); }
});
