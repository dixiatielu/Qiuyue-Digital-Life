import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type ImageContent, type Message, type TextContent, type ToolCall, type ToolResultMessage, type UserMessage } from '@earendil-works/pi-ai';

export const SUMMARY_PREFIX = 'Earlier exchanges have been consolidated into a continuity summary';
export const IMAGE_TOKENS = 2000;

/** Framing and references are part of the saved summary's limit, not extra generation space. */
export function summaryEnvelope(ids: string[]) {
  const framing = `${SUMMARY_PREFIX} (historical material; use read_context to retrieve originals):\n`;
  const references = `\nOriginal record IDs: ${ids.slice(-8).join(', ')}`;
  return { framing, references, reserve: textTokens(framing + references) + 16 };
}

/** Provider-independent estimate: CJK needs more tokens than the same number of ASCII characters. */
export function textTokens(text: string): number {
  let tokens = 0;
  for (const part of text.match(/[\x00-\x7f]+|[^\x00-\x7f]/gu) ?? []) {
    tokens += part.charCodeAt(0) < 128 ? part.length / 4 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part) ? 1 : 2;
  }
  return Math.ceil(tokens);
}
export function estimateTokens(value: unknown): number { return textTokens(JSON.stringify(value) ?? '') + 8; }
/** Keep whole lines from the start while they fit; an unfinished final line is dropped first. */
export function fitLines(text: string, limit: number, complete = true): string {
  const lines = text.trim().split('\n');
  if (!complete) lines.pop();
  while (lines.length && textTokens(lines.join('\n')) > limit) lines.pop();
  return lines.join('\n').trim();
}
function userContentBlocks(content: UserMessage['content']): (TextContent | ImageContent)[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}
/** Merge adjacent user messages cleanly at the LLM wire boundary for strict role-alternation templates. */
export function mergeConsecutiveUserMessages(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (message.role === 'user' && previous?.role === 'user') {
      const content = typeof previous.content === 'string' && typeof message.content === 'string'
        ? `${previous.content}\n\n${message.content}`
        : [...userContentBlocks(previous.content), ...userContentBlocks(message.content)];
      merged[merged.length - 1] = { role: 'user', content, timestamp: message.timestamp };
    } else {
      merged.push(message);
    }
  }
  return merged;
}
export function toModelMessages(messages: AgentMessage[], options?: { mergeUsers?: boolean }): Message[] {
  const converted = messages.map(message => message.role === 'observation' ? { role: 'user', content: message.content, timestamp: message.timestamp } : message) as Message[];
  return options?.mergeUsers ? mergeConsecutiveUserMessages(converted) : converted;
}
function contentTokens(content: unknown): number {
  if (typeof content === 'string') return textTokens(content);
  if (!Array.isArray(content)) return estimateTokens(content);
  return content.reduce((sum, block) => sum + (block.type === 'image' ? IMAGE_TOKENS : block.type === 'text' ? textTokens(block.text) : block.type === 'thinking' ? textTokens(block.thinking) : estimateTokens(block)) + 4, 0);
}
export function messageTokens(message: AgentMessage): number {
  if (message.role === 'system') return estimateTokens(message);
  return 12 + contentTokens(message.content);
}
export function estimatedContextTokens(messages: AgentMessage[]): number {
  const modelMessages = toModelMessages(messages);
  return textTokens(getCurrentSystemPrompt(modelMessages)) + estimateTokens(getCurrentTools(modelMessages)) + messages.filter(message => message.role !== 'system').reduce((sum, message) => sum + messageTokens(message), 0);
}
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bodySurface(message: AgentMessage): unknown {
  const value = toModelMessages([message])[0]!;
  if (value.role === 'system') return value;
  return { role: value.role, content: value.content, ...(value.role === 'toolResult' ? { toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError } : {}) };
}
export interface TokenAnchor { header: string; prefix: string[]; tokens: number }
export interface TokenMeasurement { tokens: number; measuredTokens: number; estimatedTokens: number; basis: 'usage' | 'estimate' }

