import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Credentials, credentialPaths } from '../credentials.js';
import { loadConfig, type Config } from '../config.js';
import { builtinSystemPrompt, checkSystemPrompt } from '../prompts.js';

export type HistoryKind = 'config' | 'persona' | 'prompt';
const kept: Record<HistoryKind, { count: number; ext: string }> = { config: { count: 50, ext: 'json' }, persona: { count: 200, ext: 'md' }, prompt: { count: 100, ext: 'md' } };
export const historyKinds = Object.keys(kept) as HistoryKind[];
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** A file changed on disk after the page read it, by hand or by another session. */
export class ConflictError extends Error {}

/** Replace a file whole, so a reader never sees half of it, and keep its permissions. */
function writeAtomic(path: string, text: string) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { mode }); renameSync(temp, path); }
  catch (error) { rmSync(temp, { force: true }); throw error; }
}
const readText = (path: string | undefined) => path && existsSync(path) ? readFileSync(path, 'utf8') : '';
const normalized = (text: string) => text.replace(/\r\n?/g, '\n');

/** The operator's files: configuration, persona, and system prompt, each saved whole with earlier versions kept beside the life database. */
export class OperatorFiles {
  readonly base: string;
  constructor(readonly configPath: string) {
    this.base = dirname(configPath);
  }
  get dataDir() {
    let database = 'data/life.sqlite';
    try { database = this.raw().database ?? database; } catch { /* an unreadable configuration keeps the default place */ }
    return resolve(this.base, dirname(database), 'webui');
  }
  configText() { return readFileSync(this.configPath, 'utf8'); }
  raw(): Record<string, any> {
    const raw = JSON.parse(this.configText());
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The configuration must be a JSON object.');
    return raw;
  }
  /** Load a configuration the way the daemon will, without touching the real file. */
  check(raw: Record<string, any>, overrides: { persona?: string; prompt?: string } = {}): Config {
    credentialPaths(this.configPath, raw.credentialsFile);
    const temp = (suffix: string) => join(this.base, `.webui-check-${randomUUID()}${suffix}`);
    const files: string[] = [];
    const candidate = { ...raw };
    try {
      for (const [key, text] of [['personaFile', overrides.persona], ['systemPromptFile', overrides.prompt]] as const) {
        if (text === undefined) continue;
        const path = temp('.md'); writeFileSync(path, text, { mode: 0o600 }); files.push(path);
        candidate[key] = path;
      }
      const path = temp('.json'); writeFileSync(path, JSON.stringify(candidate), { mode: 0o600 }); files.push(path);
      return loadConfig(path);
    } finally { for (const path of files) rmSync(path, { force: true }); }
  }
  private guard(path: string, baseHash?: string) {
    if (baseHash !== undefined && hash(readText(path)) !== baseHash) throw new ConflictError('This file changed on disk after the page loaded it. Reload to see the current version before saving.');
  }
  saveConfig(raw: Record<string, any>, baseHash?: string): Config {
    this.guard(this.configPath, baseHash);
    const config = this.check(raw);
    this.replace('config', this.configPath, JSON.stringify(raw, null, 2) + '\n');
    return config;
  }
  personaPath(raw = this.raw()) { return resolve(this.base, String(raw.personaFile)); }
  persona() { const path = this.personaPath(); const text = readText(path); return { path, text, hash: hash(text) }; }
  savePersona(text: string, baseHash?: string) {
    text = normalized(text);
    if (!text.trim()) throw new Error('The persona content in personaFile must not be empty.');
    const path = this.personaPath();
    this.guard(path, baseHash);
    this.check(this.raw(), { persona: text });
    this.replace('persona', path, text);
  }
  promptPath(raw = this.raw()) { return typeof raw.systemPromptFile === 'string' && raw.systemPromptFile ? resolve(this.base, raw.systemPromptFile) : undefined; }
  get promptBasePath() { return join(this.dataDir, 'prompt-base.md'); }
  prompt() {
    const raw = this.raw(); const path = this.promptPath(raw);
    const override = path ? readText(path) : undefined;
    const base = existsSync(this.promptBasePath) ? readFileSync(this.promptBasePath, 'utf8') : undefined;
    const builtin = builtinSystemPrompt;
    return { path, file: raw.systemPromptFile as string | undefined, builtin, override, hash: hash(override ?? ''), base, builtinChanged: override !== undefined && base !== undefined && base !== builtin };
  }
  /** Save the operator's template; the first save also points systemPromptFile at it. The built-in version it was written against is kept, to tell later when that changes. */
  savePrompt(text: string, baseHash?: string) {
    text = normalized(text);
    checkSystemPrompt(text);
    const raw = this.raw();
    const file = typeof raw.systemPromptFile === 'string' && raw.systemPromptFile ? raw.systemPromptFile : 'system-prompt.md';
    const path = resolve(this.base, file);
    if (raw.systemPromptFile) this.guard(path, baseHash);
    const next = { ...raw, systemPromptFile: file };
    this.check(next, { prompt: text });
    this.replace('prompt', path, text);
    if (!raw.systemPromptFile) this.replace('config', this.configPath, JSON.stringify(next, null, 2) + '\n');
    writeAtomic(this.promptBasePath, this.prompt().builtin);
  }
  /** Go back to the built-in prompt. The operator's file stays on disk and in history; only the reference goes. */
  resetPrompt() {
    const { systemPromptFile: _dropped, ...raw } = this.raw();
    this.check(raw);
    this.replace('config', this.configPath, JSON.stringify(raw, null, 2) + '\n');
  }
  credentials() {
    let file: unknown;
    try { file = this.raw().credentialsFile; } catch { /* the page also repairs invalid configuration */ }
    return new Credentials(credentialPaths(this.configPath, file));
  }
  private historyDir(kind: HistoryKind) { return join(this.dataDir, 'history', kind); }
  history(kind: HistoryKind) {
    const dir = this.historyDir(kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => !name.endsWith('.tmp')).sort().reverse().map(name => ({ id: name, at: Number(name.split('-')[0]), size: statSync(join(dir, name)).size }));
  }
  version(kind: HistoryKind, id: string) {
    if (!/^\d+-[0-9a-f]{12}\.\w+$/.test(id)) throw new Error('Unknown version.');
    const path = join(this.historyDir(kind), id);
    if (!existsSync(path)) throw new Error('Unknown version.');
    return readFileSync(path, 'utf8');
  }
  /** Keep the text a file held before and after a save, so edits made outside the page are kept too. */
  private snapshot(kind: HistoryKind, text: string) {
    const dir = this.historyDir(kind);
    const latest = this.history(kind)[0];
    if (latest && this.version(kind, latest.id) === text) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The before and after of one save can fall in the same millisecond; names must still sort in order.
    const at = Math.max(Date.now(), (latest?.at ?? 0) + 1);
    writeFileSync(join(dir, `${at}-${hash(text).slice(0, 12)}.${kept[kind].ext}`), text, { mode: 0o600 });
    for (const old of this.history(kind).slice(kept[kind].count)) rmSync(join(dir, old.id), { force: true });
  }
  private replace(kind: HistoryKind, path: string, text: string) {
    const previous = readText(path);
    if (previous === text) return;
    if (previous) this.snapshot(kind, previous);
    writeAtomic(path, text);
    this.snapshot(kind, text);
  }
}
