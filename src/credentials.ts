import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export type CredentialReader = (name: string) => string | undefined;
export const environmentCredential: CredentialReader = name => process.env[name];
export type CredentialPaths = { file: string; legacyEnv: string };
type Change = { name: string; at: number; action: 'set' | 'disable' | 'migrate' };
type SavedCredentials = { version: 1; credentials: Record<string, string | null>; changes: Change[] };
export class CredentialConflictError extends Error {}
const sensitiveName = /key|token|secret|password|cookie|credential|authorization/i;
const readText = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';

export function checkCredentialName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('A credential name must use environment variable name syntax.');
}
export function credentialPaths(configPath: string, file: unknown = 'credentials.json'): CredentialPaths {
  if (typeof file !== 'string' || !file.trim()) throw new Error('credentialsFile must be a non-empty file path.');
  const base = dirname(resolve(configPath));
  const paths = { file: resolve(base, file), legacyEnv: resolve(base, '.env') };
  if ([resolve(configPath), paths.legacyEnv].includes(paths.file)) throw new Error('credentialsFile must be separate from config.json and .env.');
  return paths;
}
/** Credential writes always create a private file, including when replacing a permissive one. */
function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

/** One immutable view of credentials. Only names, sources and masked values leave the management API. */
export class Credentials {
  #environment: NodeJS.ProcessEnv;
  #legacy: Record<string, string>;
  #saved: SavedCredentials;
  #fileText: string;
  #envText: string;
  readonly revision: string;
  constructor(readonly paths: CredentialPaths, environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = { ...environment };
    this.#fileText = readText(paths.file);
    this.#envText = readText(paths.legacyEnv);
    this.#legacy = parseEnv(this.#envText) as Record<string, string>;
    this.#saved = { version: 1, credentials: {}, changes: [] };
    if (this.#fileText) {
      try {
        const data = JSON.parse(this.#fileText);
        if (data?.version !== 1 || !data.credentials || typeof data.credentials !== 'object' || Array.isArray(data.credentials) || !Array.isArray(data.changes)) throw new Error();
        for (const [name, value] of Object.entries(data.credentials)) {
          checkCredentialName(name);
          if (value !== null && (typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error();
        }
        if (data.changes.some((change: Change) => !change || typeof change.name !== 'string' || !Number.isSafeInteger(change.at) || !['set', 'disable', 'migrate'].includes(change.action))) throw new Error();
        this.#saved = { version: 1, credentials: data.credentials, changes: data.changes.map(({ name, at, action }: Change) => ({ name, at, action })) };
      } catch { throw new Error(`Invalid credential file: ${paths.file}. Expected version 1, credentials and changes; values are not included in this error.`); }
    } else if (existsSync(paths.file)) throw new Error(`The credential file is empty: ${paths.file}.`);
    this.revision = createHash('sha256').update(JSON.stringify([this.#fileText, this.#envText])).digest('hex');
  }
  private source(name: string): 'environment' | 'file' | 'legacy' | 'missing' {
    if (Object.hasOwn(this.#environment, name) && this.#environment[name] !== undefined) return 'environment';
    if (Object.hasOwn(this.#saved.credentials, name)) return 'file';
    if (Object.hasOwn(this.#legacy, name)) return 'legacy';
    return 'missing';
  }
  readonly get: CredentialReader = name => {
    switch (this.source(name)) {
      case 'environment': return this.#environment[name] || undefined;
      case 'file': return this.#saved.credentials[name] || undefined;
      case 'legacy': return this.#legacy[name] || undefined;
      default: return undefined;
    }
  };
  list(names: string[] = []) {
    const all = new Set([...names, ...Object.keys(this.#saved.credentials), ...Object.keys(this.#legacy).filter(name => sensitiveName.test(name))]);
    return [...all].sort().map(name => {
      const value = this.get(name); const source = this.source(name);
      return { name, source, writable: source !== 'environment', set: Boolean(value), value: value ? (value.length > 8 ? `••••${value.slice(-4)}` : '••••') : '' };
    });
  }
  /** Null intentionally disables legacy fallback, so deleting a key cannot revive an old .env value. */
  set(name: string, value: string | null, revision: string) {
    checkCredentialName(name);
    if (this.source(name) === 'environment') throw new Error(`${name} is managed by the external environment; change it there and restart.`);
    if (value !== null && (typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw new Error('A credential must be a non-empty single line.');
    const credentials = { ...this.#saved.credentials, [name]: value };
    this.save(credentials, [{ name, at: Date.now(), action: value === null ? 'disable' : 'set' }], revision);
  }
  private save(credentials: SavedCredentials['credentials'], changes: Change[], revision: string) {
    if (revision !== this.revision || readText(this.paths.file) !== this.#fileText || readText(this.paths.legacyEnv) !== this.#envText) throw new CredentialConflictError('Credentials changed since this page loaded. Reload before saving.');
    writePrivate(this.paths.file, JSON.stringify({ version: 1, credentials, changes: [...this.#saved.changes, ...changes].slice(-100) }, null, 2) + '\n');
  }
  /** Copy first, then remove legacy entries. A failed cleanup can safely be retried without losing values. */
  migrate(names: string[]) {
    const selected = this.list(names).map(item => item.name).filter(name => Object.hasOwn(this.#legacy, name));
    if (!selected.length) return [];
    const removed = new Set(selected);
    const nextEnv = this.#envText.split('\n').filter(line => {
      const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      return !name || !removed.has(name);
    }).join('\n');
    const remaining = parseEnv(nextEnv);
    const expected = Object.fromEntries(Object.entries(this.#legacy).filter(([name]) => !removed.has(name)));
    if (Object.keys(remaining).length !== Object.keys(expected).length || Object.entries(expected).some(([name, value]) => remaining[name] !== value)) throw new Error('Legacy .env contains multiline definitions that cannot be migrated automatically. Move those credentials manually.');
    const credentials = { ...this.#saved.credentials };
    for (const name of selected) {
      if (/[\r\n\0]/.test(this.#legacy[name]!)) throw new Error(`${name} is not a single-line credential.`);
      if (!Object.hasOwn(credentials, name)) credentials[name] = this.#legacy[name] || null;
    }
    this.save(credentials, selected.map(name => ({ name, at: Date.now(), action: 'migrate' })), this.revision);
    if (readText(this.paths.legacyEnv) !== this.#envText) throw new CredentialConflictError('The credentials were copied, but .env changed before cleanup. Retry migration.');
    writePrivate(this.paths.legacyEnv, nextEnv);
    return selected;
  }
}

/** Every credential referenced by effective configuration, including defaults. */
export function credentialNames(config: { model: { apiKeyEnv: string }; snowluma: { tokenEnv: string }; web: { searchKeyEnv: string }; embedding: { apiKeyEnv: string }; drawing: { apiKeyEnv: string }; webui: { tokenEnv: string } }) {
  return [...new Set([config.model.apiKeyEnv, config.snowluma.tokenEnv, config.web.searchKeyEnv, config.embedding.apiKeyEnv, config.drawing.apiKeyEnv, config.webui.tokenEnv])];
}
