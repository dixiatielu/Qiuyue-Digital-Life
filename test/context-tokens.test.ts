import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { contextRecordId, estimatedContextTokens, fitLines, IMAGE_TOKENS, messageTokens, persistableMessage, pruneToolResults, TokenMeter } from '../src/context.js';

const system: AgentMessage = { role: 'system', content: 'Fixed instructions', timestamp: 1 };
const input: AgentMessage = { role: 'user', content: 'Hello', timestamp: 2 };

test('token accounting anchors server usage including cached input and estimates only appended mixed-language messages', () => {
  const meter = new TokenMeter();
  const response = answer('Answer');
  response.usage = { ...response.usage, input: 1000, cacheRead: 600, cacheWrite: 200, output: 100, totalTokens: 1900 };
  const request = [system, input];
  meter.observe(request, response, 'route');
  const newer: AgentMessage = { role: 'user', content: 'New 中文 and English content', timestamp: 3 };
  const result = meter.measure([...request, response, newer], 'route');
  assert.equal(result.basis, 'usage');
  assert.equal(result.measuredTokens, 1900);
  assert.equal(result.estimatedTokens, messageTokens(newer));
  assert.equal(result.tokens, 1900 + messageTokens(newer));
  const restored = new TokenMeter(JSON.parse(JSON.stringify(meter.anchor)));
  assert.deepEqual(restored.measure([...request, response, newer], 'route'), result);
});

test('changed instructions, tools, history or route cannot reuse a stale token anchor', () => {
  const meter = new TokenMeter(); const response = answer('Answer');
  response.usage = { ...response.usage, input: 900, output: 20 };
  meter.observe([system, input], response, 'route');
  const messages = [system, input, response];
  assert.equal(meter.measure(messages, 'route').basis, 'usage');
  assert.equal(meter.measure([{ ...system, content: 'New rules' }, input, response], 'route').basis, 'estimate');
  assert.equal(meter.measure([system, { ...input, content: 'Old history summarized' }, response], 'route').basis, 'estimate');
  assert.equal(meter.measure(messages, 'different-route').basis, 'estimate');
  const toolsChanged: AgentMessage = { role: 'system', content: '', toolsAdded: [{ name: 'extra', description: 'New tool', parameters: { type: 'object', properties: {} } }], timestamp: 4 };
  assert.equal(meter.measure([...messages, toolsChanged], 'route').basis, 'estimate');
  meter.reset(); assert.equal(meter.measure(messages, 'route').basis, 'estimate');
});

test('fallback excludes accounting metadata and image bytes but includes tool schemas and image allowance', () => {
  const first = answer('Short answer'); const second = structuredClone(first);
  second.usage.input = 99999999; second.timestamp = 99999999;
  assert.equal(estimatedContextTokens([system, first]), estimatedContextTokens([system, second]));
  const image = (data: string): AgentMessage => ({ role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }], timestamp: 1 });
  assert.equal(messageTokens(image('a')), messageTokens(image('a'.repeat(100000))));
  assert.ok(messageTokens(image('a')) >= IMAGE_TOKENS);
  const withTools = { ...system, toolsAdded: [{ name: 'extra', description: 'Tool description '.repeat(100), parameters: { type: 'object', properties: {} } }] };
  assert.ok(estimatedContextTokens([withTools]) > estimatedContextTokens([system]));
  const thought = answer([{ type: 'thinking', thinking: 'Internal reasoning that must not be archived' }, { type: 'text', text: 'Visible answer' }]);
  assert.doesNotMatch(JSON.stringify(persistableMessage(thought)), /Internal reasoning that must not be archived/);
});

test('old tool results retain provenance and unknown status while the latest tool exchange stays intact', () => {
  const firstCall = answer(call('get_msg', { message_id: 1 }, { id: 't1' }));
  const firstResult: AgentMessage = { role: 'toolResult', toolCallId: 't1', toolName: 'get_msg', content: [{ type: 'text', text: 'long body '.repeat(2000) }, { type: 'text', text: 'sourceId=e:1 actionId=a:1 outcome=unknown' }], isError: true, timestamp: 1 };
  const lastCall = answer(call('read_event', { id: 'e:2' }, { id: 't2' }));
  const lastResult: AgentMessage = { ...firstResult, toolCallId: 't2', toolName: 'read_event', timestamp: 2 };
  const tail: AgentMessage = { role: 'user', content: 'Recent observation '.repeat(200), timestamp: 3 };
  const messages = [system, firstCall, firstResult, lastCall, lastResult, tail];
  const result = pruneToolResults(messages, 100);
  assert.equal(result.changed, 1);
  assert.equal(result.messages[4], lastResult);
  assert.equal(result.messages[1], firstCall);
  assert.match(JSON.stringify(result.messages[2]), /outcome=unknown/);
  assert.match(JSON.stringify(result.messages[2]), new RegExp(contextRecordId(firstResult)));
  assert.ok(messageTokens(result.messages[2]!) < messageTokens(firstResult));
  assert.equal(pruneToolResults(result.messages, 100).changed, 0);
});

test('fitted text keeps whole lines from the start and drops an unfinished last line', () => {
  const text = '最重要的事\nsecond line\n第三行写到一半';
  assert.equal(fitLines(text, 100), text);
  assert.equal(fitLines(text, 100, false), '最重要的事\nsecond line');
  assert.equal(fitLines(text, 5), '最重要的事');
  assert.equal(fitLines('一行就超出了限制', 3), '');
});

