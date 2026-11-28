import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { createModels, fauxAssistantMessage as answer, fauxToolCall as call, normalizeContext, type Message, type Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { convertMessages } from '@earendil-works/pi-ai/api/google-shared';
import { createTools, event, fixture } from './helpers.js';
import { PiBrain } from '../src/brain.js';
import { Monitor, type DisplayPacket } from '../src/monitor.js';
import { foldImages, messageTokens, portableMessages } from '../src/context.js';
import { GEMINI_INTERACTIONS, interactionRequest } from '../src/gemini-interactions.js';
import { describeMedia, mediaModality, mediaPlaceholder, mediaTokens, outboundMessages, type MediaContent } from '../src/media.js';
import { mediaCarriage, resolveModel, validateModelConfig, withMedia, type ModelConfig } from '../src/model.js';
import type { LifePlugin } from '../src/plugins.js';

const BYTES = Buffer.from('qiuyue-media-fixture-bytes-that-must-never-reach-a-display').toString('base64');
const voice: MediaContent = { type: 'media', mimeType: 'audio/ogg', data: BYTES, seconds: 12 };
const clip: MediaContent = { type: 'media', mimeType: 'video/mp4', data: BYTES, seconds: 20 };
const paper: MediaContent = { type: 'media', mimeType: 'application/pdf', data: BYTES, pages: 3 };
const custom = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({ provider: 'gateway', id: 'gemini-4-hydrogen', apiKeyEnv: 'MODEL_API_KEY', api: 'google-generative-ai', baseUrl: 'https://gateway.example/v1beta', input: ['text', 'image', 'audio', 'video', 'pdf'], contextWindow: 1_000_000, maxTokens: 65_536, ...overrides });
const gemini = () => {
  const model = builtinModels().getModels('google').find(candidate => candidate.api === 'google-generative-ai' && /^gemini-[3-9]/.test(candidate.id));
  assert.ok(model, 'the catalog lists a Gemini 3 or later model');
  return model;
};

test('a media block is known by its type, described in a few words, and costed by its length rather than its size', () => {
  assert.equal(mediaModality('audio/ogg; codecs=opus'), 'audio');
  assert.equal(mediaModality('VIDEO/MP4'), 'video');
  assert.equal(mediaModality('application/pdf'), 'pdf');
  assert.equal(mediaModality('application/zip'), undefined);
  assert.equal(describeMedia(voice), '12s audio');
  assert.equal(describeMedia(clip), '20s video');
  assert.equal(describeMedia(paper), '3-page document');
  assert.equal(describeMedia({ ...voice, seconds: undefined }), 'audio');
  assert.equal(mediaTokens(voice), 12 * 32 + 8);
  assert.equal(mediaTokens(clip), 20 * 100 + 8);
  assert.equal(mediaTokens(paper), 3 * 1100 + 8);
  // Megabytes of base64 cost what the seconds say, where an unknown block would be counted character by character.
  const large = { ...clip, data: 'A'.repeat(8_000_000) };
  assert.equal(mediaTokens(large), mediaTokens(clip));
  assert.ok(messageTokens({ role: 'toolResult', toolCallId: 'c', toolName: 't', content: [{ type: 'text', text: 'A clip' }, large], isError: false, timestamp: 1 } as never) < 2_100);
  // Without a length the size stands in, so more bytes cost more.
  assert.ok(mediaTokens({ ...clip, seconds: undefined, data: 'A'.repeat(4_000_000) }) > mediaTokens({ ...clip, seconds: undefined, data: 'A'.repeat(400_000) }));
});

test('media leaves as the transport carries it, and as a line of text for a model that does not take it', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Listen' }, voice, clip], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c', toolName: 't', content: [{ type: 'text', text: 'Paper' }, paper], isError: false, timestamp: 3 },
  ];
  const inline = outboundMessages(messages, modality => modality === 'video' ? undefined : 'inline');
  assert.deepEqual(inline[0]!.content, [{ type: 'text', text: 'Listen' }, { type: 'image', data: BYTES, mimeType: 'audio/ogg' }, { type: 'text', text: '(20s video omitted: model does not support video)' }]);
  assert.equal(inline[1], messages[1]);
  assert.deepEqual(inline[2]!.content, [{ type: 'text', text: 'Paper' }, { type: 'image', data: BYTES, mimeType: 'application/pdf' }]);
  assert.deepEqual(mediaPlaceholder({ ...voice, mimeType: 'application/zip' }), { type: 'text', text: '(file (application/zip) omitted: model does not support this file type)' });
  // The context itself keeps its media: what leaves is a copy.
  assert.equal(messages[0]!.content[1], voice);
  // Nothing to carry and nothing to change leave the very same messages, so a context without media costs nothing.
  assert.equal(outboundMessages(messages, () => 'native'), messages);
  const plain = [messages[1]!];
  assert.equal(outboundMessages(plain, () => undefined), plain);
});

