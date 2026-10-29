import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { unzip } from '../src/faces.js';
import { normalizeEvent } from '../src/snowluma.js';
import { fixture } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** A zip archive laid out as QQ's face resources are, with each file stored or deflated. */
function zip(files: Record<string, { data: Buffer; deflate?: boolean }>) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, file] of Object.entries(files)) {
    const body = file.deflate ? deflateRawSync(file.data) : file.data; const path = Buffer.from(name); const method = file.deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, body); centrals.push(central, path); offset += 30 + path.length + body.length;
  }
  const directory = Buffer.concat(centrals); const count = Object.keys(files).length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a face picture is read from its archive whether stored or deflated', () => {
  const large = Buffer.concat([PNG, Buffer.alloc(4000, 7)]);
  const archive = zip({ '424/png/424_0.png': { data: large }, '424/png/424.png': { data: PNG, deflate: true } });
  assert.deepEqual(unzip(archive, '424/png/424.png'), PNG);
  assert.deepEqual(unzip(archive, '424/png/424_0.png'), large);
  assert.equal(unzip(archive, '277/png/277.png'), undefined);
  assert.equal(unzip(Buffer.from('not an archive'), '424/png/424.png'), undefined);
});

test('observations name faces and reactions and show each face once a thought, and view_face shows it again', async () => {
  const urls = { 424: 'https://wa.qq.com/sysemoji/424.zip', 277: 'https://wa.qq.com/sysemoji/277.zip' };
  const catalogs: unknown[] = [];
  const f = fixture({ execute: async (kind: string) => {
    if (kind !== 'fetch_sys_faces') return { message_id: -9 };
    catalogs.push(kind);
    return { packs: [{ pack_name: 'Default', emojis: [{ q_sid: '424', q_des: '/续标识', url: urls[424] }, { q_sid: '277', q_des: '/汪汪', url: urls[277] }] }] };
  } });
  const pictured: string[] = [];
  f.tools.faces.image = async id => { pictured.push(id); return PNG; };
  try {
    f.store.bindAccount(900);
    const receive = (raw: Record<string, unknown>) => f.store.receive(normalizeEvent({ self_id: 900, group_id: 100, user_id: 7, time: Math.floor(Date.now() / 1000), ...raw }, f.cfg.snowluma)!)!;
    const said = receive({ post_type: 'message', message_type: 'group', message_id: 31, message: [{ type: 'face', data: { id: '424' } }, { type: 'text', data: { text: 'this one?' } }] });
    receive({ post_type: 'notice', notice_type: 'group_msg_emoji_like', message_id: 31, likes: [{ emoji_id: '424', count: 1 }, { emoji_id: '277', count: 1 }, { emoji_id: '128077', count: 1 }] });
    assert.equal(said.text, '[face 424]this one?');
    let observed = '';
    f.faux.setResponses([
      context => { observed = JSON.stringify(context.messages.findLast(message => message.role === 'user' && JSON.stringify(message).includes('New environment observations'))); return answer(call('view_face', { id: '277' })); },
      answer('Seen'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.match(observed, /\\"type\\":\\"face\\",\\"data\\":\{\\"id\\":\\"424\\",\\"name\\":\\"续标识\\"\}/);
    assert.match(observed, /\\"emoji_id\\":\\"277\\",\\"count\\":1,\\"name\\":\\"汪汪\\"\}.*\\"emoji_id\\":\\"128077\\",\\"count\\":1\}/);
    // Seen once each, though 424 is both sent and reacted with.
    assert.equal(observed.split('QQ system face 424 续标识, as it looks:').length, 2);
    assert.equal(observed.split('QQ system face 277 汪汪, as it looks:').length, 2);
    assert.deepEqual(pictured, ['424', '277', '277']);
    assert.equal(catalogs.length, 1);
    assert.deepEqual(f.store.faces()[424], { name: '续标识', url: urls[424] });
    // Folded when the thought ends, each picture points back to view_face.
    const context = JSON.stringify(f.brain.agent.state.messages);
    assert.doesNotMatch(context, /"type":"image"/);
    assert.match(context, /QQ system face 424 续标识, as it looks:"\},\{"type":"text","text":"\[Folded when the thought ended; view it again with view_face\]/);
    assert.match(context, /"toolName":"view_face".*QQ system face 277 汪汪, as it looks:"\},\{"type":"text","text":"\[Folded when the thought ended; view it again with view_face\]/);
    // A new thought sees the face again.
    receive({ post_type: 'message', message_type: 'group', message_id: 32, message: [{ type: 'face', data: { id: '424' } }] });
    f.faux.setResponses([answer('Again')]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(pictured, ['424', '277', '277', '424']);
  } finally { f.store.close(); }
});
