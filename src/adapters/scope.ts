import type { LifePlugin } from '../plugins.js';
import { nativeToolName, type SocialAdapter } from '../platform.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { NativeActionDefinition } from '../platform.js';

/** Scope a plugin without altering the native declarations its implementation works with. */
export function scopePlugin(plugin: LifePlugin, instance: string, actions: readonly NativeActionDefinition[], adapter: SocialAdapter, conversation?: (legacy: string) => string): LifePlugin {
  const names = new Map(actions.map(action => [nativeToolName(instance, action.name), action.name]));
  const qualify = (name: string) => { const qualified = nativeToolName(instance, name); names.set(qualified, name); return qualified; };
  const local = (name: string) => names.get(name);
  const instructions = (text: string) => text.replace(/\b[a-zA-Z][a-zA-Z0-9_]*\b/g, name => names.has(nativeToolName(instance, name)) ? qualify(name) : name);
  const matches = (event: import('../domain.js').EnvironmentEvent) => event.source?.instance === instance;
  const scoped: LifePlugin = {
    ...plugin,
    ...(plugin.observation ? { observation: (events, thought) => plugin.observation!(events.filter(matches), thought).map(instructions) } : {}),
    ...(plugin.images ? { images: event => matches(event) ? plugin.images!(event) : [] } : {}),
    ...(plugin.supplementalImages ? { supplementalImages: (events, thought) => plugin.supplementalImages!(events.filter(matches), thought) } : {}),
    ...(plugin.imageViewer ? { imageViewer: label => { const name = plugin.imageViewer!(label); return name ? qualify(name) : undefined; } } : {}),
    ...(plugin.emojiNames ? { emojiNames: (events, signal) => plugin.emojiNames!(events?.filter(matches), signal) } : {}),
    id: `${instance.replaceAll('_', '-')}-${plugin.id}`,
    contextVersion: `${plugin.contextVersion ?? '1'}:${instance}`,
    tools: runtime => { const tools = plugin.tools(runtime.scoped(instance)); tools.forEach(tool => qualify(tool.name)); return tools.map(tool => ({ ...tool, name: qualify(tool.name), label: qualify(tool.name), description: `${instructions(tool.description)} Native operation names in catalog results use the ${instance}__ tool prefix for this account.`, ...(tool.insertBefore ? { insertBefore: qualify(tool.insertBefore) } : {}) })); },
    ...(plugin.nativeActions ? { nativeActions: {
      accounts: plugin.nativeActions.accounts,
      definition: (name: string) => { const raw = local(name); return raw ? plugin.nativeActions!.definition(raw) : undefined; },
      allowed: (name: string) => { const raw = local(name); return !!raw && plugin.nativeActions!.allowed(raw); },
      execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => adapter.execute(local(name)!, args, signal),
    } } : {}),
    reviewTools: plugin.reviewTools?.map(qualify),
    chatActions: plugin.chatActions?.map(qualify),
    staleActions: plugin.staleActions?.map(qualify),
    activities: plugin.activities?.map(activity => ({ ...activity, tools: activity.tools.map(qualify), ...(activity.currentValue ? { currentValue: { ...activity.currentValue, tool: qualify(activity.currentValue.tool) } } : {}) })),
    activityInstructions: plugin.activityInstructions ? instructions(plugin.activityInstructions) : undefined,
    experienceKinds: plugin.experienceKinds ? Object.fromEntries(Object.entries(plugin.experienceKinds).map(([tool, kind]) => [qualify(tool), kind])) : undefined,
    endsThought: plugin.endsThought ? (tool, details) => { const raw = local(tool); return !!raw && plugin.endsThought!(raw, details); } : undefined,
    chatTarget: plugin.chatTarget ? (tool, args) => { const raw = local(tool); const chat = raw ? plugin.chatTarget!(raw, args) : undefined; return chat && conversation ? conversation(chat) : chat; } : undefined,
    actionCaption: plugin.actionCaption ? action => { const raw = local(action.kind); return raw ? plugin.actionCaption!({ ...action, kind: raw }) : undefined; } : undefined,
    decorateTool: plugin.decorateTool ? (tool, runtime) => {
      const raw = local(tool.name); if (!raw) return tool;
      const original: AgentTool = { ...tool, name: raw };
      const decorated = plugin.decorateTool!(original, runtime.scoped(instance));
      if (decorated === original) return tool;
      if (decorated.name !== raw) throw new Error(`Plugin ${plugin.id} cannot rename ${raw}.`);
      return { ...decorated, name: tool.name, description: instructions(decorated.description) };
    } : undefined,
  };
  return scoped;
}
