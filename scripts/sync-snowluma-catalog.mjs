import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SNOWLUMA_ACTIONS } from '@snowluma/sdk';

// Pin the upstream source: catalog changes are reviewed together with SDK upgrades.
const commit = process.argv[2] ?? '8ffd314260e9e2b6967eeca494d87aa5be046c34';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Provide the full SnowLuma Git commit SHA.');
const base = `https://raw.githubusercontent.com/SnowLuma/SnowLuma/${commit}/`;
async function fetchSource(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}
const catalog = JSON.parse(await fetchSource('packages/mcp/src/generated/catalog.json'));
const actions = catalog.actions.filter(action => !action.name.startsWith('.') && action.category !== '兼容接口' && !action.examples?.some(example => /兼容占位接口|历史拼写兼容接口/.test(example.notes ?? '')));
// The public catalog contains canonical actions; expose those names directly.
for (const action of actions) {
  if (!SNOWLUMA_ACTIONS.includes(action.name) || !/^[a-zA-Z0-9_-]{1,64}$/.test(action.name)) throw new Error(`Invalid original SnowLuma interface name: ${action.name}`);
}
function currentSchema(schema) {
  if (Array.isArray(schema)) return schema.map(currentSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, currentSchema(value)]));
  if (result.properties) {
    result.properties = Object.fromEntries(Object.entries(result.properties).filter(([, value]) => {
      const description = value.description ?? '';
      const duplicate = description.match(/(?:^|[（，；])同\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      return !/兼容/.test(description) && !(duplicate && Object.hasOwn(result.properties, duplicate));
    }));
    if (result.required) result.required = result.required.filter(name => Object.hasOwn(result.properties, name));
  }
  return result;
}
const sdk = JSON.parse(await readFile(new URL('../node_modules/@snowluma/sdk/package.json', import.meta.url), 'utf8'));
const result = {
  source: { repository: 'https://github.com/SnowLuma/SnowLuma', commit, sdkVersion: sdk.version, catalog: 'packages/mcp/src/generated/catalog.json' },
  actions: actions.map(({ name, category, summary, readOnly, stream, inputSchema, invariants, returns, returnsSchema, examples }) => ({ name, category, summary, readOnly, ...(stream ? { stream } : {}), inputSchema: currentSchema(inputSchema), invariants, returns: returns?.replaceAll('等级别名', '等级'), returnsSchema: currentSchema(returnsSchema), examples })).sort((a, b) => a.name.localeCompare(b.name, 'en')),
};
const directory = new URL('../src/generated/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('snowluma-catalog.json', directory), JSON.stringify(result, null, 2) + '\n');
console.log(`SnowLuma ${sdk.version}: ${result.actions.length} actions, source ${commit}`);
