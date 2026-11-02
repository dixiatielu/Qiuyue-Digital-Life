import { readFileSync } from 'node:fs';
import type { Config } from './config.js';

export const builtinSystemPrompt = readFileSync(new URL('./prompts/system.md', import.meta.url), 'utf8');
// This boundary preserves the instructions used by checkpoints from before runtime deltas.
const currentContext = '\n<!-- current-context -->';
/** An operator's template must keep the places the program fills and splits. */
export function checkSystemPrompt(template: string) {
  if (!template.includes('{{persona}}')) throw new Error('The system prompt must keep {{persona}}, where the persona file goes.');
  if (!template.trimEnd().includes(currentContext)) throw new Error('The system prompt is missing its current-context boundary.');
}
checkSystemPrompt(builtinSystemPrompt);

export function systemInstructions(config: Pick<Config, 'persona' | 'life' | 'systemPrompt'>, legacy = false): string {
  const template = (config.systemPrompt ?? builtinSystemPrompt).trimEnd();
  const prompt = legacy ? template.slice(0, template.indexOf(currentContext)) : template.replace(currentContext, '');
  return prompt
    .replace(/<!-- allow-fiction -->(.*?)<!-- \/allow-fiction -->/gs, (_match, text: string) => config.life.allowFiction ? text : '')
    // Insert persona last and use a callback to preserve its literal contents.
    .replace('{{persona}}', () => config.persona);
}
