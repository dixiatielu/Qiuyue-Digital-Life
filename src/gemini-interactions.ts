import { calculateCost, clampThinkingLevel, collapseSystemMessages, getCurrentTools, getInitialSystemMessage, createAssistantMessageEventStream, getSystemMessageText, withoutInitialSystemMessage, type Api, type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type Message, type Model, type ProviderStreams, type SimpleStreamOptions, type StreamOptions, type TextContent, type ThinkingContent, type Tool, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { retryProviderRequest } from '@earendil-works/pi-ai/utils/provider-retry';
import { sanitizeSurrogates as wellFormed } from '@earendil-works/pi-ai/utils/sanitize-unicode';

/**
 * Gemini's Interactions API, for which Pi has no transport. It is the only Gemini API that loads tools on demand
 * (ADR-0023): a function marked `defer_loading` reaches the model as a name and description, and the model reads
 * its parameters through the API's own tool search before calling it.
 *
 * Requests are stateless (`store: false`): the working context is the program's own, and it compacts, rolls back
 * and restores it. So each request replays the steps the API returned. Measured against gemini-4-hydrogen on
 * 2026-11-23: within the current turn the steps must come back exactly, thought signatures included, or the
 * request is refused; in earlier turns a call may stand without them. A call to a deferred function is refused
 * unless the search that loaded it is still in the history, so a tool called there without one is declared in
 * full for as long as that call remains.
 */
export const GEMINI_INTERACTIONS = 'google-interactions';

type Step = { type: string; [key: string]: unknown };
type InteractionUsage = Partial<Record<'total_input_tokens' | 'total_cached_tokens' | 'total_output_tokens' | 'total_thought_tokens' | 'total_tool_use_tokens' | 'total_tokens', number>>;
export interface InteractionsOptions extends StreamOptions {
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  toolChoice?: SimpleStreamOptions['toolChoice'];
  /** Names of declared tools the model may load on demand. */
  deferredTools?: readonly string[];
}

const image = (block: ImageContent) => ({ type: 'image', data: block.data, mime_type: block.mimeType });
const callId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

/** What the model is shown of a deferred tool before it loads it: the first line, when the description says more. */
function shortDescription(description: string): string | undefined {
  const first = description.split('\n', 1)[0]!.slice(0, 200);
  return first && first !== description ? first : undefined;
}
function declarations(tools: Tool[], deferred: ReadonlySet<string>) {
  const functions = tools.map(tool => {
    const short = deferred.has(tool.name) ? shortDescription(tool.description) : undefined;
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, ...(deferred.has(tool.name) ? { defer_loading: true, ...(short ? { short_description: short } : {}) } : {}) };
  });
  return functions.some(tool => 'defer_loading' in tool) ? [{ type: 'tool_search' }, ...functions] : functions;
}

/**
 * Pi's content has text, thinking and tool calls. A thought or a tool-search step is neither text nor a call, and
 * must return to the API as it came, so it is carried whole in a thinking block's signature. Thinking blocks stay
 * in the running process and are left out of the saved context, which is as long as the API needs them.
 */
function carry(step: Step): ThinkingContent {
  const names = step.type === 'tool_search_call' ? (step.arguments as { function_names?: unknown } | undefined)?.function_names : undefined;
  const summary = Array.isArray(step.summary) ? step.summary.map(item => typeof item?.text === 'string' ? item.text : '').join('') : '';
  const thinking = Array.isArray(names) ? `Looked up tools: ${names.join(', ')}` : summary;
  // A thought cut off at the output limit has no signature, and the API would not take it back.
  return { type: 'thinking', thinking, ...(step.type === 'thought' && !step.signature ? {} : { thinkingSignature: JSON.stringify(step) }) };
}
function carried(block: ThinkingContent): Step | undefined {
  try {
    const step = JSON.parse(block.thinkingSignature ?? '');
    return step && typeof step === 'object' && typeof step.type === 'string' ? step : undefined;
  } catch { return undefined; }
}

function inputSteps(messages: Message[], model: Model<Api>): Step[] {
  const steps: Step[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const content = typeof message.content === 'string' ? [{ type: 'text', text: wellFormed(message.content) }]
        : message.content.map(block => block.type === 'text' ? { type: 'text', text: wellFormed(block.text) } : image(block));
      if (content.length) steps.push({ type: 'user_input', content });
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') { if (block.text) steps.push({ type: 'model_output', content: [{ type: 'text', text: wellFormed(block.text) }] }); }
        else if (block.type === 'thinking') { const step = carried(block); if (step) steps.push(step); }
        else steps.push({ type: 'function_call', id: block.id, name: block.name, arguments: block.arguments ?? {}, ...(block.thoughtSignature ? { signature: block.thoughtSignature } : {}) });
      }
    } else if (message.role === 'toolResult') {
      const text = wellFormed(message.content.filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('\n'));
      const images = model.input.includes('image') ? message.content.filter((block): block is ImageContent => block.type === 'image') : [];
      steps.push({ type: 'function_result', name: message.toolName, call_id: message.toolCallId, result: images.length ? [...(text ? [{ type: 'text', text }] : []), ...images.map(image)] : text, ...(message.isError ? { is_error: true } : {}) });
    }
  }
  return steps;
}

