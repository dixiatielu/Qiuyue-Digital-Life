import test from 'node:test';
import assert from 'node:assert/strict';
import { displayImageUrl, displayMessageParts, outgoingMessage } from '../src/display-message.js';
import { Monitor } from '../src/monitor.js';
import { Store } from '../src/store.js';
import { normalizeEvent } from '../src/adapters/snowluma/index.js';
import { config } from './helpers.js';
import { feedItems, presentItem, imageUrl } from '../src/webui/public/feed-model.js';

const item = (overrides: Record<string, unknown> = {}) => ({ id: 'event', at: 100, type: 'environment', title: 'Received', text: 'Hello', eventKind: 'message', state: 'processed', ...overrides });

test('live and restored messages retain ordered text, quotes and image URLs without carrying image bytes', () => {
  const cfg = config(), store = new Store(':memory:');
  const monitor = new Monitor(cfg, store, 2000, name => name === cfg.model.apiKeyEnv ? 'display-secret' : undefined);
  try {
    const event = store.receive(normalizeEvent({ self_id: 900, post_type: 'message', message_type: 'group', group_id: 100, group_name: 'Rain club', user_id: 7, sender: { nickname: 'Lin' }, message_id: 42, message: [
      { type: 'reply', data: { id: 11 } }, { type: 'text', data: { text: 'Look at this display-secret' } },
      { type: 'image', data: { url: 'https://example.com/photo.png', file: 'base64://private-image-bytes', summary: 'Rain outside' } },
    ] }, cfg.adapters[0]!)!)!;
    const project = (view: Monitor) => view.snapshot().items.find(entry => entry.id === event.id)!;
    const live = project(monitor);
    assert.equal(live.sender, 'Lin'); assert.equal(live.sourceName, 'Rain club');
    assert.equal(live.message?.direction, 'incoming');
    assert.deepEqual(live.message?.parts.map(part => part.kind), ['reply', 'text', 'image']);
    assert.equal(live.message?.parts[2]?.url, 'https://example.com/photo.png');
    assert.equal(live.message?.parts[1]?.text, 'Look at this <REDACTED>');
    assert.ok(!JSON.stringify(live).includes('private-image-bytes'));
    const restored = new Monitor(cfg, store, 2000, name => name === cfg.model.apiKeyEnv ? 'display-secret' : undefined);
    try { assert.deepEqual(project(restored).message, live.message); } finally { restored.close(); }
  } finally { monitor.close(); store.close(); }
});

test('outgoing messages preserve unknown and failed outcomes in the browser projection', () => {
  const cfg = config(), store = new Store(':memory:'), monitor = new Monitor(cfg, store);
  try {
    const action = store.beginAction('send', 'qq_main__send_group_msg', { group_id: 100, message: 'Hello [CQ:image,file=https://example.com/a.png]' }, []).action;
    for (const state of ['pending', 'unknown', 'failed', 'success'] as const) {
      if (state !== 'pending') store.finishAction(action.id, state, {});
      const view = presentItem(monitor.snapshot().items.find(entry => entry.id === action.id));
      assert.equal(view.message.direction, 'outgoing'); assert.equal(view.state, state);
      assert.equal(view.message.parts[1].url, 'https://example.com/a.png');
      assert.equal(view.stateLabel, { pending: 'Sending', unknown: 'Delivery unconfirmed', failed: 'Not sent', success: 'Sent' }[state]);
    }
  } finally { monitor.close(); store.close(); }
});

test('media projections reject local files, executable URLs, embedded credentials and Telegram bot URLs', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'base64://image-bytes', 'https://user:password@example.com/a', 'https://api.telegram.org/file/bot123:secret/photo.png', '//example.com/a']) {
    assert.equal(displayImageUrl(value), undefined, value); assert.equal(imageUrl(value), undefined, value);
  }
  assert.equal(imageUrl('/api/gallery/drawing%3Aabc-123/image'), '/api/gallery/drawing%3Aabc-123/image');
  assert.equal(displayImageUrl('drawing:abc-123'), '/api/gallery/drawing%3Aabc-123/image');
  assert.deepEqual(displayMessageParts([{ type: 'image', data: { file: 'base64://hidden' } }]), [{ kind: 'image', text: '', url: undefined }]);
  assert.equal(outgoingMessage('telegram_main__sendMessage', { text: 'Hello' })?.parts[0]?.text, 'Hello');
  assert.equal(outgoingMessage('qq_main__get_msg', { message: 'Not a send' }), undefined);
});

test('the feed uses occurrence time, keeps failures visible, and filters routine records without losing details', () => {
  const records = [item({ id: 'new', at: 300 }), item({ id: 'request', at: 400, type: 'system', title: 'model_request_finished', text: '{"status":"success","model":"test"}', eventKind: undefined }), item({ id: 'old-updated', at: 100 }), item({ id: 'failed-request', at: 200, type: 'system', title: 'model_request_finished', text: '{"status":"error"}', eventKind: undefined })];
  assert.deepEqual(feedItems(records).map(view => view.item.id), ['new', 'failed-request', 'old-updated']);
  assert.equal(feedItems(records, { quiet: true }).length, 4);
  assert.equal(feedItems(records, { filter: 'messages' }).length, 2);
  assert.equal(feedItems(records, { filter: 'system' })[0].state, 'error');
  assert.equal(feedItems(records, { quiet: true })[0].item.text, records[1].text);
});

test('life event summaries describe structured facts and model prose is never presented as a sent message', () => {
  const rest = presentItem(item({ eventKind: 'rest_backlog', text: 'While you rested: internal refs', eventData: { chats: [{ conversation: 'qq:900:group:100', messages: 11, notices: 2 }] } }));
  assert.equal(rest.message, undefined); assert.match(rest.text, /1 conversations/);
  assert.deepEqual(rest.facts, [{ label: 'Group · 100', value: '11 messages · 2 notices' }]);
  const thought = presentItem(item({ type: 'assistant', text: 'I will say hello.' }));
  assert.equal(thought.message, undefined); assert.equal(thought.facts[0].value, 'Not sent to a conversation');
  const revision = presentItem(item({ eventKind: 'memory_revision', text: 'memory:1 replaces memory:2', eventData: { revisions: [{ memoryId: 'memory:1' }], cites: ['state:activity'] } }));
  assert.ok(!revision.text.includes('memory:1')); assert.equal(revision.facts.length, 2);
});
