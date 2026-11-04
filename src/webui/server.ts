import { inspectPluginManifests, pluginCredentialReferences } from '../plugin-manifest.js';
import { CredentialConflictError } from '../credentials.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, webuiSettings, type Config } from '../config.js';
import { callControl, requestControl } from '../control.js';
import { errorText } from '../domain.js';
import { configuredPluginIds, pluginIds } from '../plugins/index.js';
import { discoverPlugins } from '../plugin-loader.js';
import type { PluginManager } from '../plugin-manager.js';
import { systemInstructions } from '../prompts.js';
import { getSnowLumaCatalog } from '../adapters/snowluma/catalog.js';
import { ui } from '../ui-language.js';
import { LiveMirror, ServiceJobs, alive, busyReasons, changedSince, processStartedAt, serviceCommand, serviceState } from './daemon.js';
import { ConflictError, OperatorFiles, hash, historyKinds, type HistoryKind } from './files.js';
import { inspectConfig } from './inspect.js';
import { ProviderProfiles, catalog, remoteModels, testEmbedding, testModel, type ProviderProfile } from './providers.js';
import { LifeReader } from './reader.js';
import { loginPage } from './login.js';
import { drawingIdPattern, validateDrawingPatch, validateDrawingQuery, type DrawingQuery } from '../plugins/gallery-store.js';

const publicDir = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const modulesDir = resolve(fileURLToPath(new URL('../../node_modules/', import.meta.url)));
const vendored = new Set(['preact', 'htm']);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const cookie = 'qiuyue_webui';
// These contain presentation only. Management modules and every API still require authentication.
const loginAssets = new Set(['/app/style.css', '/app/favicon.svg', '/app/login.js', '/app/theme.js']);
const credentialFields: [string, string][] = [['model', 'apiKeyEnv'], ['web', 'searchKeyEnv'], ['embedding', 'apiKeyEnv'], ['drawing', 'apiKeyEnv'], ['webui', 'tokenEnv']];

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Handler = (request: { url: URL; body: any; params: string[] }) => unknown | Promise<unknown>;
type Paths = { database: string; socket: string; log: string };

function send(response: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8', headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...headers });
  response.end(body);
}
function readBody(request: IncomingMessage, limit = 2_000_000): Promise<any> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { fail(new HttpError(413, 'The request is too large.')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new HttpError(400, 'The request body must be JSON.')); } });
    request.on('error', fail);
  });
}
/** The last lines of a log that may be large, read from its end. */
function tail(path: string, lines: number, bytes = 256_000) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size; const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length); const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8').split('\n').slice(-lines - 1).join('\n');
}