/** A measured request plus its output is reusable only while its complete prefix and header match. */
export class TokenMeter {
  constructor(public anchor?: TokenAnchor) {}
  private surface(messages: AgentMessage[], route: string) {
    const modelMessages = toModelMessages(messages);
    return { header: hash([route, getCurrentSystemPrompt(modelMessages), getCurrentTools(modelMessages)]), body: messages.filter(message => message.role !== 'system') };
  }
  measure(messages: AgentMessage[], route: string): TokenMeasurement {
    const { header, body } = this.surface(messages, route);
    const anchor = this.anchor;
    if (anchor && anchor.header === header && body.length >= anchor.prefix.length && anchor.prefix.every((id, index) => id === hash(bodySurface(body[index]!)))) {
      const extra = body.slice(anchor.prefix.length).reduce((sum, message) => sum + messageTokens(message), 0);
      return { tokens: anchor.tokens + extra, measuredTokens: anchor.tokens, estimatedTokens: extra, basis: 'usage' };
    }
    const tokens = estimatedContextTokens(messages);
    return { tokens, measuredTokens: 0, estimatedTokens: tokens, basis: 'estimate' };
  }
  /**
   * Carry the measured base across a fold, which works message by message: the anchored messages as folded, at the
   * measured total less the estimate of what the fold took out. Folding most thoughts' last reply would otherwise leave
   * every next request on an estimate alone.
   */
  rebase(messages: AgentMessage[], fold: (messages: AgentMessage[]) => AgentMessage[], route: string) {
    const anchor = this.anchor;
    if (!anchor) return;
    const { header, body } = this.surface(messages, route);
    if (anchor.header !== header || body.length < anchor.prefix.length || !anchor.prefix.every((id, index) => id === hash(bodySurface(body[index]!)))) return;
    const anchored = body.slice(0, anchor.prefix.length); const folded = fold(anchored);
    const removed = anchored.reduce((sum, message) => sum + messageTokens(message), 0) - folded.reduce((sum, message) => sum + messageTokens(message), 0);
    this.anchor = { header, prefix: folded.map(message => hash(bodySurface(message))), tokens: Math.max(0, anchor.tokens - removed) };
  }
  observe(request: AgentMessage[], response: AssistantMessage, route: string) {
    const usage = response.usage;
    const values = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
    if (['error', 'aborted'].includes(response.stopReason) || values.some(value => !Number.isFinite(value) || value < 0) || values.reduce((a, b) => a + b, 0) <= 0) return;
    const { header, body } = this.surface(request, route);
    this.anchor = { header, prefix: [...body, response].map(message => hash(bodySurface(message))), tokens: Math.ceil(values.reduce((a, b) => a + b, 0)) };
  }
  reset() { this.anchor = undefined; }
}

function compactSnippet(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = Math.floor(limit * 0.55);
  const tail = Math.max(0, limit - head - 30);
  const metadata = trimmed.match(/(?:sourceId|actionId|outcome|status|reused)[^\n]{0,160}/g)?.slice(-4).join('; ') ?? '';
  return `${trimmed.slice(0, head)}\n...${metadata ? ` [${metadata}] ` : ''}${trimmed.slice(trimmed.length - tail)}`;
}

function summarizeFlattenedResult(result: ToolResultMessage): string {
  const text = result.content.filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('\n').trim();
  const images = result.content.filter(block => block.type === 'image').length;
  const parts = [
    ...(text ? [compactSnippet(text, 1200)] : []),
    ...(images ? [`[${images} image${images > 1 ? 's' : ''} omitted across model handoff]`] : []),
  ];
  return parts.join(' ') || '[empty result]';
}

/**
 * Messages sent to another model/endpoint cannot replay provider-specific reasoning or opaque signatures.
 * When `flattenToolCalls` is set (for targets like Gemini 3+/4+ that reject unsigned historical function calls),
 * historical tool-call/result exchanges are converted into compact plain-text user notes while preserving
 * system messages, observations, runtime snapshots, and action outcomes. Originals stay intact.
 */
