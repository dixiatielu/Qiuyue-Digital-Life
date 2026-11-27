import type { TSchema } from 'typebox';

const ANY_JSON_ITEM = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'object' }],
};

export const ANY_JSON_VALUE = [
  { type: 'string' },
  { type: 'number' },
  { type: 'boolean' },
  { type: 'object' },
  { type: 'array', items: ANY_JSON_ITEM },
];

const SCHEMA_META_KEYS = new Set(['$schema', '$id', 'definitions', '$defs']);
const LITERAL_KEYS = new Set(['enum', 'const', 'default', 'examples']);
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function resolvePointer(root: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(2).split('/')) {
    if (!current || typeof current !== 'object') return undefined;
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isTypedSchema(node: Record<string, unknown>): boolean {
  return (
    typeof node.type === 'string' ||
    Array.isArray(node.type) ||
    Array.isArray(node.anyOf) ||
    Array.isArray(node.oneOf) ||
    Array.isArray(node.allOf) ||
    Array.isArray(node.enum) ||
    Object.hasOwn(node, 'const') ||
    typeof node.$ref === 'string'
  );
}

function needsSanitization(value: unknown, inSchemaMap = false): boolean {
  if (Array.isArray(value)) return value.some(item => needsSanitization(item, false));
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (inSchemaMap) {
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        if (!isTypedSchema(child as Record<string, unknown>)) return true;
      }
      if (needsSanitization(child, false)) return true;
    }
    return false;
  }
  if (typeof obj.$ref === 'string') return true;
  if (Array.isArray(obj.type)) return true;
  if (obj.additionalProperties === true) return true;
  if (obj.type === 'array' && obj.items === undefined) return true;
  if (obj.properties !== undefined && !isTypedSchema(obj)) return true;
  for (const [key, child] of Object.entries(obj)) {
    if (SCHEMA_META_KEYS.has(key)) return true;
    if (LITERAL_KEYS.has(key)) continue;
    if (needsSanitization(child, SCHEMA_MAP_KEYS.has(key))) return true;
  }
  return false;
}

function sanitizeNode(value: unknown, root: Record<string, unknown>, seenRefs: ReadonlySet<string>, ensureTyped: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeNode(item, root, seenRefs, false));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    const { $ref: _ref, ...siblings } = obj;
    const sanitizedSiblings: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(siblings)) {
      if (SCHEMA_META_KEYS.has(key)) continue;
      if (LITERAL_KEYS.has(key)) sanitizedSiblings[key] = item;
      else sanitizedSiblings[key] = sanitizeNode(item, root, seenRefs, false);
    }
    if (seenRefs.has(ref)) {
      // Break recursive $ref cycles cleanly so every provider gets a finite schema.
      return { type: 'object', ...sanitizedSiblings };
    }
    const target = resolvePointer(root, ref);
    if (!target || typeof target !== 'object') {
      return { type: 'object', ...sanitizedSiblings };
    }
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    const resolved = sanitizeNode(target, root, nextSeen, ensureTyped);
    if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
      return { ...(resolved as Record<string, unknown>), ...sanitizedSiblings };
    }
    return resolved;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (SCHEMA_META_KEYS.has(key)) continue;
    if (key === 'additionalProperties') {
      if (item === true) continue;
      if (item && typeof item === 'object') out.additionalProperties = sanitizeNode(item, root, seenRefs, true);
      else if (item === false) out.additionalProperties = false;
      continue;
    }
    if (LITERAL_KEYS.has(key)) {
      out[key] = item;
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && item && typeof item === 'object' && !Array.isArray(item)) {
      const nextMap: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(item as Record<string, unknown>)) {
        nextMap[propName] = sanitizeNode(propSchema, root, seenRefs, true);
      }
      out[key] = nextMap;
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(item)) {
      out[key] = item.map(branch => sanitizeNode(branch, root, seenRefs, true));
      continue;
    }
    if (key === 'items') {
      out.items = Array.isArray(item)
        ? item.map(branch => sanitizeNode(branch, root, seenRefs, true))
        : sanitizeNode(item, root, seenRefs, true);
      continue;
    }
    out[key] = sanitizeNode(item, root, seenRefs, false);
  }

  if (Array.isArray(out.type)) {
    const types = (out.type as unknown[]).filter((item): item is string => typeof item === 'string');
    delete out.type;
    if (types.length === 1) {
      out.type = types[0];
    } else if (types.length > 1) {
      const branches = types.map(type => (type === 'array' ? { type: 'array', items: structuredClone(ANY_JSON_ITEM) } : { type }));
      if (Array.isArray(out.anyOf)) out.anyOf = [...out.anyOf, ...branches];
      else out.anyOf = branches;
    }
  }

  if (out.properties !== undefined && !isTypedSchema(out)) {
    out.type = 'object';
  }
  if (out.type === 'array' && out.items === undefined) {
    out.items = structuredClone(ANY_JSON_ITEM);
  }
  if (ensureTyped && !isTypedSchema(out)) {
    out.anyOf = structuredClone(ANY_JSON_VALUE);
  }
  return out;
}

/**
 * Normalize a JSON Schema / TypeBox tool schema for cross-provider compatibility:
 * - inline local `#/definitions/...` and `#/$defs/...` `$ref`s with cycle protection,
 * - strip `$schema`, `$id`, `definitions`, `$defs`, and `additionalProperties: true`,
 * - convert JSON Schema array `type` (e.g. `["string", "number"]`) into `anyOf`,
 * - ensure every array schema declares `items` and every untyped property has an explicit `anyOf`.
 *
 * Clean schemas (such as built-in TypeBox schemas) are returned unchanged.
 */
export function sanitizeToolSchema<T extends TSchema = TSchema>(schema: T): T {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (!needsSanitization(schema)) return schema;
  return sanitizeNode(schema, schema as unknown as Record<string, unknown>, new Set(), false) as T;
}