/**
 * Deferred functions the history calls with no search before the call. The saved context keeps no search steps and
 * compaction removes old ones, and the model, having seen such a call, makes the next without searching; the API
 * then refuses the request ("Missing circulated context for functions"). Both happen where the cached prefix is
 * rebuilt anyway.
 */
function calledUnloaded(steps: Step[]): Set<string> {
  const loaded = new Set<string>(); const bare = new Set<string>();
  for (const step of steps) {
    // A loaded function is named as the API knows it, such as default_api:send_like.
    if (step.type === 'tool_search_result' && Array.isArray(step.result)) { for (const item of step.result) if (typeof item?.name === 'string') loaded.add(item.name.slice(item.name.lastIndexOf(':') + 1)); }
    else if (step.type === 'function_call' && typeof step.name === 'string' && !loaded.has(step.name)) bare.add(step.name);
  }
  return bare;
}

/**
 * The API lists a deferred function to the model under a namespace, such as default_api:send_like, and finds nothing
 * for a name asked for without it. With 194 functions deferred, gemini-4-hydrogen's first search came back empty in
 * 49 of 60 requests on 2026-11-23: it then searched again, reading the prompt a further time, and in five it gave up
 * and said it could not do what was asked. With this sentence the first search found the function in 12 of 12. With
 * five functions deferred it did so without the sentence, in 6 of 6.
 */
const LOADING_HINT = 'Tools listed with only a name and description are loaded on demand. To load one, pass its identifier exactly as listed, including any prefix before a colon such as `default_api:`.';

export function interactionRequest(model: Model<Api>, context: TranscriptContext, options: InteractionsOptions = {}) {
  // The API takes one system instruction and one tool list; later system messages are folded into them.
  const transcript = collapseSystemMessages(context);
  const system = getInitialSystemMessage(transcript.messages);
  const tools = getCurrentTools(transcript.messages);
  const conversation = transformMessages(withoutInitialSystemMessage(transcript.messages).filter(message => message.role !== 'system'), model, callId);
  const input = inputSteps(conversation, model);
  const deferred = new Set(options.deferredTools ?? []);
  for (const name of calledUnloaded(input)) deferred.delete(name);
  const declared = declarations(tools, deferred);
  const instruction = [system ? wellFormed(getSystemMessageText(system)) : '', declared.some(tool => tool.type === 'tool_search') ? LOADING_HINT : ''].filter(Boolean).join('\n\n');
  return {
    model: model.id,
    input,
    ...(instruction ? { system_instruction: instruction } : {}),
    ...(tools.length ? { tools: declared } : {}),
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
  const prompt = reported.total_input_tokens ?? 0; const thought = reported.total_thought_tokens ?? 0; const loading = reported.total_tool_use_tokens ?? 0;
  // Loading a tool makes the API read the prompt again, and the cached count covers every reading, so it can exceed the prompt.
  // The context is measured from input, cache and output, so they describe one reading and the further ones are reported apart.
  const cached = Math.min(reported.total_cached_tokens ?? 0, prompt); const output = (reported.total_output_tokens ?? 0) + thought;
  const usage = {
    input: prompt - cached, output, cacheRead: cached, cacheWrite: 0, reasoning: thought, totalTokens: reported.total_tokens ?? prompt + output + loading,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...(loading ? { toolUse: loading, toolUseCacheRead: (reported.total_cached_tokens ?? 0) - cached } : {}),
  };
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
          // A signature, or a search step's arguments or result, arrives whole.
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

export const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions & Pick<InteractionsOptions, 'deferredTools'>): AssistantMessageEventStream => {
  if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  // These models cannot turn thinking off. Low is the least every one of them accepts: gemini-4-hydrogen refuses minimal, and left unset it thinks about as much as at high.
  const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : 'off';
  return stream(model, context, { ...options, maxTokens: options.maxTokens ?? model.maxTokens, thinkingLevel: level === 'off' ? 'low' : level === 'max' ? 'xhigh' : level });
};

export const geminiInteractionsApi = (): ProviderStreams => ({ stream, streamSimple });
