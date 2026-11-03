import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Check } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { Config } from './config.js';
import type { CredentialReader } from './credentials.js';
import { errorText } from './domain.js';
import type { LifePlugin } from './plugins.js';
import type { PluginContext, PluginDefinition, UserTool } from './plugin-sdk.js';
import { findSnowLumaAction } from './snowluma-catalog.js';
import type { Store } from './store.js';
import { waitFor } from './async.js';

export const validPluginId = (id: string) => id !== 'all' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
const skipped = new Set(['node_modules', '.qiuyue-cache', '.git']);
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin sources must be regular files, not symbolic links: ${relative}`);
    return entry.isDirectory() ? files(directory, relative) : entry.isFile() ? [relative] : [];
  });
}
export function discoverPlugins(directory: string): string[] {
  try { return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && validPluginId(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Also fingerprints helper files and removals; no user code executes during inspection. */
export function pluginSource(directory: string) {
  const entries = files(directory).map(name => ({ name, data: readFileSync(join(directory, name)) }));
  const hash = createHash('sha256');
  for (const { name, data } of entries) hash.update(name).update('\0').update(String(data.length)).update('\0').update(data);
  return { entries, hash: hash.digest('hex') };
}
export interface LoadedPlugin {
  plugin: LifePlugin; definition: Omit<PluginDefinition, 'setup'>; sourceHash: string;
}

/** Scoped resources. Setup only registers them; disposal revokes all SDK writes before awaiting cleanup. */
class PluginScope {
  private controller = new AbortController();
  private state: 'staged' | 'active' | 'stopped' = 'staged';
  private suspended = false;
  private work = new Set<Promise<void>>();
  private timers: { ms: number; run: (signal: AbortSignal) => void | Promise<void>; timer?: ReturnType<typeof setInterval>; busy: boolean }[] = [];
  private cleanup: (() => void | Promise<void>)[] = [];
  private stopping?: Promise<void>;
  private tools: UserTool[] = [];
  private observations: Parameters<PluginContext['observe']>[0][] = [];
  private activities: Parameters<PluginContext['activity']>[0][] = [];
  constructor(private id: string, private store: Store, private credential: CredentialReader) {}
  private active() { if (this.state !== 'active') throw new Error(`Plugin ${this.id} is not active.`); }
  private declare() { if (this.state !== 'staged') throw new Error('Register plugin contributions during setup only.'); }
  private key(key: string) {
    if (typeof key !== 'string' || !key || key.length > 200) throw new Error('A non-empty plugin storage key of at most 200 characters is required.');
    return `plugin:${this.id}:${key}`;
  }
  private log(level: string, message: string) { this.store.log('plugin_log', { plugin: this.id, level, message: String(message).slice(0, 2000) }); }
  private background(run: (signal: AbortSignal) => void | Promise<void>) {
    this.active();
    if (this.suspended) throw new Error(`Plugin ${this.id} is waiting to reload.`);
    const work = Promise.resolve().then(() => { this.controller.signal.throwIfAborted(); return run(this.controller.signal); })
      .catch(error => { if (!this.controller.signal.aborted) this.log('error', errorText(error)); }).finally(() => this.work.delete(work));
    this.work.add(work);
    return work;
  }
  context(settings: Record<string, unknown>, directory: string, dataDirectory: string): PluginContext {
    return {
      id: this.id, settings: Object.freeze(structuredClone(settings)), directory, dataDirectory, signal: this.controller.signal,
      credential: name => this.credential(name),
      tool: tool => {
        this.declare();
        if (!tool || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || !tool.description.trim() || typeof tool.execute !== 'function' || tool.parameters?.type !== 'object') throw new Error('Tools need a valid name, description, object parameters, and execute function.');
        if (tool.review && !tool.readOnly) throw new Error('Only read-only plugin tools may run during memory review.');
        // Exercise the schema engine now so malformed schemas fail before activation.
        Check(tool.parameters as TSchema, {});
        this.tools.push({ ...tool, parameters: structuredClone(tool.parameters) });
      },
      observe: provider => { this.declare(); if (typeof provider !== 'function') throw new Error('observe needs a function.'); this.observations.push(provider); },
      activity: activity => { this.declare(); if (!activity?.activity || !Array.isArray(activity.tools) || activity.tools.some(tool => typeof tool !== 'string')) throw new Error('An activity needs a description and tool names.'); this.activities.push(structuredClone(activity)); },
      every: (ms, run) => { this.declare(); if (!Number.isSafeInteger(ms) || ms < 100 || ms > 2_147_483_647 || typeof run !== 'function') throw new Error('A timer needs a function and an interval from 100 to 2147483647 ms.'); this.timers.push({ ms, run, busy: false }); },
      background: run => { void this.background(run); },
      publish: event => {
        this.active();
        if (!event || !event.key || !event.kind || typeof event.text !== 'string' || !['self', 'external'].includes(event.origin)) throw new Error('Published observations need key, kind, text, and origin.');
        this.store.receive({ key: this.key(`event:${event.key}`), kind: `plugin:${this.id}:${event.kind}`, at: Date.now(), text: event.text, payload: { origin: event.origin, plugin: this.id, data: event.data } });
      },
      storage: {
        get: <T>(key: string, fallback?: T) => { if (this.state === 'stopped') throw new Error('Plugin stopped.'); return structuredClone(this.store.setting<T | undefined>(this.key(key), fallback)); },
        set: (key, value) => { this.active(); this.store.setSetting(this.key(key), value); },
      },
      log: (level, message) => { if (this.state !== 'stopped') this.log(level, message); },
      onDispose: cleanup => { this.declare(); if (typeof cleanup !== 'function') throw new Error('onDispose needs a function.'); this.cleanup.push(cleanup); },
    };
  }
  private schedule() {
    for (const timer of this.timers) {
      timer.timer = setInterval(() => {
        if (timer.busy || this.suspended || this.state !== 'active') return;
        timer.busy = true;
        void this.background(timer.run).finally(() => { timer.busy = false; });
      }, timer.ms);
      timer.timer.unref();
    }
  }
  quiesce() {
    this.suspended = true;
    for (const timer of this.timers) clearInterval(timer.timer);
    return () => { if (this.state === 'active') { this.suspended = false; this.schedule(); } };
  }
  async idle() { while (this.work.size) await Promise.all(this.work); }
  stop() {
    return this.stopping ??= (async () => {
      this.state = 'stopped'; this.controller.abort();
      for (const timer of this.timers) clearInterval(timer.timer);
      await this.idle();
      const errors: unknown[] = [];
      for (const cleanup of this.cleanup.reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, `Plugin ${this.id} cleanup failed.`);
    })();
  }
  adapter(definition: PluginDefinition, enabled: boolean, dataDirectory: string): LifePlugin {
    return {
      id: this.id, contextVersion: definition.contextVersion ?? '1', enabled: () => enabled,
      reviewTools: this.tools.filter(tool => tool.review).map(tool => tool.name),
      activities: this.activities,
      observation: events => this.observations.flatMap(provider => {
        try { const lines = provider(structuredClone(events)); if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new Error('observe must return strings.'); return lines; }
        catch (error) { this.log('error', errorText(error)); return []; }
      }),
      tools: runtime => this.tools.map(tool => runtime.jsonTool(tool.name, tool.description, tool.parameters as TSchema, async (args, signal) => {
        this.active();
        if (!Check(tool.parameters as TSchema, args)) throw new Error(`Invalid arguments for ${tool.name}.`);
        const thought = runtime.context();
        const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
        let open = true;
        const check = () => { this.active(); if (!open || runtime.context() !== thought) throw new Error('This plugin tool call has ended.'); runtime.check(combined); };
        const write = () => { check(); if (thought.reviewing || tool.readOnly) throw new Error('This read-only tool cannot perform actions.'); };
        try {
          const result = await tool.execute(args, {
            signal: combined, reviewing: thought.reviewing ?? false,
            record: (kind, value) => { check(); return runtime.record(`plugin:${this.id}:${kind}`, value); },
            action: (kind, parameters, dispatch) => { write(); return runtime.externalAction(`plugin:${this.id}:${kind}`, parameters, () => dispatch(combined), combined); },
            snowluma: {
              query: (name, parameters) => { check(); if (!findSnowLumaAction(name).readOnly) throw new Error('Use snowluma.action for external writes.'); return runtime.query(name, parameters, combined); },
              action: (name, parameters) => { write(); return runtime.action(name, parameters, dispatch => dispatch(name, runtime.resolveMedia(parameters) as Record<string, unknown>), combined); },
            },
          });
          check(); return result;
        } finally { open = false; }
      })),
      start: () => { if (this.state !== 'staged') throw new Error('Plugin already started or stopped.'); mkdirSync(dataDirectory, { recursive: true, mode: 0o700 }); this.state = 'active'; this.schedule(); },
      stop: () => this.stop(), idle: () => this.idle(), quiesce: () => this.quiesce(),
    };
  }
}

export async function loadUserPlugin(id: string, config: Config, store: Store, credential: CredentialReader, signal: AbortSignal, describe?: (definition: LoadedPlugin['definition']) => void): Promise<LoadedPlugin> {
  if (!validPluginId(id)) throw new Error('Invalid plugin ID.');
  const directory = join(config.extensions.directory, id);
  const source = pluginSource(directory);
  const entry = ['index.mjs', 'index.js'].find(name => source.entries.some(item => item.name === name));
  if (!entry) throw new Error(`Plugin ${id} needs index.mjs or an ES-module index.js.`);
  // A unique complete snapshot refreshes relative imports too. Keep it until disposal: lazy imports may still need it.
  const snapshot = join(directory, '.qiuyue-cache', randomUUID());
  const scope = new PluginScope(id, store, credential);
  const cleanup = async () => { try { await scope.stop(); } finally { rmSync(snapshot, { recursive: true, force: true }); } };
  try {
    for (const { name, data } of source.entries) { const path = join(snapshot, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data); }
    if (!existsSync(join(snapshot, 'package.json'))) writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}\n');
    const module = await waitFor(import(pathToFileURL(join(snapshot, entry)).href), signal);
    const definition = module.default as PluginDefinition;
    if (!definition || definition.id !== id || definition.apiVersion !== 1 || typeof definition.setup !== 'function') throw new Error(`Plugin ${id} must export { id: '${id}', apiVersion: 1, setup(ctx) }.`);
    for (const key of ['name', 'version', 'description', 'contextVersion'] as const) if (definition[key] !== undefined && typeof definition[key] !== 'string') throw new Error(`Plugin ${id}.${key} must be a string.`);
    if (definition.defaults !== undefined && (!definition.defaults || typeof definition.defaults !== 'object' || Array.isArray(definition.defaults))) throw new Error(`Plugin ${id}.defaults must be an object.`);
    const metadata = structuredClone({ id, apiVersion: 1 as const, name: definition.name, version: definition.version, description: definition.description, contextVersion: definition.contextVersion, defaults: definition.defaults, configSchema: definition.configSchema });
    // Keep the form available even if settings fail validation; only the daemon imports this code.
    describe?.(metadata);
    const settings = { ...definition.defaults, ...config.extensions.settings[id] };
    if (definition.configSchema && !Check(definition.configSchema as TSchema, settings)) throw new Error(`Invalid settings for plugin ${id}.`);
    const dataDirectory = join(config.extensions.dataDirectory, id);
    await waitFor(Promise.resolve(definition.setup(scope.context(settings, directory, dataDirectory))), signal);
    signal.throwIfAborted();
    const plugin = scope.adapter(definition, config.plugins[id] !== false, dataDirectory);
    plugin.stop = cleanup;
    return { plugin, definition: metadata, sourceHash: source.hash };
  } catch (error) { try { await waitFor(cleanup(), AbortSignal.timeout(5000)); } catch { /* preserve the loading error */ } throw error; }
}
