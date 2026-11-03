import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Credentials, CredentialConflictError, credentialPaths } from '../src/credentials.js';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

function fixture(work: (paths: ReturnType<typeof credentialPaths>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-credentials-'));
  try { work(credentialPaths(join(dir, 'config.json'))); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const saved = (credentials: Record<string, string | null>) => JSON.stringify({ version: 1, credentials, changes: [] });

test('environment, file and legacy resolution is consistent, including explicit empty and disabled values', () => fixture(paths => {
  writeFileSync(paths.legacyEnv, 'A=legacy-a\nB=legacy-b\nC=legacy-c\nD=legacy-d\nQIUYUE_UI_LANGUAGE=zh\n');
  writeFileSync(paths.file, saved({ A: 'file-a', B: 'file-b', C: null, UNUSUAL: 'private-value-1234' }));
  const credentials = new Credentials(paths, { A: 'external-a', B: '' });
  assert.equal(credentials.get('A'), 'external-a');
  assert.equal(credentials.get('B'), undefined, 'an explicitly empty external variable is not silently replaced');
  assert.equal(credentials.get('C'), undefined, 'disabled credentials never fall through to .env');
  assert.equal(credentials.get('D'), 'legacy-d');
  assert.equal(credentials.get('MISSING'), undefined);
  const list = credentials.list(['A', 'B', 'C', 'D']);
  assert.deepEqual(list.find(item => item.name === 'A'), { name: 'A', source: 'environment', writable: false, set: true, value: '••••al-a' });
  assert.equal(list.find(item => item.name === 'UNUSUAL')?.value, '••••1234', 'every file entry is masked regardless of its name');
  assert.ok(!list.some(item => item.name === 'QIUYUE_UI_LANGUAGE'));
  assert.ok(!JSON.stringify(credentials).includes('private-value'));
  assert.throws(() => credentials.set('A', 'replacement', credentials.revision), /external environment/);
}));

test('writes stay private, preserve running snapshots, detect stale edits and retain metadata without old values', () => fixture(paths => {
  writeFileSync(paths.legacyEnv, 'MY_KEY=legacy-old-secret\n');
  writeFileSync(paths.file, saved({ MY_KEY: 'file-old-secret' }));
  chmodSync(paths.file, 0o644);
  const running = new Credentials(paths, {});
  running.set('MY_KEY', 'new-value-5678', running.revision);
  assert.equal(statSync(paths.file).mode & 0o777, 0o600);
  assert.equal(running.get('MY_KEY'), 'file-old-secret');
  const current = new Credentials(paths, {});
  assert.equal(current.get('MY_KEY'), 'new-value-5678');
  assert.equal(process.env.MY_KEY, undefined);
  assert.throws(() => running.set('OTHER', 'lost-update', running.revision), CredentialConflictError);
  assert.throws(() => current.set('OTHER', 'lost-update', running.revision), CredentialConflictError);
  current.set('MY_KEY', null, current.revision);
  const disabled = new Credentials(paths, {});
  assert.equal(disabled.get('MY_KEY'), undefined);
  const text = readFileSync(paths.file, 'utf8');
  assert.ok(!text.includes('file-old-secret') && !text.includes('new-value-5678'));
  assert.deepEqual(JSON.parse(text).changes.map((change: any) => change.action), ['set', 'disable']);
  assert.ok(JSON.parse(text).changes.every((change: any) => Object.keys(change).sort().join() === 'action,at,name'));
}));

test('migration preserves non-secret settings, never overwrites newer file values, and is safe to repeat', () => fixture(paths => {
  writeFileSync(paths.legacyEnv, '# legacy\nMODEL_API_KEY=legacy-value\nexport MODEL_API_KEY=last-value\nCUSTOM=custom-value\nQIUYUE_UI_LANGUAGE=zh\nOTHER=1\n');
  writeFileSync(paths.file, saved({ MODEL_API_KEY: 'newer-value' }));
  const credentials = new Credentials(paths, {});
  assert.deepEqual(credentials.migrate(['CUSTOM']), ['CUSTOM', 'MODEL_API_KEY']);
  assert.equal(readFileSync(paths.legacyEnv, 'utf8'), '# legacy\nQIUYUE_UI_LANGUAGE=zh\nOTHER=1\n');
  const next = new Credentials(paths, {});
  assert.equal(next.get('MODEL_API_KEY'), 'newer-value');
  assert.equal(next.get('CUSTOM'), 'custom-value');
  assert.deepEqual(next.migrate(['CUSTOM']), []);
  assert.equal(statSync(paths.legacyEnv).mode & 0o777, 0o600);
}));

test('invalid files and unsafe migration fail without disclosing or partially saving credentials', () => fixture(paths => {
  writeFileSync(paths.file, '{"credential":"sensitive-malformed-value');
  assert.throws(() => new Credentials(paths, {}), error => error instanceof Error && !error.message.includes('sensitive-malformed-value'));
  rmSync(paths.file);
  const text = 'MODEL_API_KEY="first\nsecond"\nOTHER=1\n';
  writeFileSync(paths.legacyEnv, text);
  assert.throws(() => new Credentials(paths, {}).migrate([]), /multiline|single-line/);
  assert.equal(readFileSync(paths.legacyEnv, 'utf8'), text);
  assert.equal(existsSync(paths.file), false);
  const current = new Credentials(paths, {});
  assert.throws(() => current.set('BAD NAME', 'x', current.revision), /name/);
  assert.throws(() => current.set('KEY', 'a\nb', current.revision), /single line/);
  assert.throws(() => credentialPaths(join(dirname(paths.file), 'config.json'), '.env'), /separate/);
}));

test('the migration command uses configured paths, removes old credential history and prints no values', () => fixture(paths => {
  const dir = dirname(paths.file);
  const config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  config.credentialsFile = 'private/credentials.json';
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, config.personaFile), 'Test persona');
  writeFileSync(paths.legacyEnv, 'MODEL_API_KEY=migration-test-secret\nQIUYUE_UI_LANGUAGE=zh\n');
  const history = join(dir, 'data/webui/history/env');
  mkdirSync(history, { recursive: true }); writeFileSync(join(history, 'old.env'), 'MODEL_API_KEY=old-test-secret');
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'credentials', 'migrate', '--config', join(dir, 'config.json')], { encoding: 'utf8' });
  assert.ok(!output.includes('migration-test-secret') && !output.includes('old-test-secret'));
  assert.deepEqual(JSON.parse(output).migrated, ['MODEL_API_KEY']);
  assert.equal(existsSync(history), false);
  const destination = credentialPaths(join(dir, 'config.json'), config.credentialsFile);
  assert.equal(new Credentials(destination, {}).get('MODEL_API_KEY'), 'migration-test-secret');
  assert.equal(statSync(dirname(destination.file)).mode & 0o777, 0o700);
  assert.equal(readFileSync(paths.legacyEnv, 'utf8'), 'QIUYUE_UI_LANGUAGE=zh\n');
}));

test('credential paths and interface language are ordinary validated configuration without credential values', () => fixture(paths => {
  const dir = dirname(paths.file); const path = join(dir, 'config.json');
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, base.personaFile), 'Test persona');
  const load = (extra: object) => { writeFileSync(path, JSON.stringify({ ...base, ...extra })); return loadConfig(path); };
  assert.equal(load({}).credentialsFile, paths.file);
  assert.equal(load({ credentialsFile: 'private/keys.json', uiLanguage: 'zh' }).credentialsFile, join(dir, 'private/keys.json'));
  assert.equal(load({ uiLanguage: 'zh' }).uiLanguage, 'zh');
  for (const credentialsFile of ['', null, 42, '.env', 'config.json']) assert.throws(() => load({ credentialsFile }), /credentialsFile/);
  assert.throws(() => load({ uiLanguage: 'invalid' }), /uiLanguage/);
}));
