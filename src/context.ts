import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message } from '@earendil-works/pi-ai';

export const SUMMARY_PREFIX = 'Earlier exchanges have been consolidated into a continuity summary';
export const IMAGE_TOKENS = 2000;

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
export function toModelMessages(messages: AgentMessage[]): Message[] {
  return messages.map(message => message.role === 'observation' ? { role: 'user', content: message.content, timestamp: message.timestamp } : message) as Message[];
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
  observe(request: AgentMessage[], response: AssistantMessage, route: string) {
    const usage = response.usage;
    const values = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
    if (['error', 'aborted'].includes(response.stopReason) || values.some(value => !Number.isFinite(value) || value < 0) || values.reduce((a, b) => a + b, 0) <= 0) return;
    const { header, body } = this.surface(request, route);
    this.anchor = { header, prefix: [...body, response].map(message => hash(bodySurface(message))), tokens: Math.ceil(values.reduce((a, b) => a + b, 0)) };
  }
  reset() { this.anchor = undefined; }
}

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
export interface ContextCheckpoint {
  identity: string;
  generation: number;
  messages: AgentMessage[];
  sources: string[];
  anchor?: TokenAnchor;
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
export function compactionSplit(messages: AgentMessage[], recentTokens: number, inputBudget: number, summaryTokens: number): { system: AgentMessage; removed: AgentMessage[]; kept: AgentMessage[] } {
  const system = getCurrentSystemMessage(toModelMessages(messages))!;
  const blocks = exchangeBlocks(messages);
  const latestObservation = blocks.findLastIndex(block => block[0]?.role === 'observation');
  let start = blocks.length;
  let tokens = 0;
  // Always preserve the latest observation and its following exchanges, including the latest snapshot.
  while (start > 0 && (tokens < recentTokens || start > latestObservation && latestObservation >= 0 || start > blocks.length - 2)) {
    tokens += blocks[--start]!.reduce((sum, message) => sum + messageTokens(message), 0);
  }
  const fixed = estimatedContextTokens([system]) + summaryTokens;
  while (start < blocks.length - 2 && fixed + tokens > inputBudget && start < latestObservation) {
    tokens -= blocks[start++]!.reduce((sum, message) => sum + messageTokens(message), 0);
  }
  if (fixed + tokens > inputBudget) throw new Error('Required state, the latest observation, or complete tool exchanges exceed the context budget; reduce the batch size or organize pending items.');
  return { system, removed: blocks.slice(0, start).flat(), kept: blocks.slice(start).flat() };
}

/** Prune only old, large results when called under pressure; retain IDs, outcome metadata and paired calls. */
export function pruneToolResults(messages: AgentMessage[], recentTokens: number): { messages: AgentMessage[]; changed: number } {
  let tokens = 0; let boundary = messages.length;
  while (boundary > 0 && tokens < recentTokens) tokens += messageTokens(messages[--boundary]!);
  let changed = 0;
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const last = messages[lastAssistant];
  const pendingCall = last?.role === 'assistant' && last.content.some(block => block.type === 'toolCall') ? lastAssistant : -1;
  const latestObservation = messages.findLastIndex(message => message.role === 'observation');
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
