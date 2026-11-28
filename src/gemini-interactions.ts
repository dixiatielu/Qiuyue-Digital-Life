import { calculateCost, clampThinkingLevel, createAssistantMessageEventStream, getCurrentSystemPrompt, getInitialSystemMessage, resolveTranscriptTools, withoutInitialSystemMessage, type Api, type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type Message, type Model, type ProviderStreams, type SimpleStreamOptions, type StreamOptions, type TextContent, type ThinkingContent, type Tool, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { retryProviderRequest } from '@earendil-works/pi-ai/utils/provider-retry';
import { sanitizeSurrogates as wellFormed } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import { isMedia, mediaModality, type ContentBlock, type MediaContent } from './media.js';

/**
 * Gemini's Interactions API, for which Pi has no transport. Unlike `generateContent`, it can take a tool partway
 * through a conversation without replacing the request's tool list, and so the cached prefix (ADR-0023).
 *
 * Requests are stateless (`store: false`): the working context is the program's own, and it compacts, rolls back
 * and restores it. So each request replays the steps the API returned. Measured against gemini-4-hydrogen on
 * 2026-11-23: within the current turn the steps must come back exactly, thought signatures included, or the
 * request is refused; in earlier turns a call may stand without them.
 */
export const GEMINI_INTERACTIONS = 'google-interactions';

type Step = { type: string; [key: string]: unknown };
type InteractionUsage = Partial<Record<'total_input_tokens' | 'total_cached_tokens' | 'total_output_tokens' | 'total_thought_tokens' | 'total_tokens', number>>;
export interface InteractionsOptions extends StreamOptions {
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  toolChoice?: SimpleStreamOptions['toolChoice'];
  /** The declared tool whose calls load further tools. Without it, a tool added later joins the request's tool list. */
  toolLoader?: string;
}

const image = (block: ImageContent) => ({ type: 'image', data: block.data, mime_type: block.mimeType });
/** Media reaches this transport as it stands, and only what the model takes (ADR-0029). */
const mediaTypes = { audio: 'audio', video: 'video', pdf: 'document' } as const;
const media = (block: MediaContent) => ({ type: mediaTypes[mediaModality(block.mimeType)!], data: block.data, mime_type: block.mimeType });
const seen = (block: ImageContent | MediaContent) => isMedia(block) ? media(block) : image(block);
const callId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const declaration = (tool: Tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters });

/**
 * Pi's content has text, thinking and tool calls. A thought is neither text nor a call, and within its turn must
 * return to the API as it came, so it is carried whole in a thinking block's signature. Thinking blocks stay in the
 * running process and are left out of the saved context, which is as long as the API needs them.
 */
function carry(step: Step): ThinkingContent {
  const thinking = Array.isArray(step.summary) ? step.summary.map(item => typeof item?.text === 'string' ? item.text : '').join('') : '';
  // A thought cut off at the output limit has no signature, and the API would not take it back.
  return { type: 'thinking', thinking, ...(step.type === 'thought' && !step.signature ? {} : { thinkingSignature: JSON.stringify(step) }) };
}
function carried(block: ThinkingContent): Step | undefined {
  try {
    const step = JSON.parse(block.thinkingSignature ?? '');
    return step && typeof step === 'object' && typeof step.type === 'string' ? step : undefined;
  } catch { return undefined; }
}

/**
 * The transcript as the API's steps. A system message past the first `folded` adds tools where it stands: the API's
 * client-side tool search takes declarations in the result of a call to the search tool, so they join the loader's
 * result that precedes the message. Tools with no such result before them are returned to join the request's list.
 */
function inputSteps(messages: Message[], model: Model<Api>, loader: string | undefined, folded: number): { steps: Step[]; unplaced: Tool[] } {
  const steps: Step[] = []; const unplaced: Tool[] = [];
  let systemMessages = 0;
  for (const message of messages) {
    if (message.role === 'system') {
      if (++systemMessages <= folded || !message.toolsAdded?.length) continue;
      let at = steps.length - 1;
      while (at >= 0 && steps[at]!.type === 'function_result' && steps[at]!.name !== loader) at--;
      const result = at >= 0 && steps[at]!.type === 'function_result' ? steps[at]! : undefined;
      if (!loader || !result) { unplaced.push(...message.toolsAdded); continue; }
      const said = typeof result.result === 'string' ? (result.result ? [{ type: 'text', text: result.result }] : []) : result.result as unknown[];
      result.result = [...said, ...message.toolsAdded.map(declaration)];
    } else if (message.role === 'user') {
      const content = typeof message.content === 'string' ? [{ type: 'text', text: wellFormed(message.content) }]
        : (message.content as ContentBlock[]).map(block => block.type === 'text' ? { type: 'text', text: wellFormed(block.text) } : seen(block));
      if (content.length) steps.push({ type: 'user_input', content });
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') { if (block.text) steps.push({ type: 'model_output', content: [{ type: 'text', text: wellFormed(block.text) }] }); }
        else if (block.type === 'thinking') { const step = carried(block); if (step) steps.push(step); }
        else steps.push({ type: 'function_call', id: block.id, name: block.name, arguments: block.arguments ?? {}, ...(block.thoughtSignature ? { signature: block.thoughtSignature } : {}) });
      }
    } else if (message.role === 'toolResult') {
      const text = wellFormed(message.content.filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('\n'));
      const images = (message.content as ContentBlock[]).filter((block): block is ImageContent | MediaContent => isMedia(block) || block.type === 'image' && model.input.includes('image'));
      steps.push({ type: 'function_result', name: message.toolName, call_id: message.toolCallId, result: images.length ? [...(text ? [{ type: 'text', text }] : []), ...images.map(seen)] : text, ...(message.isError ? { is_error: true } : {}) });
    }
  }
  return { steps, unplaced };
}

