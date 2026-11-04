import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AdapterConfig } from './config.js';
import { conversationRef, parseConversationRef, personRef, validateSource, type EventSource } from './identity.js';
import { nativeToolName } from './platform.js';
import { actionFingerprint, digest } from './store.js';
import { normalizeEvent } from './adapters/snowluma/index.js';

const qqPlugins = ['snowluma-tools', 'qzone-share', 'qq-stickers', 'qq-faces'];
const parse = (value: unknown) => JSON.parse(String(value));
const table = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const column = (db: DatabaseSync, name: string, field: string) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${name}') WHERE name=?`).get(field);
const setting = (db: DatabaseSync, key: string) => table(db, 'settings') ? db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value : undefined;
function stopped(db: DatabaseSync) {
  const lease = setting(db, 'daemon');
  if (!lease) return;
  const pid = parse(lease).pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid daemon lease; inspect it before migrating.');
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  throw new Error(`Stop the daemon (PID ${pid}) before migrating identities.`);
}
function configuration(raw: Record<string, any>) {
  const next = structuredClone(raw);
  if (next.adapters === undefined) {
    if (!Number.isSafeInteger(next.snowluma?.selfId) || next.snowluma.selfId <= 0) throw new Error('The old configuration must identify its QQ account.');
    const { selfId, ...connection } = next.snowluma;
    next.adapters = [{ ...connection, id: 'qq_main', driver: 'snowluma', accountId: String(selfId) }];
  }
  delete next.snowluma;
  if (next.plugins) {
    for (const account of next.adapters) if (account.driver === 'snowluma') for (const id of qqPlugins) {
      const scoped = `${account.id.replaceAll('_', '-')}-${id}`;
      if (next.plugins[scoped] === undefined && next.plugins[id] !== undefined) next.plugins[scoped] = next.plugins[id];
    }
    for (const id of qqPlugins) delete next.plugins[id];
  }
  return next;
}

