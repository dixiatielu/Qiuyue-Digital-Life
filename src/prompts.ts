import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { ActivityPrompt } from './plugins.js';

export const builtinSystemPrompt = readFileSync(new URL('./prompts/system.md', import.meta.url), 'utf8');
// Separates operator instructions from generated runtime state.
const currentContext = '\n<!-- current-context -->';
/** An operator's template must keep the places the program fills and splits. */
export function checkSystemPrompt(template: string) {
  if (!template.includes('{{persona}}')) throw new Error('The system prompt must keep {{persona}}, where the persona file goes.');
  if (!template.trimEnd().includes(currentContext)) throw new Error('The system prompt is missing its current-context boundary.');
}
checkSystemPrompt(builtinSystemPrompt);

export function systemInstructions(config: Pick<Config, 'persona' | 'life' | 'systemPrompt'>, activities: readonly ActivityPrompt[] = []): string {
  const template = (config.systemPrompt ?? builtinSystemPrompt).trimEnd();
  const prompt = template.replace(currentContext, '');
  const base = prompt
    .replace(/<!-- allow-fiction -->(.*?)<!-- \/allow-fiction -->/gs, (_match, text: string) => config.life.allowFiction ? text : '')
    // Insert persona last and use a callback to preserve its literal contents.
    .replace('{{persona}}', () => config.persona);
  if (!activities.length) return base;
  // Append after template expansion so plugin text stays literal, including with custom templates.
  return `${base}\n\nOnline activity guidance from enabled plugins. These are possibilities, not assignments; choose according to your persona, interests, and current situation. Autonomous life still follows the life-mode switch. Each entry lists its currently available activity tools.\n${activities.map(({ plugin, activity, tools, instructions }) => `\n### ${activity} (${plugin})\nAvailable tools: ${tools.join(', ')}\n${instructions}`).join('\n')}`;
}
