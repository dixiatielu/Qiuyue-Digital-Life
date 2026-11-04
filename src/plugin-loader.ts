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
import type { Store } from './store.js';
import { waitFor } from './async.js';
import { validateManifest, validPluginId } from './plugin-manifest.js';
import { fetchImage } from './web.js';
import { nativeAdapterPlugin } from './adapters/native.js';
import { nativeToolName } from './platform.js';
import { jsonResult } from './tool-runtime.js';
export { discoverPlugins, validPluginId } from './plugin-manifest.js';

const skipped = new Set(['node_modules', '.qiuyue-cache', '.git']);
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin sources must be regular files, not symbolic links: ${relative}`);
    return entry.isDirectory() ? files(directory, relative) : entry.isFile() ? [relative] : [];
  });
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
  private adapters: LifePlugin[] = [];
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
      adapter: adapter => { this.declare(); this.adapters.push(nativeAdapterPlugin(adapter, this.store)); },
      tool: tool => {
        this.declare();
        if (!tool || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || !tool.description.trim() || typeof tool.execute !== 'function' || tool.parameters?.type !== 'object') throw new Error('Tools need a valid name, description, object parameters, and execute function.');
        if (tool.review && !tool.readOnly) throw new Error('Only read-only plugin tools may run during memory review.');
        if (tool.experienceKind !== undefined && (typeof tool.experienceKind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.experienceKind))) throw new Error('A tool experienceKind must be a local event kind.');
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
      const closed = await Promise.allSettled(this.adapters.map(adapter => adapter.stop?.()));
      await this.idle();
      const errors: unknown[] = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      for (const cleanup of this.cleanup.reverse()) { try { await cleanup(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, `Plugin ${this.id} cleanup failed.`);
    })();
  }
  adapter(definition: PluginDefinition, enabled: boolean, dataDirectory: string): LifePlugin {
    const base: LifePlugin = {
      id: this.id, contextVersion: definition.contextVersion ?? '1', enabled: () => enabled,
      reviewTools: this.tools.filter(tool => tool.review).map(tool => tool.name),
      experienceKinds: Object.fromEntries(this.tools.filter(tool => tool.experienceKind).map(tool => [tool.name, `plugin:${this.id}:${tool.experienceKind}`])),
      activities: this.activities,
      observation: events => this.observations.flatMap(provider => {
        try { const lines = provider(structuredClone(events)); if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new Error('observe must return strings.'); return lines; }
        catch (error) { this.log('error', errorText(error)); return []; }
      }),
      tools: runtime => this.tools.map(tool => runtime.tool(tool.name, tool.description, tool.parameters as TSchema, async (args, signal) => {
        this.active();
        if (!Check(tool.parameters as TSchema, args)) throw new Error(`Invalid arguments for ${tool.name}.`);
        const thought = runtime.context();
        const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
        let open = true;
        const sources = new Set<string>();
        const images: { type: 'image'; data: string; mimeType: string }[] = [];
        const labels: string[] = [];
        let imageSlots = Math.min(runtime.config.limits.maxImages, 20), imageBytes = 0;
        const check = () => { this.active(); if (!open || runtime.context() !== thought) throw new Error('This plugin tool call has ended.'); runtime.check(combined); };
        const write = () => { check(); if (thought.reviewing || tool.readOnly) throw new Error('This read-only tool cannot perform actions.'); };
        try {
          const result = await tool.execute(args, {
            signal: combined, reviewing: thought.reviewing ?? false,
            record: (kind, value) => { check(); const recorded = runtime.record(`plugin:${this.id}:${kind}`, value); sources.add(recorded.sourceId); return recorded; },
            attachImages: async (sourceId, urls) => {
              check();
              if (!sources.has(sourceId) || !Array.isArray(urls) || urls.some(url => typeof url !== 'string') || urls.length > 100) throw new Error('Images need URLs from a source recorded by this invocation.');
              const available = new Set<string>();
              const collect = (value: unknown) => { if (typeof value === 'string') available.add(value); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
              collect(this.store.event(sourceId)?.payload);
              const unique = [...new Set(urls)];
              if (unique.some(url => !available.has(url))) throw new Error('An image URL does not appear in the recorded source.');
              const selected = unique.slice(0, imageSlots); imageSlots -= selected.length;
              const delivery = { attached: [] as string[], failed: [] as { url: string; error: string }[], omitted: unique.slice(selected.length) };
              const results = await Promise.all(selected.map(async url => {
                try { return { url, image: await fetchImage(url, combined) }; }
                catch { check(); return { url }; }
              }));
              check();
              for (const { url, image } of results) {
                if (!image) { delivery.failed.push({ url, error: 'Image unavailable; its appearance has not been perceived.' }); continue; }
                if (imageBytes + image.data.length > 12_000_000) { delivery.omitted.push(url); continue; }
                imageBytes += image.data.length;
                delivery.attached.push(url); labels.push(`Image from ${sourceId}: ${url}`);
                images.push({ type: 'image', data: image.data.toString('base64'), mimeType: image.type });
              }
              return delivery;
            },
            action: (kind, parameters, dispatch) => { write(); return runtime.externalAction(`plugin:${this.id}:${kind}`, parameters, () => dispatch(combined), combined); },
            adapters: {
              query: (instance, operation, parameters) => { check(); const name = nativeToolName(instance, operation); if (!runtime.definition(name).readOnly) throw new Error('Use adapters.action for external writes.'); return runtime.query(name, parameters, combined); },
              action: (instance, operation, parameters) => { write(); const name = nativeToolName(instance, operation); return runtime.action(name, parameters, dispatch => dispatch(name, runtime.resolveMedia(parameters) as Record<string, unknown>), combined); },
            },

          });
          check();
          const response = jsonResult(result);
          for (const [index, image] of images.entries()) response.content.push({ type: 'text', text: labels[index]! }, image);
          return response;
        } finally { open = false; }
      })),
      start: () => { if (this.state !== 'staged') throw new Error('Plugin already started or stopped.'); mkdirSync(dataDirectory, { recursive: true, mode: 0o700 }); this.state = 'active'; this.schedule(); },
      stop: () => this.stop(), idle: () => this.idle(), quiesce: () => this.quiesce(),
    };
    const adapters = this.adapters;
    return {
      ...base, requiresRestart: adapters.length > 0,
      tools: runtime => [...base.tools(runtime), ...adapters.flatMap(adapter => adapter.tools(runtime))],
      reviewTools: [...base.reviewTools ?? [], ...adapters.flatMap(adapter => adapter.reviewTools ?? [])],
      images: event => adapters.flatMap(adapter => adapter.images?.(event) ?? []),
      chatActions: adapters.flatMap(adapter => adapter.chatActions ?? []),
      chatTarget: (name, args) => adapters.map(adapter => adapter.chatTarget?.(name, args)).find(Boolean),
      nativeActions: {
        accounts: adapters.flatMap(adapter => adapter.nativeActions?.accounts ?? []),
        definition: name => adapters.map(adapter => adapter.nativeActions?.definition(name)).find(Boolean),
        allowed: name => adapters.some(adapter => adapter.nativeActions?.definition(name) && adapter.nativeActions.allowed(name)),
        execute: (name, args, signal) => { const adapter = adapters.find(adapter => adapter.nativeActions?.definition(name)); if (!adapter) throw new Error('Unknown native operation.'); return adapter.nativeActions!.execute!(name, args, signal); },
      },
      start: async () => { await base.start?.(); for (const adapter of adapters) await adapter.start?.(); },
      stop: () => this.stop(),
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
    const exported = module.default as PluginDefinition;
    if (!exported || exported.id !== id || exported.apiVersion !== 2 || typeof exported.setup !== 'function') throw new Error(`Plugin ${id} must export { id: '${id}', apiVersion: 2, setup(ctx) }.`);
    // Read the sidecar from the same snapshot as the code, not a newer directory revision.
    const sidecar = source.entries.find(entry => entry.name === 'plugin.json');
    const definition = { ...exported, ...(sidecar ? validateManifest(JSON.parse(sidecar.data.toString('utf8')), id) : {}) };
    const metadata = validateManifest(definition, id);
    // Keep the form available even if settings fail validation; only the daemon imports this code.
    describe?.(metadata);
    const settings = { ...definition.defaults, ...config.extensions.settings[id] };
    if (definition.configSchema && !Check(definition.configSchema as TSchema, settings)) throw new Error(`Invalid settings for plugin ${id}.`);
    const dataDirectory = join(config.extensions.dataDirectory, id);
    await waitFor(Promise.resolve(definition.setup(scope.context(settings, directory, dataDirectory))), signal);
    signal.throwIfAborted();
    const plugin = scope.adapter(definition, config.plugins[id] ?? definition.defaultEnabled ?? true, dataDirectory);
    plugin.stop = cleanup;
    return { plugin, definition: metadata, sourceHash: source.hash };
  } catch (error) { try { await waitFor(cleanup(), AbortSignal.timeout(5000)); } catch { /* preserve the loading error */ } throw error; }
}