/** The management page: reads and saves the operator's files, follows the daemon, and asks it to act through the management interface (ADR-0020). */
export class WebUi {
  readonly files: OperatorFiles;
  readonly reader: LifeReader;
  readonly mirror: LiveMirror;
  readonly jobs: ServiceJobs;
  readonly providers: ProviderProfiles;
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private inspected?: { key: string; result: ReturnType<typeof inspectConfig> };
  private page?: { html: string; csp: string };
  constructor(configPath: string, private token: string, readonly paths: Paths) {
    this.files = new OperatorFiles(configPath);
    this.reader = new LifeReader(paths.database);
    this.mirror = new LiveMirror(paths.socket);
    this.jobs = new ServiceJobs(this.mirror, this.reader);
    this.providers = new ProviderProfiles(resolve(this.files.dataDir, 'providers.json'));
    this.register();
  }
  static paths(configPath: string): Paths {
    const base = dirname(configPath);
    let raw: Record<string, any> = {};
    try { raw = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* defaults until the configuration is repaired */ }
    const database = resolve(base, raw.database ?? 'data/life.sqlite');
    return { database, socket: resolve(base, raw.socket ?? 'data/control.sock'), log: resolve(dirname(database), 'runtime.log') };
  }
  private current(): { raw: Record<string, any>; config?: Config; error?: string } {
    const raw = this.files.raw();
    try { return { raw, config: loadConfig(this.files.configPath) }; } catch (error) { return { raw, error: errorText(error) }; }
  }
  private config() {
    const { config, error } = this.current();
    if (!config) throw new HttpError(409, `The configuration does not load: ${error}`);
    return config;
  }
  private control(args: string[], yes = false) {
    const { config } = this.current();
    return config ? requestControl(config, { args, yes }) : callControl(this.paths.socket, { args, yes });
  }
  /** Whether a start with this configuration would continue the working context saved now. */
  private continuity(config: Config) {
    const saved = this.reader.workingContext();
    const credentials = this.files.credentials();
    const key = hash(JSON.stringify(config) + credentials.revision);
    if (this.inspected?.key !== key) this.inspected = { key, result: inspectConfig(config, credentials.get) };
    const result = this.inspected.result;
    const userPlugins = discoverPlugins(config.extensions.directory).some(id => !(pluginIds as readonly string[]).includes(id) && config.plugins[id] !== false);
    return { continues: userPlugins ? null : Boolean(saved?.current && result.identities.includes(saved.identity)), unknown: userPlugins, saved: saved ? { at: saved.updatedAt, current: saved.current } : null, plugins: result.plugins, tools: result.tools.length, credentials: result.credentials };
  }
  private on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler });
  }
  private register() {
    this.on('GET', '/api/overview', async () => {
      const { raw, config, error } = this.current();
      const settings = webuiSettings(raw);
      const daemon = this.reader.daemon();
      const running = daemon !== undefined && alive(daemon.pid);
      const startedAt = running ? processStartedAt(daemon.pid) : undefined;
      let status: unknown = null;
      if (running) { try { status = await callControl(this.paths.socket, { args: ['status'] }); } catch { /* the live view says why */ } }
      return {
        lang: config?.uiLanguage ?? 'en', configPath: this.files.configPath,
        config: { valid: Boolean(config), error },
        daemon: { running, pid: running ? daemon.pid : undefined, startedAt, changed: changedSince(startedAt, { config: this.files.configPath, persona: (() => { try { return this.files.personaPath(raw); } catch { return undefined; } })(), prompt: this.files.promptPath(raw), credentials: this.files.credentials().paths.file }) },
        service: settings.service ? { unit: settings.service, ...await serviceState(settings.service) } : null,
        live: { connected: this.mirror.connected, message: this.mirror.message },
        status, busy: busyReasons(this.mirror, this.reader), activity: this.reader.activity(), counts: this.reader.counts(),
        context: config ? this.continuity(config) : null, job: this.jobs.job ?? null,
      };
    });
    this.on('POST', '/api/control', ({ body }) => {
      const args = body.args;
      if (!Array.isArray(args) || !['pause', 'resume', 'life on', 'life off'].includes(args.join(' '))) throw new HttpError(400, 'Only pause, resume, and life on|off are available here.');
      return this.control(args);
    });
    this.on('POST', '/api/service', async ({ body }) => {
      const unit = webuiSettings(this.files.raw()).service;
      if (!unit) throw new HttpError(409, 'webui.service is not set, so the page cannot start or stop the daemon.');
      if (body.action === 'start') { await serviceCommand(unit, 'start'); return { started: true }; }
      if (body.action !== 'restart' && body.action !== 'stop') throw new HttpError(400, 'Unknown service action.');
      return this.jobs.start(unit, body.action, body.whenIdle !== false);
    });
    this.on('DELETE', '/api/service/job', () => this.jobs.cancel() ?? null);
    this.on('GET', '/api/logs', ({ url }) => ({ text: tail(this.paths.log, Math.min(Number(url.searchParams.get('lines')) || 200, 2000)), trace: this.reader.trace(Math.min(Number(url.searchParams.get('trace')) || 50, 500)) }));

    this.on('GET', '/api/config', () => {
      const text = this.files.configText();
      let raw: unknown = null;
      try { raw = this.files.raw(); } catch { /* the raw editor shows the text to repair */ }
      const { config, error } = raw ? this.current() : { config: undefined, error: 'The configuration is not valid JSON.' };
      const { persona: _persona, systemPrompt: _prompt, ...effective } = config ?? ({} as Partial<Config>);
      return { text, hash: hash(text), raw, effective: config ? effective : null, error: error ?? null };
    });
    this.on('POST', '/api/config/check', ({ body }) => {
      try { const config = this.files.check(body.raw); return { valid: true, context: this.continuity(config) }; }
      catch (error) { return { valid: false, error: errorText(error) }; }
    });
    this.on('PUT', '/api/config', ({ body }) => {
      const config = this.files.saveConfig(body.raw, body.hash);
      return { hash: hash(this.files.configText()), context: this.continuity(config) };
    });
    this.on('GET', '/api/history/:kind', ({ params }) => this.files.history(this.kind(params[0]!)));
    this.on('GET', '/api/history/:kind/:id', ({ params }) => ({ text: this.files.version(this.kind(params[0]!), params[1]!) }));

    this.on('GET', '/api/persona', () => this.files.persona());
    this.on('PUT', '/api/persona', ({ body }) => { this.files.savePersona(String(body.text ?? ''), body.hash); return this.after(); });
    this.on('GET', '/api/prompt', () => this.files.prompt());
    this.on('PUT', '/api/prompt', ({ body }) => { this.files.savePrompt(String(body.text ?? ''), body.hash); return this.after(); });
    this.on('DELETE', '/api/prompt', () => { this.files.resetPrompt(); return this.after(); });
    this.on('POST', '/api/prompt/preview', ({ body }) => {
      const { raw, config } = this.current();
      const persona = typeof body.persona === 'string' ? body.persona : config?.persona ?? this.files.persona().text;
      const template = typeof body.template === 'string' ? body.template : config?.systemPrompt;
      const text = systemInstructions({ persona, life: { allowFiction: Boolean(config?.life.allowFiction ?? raw.life?.allowFiction) } as Config['life'], systemPrompt: template });
      return { text, chars: text.length };
    });

    this.on('GET', '/api/plugins', async () => {
      const { raw, config, error } = this.current();
      let running: ReturnType<PluginManager['status']> | null = null, runtimeError: string | undefined;
      try { running = await callControl(this.paths.socket, { args: ['plugins', 'list'] }) as ReturnType<PluginManager['status']>; }
      catch (error) { runtimeError = errorText(error); }
      const discovered = config ? discoverPlugins(config.extensions.directory) : [];
      const manifests = config ? inspectPluginManifests(config.extensions.directory) : { metadata: {}, errors: {} };
      const builtins = config ? configuredPluginIds(config) : pluginIds;
      return { ids: [...new Set([...builtins, ...discovered, ...running?.plugins.map(plugin => plugin.id) ?? []])], ...manifests, builtinIds: builtins, switches: raw.plugins ?? {}, inspected: config ? this.continuity(config) : null, error: error ?? null, running, runtimeError, directory: config?.extensions.directory };
    });
    this.on('POST', '/api/plugins/reload', ({ body }) => {
      const id = body.id ?? 'all';
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new HttpError(400, 'Invalid plugin ID.');
      return callControl(this.paths.socket, { args: ['plugins', 'reload', id] });
    });
    this.on('GET', '/api/snowluma', () => { const catalog = getSnowLumaCatalog(); return { source: catalog.source, actions: catalog.actions.map(action => ({ name: action.name, category: action.category, summary: action.summary, readOnly: action.readOnly })) }; });

    this.on('GET', '/api/gallery', ({ url }) => {
      const query: DrawingQuery = { limit: 24 };
      for (const key of ['query', 'from', 'to', 'person', 'conversation'] as const) if (url.searchParams.has(key)) query[key] = url.searchParams.get(key)!;
      for (const key of ['favorite', 'archived', 'includeArchived', 'includeDeleted', 'needsDescription'] as const) if (url.searchParams.has(key)) {
        const value = url.searchParams.get(key); if (value !== 'true' && value !== 'false') throw new HttpError(400, `Invalid ${key}.`); query[key] = value === 'true';
      }
      for (const key of ['limit', 'offset'] as const) if (url.searchParams.has(key)) query[key] = Number(url.searchParams.get(key));
      if (url.searchParams.has('tag')) query.tags = url.searchParams.getAll('tag');
      validateDrawingQuery(query);
      return this.reader.drawings(this.drawingDirectory(), query);
    });
    this.on('GET', '/api/gallery/:id', ({ params }) => {
      const item = this.reader.drawing(this.drawingDirectory(), decodeURIComponent(params[0]!));
      if (!item) throw new HttpError(404, 'Drawing not found.'); return item;
    });
    this.on('PUT', '/api/gallery/:id', ({ params, body }) => {
      validateDrawingPatch(body.changes);
      return this.manageDrawing('update', decodeURIComponent(params[0]!), body);
    });
    this.on('DELETE', '/api/gallery/:id', ({ params, body }) => this.manageDrawing('delete', decodeURIComponent(params[0]!), body));

    this.on('GET', '/api/development', () => this.reader.development());
    this.on('GET', '/api/memory/:id', ({ params }) => this.reader.memory(decodeURIComponent(params[0]!)) ?? null);
    this.on('POST', '/api/memory/:id/correct', ({ params, body }) => {
      if (typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, 'Correction content is required.');
      return this.control(['memory', 'correct', decodeURIComponent(params[0]!), body.content]);
    });
    this.on('POST', '/api/memory/:id/forget', ({ params, body }) => this.control(['memory', 'forget', decodeURIComponent(params[0]!)], body.yes === true));

    this.on('GET', '/api/providers', () => ({ providers: this.providers.list(this.files.raw()) }));
    this.on('PUT', '/api/providers', ({ body }) => ({ providers: this.providers.save(body.providers) }));
    this.on('POST', '/api/providers/models', ({ body }) => { return remoteModels(body.provider as ProviderProfile, fetch, this.files.credentials().get).then(models => ({ models })); });
    this.on('GET', '/api/catalog', ({ url }) => catalog(url.searchParams.get('provider') ?? undefined));
    this.on('POST', '/api/test/model', ({ body }) => { return testModel(body.model, 60_000, this.files.credentials().get); });
    this.on('POST', '/api/test/embedding', ({ body }) => {
      return testEmbedding({ enabled: true, apiKeyEnv: 'MODEL_API_KEY', threshold: 0.65, searchThreshold: 0.55, limit: 3, stickerThreshold: 0.65, stickerLimit: 3, timeoutMs: 15_000, selfNames: [], ...body.embedding }, this.files.credentials().get);
    });

    this.on('GET', '/api/secrets', () => this.secrets());
    this.on('PUT', '/api/secrets', ({ body }) => {
      if (typeof body.name !== 'string' || (body.value !== null && typeof body.value !== 'string')) throw new HttpError(400, 'A name and a value, or null to remove it, are required.');
      if (typeof body.revision !== 'string') throw new HttpError(400, 'Reload the credential list before saving.');
      this.files.credentials().set(body.name, body.value === null || body.value === '' ? null : body.value, body.revision);
      this.inspected = undefined;
      return this.secrets();
    });
  }
  private kind(value: string): HistoryKind {
    if (!(historyKinds as string[]).includes(value)) throw new HttpError(404, 'Unknown history.');
    return value as HistoryKind;
  }
  private drawingDirectory() {
    let dir = 'data/drawings'; try { dir = this.files.raw().drawing?.dir ?? dir; } catch { /* saved runtime directory remains readable */ }
    return resolve(dirname(this.files.configPath), dir);
  }
  private async manageDrawing(command: string, id: string, body: any) {
    if (!drawingIdPattern.test(id) || !Number.isSafeInteger(body.revision)) throw new HttpError(400, 'A drawing ID and revision are required.');
    try { return await callControl(this.paths.socket, { args: ['plugins', 'manage', 'gallery', command, JSON.stringify({ id, revision: body.revision, changes: body.changes })] }); }
    catch (error) {
      if (/drawing changed/i.test(errorText(error))) throw new HttpError(409, errorText(error));
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(409, 'Start the daemon with the gallery plugin to organize works. Browsing remains available.');
      throw error;
    }
  }
  /** What a saved persona or prompt means for the next start. */
  private after() {
    const { config, error } = this.current();
    return { context: config ? this.continuity(config) : null, error: error ?? null };
  }
  /** All managed values are secrets; source metadata never includes an unmasked value. */
  private secrets() {
    let raw: Record<string, any> = {};
    let config: Config | undefined;
    try { ({ raw, config } = this.current()); } catch { /* still allow credentials while repairing config */ }
    const usedBy = new Map<string, string[]>();
    const use = (name: unknown, by: string) => { if (typeof name === 'string' && name) usedBy.set(name, [...usedBy.get(name) ?? [], by]); };
    for (const adapter of config?.adapters ?? []) use(adapter.tokenEnv, `adapter:${adapter.id}`);
    for (const [section, field] of credentialFields) use((config as any)?.[section]?.[field] ?? raw[section]?.[field], section);
    for (const { name, plugin } of pluginCredentialReferences(config?.extensions)) use(name, plugin);
    try { for (const profile of this.providers.list(raw)) use(profile.apiKeyEnv, `provider:${profile.name}`); } catch { /* unreadable providers add no names */ }
    const credentials = this.files.credentials();
    return { file: credentials.paths.file, revision: credentials.revision, entries: credentials.list([...usedBy.keys()]).map(item => ({ ...item, usedBy: usedBy.get(item.name) ?? [] })) };
  }
  private authorized(request: IncomingMessage) {
    const expected = Buffer.from(this.token);
    const header = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    const fromCookie = request.headers.cookie?.split(';').map(part => part.trim().split('=')).find(([name]) => name === cookie)?.[1];
    return [header, fromCookie ? decodeURIComponent(fromCookie) : undefined].some(value => {
      if (!value) return false;
      const given = Buffer.from(value);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }
  /** Only names that resolve here, so a page elsewhere cannot reach this one by rebinding its own name to this address. */
  private allowedHost(request: IncomingMessage, host: string) {
    if (host === '0.0.0.0' || host === '::') return true;
    const name = (request.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', host].includes(name);
  }
  async handle(request: IncomingMessage, response: ServerResponse, host: string) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!this.allowedHost(request, host)) return send(response, 421, 'Unknown host.', 'text/plain; charset=utf-8');
    if (url.pathname === '/login') return this.login(request, response);
    if (request.method === 'GET' && loginAssets.has(url.pathname)) return this.asset(url.pathname, response);
    if (!this.authorized(request)) {
      if (url.pathname.startsWith('/api/')) return send(response, 401, JSON.stringify({ error: 'Sign in with the access token first.' }));
      return this.signInPage(response, false);
    }
    if (url.pathname.startsWith('/api/')) return this.api(request, response, url);
    if (request.method !== 'GET') return send(response, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
    return this.asset(url.pathname, response);
  }
  private async login(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'GET' && request.method !== 'POST') return send(response, 405, 'Method not allowed.', 'text/plain; charset=utf-8');
    if (request.method === 'GET') return this.signInPage(response, false);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) return send(response, 403, 'Cross-site requests are refused.', 'text/plain; charset=utf-8');
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') return send(response, 415, 'Submit the login form.', 'text/plain; charset=utf-8');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 8192) { send(response, 413, 'The token is too long.', 'text/plain; charset=utf-8'); return; }
      chunks.push(chunk);
    }
    const value = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('token') ?? '';
    const given = Buffer.from(value);
    const expected = Buffer.from(this.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return this.signInPage(response, true);
    send(response, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `${cookie}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  private signInPage(response: ServerResponse, failed: boolean) {
    let tokenEnv = 'WEBUI_TOKEN';
    try { tokenEnv = webuiSettings(this.files.raw()).tokenEnv; } catch { /* The page must open even with broken configuration. */ }
    return send(response, 401, loginPage(failed, tokenEnv), types['.html'], {
      // Browsers send Origin: null for a form POST under no-referrer. Keep same-origin login verifiable.
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
  }
  private async api(request: IncomingMessage, response: ServerResponse, url: URL) {
    try {
      const method = request.method ?? 'GET';
      if (method !== 'GET') {
        // A cross-site form cannot send JSON, and a cross-site script cannot pass the origin check.
        if (!request.headers['content-type']?.includes('application/json')) throw new HttpError(415, 'Requests must send JSON.');
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new HttpError(403, 'Cross-site requests are refused.');
      }
      if (url.pathname === '/api/live' && method === 'GET') return this.live(request, response);
      const drawingImage = /^\/api\/gallery\/([^/]+)\/image$/.exec(url.pathname);
      if (drawingImage && method === 'GET') {
        const id = decodeURIComponent(drawingImage[1]!);
        if (!drawingIdPattern.test(id)) throw new HttpError(404, 'Drawing not found.');
        const picture = this.reader.drawingImage(this.drawingDirectory(), id, url.searchParams.get('thumbnail') === 'true');
        if (!picture) throw new HttpError(404, 'The image is missing or deleted.');
        const extension = picture.mimeType === 'image/jpeg' ? 'jpg' : picture.mimeType === 'image/webp' ? 'webp' : 'png';
        return send(response, 200, picture.data, picture.mimeType, url.searchParams.get('download') === 'true' ? { 'Content-Disposition': `attachment; filename="${id.slice(8)}.${extension}"` } : {});
      }
      for (const route of this.routes) {
        const match = route.method === method && route.pattern.exec(url.pathname);
        if (!match) continue;
        const body = method === 'GET' ? {} : await readBody(request);
        const result = await route.handler({ url, body, params: match.slice(1) });
        return send(response, 200, JSON.stringify(result ?? null));
      }
      throw new HttpError(404, 'Unknown API.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ConflictError || error instanceof CredentialConflictError ? 409 : 400;
      send(response, status, JSON.stringify({ error: errorText(error) }));
    }
  }
  /** Server-sent events from the shared live subscription; a viewer too slow to keep up is let go. */
  private live(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const unsubscribe = this.mirror.subscribe(packet => {
      if (response.writableLength > 2_000_000) { response.destroy(); return; }
      response.write(`data: ${JSON.stringify(packet)}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25_000);
    request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  }
  private asset(pathname: string, response: ServerResponse) {
    if (pathname === '/' || pathname === '/index.html') {
      const page = this.page ??= this.indexPage();
      return send(response, 200, page.html, types['.html'], { 'Content-Security-Policy': page.csp });
    }
    let root: string; let relative: string;
    if (pathname.startsWith('/app/')) { root = publicDir; relative = pathname.slice(5); }
    else if (pathname.startsWith('/vendor/')) {
      const [name, ...rest] = pathname.slice(8).split('/');
      if (!name || !vendored.has(name)) return send(response, 404, 'Not found.', 'text/plain; charset=utf-8');
      root = resolve(modulesDir, name); relative = rest.join('/');
    } else return send(response, 404, 'Not found.', 'text/plain; charset=utf-8');
    const path = resolve(root, decodeURIComponent(relative));
    const type = types[extname(path)];
    if (!path.startsWith(root + sep) || !type || !existsSync(path) || !statSync(path).isFile()) return send(response, 404, 'Not found.', 'text/plain; charset=utf-8');
    send(response, 200, readFileSync(path), type, { 'Cache-Control': 'no-cache' });
  }
  /** The page allows its own scripts and the import map inlined in it, by the map's hash. */
  private indexPage() {
    const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const digest = createHash('sha256').update(map).digest('base64');
    return { html, csp: `default-src 'self'; script-src 'self' 'sha256-${digest}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` };
  }
  listen(host: string, port: number): Promise<Server> {
    const server = createServer((request, response) => { void this.handle(request, response, host).catch(error => { if (!response.headersSent) send(response, 500, JSON.stringify({ error: errorText(error) })); else response.destroy(); }); });
    return new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, () => done(server)); });
  }
  close() { this.mirror.close(); this.jobs.close(); }
}

export async function runWebUi(configPath: string) {
  const files = new OperatorFiles(configPath);
  let raw: Record<string, any> = {};
  try { raw = files.raw(); } catch (error) { console.error(ui(`The configuration is not readable (${errorText(error)}); using default page settings.`, `配置无法读取（${errorText(error)}），网页使用默认设置。`)); }
  const settings = webuiSettings(raw);
  const configured = files.credentials().get(settings.tokenEnv);
  const token = configured || randomBytes(24).toString('base64url');
  const app = new WebUi(configPath, token, WebUi.paths(configPath));
  const server = await app.listen(settings.host, settings.port);
  const address = settings.host.includes(':') ? `[${settings.host}]` : settings.host;
  console.log(ui(`Management page: http://${address}:${settings.port}/`, `管理网页：http://${address}:${settings.port}/`));
  console.log(configured
    ? ui(`Sign in with the value of ${settings.tokenEnv}.`, `使用 ${settings.tokenEnv} 的值登录。`)
    : ui(`${settings.tokenEnv} is not set; this start's access token: ${token}`, `未设置 ${settings.tokenEnv}；本次启动的访问令牌：${token}`));
  const shutdown = () => { app.close(); server.closeAllConnections(); server.close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