test('Pi\'s Google transport sends a block that is not text as inline data under its own type', () => {
  // The inline carriage rests on this. Should Pi come to check the type of an image block, this fails and the carriage needs a transport of ours.
  const model = gemini();
  const wire = outboundMessages<Message>([
    { role: 'user', content: [{ type: 'text', text: 'Listen' }, voice] as never, timestamp: 1 },
    { role: 'assistant', content: [call('hear', {})], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 },
  ], () => 'inline');
  const toolCall = wire[1]!.role === 'assistant' ? wire[1]!.content[0]! : undefined;
  assert.ok(toolCall?.type === 'toolCall');
  const result = outboundMessages<Message>([{ role: 'toolResult', toolCallId: toolCall.id, toolName: 'hear', content: [{ type: 'text', text: 'Voice' }, clip] as never, isError: false, timestamp: 3 }], () => 'inline');
  const sent = JSON.stringify(convertMessages(model as Parameters<typeof convertMessages>[0], normalizeContext({ messages: [...wire, ...result] })));
  assert.match(sent, new RegExp(`"inlineData":\\{"mimeType":"audio/ogg","data":"${BYTES}"\\}`));
  assert.match(sent, new RegExp(`"inlineData":\\{"mimeType":"video/mp4","data":"${BYTES}"\\}`));
});

test('the Interactions transport names audio, video and documents as the API does', () => {
  const model = { ...gemini(), api: GEMINI_INTERACTIONS, input: ['text', 'image', 'audio', 'pdf'] } as unknown as Model<any>;
  assert.equal(mediaCarriage(model, 'audio'), 'native');
  assert.equal(mediaCarriage(model, 'video'), undefined);
  const messages = outboundMessages<Message>([
    { role: 'user', content: [{ type: 'text', text: 'Listen' }, voice, clip] as never, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'read_paper', arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'read_paper', content: [{ type: 'text', text: 'Paper' }, paper] as never, isError: false, timestamp: 3 },
  ], modality => mediaCarriage(model, modality));
  const steps = interactionRequest(model, normalizeContext({ messages })).input as any[];
  assert.deepEqual(steps[0], { type: 'user_input', content: [{ type: 'text', text: 'Listen' }, { type: 'audio', data: BYTES, mime_type: 'audio/ogg' }, { type: 'text', text: '(20s video omitted: model does not support video)' }] });
  assert.deepEqual(steps.at(-1).result, [{ type: 'text', text: 'Paper' }, { type: 'document', data: BYTES, mime_type: 'application/pdf' }]);
});

test('what a model takes is declared in its input, and only where a transport can deliver it', () => {
  const model = resolveModel(custom());
  assert.deepEqual(model.input, ['text', 'image', 'audio', 'video', 'pdf']);
  assert.equal(mediaCarriage(model, 'audio'), 'inline');
  assert.equal(mediaCarriage(resolveModel(custom({ input: ['text', 'image', 'audio'] })), 'video'), undefined);
  assert.equal(mediaCarriage(resolveModel(custom({ input: ['text', 'image'] })), 'audio'), undefined);
  assert.throws(() => validateModelConfig(custom({ input: ['text', 'smell'] as never })), /model\.input must be an array/);
  assert.throws(() => validateModelConfig(custom({ input: ['image', 'audio'] })), /model\.input must be an array/);
  assert.throws(() => resolveModel(custom({ api: 'openai-completions', baseUrl: 'https://gateway.example/v1' })), /model\.input audio, video, pdf can be sent only through/);
  // Pi's catalog lists text and image alone, so on a catalog model the operator says what else it takes.
  const listed = gemini();
  const declared = resolveModel({ provider: listed.provider, id: listed.id, apiKeyEnv: 'GEMINI_API_KEY', input: ['text', 'image', 'audio'] });
  assert.deepEqual(declared.input, ['text', 'image', 'audio']);
  assert.equal(declared.contextWindow, listed.contextWindow);
  assert.deepEqual(resolveModel({ provider: listed.provider, id: listed.id, apiKeyEnv: 'GEMINI_API_KEY' }).input, listed.input);
  const other = builtinModels().getModels('openai').find(candidate => candidate.input.includes('image'))!;
  assert.throws(() => resolveModel({ provider: other.provider, id: other.id, apiKeyEnv: 'OPENAI_API_KEY', input: ['text', 'image', 'audio'] }), /can be sent only through/);
});

