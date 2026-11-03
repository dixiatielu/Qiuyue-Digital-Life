import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as schema from 'typescript-json-schema';

// Pinned MIT-licensed declarations. A changed dependency is an explicit catalog upgrade.
const pkg = JSON.parse(readFileSync(new URL('../node_modules/@grammyjs/types/package.json', import.meta.url), 'utf8'));
if (pkg.version !== '5.0.0') throw new Error('Review Telegram coverage before changing @grammyjs/types.');
const dir = new URL('../.qiuyue-cache/telegram/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = fileURLToPath(new URL('schema.ts', dir));
const prelude = `import type { ApiMethods, Opts } from '../../node_modules/@grammyjs/types/mod.js';
/** Upload a local file as multipart data; strings retain Telegram file IDs, URLs and attach:// references. */
export interface Upload { file: string; filename?: string; contentType?: string }
export type Methods = ApiMethods<Upload>;
export type Parameters = Opts<Upload>;
`;
writeFileSync(file, prelude);
const options = { strictNullChecks: true, skipLibCheck: true, target: 'ES2022', moduleResolution: 'node', types: [] };
let program = schema.getProgramFromFiles([file], options);
const checker = program.getTypeChecker();
const declaration = program.getSourceFile(file).statements.find(node => node.name?.text === 'Methods');
const methods = checker.getTypeAtLocation(declaration).getProperties().map(symbol => ({ name: symbol.name, summary: symbol.getDocumentationComment(checker).map(part => part.text).join('') })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
if (methods.length < 150) throw new Error('Incomplete Telegram API declarations.');
writeFileSync(file, prelude + methods.map(({name}) => `export type P_${name} = Parameters['${name}'];`).join('\n'));
program = schema.getProgramFromFiles([file], options);
const generator = schema.buildGenerator(program, { required: true, ref: true, topRef: false, ignoreErrors: false, noExtraProps: false });
if (!generator) throw new Error('Cannot generate Telegram schemas.');
const definitions = {};
const actions = methods.map(({ name, summary }) => {
  const inputSchema = generator.getSchemaForSymbol(`P_${name}`);
  delete inputSchema.$schema;
  for (const [key, definition] of Object.entries(inputSchema.definitions ?? {})) {
    if (definitions[key] && !isDeepStrictEqual(definitions[key], definition)) throw new Error(`Conflicting shared schema ${key}`);
    definitions[key] = definition;
  }
  delete inputSchema.definitions;
  if (!inputSchema.type && !inputSchema.anyOf && !inputSchema.allOf) inputSchema.type = 'object';
  if (inputSchema.type !== 'object') throw new Error(`Non-object Telegram input: ${name}`);
  return { name, summary, inputSchema, readOnly: name.startsWith('get') && name !== 'getUpdates', invariants: name === 'getUpdates' ? ['Calling getUpdates controls the update offset and may acknowledge pending updates. The adapter serializes it with background polling.'] : [] };
});
const result = { source: { repository: 'https://github.com/grammyjs/types', package: '@grammyjs/types', version: pkg.version, license: 'MIT', coverage: 'Every ApiMethods member in @grammyjs/types 5.0.0, including deprecated aliases.' }, definitions: Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b, 'en'))), actions };
mkdirSync(new URL('../src/adapters/telegram/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src/adapters/telegram/LICENSE', import.meta.url), readFileSync(new URL('../node_modules/@grammyjs/types/LICENSE', import.meta.url)));
writeFileSync(new URL('../src/adapters/telegram/catalog.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(`Telegram ${pkg.version}: ${actions.length} native tools.`);