export function interactionRequest(model: Model<Api>, context: TranscriptContext, options: InteractionsOptions = {}) {
  const leading = getInitialSystemMessage(context.messages) ? 1 : 0;
  // The request's own list holds the tools up to the last change that was not an addition, as a removal cannot be made in place.
  const listed = resolveTranscriptTools(context.messages, 'additions');
  const loader = listed.requestTools.some(tool => tool.name === options.toolLoader) ? options.toolLoader : undefined;
  // Pi's transformation holds a system message that falls between a call and its result until after the result.
  const conversation = transformMessages(withoutInitialSystemMessage(context.messages), model, callId);
  const { steps, unplaced } = inputSteps(conversation, model, loader, listed.foldedSystemMessages - leading);
  const tools = [...listed.requestTools.filter(tool => !unplaced.some(later => later.name === tool.name)), ...unplaced];
  // The system instruction belongs to the request, so a later change to the prompt is folded into it.
  const instruction = wellFormed(getCurrentSystemPrompt(context.messages));
  return {
    model: model.id,
    input: steps,
    ...(instruction ? { system_instruction: instruction } : {}),
    // The loader is the API's client-side tool search: a function like any other, whose result may carry declarations.
    ...(tools.length ? { tools: tools.map(tool => tool.name === loader ? { ...declaration(tool), type: 'tool_search', execution: 'client' } : declaration(tool)) } : {}),
    generation_config: {
      ...(model.reasoning ? { thinking_level: options.thinkingLevel ?? 'low', thinking_summaries: 'auto' } : {}),
      ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    },
    store: false,
    stream: true,
  };
}

async function* serverEvents(response: Response): AsyncGenerator<Record<string, any>> {
  // A gateway that does not stream answers with the finished interaction.
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const interaction = await response.json() as { steps?: Step[] } & Record<string, unknown>;
    if (interaction.error) { yield { event_type: 'error', error: interaction.error }; return; }
    for (const [index, step] of (interaction.steps ?? []).entries()) { yield { event_type: 'step.start', index, step }; yield { event_type: 'step.stop', index }; }
    yield { event_type: 'interaction.completed', interaction };
    return;
  }
  const decoder = new TextDecoder(); let buffer = '';
  const parse = function* (block: string) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      yield* parse(block);
    }
  }
  yield* parse(buffer + decoder.decode());
}

