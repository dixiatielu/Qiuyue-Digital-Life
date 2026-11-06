import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateToolArguments, type ToolCall } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { MemoryInput, Store } from './store.js';

/** Pi prepares arguments before schema validation. Report repairable errors together without echoing the memory body. */
export function validatedMemoryTool(tool: AgentTool, store: Store, limits: Config['development']): AgentTool {
  return {
    ...tool,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    prepareArguments(raw) {
      let args = raw; const problems: string[] = [];
      try { args = validateToolArguments(tool, { type: 'toolCall', id: 'memory-validation', name: tool.name, arguments: raw as ToolCall['arguments'] }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(message.split('\n\nReceived arguments:')[0]!);
      }
      if (args && typeof args === 'object' && !Array.isArray(args)) problems.push(...store.inspectMemoryWrite(args as Partial<MemoryInput>, limits).problems);
      if (problems.length) throw new Error(`${problems.join('\n')}\nNothing was saved. Fix all reported fields. Copy source IDs exactly from evidence into sources; keep source IDs and #xxxxxxxx references out of content for every memory kind. Reread missing evidence with read_event, read_chat_record, or read_context. If evidence does not support a claim, omit the claim rather than substituting unrelated sources.`);
      return args as Record<string, unknown>;
    },
  };
}
