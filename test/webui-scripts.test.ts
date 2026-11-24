import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const publicDir = fileURLToPath(new URL('../src/webui/public/', import.meta.url));

function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? scripts(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}

// Most page modules import preact through the browser's import map, so no test imports them;
// one syntax error in any of them leaves the whole management page blank.
test('every browser script of the management page parses', () => {
  const files = scripts(publicDir);
  assert.ok(files.length > 5);
  for (const file of files) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (error: any) { assert.fail(`${file}\n${error.stderr}`); }
  }
});