function usageOf(model: Model<Api>, reported: InteractionUsage): AssistantMessage['usage'] {
  const prompt = reported.total_input_tokens ?? 0; const thought = reported.total_thought_tokens ?? 0;
  const cached = Math.min(reported.total_cached_tokens ?? 0, prompt); const output = (reported.total_output_tokens ?? 0) + thought;
  const usage = { input: prompt - cached, output, cacheRead: cached, cacheWrite: 0, reasoning: thought, totalTokens: reported.total_tokens ?? prompt + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  calculateCost(model, usage);
  return usage;
}

let generatedCalls = 0;
export const stream = (model: Model<Api>, context: TranscriptContext, options: InteractionsOptions = {}): AssistantMessageEventStream => {
  const events = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending', timestamp: Date.now(),
  };
  (async () => {
    try {
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      let body: unknown = interactionRequest(model, context, options);
      body = await options.onPayload?.(body, model) ?? body;
      const request = options.fetch ?? fetch;
      const response = await retryProviderRequest(async () => {
        const answer = await request(`${model.baseUrl.replace(/\/+$/, '')}/interactions`, {
          method: 'POST', signal: options.signal, body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-goog-api-key': options.apiKey!, ...model.headers, ...options.headers },
        });
        if (!answer.ok) throw Object.assign(new Error(`Interactions API returned HTTP ${answer.status}: ${(await answer.text()).slice(0, 2000)}`), { status: answer.status, headers: answer.headers });
        return answer;
      }, { maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal });
      events.push({ type: 'start', partial: output });

      const open = new Map<number, { step: Step; contentIndex: number; args: string }>();
      let status: string | undefined;
      const close = (index: number) => {
        const entry = open.get(index); if (!entry) return;
        open.delete(index);
        const { step, contentIndex } = entry; const block = output.content[contentIndex]!;
        if (block.type === 'text') events.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
        else if (block.type === 'toolCall') {
          if (entry.args) {
            try { const parsed = JSON.parse(entry.args); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object'); block.arguments = parsed; }
            catch { block.arguments = {}; block.argumentsError = `The arguments were not a complete JSON object: ${entry.args.slice(0, 2000)}`; }
          }
          if (typeof step.signature === 'string' && step.signature) block.thoughtSignature = step.signature;
          events.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: output });
        } else {
          Object.assign(block, carry(step));
          events.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial: output });
        }
      };
      for await (const event of serverEvents(response)) {
        await options.onProviderStreamEvent?.(event, model);
        if (event.event_type === 'error' || event.error) throw new Error(`Interactions API error: ${event.error?.message ?? JSON.stringify(event.error ?? event)}${event.error?.code ? ` (${event.error.code})` : ''}`);
        if (event.event_type === 'step.start') {
          const step = { ...event.step } as Step;
          const contentIndex = output.content.length;
          open.set(event.index, { step, contentIndex, args: '' });
          if (step.type === 'model_output') {
            output.content.push({ type: 'text', text: '' });
            events.push({ type: 'text_start', contentIndex, partial: output });
            const text = (Array.isArray(step.content) ? step.content : []).map(item => item?.type === 'text' && typeof item.text === 'string' ? item.text : '').join('');
            if (text) { (output.content[contentIndex] as TextContent).text = text; events.push({ type: 'text_delta', contentIndex, delta: text, partial: output }); }
          } else if (step.type === 'function_call') {
            const name = typeof step.name === 'string' ? step.name : '';
            const call: ToolCall = { type: 'toolCall', id: typeof step.id === 'string' && step.id ? step.id : `${name}_${Date.now()}_${++generatedCalls}`, name, arguments: step.arguments && typeof step.arguments === 'object' ? step.arguments as ToolCall['arguments'] : {} };
            output.content.push(call);
            events.push({ type: 'toolcall_start', contentIndex, partial: output });
          } else {
            output.content.push({ type: 'thinking', thinking: '' });
            events.push({ type: 'thinking_start', contentIndex, partial: output });
          }
        } else if (event.event_type === 'step.delta') {
          const entry = open.get(event.index); if (!entry) continue;
          const block = output.content[entry.contentIndex]!; const { type, ...rest } = event.delta ?? {};
          if (block.type === 'text') {
            if (type === 'text' && typeof rest.text === 'string') { block.text += rest.text; events.push({ type: 'text_delta', contentIndex: entry.contentIndex, delta: rest.text, partial: output }); }
          } else if (block.type === 'toolCall' && type === 'arguments_delta' && typeof rest.arguments === 'string') {
            entry.args += rest.arguments;
            events.push({ type: 'toolcall_delta', contentIndex: entry.contentIndex, delta: rest.arguments, partial: output });
          } else if (type === 'thought_summary') {
            const text = typeof rest.text === 'string' ? rest.text : typeof rest.content?.text === 'string' ? rest.content.text : '';
            if (text) ((entry.step.summary ??= []) as unknown[]).push({ type: 'text', text });
          }
          // A signature arrives whole, as does whatever else a step is given.
          else Object.assign(entry.step, rest);
        } else if (event.event_type === 'step.stop') close(event.index);
        else if (event.event_type === 'interaction.completed') {
          status = event.interaction?.status;
          if (typeof event.interaction?.id === 'string' && event.interaction.id) output.responseId = event.interaction.id;
          output.usage = usageOf(model, event.interaction?.usage ?? {});
        }
      }
      for (const index of [...open.keys()]) close(index);
      if (options.signal?.aborted) throw new Error('Request was aborted');
      if (status === undefined) throw new Error('The interaction stream ended before it completed.');
      output.rawStopReason = status;
      // The API reports a request that ends on a function call as completed as often as requires_action.
      if (output.content.some(block => block.type === 'toolCall')) output.stopReason = 'toolUse';
      else if (status === 'incomplete') output.stopReason = 'length';
      else if (status === 'completed' || status === 'requires_action') output.stopReason = 'stop';
      else throw new Error(`The interaction ended as ${status}.`);
      events.push({ type: 'done', reason: output.stopReason, message: output });
      events.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: 'error', reason: output.stopReason, error: output });
      events.end();
    }
  })();
  return events;
};

export const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions & Pick<InteractionsOptions, 'toolLoader'>): AssistantMessageEventStream => {
  if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  // These models cannot turn thinking off. Low is the least every one of them accepts: gemini-4-hydrogen refuses minimal, and left unset it thinks about as much as at high.
  const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : 'off';
  return stream(model, context, { ...options, maxTokens: options.maxTokens ?? model.maxTokens, thinkingLevel: level === 'off' ? 'low' : level === 'max' ? 'xhigh' : level });
};

export const geminiInteractionsApi = (): ProviderStreams => ({ stream, streamSimple });