export function portableMessages(messages: AgentMessage[], options?: { flattenToolCalls?: boolean }): AgentMessage[] {
  if (!options?.flattenToolCalls) {
    return messages.flatMap((message): AgentMessage[] => {
      if (message.role !== 'assistant') return [message];
      const content = message.content.flatMap<AssistantMessage['content'][number]>(block => {
        if (block.type === 'thinking') return [];
        if (block.type === 'text') return [{ type: 'text' as const, text: block.text }];
        const { thoughtSignature: _signature, ...portable } = block;
        return [portable];
      });
      return content.length ? [{ ...message, content }] : [];
    });
  }

  const resultsById = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === 'toolResult') resultsById.set(message.toolCallId, message);
  }
  const consumedResults = new Set<string>();
  const output: AgentMessage[] = [];

  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (consumedResults.has(message.toolCallId)) continue;
      output.push({
        role: 'user',
        content: `[Prior tool result flattened across model handoff]\n- ${message.toolName} => ${message.isError ? 'error' : 'ok'}: ${summarizeFlattenedResult(message)}`,
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role !== 'assistant') {
      output.push(message);
      continue;
    }
    const textBlocks = message.content.filter((block): block is TextContent => block.type === 'text' && block.text.length > 0)
      .map(block => ({ type: 'text' as const, text: block.text }));
    const calls = message.content.filter((block): block is ToolCall => block.type === 'toolCall');
    if (textBlocks.length) output.push({ ...message, content: textBlocks });
    if (calls.length) {
      let timestamp = message.timestamp;
      const lines = calls.map(toolCall => {
        const result = resultsById.get(toolCall.id);
        if (result) {
          consumedResults.add(toolCall.id);
          timestamp = Math.max(timestamp, result.timestamp);
        }
        const args = compactSnippet(JSON.stringify(toolCall.arguments ?? {}), 600);
        const status = result ? (result.isError ? 'error' : 'ok') : 'unrecorded';
        const outcome = result ? summarizeFlattenedResult(result) : '[no tool result recorded]';
        return `- ${toolCall.name}(${args}) => ${status}: ${outcome}`;
      });
      output.push({
        role: 'user',
        content: `[Prior tool exchange flattened across model handoff]\n${lines.join('\n')}`,
        timestamp,
      });
    }
  }
  return output;
}
export const portableSummaryMessages = portableMessages;

/** Only persist visible messages; thinking blocks and tool-private details are never archived. */
export function persistableMessage(message: AgentMessage): AgentMessage {
  if (message.role === 'assistant') return { ...message, content: message.content.filter(block => block.type !== 'thinking') };
  if (message.role === 'toolResult') return { ...message, details: undefined };
  return message;
}
export function contextRecordId(message: AgentMessage): string { return `ctx:${hash(persistableMessage(message))}`; }
const FOLDED = '[Folded when the thought ended;';
/** Replace every result of one tool with a pointer to its archived original, keeping the first line as a label. */
export function foldToolResults(messages: AgentMessage[], toolName: string): { messages: AgentMessage[]; changed: number } {
  let changed = 0;
  const folded = messages.map(message => {
    if (message.role !== 'toolResult' || message.toolName !== toolName) return message;
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (text.startsWith(FOLDED)) return message;
    changed++;
    return { ...message, content: [{ type: 'text' as const, text: `${FOLDED} read it again with ${toolName}, or read_context ${contextRecordId(message)} for this exact result]\n${text.split('\n', 1)[0]}` }] };
  });
  return { messages: folded, changed };
}
/**
 * Keep of the model's replies only the actions they took (ADR-0024). Its text and thoughts reached no one, and a context
 * that keeps them teaches the model to answer each observation with the same words, until it writes the next observation itself.
 * A reply that took no action leaves nothing; one that acted keeps its calls, whose results follow it.
 */
export function foldReplies(messages: AgentMessage[]): { messages: AgentMessage[]; changed: number } {
  let changed = 0;
  const folded = messages.flatMap((message): AgentMessage[] => {
    if (message.role !== 'assistant') return [message];
    const calls = message.content.filter(block => block.type === 'toolCall');
    if (calls.length === message.content.length) return [message];
    changed++;
    return calls.length ? [{ ...message, content: calls }] : [];
  });
  return { messages: folded, changed };
}
/**
 * Drop no-op or repeated calls from a finished thought before they can teach the model to repeat them (ADR-0024).
 * Removes both each flagged tool call and its paired tool result so assistant/toolResult pairing stays intact.
 */
export function foldNoopCalls(messages: AgentMessage[], noopCallIds: ReadonlySet<string>): { messages: AgentMessage[]; changed: number } {
  if (!noopCallIds.size) return { messages, changed: 0 };
  let changed = 0;
  const folded = messages.flatMap((message): AgentMessage[] => {
    if (message.role === 'toolResult') {
      if (!noopCallIds.has(message.toolCallId)) return [message];
      changed++;
      return [];
    }
    if (message.role === 'assistant') {
      const kept = message.content.filter(block => block.type !== 'toolCall' || !noopCallIds.has(block.id));
      if (kept.length === message.content.length) return [message];
      changed++;
      return kept.length ? [{ ...message, content: kept }] : [];
    }
    return [message];
  });
  return { messages: folded, changed };
}
/** Replace every image in observations and tool results with a note; the label before each names its event and index, or the face it shows. */
export function foldImages(messages: AgentMessage[], imageViewer: (label: string) => string | undefined = () => undefined): { messages: AgentMessage[]; changed: number } {
  let changed = 0;
  const folded = messages.map(message => {
    if ((message.role !== 'observation' && message.role !== 'toolResult') || !message.content.some(block => block.type === 'image')) return message;
    return { ...message, content: message.content.map((block, index, blocks) => {
      if (block.type !== 'image') return block;
      changed++; const label = blocks[index - 1];
      return { type: 'text' as const, text: `${FOLDED} view it again with ${label?.type === 'text' && imageViewer(label.text) || 'view_event_image'}]` };
    }) };
  });
  return { messages: folded as AgentMessage[], changed };
}
export interface ContextCheckpoint {
  identity: string;
  generation: number;
  messages: AgentMessage[];
  sources: string[];
  anchor?: TokenAnchor;
  /** Stable session ID for provider prompt-cache affinity; rotated on reset or cross-model handoff. */
  sessionId?: string;
  /** Model route that produced this checkpoint, used to detect cross-model Working Context handoffs. */
  route?: string;
}

