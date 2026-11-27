import { readFileSync } from 'node:fs';
import type { UserActivity } from './plugin-sdk.js';

export interface PromptConfig {
  persona: string;
  life: { allowFiction: boolean };
  systemPrompt?: string;
}
export interface ActivityPrompt extends UserActivity { plugin: string; instructions: string }

export const builtinSystemPrompt = readFileSync(new URL('./prompts/system.md', import.meta.url), 'utf8');
// Separates operator instructions from generated runtime state.
const currentContext = '\n<!-- current-context -->';
/** An operator's template must keep the places the program fills and splits. */
export function checkSystemPrompt(template: string) {
  if (!template.includes('{{persona}}')) throw new Error('The system prompt must keep {{persona}}, where the persona file goes.');
  if (!template.trimEnd().includes(currentContext)) throw new Error('The system prompt is missing its current-context boundary.');
}
checkSystemPrompt(builtinSystemPrompt);

/** The tools a model must ask for before it can call them, each by its name and what it does (ADR-0023). */
function onDemand(tools: readonly { name: string; summary: string }[]) {
  return tools.length ? `\n\nTools loaded on demand. These are yours to use like any other, but their parameters are declared only once you ask: call find_tools with the names you want, several at once, and they are callable from your next step and stay available. A call to one you have not loaded fails as not found, and loads it for the step after.\n${tools.map(tool => `- ${tool.name}: ${tool.summary}`).join('\n')}` : '';
}

export function systemInstructions(config: PromptConfig, activities: readonly ActivityPrompt[] = [], deferred: readonly { name: string; summary: string }[] = []): string {
  const template = (config.systemPrompt ?? builtinSystemPrompt).trimEnd();
  const prompt = template.replace(currentContext, '');
  const base = prompt
    .replace(/<!-- allow-fiction -->(.*?)<!-- \/allow-fiction -->/gs, (_match, text: string) => config.life.allowFiction ? text : '')
    // Insert persona last and use a callback to preserve its literal contents.
    .replace('{{persona}}', () => config.persona);
  if (!activities.length) return base + onDemand(deferred);
  // Append after template expansion so plugin text stays literal, including with custom templates.
  return `${base}\n\nOnline activity guidance from enabled plugins. These are possibilities, not assignments; choose according to your persona, interests, and current situation. Autonomous life still follows the life-mode switch. Each entry lists its currently available activity tools.\n${activities.map(({ plugin, activity, tools, instructions }) => `\n### ${activity} (${plugin})\nAvailable tools: ${tools.join(', ')}\n${instructions}`).join('\n')}${onDemand(deferred)}`;
}
