import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Credentials, CredentialConflictError, credentialPaths } from '../src/credentials.js';
import { loadUiLanguage, ui } from '../src/ui-language.js';
import { loadConfig } from '../src/config.js';

function fixture(work: (paths: ReturnType<typeof credentialPaths>) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-credentials-'));
  try { work(credentialPaths(join(dir, 'config.json'))); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const saved = (credentials: Record<string, string | null>) => JSON.stringify({ version: 1, credentials, changes: [] });

test('only environment and file credentials resolve, including explicit empty and disabled values', () => fixture(paths => {
  writeFileSync(join(dirname(paths.file), '.env'), 'A=legacy-a\nB=legacy-b\nC=legacy-c\nD=legacy-d\nQIUYUE_UI_LANGUAGE=zh\nABANDONED_TOKEN=ignored-secret\n');
  writeFileSync(paths.file, saved({ A: 'file-a', B: 'file-b', C: null, UNUSUAL: 'private-value-1234' }));
  const credentials = new Credentials(paths, { A: 'external-a', B: '' });
  assert.equal(credentials.get('A'), 'external-a');
  assert.equal(credentials.get('B'), undefined, 'an explicitly empty external variable is not silently replaced');
  assert.equal(credentials.get('C'), undefined, 'disabled credentials never fall through to .env');
  assert.equal(credentials.get('D'), undefined);
  assert.equal(credentials.list(['D']).find(item => item.name === 'D')?.source, 'missing');
  assert.equal(credentials.get('MISSING'), undefined);
  const list = credentials.list(['A', 'B', 'C', 'D']);
  assert.deepEqual(list.find(item => item.name === 'A'), { name: 'A', source: 'environment', writable: false, set: true, value: '••••al-a' });
  assert.equal(list.find(item => item.name === 'UNUSUAL')?.value, '••••1234', 'every file entry is masked regardless of its name');
  assert.ok(!list.some(item => ['QIUYUE_UI_LANGUAGE', 'ABANDONED_TOKEN'].includes(item.name)));
  assert.ok(!JSON.stringify(credentials).includes('private-value'));
  assert.throws(() => credentials.set('A', 'replacement', credentials.revision), /external environment/);
}));

test('writes stay private, preserve running snapshots, detect stale edits and retain metadata without old values', () => fixture(paths => {
  writeFileSync(join(dirname(paths.file), '.env'), 'MY_KEY=legacy-old-secret\n');
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

test('dotenv changes do not affect credential revisions or writes', () => fixture(paths => {
  const env = join(dirname(paths.file), '.env');
  const credentials = new Credentials(paths, {});
  writeFileSync(env, 'MODEL_API_KEY="malformed\nignored');
  assert.equal(new Credentials(paths, {}).revision, credentials.revision);
  credentials.set('MODEL_API_KEY', 'file-value', credentials.revision);
  assert.equal(new Credentials(paths, {}).get('MODEL_API_KEY'), 'file-value');
  assert.equal(readFileSync(env, 'utf8'), 'MODEL_API_KEY="malformed\nignored');
}));

test('invalid credential files and edits fail without disclosing secrets', () => fixture(paths => {
  writeFileSync(paths.file, '{"credential":"sensitive-malformed-value');
  assert.throws(() => new Credentials(paths, {}), error => error instanceof Error && !error.message.includes('sensitive-malformed-value'));
  rmSync(paths.file);
  const current = new Credentials(paths, {});
  assert.throws(() => current.set('BAD NAME', 'x', current.revision), /name/);
  assert.throws(() => current.set('KEY', 'a\nb', current.revision), /single line/);
  assert.throws(() => credentialPaths(join(dirname(paths.file), 'config.json'), 'config.json'), /separate/);
}));

test('interface language comes only from configuration, without reading dotenv or changing the environment', () => fixture(paths => {
  const path = join(dirname(paths.file), 'config.json');
  const old = process.env.QIUYUE_UI_LANGUAGE;
  process.env.QIUYUE_UI_LANGUAGE = 'zh';
  writeFileSync(join(dirname(paths.file), '.env'), 'QIUYUE_UI_LANGUAGE=zh\n');
  try {
    loadUiLanguage(path); assert.equal(ui('English', 'Chinese'), 'English');
    writeFileSync(path, JSON.stringify({ uiLanguage: 'zh' }));
    loadUiLanguage(path); assert.equal(ui('English', 'Chinese'), 'Chinese');
    writeFileSync(path, '{}'); loadUiLanguage(path);
    assert.equal(ui('English', 'Chinese'), 'English');
    assert.equal(process.env.QIUYUE_UI_LANGUAGE, 'zh');
  } finally {
    if (old === undefined) delete process.env.QIUYUE_UI_LANGUAGE; else process.env.QIUYUE_UI_LANGUAGE = old;
    rmSync(path, { force: true }); loadUiLanguage(path);
  }
}));

test('credential paths and interface language are ordinary validated configuration without credential values', () => fixture(paths => {
  const dir = dirname(paths.file); const path = join(dir, 'config.json');
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, base.personaFile), 'Test persona');
  const load = (extra: object) => { writeFileSync(path, JSON.stringify({ ...base, ...extra })); return loadConfig(path); };
  assert.equal(load({}).credentialsFile, paths.file);
  assert.equal(load({ credentialsFile: 'private/keys.json', uiLanguage: 'zh' }).credentialsFile, join(dir, 'private/keys.json'));
  assert.equal(load({ uiLanguage: 'zh' }).uiLanguage, 'zh');
  for (const credentialsFile of ['', null, 42, 'config.json']) assert.throws(() => load({ credentialsFile }), /credentialsFile/);
  assert.throws(() => load({ uiLanguage: 'invalid' }), /uiLanguage/);
}));