/** An assistant call and all its results form one indivisible block. */
export function exchangeBlocks(messages: AgentMessage[]): AgentMessage[][] {
  const blocks: AgentMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'toolResult') {
      const previous = blocks.at(-1);
      if (previous?.[0]?.role !== 'assistant') throw new Error('A tool result is missing its corresponding model action.');
      previous.push(message);
    } else blocks.push([message]);
  }
  return blocks;
}
export function compactionSplit(messages: AgentMessage[], recentTokens: number, inputBudget: number, summaryTokens: number, reviewing = false): { system: AgentMessage; pinned: AgentMessage[]; removed: AgentMessage[]; kept: AgentMessage[] } {
  const system = getCurrentSystemMessage(toModelMessages(messages))!;
  // A review has one permanent prompt, rather than new observations that advance the protected tail.
  // Keep that prompt verbatim while allowing its completed intermediate exchanges to be summarized.
  const pinned = reviewing ? messages.filter(message => message.role === 'observation') : [];
  const blocks = exchangeBlocks(reviewing ? messages.filter(message => message.role !== 'observation') : messages);
  const latestObservation = blocks.findLastIndex(block => block[0]?.role === 'observation');
  let start = blocks.length;
  let tokens = 0;
  // Always preserve the latest observation and its following exchanges, including the latest snapshot.
  while (start > 0 && (tokens < recentTokens || start > latestObservation && latestObservation >= 0 || start > blocks.length - 2)) {
    tokens += blocks[--start]!.reduce((sum, message) => sum + messageTokens(message), 0);
  }
  const fixed = estimatedContextTokens([system, ...pinned]) + summaryTokens;
  while (start < blocks.length - 2 && fixed + tokens > inputBudget && (reviewing || start < latestObservation)) {
    tokens -= blocks[start++]!.reduce((sum, message) => sum + messageTokens(message), 0);
  }
  if (fixed + tokens > inputBudget) throw new Error('Required state, the latest observation, or complete tool exchanges exceed the context budget; reduce the batch size or organize pending items.');
  return { system, pinned, removed: blocks.slice(0, start).flat(), kept: blocks.slice(start).flat() };
}

/** Prune only old, large results when called under pressure; retain IDs, outcome metadata and paired calls. */
export function pruneToolResults(messages: AgentMessage[], recentTokens: number): { messages: AgentMessage[]; changed: number } {
  let tokens = 0; let boundary = messages.length;
  while (boundary > 0 && tokens < recentTokens) tokens += messageTokens(messages[--boundary]!);
  let changed = 0;
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const last = messages[lastAssistant];
  const latestObservation = messages.findLastIndex(message => message.role === 'observation');
  // A call is pending only in the current turn. A thought that ended on a call (its silent last reply folded, ADR-0024) is history.
  const pendingCall = lastAssistant > latestObservation && last?.role === 'assistant' && last.content.some(block => block.type === 'toolCall') ? lastAssistant : -1;
  const pruned = messages.map((message, index) => {
    const oversizedBoundary = index === boundary && index < latestObservation;
    if (index >= boundary && !oversizedBoundary || pendingCall >= 0 && index >= pendingCall || message.role !== 'toolResult' || messageTokens(message) < 1000) return message;
    const id = contextRecordId(message);
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (text.includes('[Old tool result pruned;')) return message;
    const metadata = text.match(/(?:sourceId|actionId|outcome|status|reused|truncated)[^\n]{0,250}/g)?.slice(-8).join('\n') ?? '';
    changed++;
    return { ...message, content: [{ type: 'text' as const, text: `${text.slice(0, 500)}\n[Old tool result pruned; use read_context to read the full result ${id}]\n${metadata}\n${text.slice(-500)}` }] };
  });
  return { messages: pruned, changed };
}