test('a model call without media is passed on untouched', () => {
  const seen: unknown[] = [];
  const send = withMedia((_target: Model<any>, context: any) => { seen.push(context); return context; });
  const context = { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] };
  send(resolveModel(custom()), context);
  assert.equal(seen[0], context);
  const withVoice = { messages: [{ role: 'user', content: [voice], timestamp: 1 }], tools: [] };
  send(resolveModel(custom({ input: ['text', 'image'] })), withVoice);
  assert.deepEqual(seen[1], { messages: [{ role: 'user', content: [{ type: 'text', text: '(12s audio omitted: model does not support audio)' }], timestamp: 1 }], tools: [] });
  assert.equal(withVoice.messages[0]!.content[0], voice);
});

test('folding and a model handoff leave a note of what media there was', () => {
  const messages = [
    { role: 'observation', batchId: 'b', eventIds: [], lifeOnly: false, content: [{ type: 'text', text: 'Voice from #1' }, voice, { type: 'text', text: 'Image 0' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'watch', arguments: {} }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'c', toolName: 'watch', content: [{ type: 'text', text: 'Clip' }, clip], isError: false, timestamp: 3 },
  ] as never[];
  const folded = foldImages(messages);
  assert.equal(folded.changed, 1); assert.equal(folded.media, 2);
  const text = JSON.stringify(folded.messages);
  assert.ok(!text.includes(BYTES));
  assert.match(text, /\[Folded when the thought ended; it was 12s audio\]/);
  assert.match(text, /\[Folded when the thought ended; it was 20s video\]/);
  assert.match(text, /view it again with view_event_image/);
  const flattened = JSON.stringify(portableMessages(messages, { flattenToolCalls: true }).at(-1));
  assert.match(flattened, /\[20s video omitted across model handoff\]/);
  assert.ok(!flattened.includes(BYTES));
});

/** A thinking process whose model answers from the fixture's script but is declared as `model` is. */
function brainFor(model: Partial<Model<any>>) {
  const hearing: LifePlugin = { id: 'test-voice', tools: runtime => [runtime.tool('hear_test_voice', 'Listen to a test voice message', Type.Object({}), () => ({ content: [{ type: 'text', text: 'Voice message from #1' }, voice], details: {} }))] };
  const f = fixture(undefined, undefined, undefined, () => [hearing]);
  const models = createModels(); models.setProvider(f.faux.provider);
  const monitor = new Monitor(f.cfg, f.store);
  const packets: DisplayPacket[] = []; monitor.subscribe(undefined, packet => packets.push(packet));
  let brain!: PiBrain;
  const tools = createTools(f.cfg, f.store, { execute: async () => ({ message_id: -1 }) }, () => brain.thought, undefined, f.plugins);
  brain = new PiBrain(f.cfg, f.store, tools, { model: { ...f.faux.getModel(), ...model } as Model<any>, stream: (_target: any, context: any, options: any) => models.streamSimple(f.faux.getModel(), context, { ...options, cacheRetention: 'none' }) }, monitor);
  return { store: f.store, faux: f.faux, brain, monitor, packets, close() { monitor.close(); f.store.close(); } };
}

test('a tool\'s media is heard by a model that takes it, kept out of the display, and folded when the thought ends', async () => {
  const f = brainFor({ api: 'google-generative-ai', input: ['text', 'image', 'audio'] as never });
  try {
    event(f.store, 'Listen to this');
    let heard: unknown;
    f.faux.setResponses([
      answer(call('hear_test_voice', {})),
      context => { heard = structuredClone(context.messages.at(-1)!.content); return answer('Quiet'); },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(heard, [{ type: 'text', text: 'Voice message from #1' }, { type: 'image', data: BYTES, mimeType: 'audio/ogg' }]);
    const kept = JSON.stringify(f.brain.agent.state.messages);
    assert.ok(!kept.includes(BYTES));
    assert.match(kept, /Voice message from #1/);
    assert.match(kept, /\[Folded when the thought ended; it was 12s audio\]/);
    assert.ok(!JSON.stringify(f.packets).includes(BYTES));
    assert.ok(!JSON.stringify(f.monitor.snapshot()).includes(BYTES));
    assert.match(JSON.stringify(f.packets), /12s audio: bytes omitted from display|12s audio：字节不进入展示/);
  } finally { f.close(); }
});

test('a model that does not take audio reads a line of text in its place', async () => {
  const f = brainFor({});
  try {
    event(f.store, 'Listen to this');
    let read: unknown;
    f.faux.setResponses([
      answer(call('hear_test_voice', {})),
      context => { read = structuredClone(context.messages.at(-1)!.content); return answer('Quiet'); },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(read, [{ type: 'text', text: 'Voice message from #1' }, { type: 'text', text: '(12s audio omitted: model does not support audio)' }]);
  } finally { f.close(); }
});
