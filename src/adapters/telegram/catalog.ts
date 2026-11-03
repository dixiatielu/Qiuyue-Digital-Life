import data from './catalog.json' with { type: 'json' };
import type { NativeAdapterDefinition, JsonSchema } from '../../plugin-sdk.js';

/** Share type definitions on disk; each model tool receives a self-contained native schema. */
const source = data as unknown as { source: Record<string, string>; definitions: Record<string, JsonSchema>; actions: NativeAdapterDefinition['actions'] };
function complete(input: JsonSchema): JsonSchema {
  const definitions: Record<string, JsonSchema> = {};
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const ref = (value as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
      const name = decodeURIComponent(ref.slice('#/definitions/'.length)).replaceAll('~1', '/').replaceAll('~0', '~');
      if (!Object.hasOwn(definitions, name)) {
        const definition = source.definitions[name]; if (!definition) throw new Error(`Missing Telegram schema: ${name}`);
        definitions[name] = definition; visit(definition);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(input);
  return { ...input, ...(Object.keys(definitions).length ? { definitions } : {}) };
}
export const telegramCatalog = { source: source.source, actions: source.actions.map(action => ({ ...action, inputSchema: complete(action.inputSchema) })) };
