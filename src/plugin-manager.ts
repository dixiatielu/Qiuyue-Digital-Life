import type { Config } from './config.js';
import type { CredentialReader } from './credentials.js';
import { errorText } from './domain.js';
import type { SemanticSource } from './embedding.js';
import { discoverPlugins, loadUserPlugin, pluginSource, validPluginId } from './plugin-loader.js';
import { waitFor } from './async.js';
import type { PluginDefinition } from './plugin-sdk.js';
import { PluginHost, type LifePlugin } from './plugins.js';
import { createBuiltinPlugin, pluginIds, type BuiltinPluginId } from './plugins/index.js';
import type { LifeRuntime } from './runtime.js';
import type { SocialAdapter } from './snowluma.js';
import { digest, type Store } from './store.js';
import { join } from 'node:path';

type Metadata = Omit<PluginDefinition, 'setup'>;
interface Installed { plugin: LifePlugin; source: 'builtin' | 'user'; loadedAt: number; fingerprint: string; sourceHash?: string; metadata?: Metadata }
export interface PluginReloadJob {
  id: string; target: string; state: 'preparing' | 'waiting' | 'applying' | 'done' | 'failed'; startedAt: number; finishedAt?: number;
  changed?: string[]; contextReset?: boolean; error?: string; cleanupErrors?: string[];
}
const builtin = (id: string): id is BuiltinPluginId => (pluginIds as readonly string[]).includes(id);
const busy = (job?: PluginReloadJob) => job && !['done', 'failed'].includes(job.state);
function fingerprint(id: string, config: Config): string {
  const enabled = config.plugins[id] ?? true;
  if (!builtin(id)) return digest({ enabled, settings: config.extensions.settings[id] ?? {} });
  switch (id) {
    case 'drawing': return digest({ enabled, drawing: config.drawing });
    case 'gallery': return digest({ enabled, dir: config.drawing.dir, drawing: config.drawing.enabled, generator: config.plugins.drawing, embedding: config.embedding });
    case 'web-reader': case 'web-search': return digest({ enabled, web: config.web });
    case 'qq-stickers': return digest({ enabled, native: config.plugins['snowluma-tools'] ?? true, permissions: config.snowluma.tools, embedding: config.embedding });
    default: return digest({ enabled, permissions: config.snowluma.tools });
  }
}
function core(config: Config) {
  const { plugins: _plugins, web: _web, drawing: _drawing, extensions, snowluma, ...rest } = config;
  const { tools: _tools, ...connection } = snowluma;
  return { ...rest, snowluma: connection, drawing: { dir: config.drawing.dir }, extensions: { directory: extensions.directory, dataDirectory: extensions.dataDirectory } };
}
/** Reload is a daemon operation. The web page reads metadata and never imports user code. */
export class PluginManager {
  private installed = new Map<string, Installed>();
  private errors = new Map<string, string>();
  private definitions = new Map<string, Metadata>();
  private runtime?: LifeRuntime;
  private refresh?: () => boolean;
  private operation?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private ready = false;
  job?: PluginReloadJob;
  constructor(
    private config: Config, readonly host: PluginHost, private store: Store, private social: SocialAdapter,
    private readConfig: () => Config, private credential: CredentialReader, private semantics?: SemanticSource,
    private readCredentials: () => CredentialReader = () => credential,
  ) {
    for (const plugin of host.installed()) this.installed.set(plugin.id, { plugin, source: 'builtin', loadedAt: Date.now(), fingerprint: fingerprint(plugin.id, config) });
  }
  connect(runtime: LifeRuntime, refresh: () => boolean) { this.runtime = runtime; this.refresh = refresh; }
  private disabled(id: string, config: Config): Installed {
    const previous = this.installed.get(id);
    return { ...previous, plugin: { id, enabled: () => false, tools: () => [] }, source: 'user', loadedAt: Date.now(), fingerprint: fingerprint(id, config) };
  }
  async start() {
    for (const id of discoverPlugins(this.config.extensions.directory)) {
      if (builtin(id)) { this.errors.set(id, 'A user plugin cannot replace a built-in plugin with the same ID.'); continue; }
      if (this.config.plugins[id] === false) {
        const disabled = this.disabled(id, this.config);
        this.host.install([...this.host.installed(), disabled.plugin]); this.installed.set(id, disabled); continue;
      }
      let loaded: Awaited<ReturnType<typeof loadUserPlugin>> | undefined;
      try {
        loaded = await loadUserPlugin(id, this.config, this.store, this.credential, AbortSignal.timeout(this.config.extensions.reloadTimeoutMs), definition => this.definitions.set(id, definition));
        this.host.install([...this.host.installed(), loaded.plugin]);
        this.installed.set(id, { ...loaded, source: 'user', metadata: loaded.definition, loadedAt: Date.now(), fingerprint: fingerprint(id, this.config) });
      } catch (error) { try { await waitFor(Promise.resolve(loaded?.plugin.stop?.()), AbortSignal.timeout(5000)); } catch { /* preserve the loading error */ } this.failed(id, error); }
    }
    await this.host.start((plugin, error) => { this.installed.delete(plugin.id); this.failed(plugin.id, error); });
    this.refresh?.();
    this.ready = true;
  }
  private failed(id: string, error: unknown) {
    if (id !== 'all') this.errors.set(id, errorText(error));
    this.store.log('plugin_error', { plugin: id, message: errorText(error) });
  }
  status() {
    let desired = this.config, configError: string | undefined;
    try { desired = this.readConfig(); } catch (error) { configError = errorText(error); }
    const discovered = discoverPlugins(this.config.extensions.directory);
    const ids = [...new Set([...pluginIds, ...discovered, ...this.installed.keys(), ...Object.keys(desired.plugins), ...this.errors.keys()])];
    const plugins = ids.map(id => {
      const item = this.installed.get(id);
      const definition = this.definitions.get(id) ?? item?.metadata;
      let changed = item?.fingerprint !== fingerprint(id, desired), sourceError: string | undefined;
      if (!builtin(id) && desired.plugins[id] !== false) {
        try { changed ||= pluginSource(join(this.config.extensions.directory, id)).hash !== item?.sourceHash; }
        catch (error) { sourceError = errorText(error); changed = true; }
      }
      return {
        id, source: builtin(id) ? 'builtin' : 'user', name: item?.metadata?.name ?? definition?.name ?? id, description: item?.metadata?.description ?? definition?.description ?? '', version: item?.metadata?.version ?? (builtin(id) ? 'built-in' : null),
        state: item ? (item.plugin.enabled?.() ?? true) ? 'running' : 'disabled' : this.errors.has(id) ? 'failed' : 'unloaded',
        loadedAt: item?.loadedAt ?? null, sourceHash: item?.sourceHash, pending: changed,
        error: this.errors.get(id) ?? sourceError ?? null, configSchema: definition?.configSchema, defaults: definition?.defaults,
      };
    });
    const runningCore = core(this.config), savedCore = core(desired);
    const restartRequired = Object.keys(savedCore).filter(key => digest(savedCore[key as keyof typeof savedCore]) !== digest(runningCore[key as keyof typeof runningCore]));
    return { plugins, job: this.job ?? null, ready: this.ready && !this.stopped, directory: this.config.extensions.directory, dataDirectory: this.config.extensions.dataDirectory, configError, restartRequired };
  }
  request(args: string[]) {
    if (args.length === 0 || (args.length === 1 && ['list', 'status'].includes(args[0]!))) return this.status();
    if (args[0] === 'manage' && args.length === 4) {
      if (!this.ready || this.stopped || this.operation) throw new Error('Plugin management is unavailable while starting, stopping, or reloading.');
      const input = JSON.parse(args[3]!);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Plugin command arguments must be an object.');
      return this.host.manage(args[1]!, args[2]!, input);
    }
    if (args[0] !== 'reload' || args.length > 2) throw new Error('Usage: plugins list | plugins reload [ID|all]');
    const target = args[1] ?? 'all';
    if (target !== 'all' && !validPluginId(target)) throw new Error('Invalid plugin ID.');
    if (!this.ready || this.stopped || !this.runtime || !this.refresh) throw new Error('Plugin management is not ready or is stopping.');
    if (this.operation || busy(this.job)) throw new Error('A plugin reload is already in progress.');
    const job: PluginReloadJob = { id: crypto.randomUUID(), target, state: 'preparing', startedAt: Date.now() };
    this.job = job; const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error('Plugin reload timed out; the running version was kept.')), this.config.extensions.reloadTimeoutMs);
    this.operation = this.reload(target, job, controller.signal).then(() => { job.state = 'done'; }, error => {
      job.state = 'failed'; job.error = errorText(error); this.failed(target, error);
    }).finally(() => { clearTimeout(timer); job.finishedAt = Date.now(); this.operation = undefined; });
    return { ...job };
  }
  async settled() { await this.operation; return this.job; }
  private selected(target: string, desired: Config): Config {
    const next = structuredClone(this.config);
    next.extensions.reloadTimeoutMs = desired.extensions.reloadTimeoutMs;
    if (target === 'all') {
      next.plugins = desired.plugins; next.extensions.settings = desired.extensions.settings;
      next.web = desired.web; next.drawing = { ...desired.drawing, dir: this.config.drawing.dir }; next.snowluma.tools = desired.snowluma.tools;
    } else {
      delete next.plugins[target];
      if (desired.plugins[target] !== undefined) next.plugins[target] = desired.plugins[target];
      delete next.extensions.settings[target];
      if (desired.extensions.settings[target] !== undefined) next.extensions.settings[target] = desired.extensions.settings[target]!;
      if (target === 'drawing') next.drawing = { ...desired.drawing, dir: this.config.drawing.dir };
      if (target === 'web-reader' || target === 'web-search') next.web = desired.web;
      if (target === 'snowluma-tools') next.snowluma.tools = desired.snowluma.tools;
    }
    return next;
  }
  private applyConfig(next: Config) {
    this.config.plugins = next.plugins; this.config.extensions.settings = next.extensions.settings;
    this.config.extensions.reloadTimeoutMs = next.extensions.reloadTimeoutMs;
    this.config.web = next.web; this.config.drawing = next.drawing; this.config.snowluma.tools = next.snowluma.tools;
  }
  private async reload(target: string, job: PluginReloadJob, signal: AbortSignal) {
    const next = this.selected(target, this.readConfig());
    const credential = this.readCredentials();
    const discovered = discoverPlugins(next.extensions.directory);
    if (target !== 'all' && !builtin(target) && !discovered.includes(target) && !this.installed.has(target)) throw new Error(`Plugin ${target} is not installed.`);
    const ids = new Set<string>(pluginIds.filter(id => target === 'all' || id === target || !this.installed.has(id) || this.installed.get(id)!.fingerprint !== fingerprint(id, next)));
    if (target === 'all') for (const id of [...discovered, ...this.installed.keys()]) { if (!builtin(id)) ids.add(id); }
    else if (!builtin(target)) ids.add(target);
    const candidates = new Map<string, Installed>();
    const previous = [...this.host.installed()];
    let committed = false;
    try {
      for (const id of ids) {
        signal.throwIfAborted();
        if (builtin(id)) {
          if (discovered.includes(id)) throw new Error(`User plugin ${id} conflicts with a built-in plugin.`);
          candidates.set(id, { plugin: createBuiltinPlugin(id, next, this.store, this.social, this.semantics, credential), source: 'builtin', loadedAt: Date.now(), fingerprint: fingerprint(id, next) });
        } else if (next.plugins[id] === false) {
          candidates.set(id, this.disabled(id, next));
        } else if (discovered.includes(id)) {
          const loaded = await loadUserPlugin(id, next, this.store, credential, signal, definition => this.definitions.set(id, definition));
          candidates.set(id, { ...loaded, source: 'user', metadata: loaded.definition, loadedAt: Date.now(), fingerprint: fingerprint(id, next) });
        }
      }
      const replacement = previous.flatMap(plugin => ids.has(plugin.id) ? candidates.has(plugin.id) ? [candidates.get(plugin.id)!.plugin] : [] : [plugin]);
      for (const [id, item] of candidates) if (!previous.some(plugin => plugin.id === id)) replacement.push(item.plugin);
      this.host.validate(replacement);
      job.state = 'waiting';
      await this.runtime!.maintain(signal, async () => {
        const retiring = previous.filter(plugin => ids.has(plugin.id));
        const resume: (() => void)[] = [];
        try {
          for (const plugin of retiring) if (plugin.quiesce) resume.push(plugin.quiesce());
          await waitFor(Promise.all(retiring.map(plugin => plugin.idle?.())), signal);
          signal.throwIfAborted(); job.state = 'applying';
          for (const { plugin } of candidates.values()) { if (plugin.enabled?.() ?? true) await plugin.start?.(); signal.throwIfAborted(); }
          const oldConfig = structuredClone(this.config);
          try {
            this.applyConfig(next); this.host.install(replacement);
            job.contextReset = this.refresh!();
            if (job.contextReset) this.store.bumpGeneration();
          } catch (error) { this.applyConfig(oldConfig); this.host.install(previous); this.refresh!(); throw error; }
          committed = true;
          for (const id of ids) { this.installed.delete(id); this.errors.delete(id); }
          for (const [id, item] of candidates) this.installed.set(id, item);
          this.errors.delete(target); job.changed = [...ids];
          const cleanup = await Promise.allSettled(retiring.map(plugin => waitFor(Promise.resolve(plugin.stop?.()), AbortSignal.timeout(5000))));
          job.cleanupErrors = cleanup.flatMap(result => result.status === 'rejected' ? [errorText(result.reason)] : []);
          this.store.log('plugins_reloaded', { plugins: job.changed, contextReset: job.contextReset, cleanupErrors: job.cleanupErrors });
        } finally { if (!committed) for (const restart of resume.reverse()) restart(); }
      });
    } finally {
      if (!committed) await Promise.allSettled([...candidates.values()].map(item => waitFor(Promise.resolve(item.plugin.stop?.()), AbortSignal.timeout(5000))));
    }
  }
  async stop() {
    this.stopped = true; this.controller?.abort(new Error('The program is shutting down.'));
    await this.operation;
  }
}