/** Offline conversion only. The running application never reads the old identity format. */
export async function migrateIdentities(configPath: string) {
  configPath = resolve(configPath);
  const before = readFileSync(configPath, 'utf8');
  const raw = parse(before); const next = configuration(raw);
  const token = randomUUID(); const candidate = `${configPath}.identities-${token}.tmp`;
  writeFileSync(candidate, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  let db: DatabaseSync | undefined; let lock: number | undefined; let lockPath: string | undefined;
  let configBackup: string | undefined; let databaseBackup: string | undefined;
  try {
    const config = loadConfig(candidate);
    lockPath = `${config.database}.identities.lock`;
    // The config and database parent already exist for a deployed life. A new install needs no database conversion.
    if (existsSync(dirname(config.database))) { lock = openSync(lockPath, 'wx', 0o600); }
    if (existsSync(config.database)) { db = new DatabaseSync(config.database); db.exec('PRAGMA busy_timeout=5000'); stopped(db); }
    const version = db ? Number(db.prepare('PRAGMA user_version').get()!.user_version) : 2;
    if (![0, 2].includes(version)) throw new Error(`Unsupported database identity format: ${version}`);
    const changedConfig = JSON.stringify(raw) !== JSON.stringify(next);
    if (version === 2 && !changedConfig) return { migrated: false };
    configBackup = `${configPath}.before-identities-${token}`;
    copyFileSync(configPath, configBackup); chmodSync(configBackup, 0o600);
    if (db && version !== 2) {
      databaseBackup = `${config.database}.before-identities-${token}`;
      await backup(db, databaseBackup); chmodSync(databaseBackup, 0o600);
      const check = new DatabaseSync(databaseBackup, { readOnly: true });
      try { if (check.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('Database backup failed integrity verification.'); } finally { check.close(); }
      db.exec('BEGIN EXCLUSIVE');
      try {
        stopped(db);
        convertDatabase(db, config.adapters, raw.snowluma?.selfId);
        if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('Migrated database failed integrity verification.');
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migrated database has broken foreign keys.');
        db.exec('PRAGMA user_version=2; COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // Database commits first. A crash here is recoverable by rerunning this command with the original config.
    if (readFileSync(configPath, 'utf8') !== before) throw new Error('Configuration changed during migration; rerun with the current file. The database migration is already committed.');
    renameSync(candidate, configPath);
    return { migrated: true, configBackup, databaseBackup, workingContext: 'archived; rebuilt on next thought' };
  } finally {
    db?.close(); if (lock !== undefined) { closeSync(lock); rmSync(lockPath!, { force: true }); }
    rmSync(candidate, { force: true });
  }
}
function convertDatabase(db: DatabaseSync, accounts: AdapterConfig[], configuredSelf?: number) {
  if (!table(db, 'events')) throw new Error('This database has no life event schema.');
  const self = setting(db, 'selfId');
  const selfId = self === undefined ? configuredSelf : parse(self);
  const candidates = accounts.filter(account => account.driver === 'snowluma' && (selfId === undefined || account.accountId === String(selfId)));
  const primary = () => { if (candidates.length !== 1) throw new Error('Old QQ records need exactly one matching account. Restore the old account configuration before migrating.'); return candidates[0]!; };
  const identity = (account: AdapterConfig) => ({ platform: account.driver === 'snowluma' ? 'qq' : 'telegram', accountId: account.accountId });
  const chat = (value: string, account?: AdapterConfig): string => {
    if (parseConversationRef(value)) return value;
    const match = /^(group|private):(\d+)$/.exec(value);
    if (!match) throw new Error(`Cannot migrate conversation: ${value}`);
    return conversationRef(identity(account ?? primary()), match[1] as 'group' | 'private', match[2]!);
  };
  const person = (value: string) => /^\d+$/.test(value) ? personRef('qq', value) : value;
  for (const [name, declaration] of [['source', 'TEXT'], ['conversation_ref', 'TEXT'], ['actor_ref', 'TEXT'], ['ambient_flag', 'INTEGER NOT NULL DEFAULT 0'], ['addressed', 'INTEGER NOT NULL DEFAULT 0'], ['received_at', 'INTEGER']] as const) if (!column(db, 'events', name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${declaration}`);
  for (const row of db.prepare('SELECT * FROM events').all()) {
    const payload = parse(row.payload); const kind = String(row.kind);
    let source: EventSource | undefined = row.source ? parse(row.source) : undefined;
    if (!source && (row.group_id != null || row.actor_id != null || /^(message|notice:|request:|meta_event:)/.test(kind))) {
      const account = primary();
      const raw = { ...payload, self_id: Number(account.accountId), group_id: payload.group_id ?? row.group_id, user_id: payload.user_id ?? row.actor_id, post_type: payload.post_type ?? kind.split(':')[0], notice_type: payload.notice_type ?? (kind.startsWith('notice:') ? kind.split(':')[1] : undefined), sub_type: payload.sub_type ?? kind.split(':')[2] };
      source = normalizeEvent(raw, account, messageId => {
        const prefix = `${account.id}__`;
        return !!db.prepare("SELECT 1 FROM actions WHERE status='success' AND json_extract(result,'$.message_id')=? AND ((instr(kind,'__')=0 AND instr(kind,':')=0) OR substr(kind,1,?)=?) LIMIT 1").get(messageId, prefix.length, prefix);
      })?.source;
      if (source) source.addressed ||= Boolean(row.addressed);
    }
    if (kind === 'perception_gap' && row.group_id != null) {
      const account = primary();
      source = { ...identity(account), instance: account.id, conversation: chat(`group:${row.group_id}`), conversationType: 'group', own: true, addressed: false, attention: 'normal' };
    }
    if (source) validateSource(source);
    // Structured pointers in program events are consumed at the next thought. Original prose/payloads stay archived as evidence.
    if (kind === 'memory_maintenance' || kind === 'rest_backlog') for (const key of ['backlog', 'chats']) if (Array.isArray(payload[key])) for (const item of payload[key]) item.conversation = chat(item.conversation);
    if (kind === 'drawing') payload.origin = 'self';
    let nextKind = kind;
    if (kind.startsWith('snowluma:')) {
      nextKind = `adapter:${primary().id}:${kind.slice('snowluma:'.length)}`;
      if (kind.startsWith('snowluma:send_')) payload.origin = 'self';
    }
    db.prepare('UPDATE events SET source=?,conversation_ref=?,actor_ref=?,ambient_flag=?,addressed=?,received_at=coalesce(received_at,at),kind=?,payload=? WHERE id=?').run(source ? JSON.stringify(source) : null, source?.conversation ?? null, source?.actor ?? null, Number(source?.attention === 'ambient'), Number(source?.addressed ?? false), nextKind, JSON.stringify(payload), String(row.id));
  }
  const oldGroups = column(db, 'memories', 'groups_json');
  if (!column(db, 'memories', 'scope')) db.exec('ALTER TABLE memories ADD COLUMN scope TEXT');
  if (!column(db, 'wakes', 'rest')) db.exec('ALTER TABLE wakes ADD COLUMN rest INTEGER NOT NULL DEFAULT 0');
  if (oldGroups) db.exec('ALTER TABLE memories RENAME COLUMN groups_json TO conversations_json');
  for (const row of db.prepare('SELECT id,scope,subjects,conversations_json FROM memories').all()) {
    let scope = row.scope == null ? null : String(row.scope);
    if (scope?.startsWith('group:')) scope = `conversation:${chat(scope)}`;
    if (scope?.startsWith('person:')) scope = `person:${person(scope.slice(7))}`;
    const conversations = parse(row.conversations_json).map((value: unknown) => oldGroups && typeof value === 'number' ? chat(`group:${value}`) : chat(String(value)));
    db.prepare('UPDATE memories SET scope=?,subjects=?,conversations_json=? WHERE id=?').run(scope, JSON.stringify(parse(row.subjects).map((value: unknown) => person(String(value)))), JSON.stringify(conversations), String(row.id));
  }
  const marks = setting(db, 'reviewMarks');
  if (marks) {
    const migrated: Record<string, number> = {};
    for (const [key, at] of Object.entries(parse(marks))) { const ref = chat(key); migrated[ref] = Math.max(migrated[ref] ?? 0, Number(at)); }
    db.prepare("UPDATE settings SET value=? WHERE key='reviewMarks'").run(JSON.stringify(migrated));
  }
  if (!column(db, 'actions', 'conversation')) db.exec('ALTER TABLE actions ADD COLUMN conversation TEXT');
  for (const row of db.prepare('SELECT id,kind,args,conversation FROM actions').all()) {
    const args = parse(row.args); let kind = String(row.kind);
    const unscoped = !kind.includes(':') && !kind.includes('__');
    const account = unscoped ? primary() : accounts.find(account => kind.startsWith(`${account.id}__`));
    if (unscoped) kind = nativeToolName(account!.id, kind);
    const conversation = row.conversation ? chat(String(row.conversation), account) : account && (args.group_id != null || args.user_id != null) ? conversationRef(identity(account), args.group_id != null ? 'group' : 'private', String(args.group_id ?? args.user_id)) : null;
    db.prepare('UPDATE actions SET kind=?,fingerprint=?,conversation=? WHERE id=?').run(kind, actionFingerprint(kind, args), conversation, String(row.id));
  }
  if (table(db, 'gallery_drawings')) for (const row of db.prepare('SELECT id,data FROM gallery_drawings').all()) {
    const data = parse(row.data);
    for (const source of data.sources ?? []) {
      const event = db.prepare('SELECT source FROM events WHERE id=?').get(source.id);
      const canonical = event?.source ? parse(event.source) : undefined;
      if (source.person) source.person = canonical?.actor ?? person(source.person);
      if (source.conversation) source.conversation = canonical?.conversation ?? chat(source.conversation);
    }
    db.prepare('UPDATE gallery_drawings SET data=? WHERE id=?').run(JSON.stringify(data), String(row.id));
  }
  // Remove the obsolete local-bookmark flag once; confirmed platform state, notes and cursors survive.
  for (const plugin of ['bilibili', 'xiaohongshu']) {
    const key = `plugin:${plugin}:history`; const value = setting(db, key);
    if (value) {
      const entries = parse(value);
      for (const entry of entries) delete entry.saved;
      db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(entries), key);
    }
  }
  // Vectors are derived cache. Old sticker vectors mixed accounts; regenerate from migrated receipts.
  if (table(db, 'sticker_vectors')) db.exec('DROP TABLE sticker_vectors');
  // Checkpoints contain obsolete tool declarations. Retain them explicitly as historical records.
  const checkpoints = table(db, 'working_context') ? db.prepare('SELECT * FROM working_context').all() : [];
  if (checkpoints.length) db.exec('CREATE TABLE IF NOT EXISTS context_records(id TEXT PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL, source_ids TEXT NOT NULL)');
  for (const row of checkpoints) {
    const data = parse(row.data);
    const message = { role: 'user', content: `Archived pre-migration working context (historical only):\n${JSON.stringify({ identity: row.identity, generation: row.generation, data })}`, timestamp: Number(row.updated_at) };
    db.prepare('INSERT OR IGNORE INTO context_records VALUES (?,?,?,?)').run(`ctx:${digest(message)}`, Number(row.updated_at), JSON.stringify(message), JSON.stringify(data.sources ?? []));
  }
  if (table(db, 'working_context')) db.exec('DELETE FROM working_context');
  const known = setting(db, 'platformAccounts'); const bindings = known ? parse(known) : {};
  for (const account of accounts) {
    const previous = bindings[account.id]; const next = identity(account);
    if (previous && (previous.platform !== next.platform || previous.accountId !== next.accountId)) throw new Error(`Adapter ${account.id} is bound to another platform account.`);
    bindings[account.id] = next;
  }
  db.prepare("INSERT INTO settings VALUES ('platformAccounts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(bindings));
  db.exec("DELETE FROM settings WHERE key='selfId'; UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='generation'; DROP INDEX IF EXISTS events_group; DROP INDEX IF EXISTS events_actor;");
  for (const field of ['group_id', 'actor_id']) if (column(db, 'events', field)) db.exec(`ALTER TABLE events DROP COLUMN ${field}`);
}
