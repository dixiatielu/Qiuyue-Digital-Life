import { readFileSync } from 'node:fs';
import type { Config } from './config.js';

const template = readFileSync(new URL('./prompts/system.md', import.meta.url), 'utf8').trimEnd();
// This boundary preserves the instructions used by checkpoints from before runtime deltas.
const currentContext = '\n<!-- current-context -->';
const legacyEnd = template.indexOf(currentContext);
if (legacyEnd < 0) throw new Error('The system prompt is missing its current-context boundary.');

export function systemInstructions(config: Pick<Config, 'persona' | 'life'>, legacy = false): string {
  const prompt = legacy ? template.slice(0, legacyEnd) : template.replace(currentContext, '');
  return prompt
    .replace(/<!-- allow-fiction -->(.*?)<!-- \/allow-fiction -->/gs, (_match, text: string) => config.life.allowFiction ? text : '')
    // Insert persona last and use a callback to preserve its literal contents.
    .replace('{{persona}}', () => config.persona);
}
