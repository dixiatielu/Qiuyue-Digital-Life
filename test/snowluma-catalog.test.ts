import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../src/snowluma-catalog.ts', import.meta.url).href;
function load(file: string, cwd: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval',
    `const { snowlumaCatalog, snowlumaCatalogSource } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({ names: snowlumaCatalog.map(action => action.name), source: snowlumaCatalogSource }));`],
  { cwd, env: { ...process.env, QIUYUE_SNOWLUMA_CATALOG: file }, encoding: 'utf8' });
}

test('a deployment can load its own catalog outside the checkout and working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-catalog-'));
  try {
    const file = join(dir, 'catalog.json');
    const source = { repository: 'https://example.com/catalog', commit: 'synthetic', sdkVersion: 'test', catalog: 'fixture' };
    // Independently authored fixture for the public login-info interface, not an upstream catalog excerpt.
    writeFileSync(file, JSON.stringify({ source, actions: [{ name: 'get_login_info', readOnly: true,
      inputSchema: { type: 'object', properties: {} }, invariants: [] }] }));
    const result = load(file, tmpdir());
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { names: ['get_login_info'], source });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing local catalog reports the preparation step instead of using a bundled fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-catalog-'));
  try {
    const result = load(join(dir, 'missing.json'), tmpdir());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm run sync:snowluma/);
    assert.match(result.stderr, /QIUYUE_SNOWLUMA_CATALOG/);
    assert.equal(result.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
