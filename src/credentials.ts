import { pluginCredentialReferences } from './plugin-manifest.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CredentialReader = (name: string) => string | undefined;
export const environmentCredential: CredentialReader = name => process.env[name];
export type CredentialPaths = { file: string };
type Change = { name: string; at: number; action: 'set' | 'disable' | 'migrate' };
type SavedCredentials = { version: 1; credentials: Record<string, string | null>; changes: Change[] };
export class CredentialConflictError extends Error {}
const readText = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';

export function checkCredentialName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('A credential name must use environment variable name syntax.');
}
export function credentialPaths(configPath: string, file: unknown = 'credentials.json'): CredentialPaths {
  if (typeof file !== 'string' || !file.trim()) throw new Error('credentialsFile must be a non-empty file path.');
  const base = dirname(resolve(configPath));
  const paths = { file: resolve(base, file) };
  if (resolve(configPath) === paths.file) throw new Error('credentialsFile must be separate from config.json.');
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
  #saved: SavedCredentials;
  #fileText: string;
  readonly revision: string;
  constructor(readonly paths: CredentialPaths, environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = { ...environment };
    this.#fileText = readText(paths.file);
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
    this.revision = createHash('sha256').update(this.#fileText).digest('hex');
  }
  private source(name: string): 'environment' | 'file' | 'missing' {
    if (Object.hasOwn(this.#environment, name) && this.#environment[name] !== undefined) return 'environment';
    if (Object.hasOwn(this.#saved.credentials, name)) return 'file';
    return 'missing';
  }
  readonly get: CredentialReader = name => {
    switch (this.source(name)) {
      case 'environment': return this.#environment[name] || undefined;
      case 'file': return this.#saved.credentials[name] || undefined;
      default: return undefined;
    }
  };
  list(names: string[] = []) {
    const all = new Set([...names, ...Object.keys(this.#saved.credentials)]);
    return [...all].sort().map(name => {
      const value = this.get(name); const source = this.source(name);
      return { name, source, writable: source !== 'environment', set: Boolean(value), value: value ? (value.length > 8 ? `••••${value.slice(-4)}` : '••••') : '' };
    });
  }
  /** Null records an explicit operator decision to disable a file credential. */
  set(name: string, value: string | null, revision: string) {
    checkCredentialName(name);
    if (this.source(name) === 'environment') throw new Error(`${name} is managed by the external environment; change it there and restart.`);
    if (value !== null && (typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) throw new Error('A credential must be a non-empty single line.');
    if (revision !== this.revision || readText(this.paths.file) !== this.#fileText) throw new CredentialConflictError('Credentials changed since this page loaded. Reload before saving.');
    const credentials = { ...this.#saved.credentials, [name]: value };
    const change: Change = { name, at: Date.now(), action: value === null ? 'disable' : 'set' };
    writePrivate(this.paths.file, JSON.stringify({ version: 1, credentials, changes: [...this.#saved.changes, change].slice(-100) }, null, 2) + '\n');
  }
}

/** Every credential referenced by effective configuration, including defaults. */
export function credentialNames(config: { model: { apiKeyEnv: string }; adapters: { tokenEnv: string }[]; web: { searchKeyEnv: string }; embedding: { apiKeyEnv: string }; drawing: { apiKeyEnv: string }; webui: { tokenEnv: string }; extensions?: { directory: string; settings: Record<string, Record<string, unknown>> } }) {
  const plugins = pluginCredentialReferences(config.extensions).map(item => item.name);
  return [...new Set([config.model.apiKeyEnv, ...config.adapters.map(account => account.tokenEnv), config.web.searchKeyEnv, config.embedding.apiKeyEnv, config.drawing.apiKeyEnv, config.webui.tokenEnv, ...plugins])];
}
