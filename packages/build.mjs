import { build } from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export async function packagePlugin(id) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid plugin ID.');
  const manifest = readFileSync(join(root, id, 'plugin.json'), 'utf8');
  const result = await build({
    entryPoints: [join(root, id, 'index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
  });
  return { 'index.mjs': result.outputFiles[0].text, 'plugin.json': manifest };
}
export async function buildPlugin(id, directory) {
  const files = await packagePlugin(id);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requested = process.argv.slice(2);
  const ids = requested.length ? requested : readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && readdirSync(join(root, entry.name)).includes('plugin.json')).map(entry => entry.name);
  for (const id of ids) {
    const destination = resolve(root, '../output/plugins', id);
    await buildPlugin(id, destination);
    console.log(`${id}: ${destination}`);
  }
}
