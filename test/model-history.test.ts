import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fauxAssistantMessage as answer, normalizeContext, type Message } from '@earendil-works/pi-ai';
import { portableSummaryMessages, toModelMessages } from '../src/context.js';
import { createModelBackend, type ModelConfig } from '../src/model.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const longId = `call|${'x'.repeat(150)}`;
const history = (provider: string, api: any, model: string): Message[] => [
  { role: 'user', content: [{ type: 'text', text: 'A source image.' }, { type: 'image', data: pixel, mimeType: 'image/png' }], timestamp: 1 },
  { ...answer([
    { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'PRIVATE_THINKING_SIGNATURE' },
    { type: 'text', text: 'I will check the original event.', textSignature: 'PRIVATE_TEXT_SIGNATURE' },
    { type: 'toolCall', id: longId, name: 'read_event', arguments: { id: 'event-1' }, thoughtSignature: 'PRIVATE_TOOL_SIGNATURE' },
  ]), provider, api, model },
  { role: 'toolResult', toolCallId: longId, toolName: 'read_event', content: [{ type: 'text', text: 'Outcome unknown. Source event-1.' }, { type: 'image', data: pixel, mimeType: 'image/png' }], isError: false, timestamp: 3 },
  { role: 'user', content: 'Produce a continuity summary. Keep unknown outcomes unknown.', timestamp: 4 },
];

test('real SDK requests preserve source content, images and paired tool IDs across APIs and endpoints', async () => {
  const requests: { path: string; key?: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ path: request.url!, key: String(request.headers['x-goog-api-key'] ?? request.headers['x-api-key'] ?? request.headers.authorization), body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url!.includes('anthropic')) {
      const events = [
        { type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Outcome remains unknown; consult event-1.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } else if (request.url!.includes('gemini')) {
      response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Outcome remains unknown; consult event-1.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } })}\n\n`);
    } else {
      response.end(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'Outcome remains unknown; consult event-1.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })}\n\ndata: [DONE]\n\n`);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const api of ['openai-completions', 'anthropic-messages', 'google-generative-ai'] as const) {
      const google = api === 'google-generative-ai';
      const selected: ModelConfig = { provider: 'same-provider', id: google ? 'gemini-3-flash-preview' : 'same-model', api, apiKeyEnv: 'SUMMARY_KEY', baseUrl: `${origin}/${google ? 'gemini/v1beta' : api === 'anthropic-messages' ? 'anthropic/v1' : 'completions/v1'}`, input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192, reasoning: true };
      // Same model metadata still needs sanitation when moving to another endpoint.
      const original = history(selected.provider, api === 'openai-completions' ? api : 'openai-responses', selected.id);
      const before = JSON.stringify(original);
      const { model, stream } = createModelBackend(selected, () => 'summary-key');
      const context = normalizeContext({ systemPrompt: 'Keep reported claims and unknown outcomes distinct.', tools: [{ name: 'read_event', description: 'Read an event', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }], messages: toModelMessages(portableSummaryMessages(original)) });
      const result = await stream(model, context, { maxTokens: 4096, reasoning: 'medium' }).result();
      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(JSON.stringify(original), before, 'archived originals are not mutated');
      const sent = requests.at(-1)!;
      if (google) assert.equal(sent.path, '/gemini/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse');
      else assert.equal(sent.body.model, 'same-model');
      assert.equal(sent.key, api === 'openai-completions' ? 'Bearer summary-key' : 'summary-key');
      assert.doesNotMatch(JSON.stringify(sent.body), /PRIVATE_/);
      assert.match(JSON.stringify(sent.body), /Outcome unknown\. Source event-1/);
      assert.match(JSON.stringify(sent.body), new RegExp(pixel.replace(/[+]/g, '\\+')));
      assert.ok((sent.body.max_tokens ?? sent.body.max_completion_tokens ?? sent.body.generationConfig?.maxOutputTokens) <= 4096, 'reasoning stays within the caller reserve');
      if (google) {
        const parts = sent.body.contents.flatMap((content: any) => content.parts);
        const call = parts.find((part: any) => part.functionCall)?.functionCall;
        const result = parts.find((part: any) => part.functionResponse)?.functionResponse;
        assert.equal(call.name, 'read_event');
        assert.equal(call.name, result.name);
        assert.equal(call.id, result.id);
        assert.match(call.id, /^[a-zA-Z0-9_-]{1,64}$/);
        assert.deepEqual(call.args, { id: 'event-1' });
        assert.ok(parts.some((part: any) => part.inlineData?.data === pixel), 'the source image survives');
        assert.ok(result.parts.some((part: any) => part.inlineData?.data === pixel), 'the tool-result image survives');
      } else if (api === 'anthropic-messages') {
        const blocks = sent.body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
        const call = blocks.find((block: any) => block.type === 'tool_use');
        const result = blocks.find((block: any) => block.type === 'tool_result');
        assert.equal(call.id, result.tool_use_id);
        assert.match(call.id, /^[a-zA-Z0-9_-]{1,64}$/);
        assert.ok(sent.body.thinking.budget_tokens < sent.body.max_tokens);
      } else {
        const call = sent.body.messages.find((message: any) => message.tool_calls)?.tool_calls[0];
        const result = sent.body.messages.find((message: any) => message.role === 'tool');
        assert.equal(call.id, result.tool_call_id);
      }
    }
    assert.equal(requests.length, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
