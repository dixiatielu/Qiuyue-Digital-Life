import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginManifest, JsonSchema } from './plugin-sdk.js';

export const validPluginId = (id: string) => id !== 'all' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
export function discoverPlugins(directory: string): string[] {
  try { return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && validPluginId(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function validateManifest(value: PluginManifest, id: string): PluginManifest {
  if (!value || value.id !== id || value.apiVersion !== 2) throw new Error(`Plugin ${id} needs a matching id and apiVersion: 2.`);
  for (const key of ['name', 'version', 'description', 'contextVersion'] as const) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Plugin ${id}.${key} must be a string.`);
  if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== 'boolean') throw new Error(`Plugin ${id}.defaultEnabled must be a boolean.`);
  if (value.defaults !== undefined && (!value.defaults || typeof value.defaults !== 'object' || Array.isArray(value.defaults))) throw new Error(`Plugin ${id}.defaults must be an object.`);
  if (value.configSchema !== undefined && value.configSchema?.type !== 'object') throw new Error(`Plugin ${id}.configSchema must be an object schema.`);
  return structuredClone({ id, apiVersion: 2, name: value.name, version: value.version, description: value.description, contextVersion: value.contextVersion, defaultEnabled: value.defaultEnabled, defaults: value.defaults, configSchema: value.configSchema });
}
export function readPluginManifest(directory: string, id: string): PluginManifest | undefined {
  if (!validPluginId(id)) throw new Error('Invalid plugin ID.');
  let text: string;
  try { text = readFileSync(join(directory, id, 'plugin.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  return validateManifest(JSON.parse(text), id);
}
/** One invalid manifest must not hide other plugins or prevent credential management. */
export function inspectPluginManifests(directory: string) {
  const metadata: Record<string, PluginManifest> = {}, errors: Record<string, string> = {};
  for (const id of discoverPlugins(directory)) {
    try { const manifest = readPluginManifest(directory, id); if (manifest) metadata[id] = manifest; }
    catch (error) { errors[id] = error instanceof Error ? error.message : String(error); }
  }
  return { metadata, errors };
}
/** String schema fields annotated credential:true contain credential names, never their values. */
export function pluginCredentialReferences(extensions?: { directory: string; settings: Record<string, Record<string, unknown>> }) {
  if (!extensions) return [];
  const { metadata } = inspectPluginManifests(extensions.directory);
  return Object.values(metadata).flatMap(manifest => {
    const settings = { ...manifest.defaults, ...extensions.settings[manifest.id] };
    const properties = manifest.configSchema?.properties as Record<string, JsonSchema> | undefined;
    return Object.entries(properties ?? {}).flatMap(([key, field]) => {
      const name = settings[key];
      return field?.type === 'string' && field.credential === true && typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? [{ name, plugin: manifest.id }] : [];
    });
  });
}
