#!/usr/bin/env node
import { Credentials, credentialPaths } from './credentials.js';
import { ui, loadUiLanguage } from './ui-language.js';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createTools, forReview } from './tools.js';
import { PiBrain } from './brain.js';
import { LifeRuntime } from './runtime.js';
import { handleControl, requestControl, serveControl } from './control.js';
import { errorText } from './domain.js';
import { modelReadiness } from './model.js';
import { Monitor } from './monitor.js';
import { followDisplay } from './display-client.js';
import { EmbeddingClient, SemanticRecall } from './recall.js';
import { createPlugins, pluginCredentials } from './plugins/index.js';
import type { PluginHost } from './plugins.js';
import { PluginManager, type PluginReloadJob } from './plugin-manager.js';

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string', default: 'config.json' }, yes: { type: 'boolean', default: false }, follow: { type: 'boolean', default: false } } });
  const configPath = resolve(values.config!);
  loadUiLanguage(configPath);
  const command = positionals[0] ?? 'help';
  if (command === 'help') {
    console.log(ui(`qiuyue-digital-life\n\n  npm run dev -- <command> --config config.json\n\n  run                     Start the single daemon\n  identities migrate      Migrate platform identities offline\n  validate                Check configuration, model, and credentials (without connecting to QQ)\n  models [provider]       List Pi models and image support\n  status | logs           Inspect continuing state or logs\n  plugins list            Inspect loaded plugins and pending changes\n  plugins reload [ID|all]  Reload plugins without restarting the daemon\n  tui                     Connect to the live terminal (exiting does not stop the daemon)\n  webui                   Serve the management web page (a process apart from the daemon)\n  logs --follow           Subscribe to live NDJSON display events\n  pause | resume          Pause or resume the digital life\n  life on | life off      Enable or disable autonomous life\n  memory search <query>   Search memories and personal notes\n  memory show <ID>        Inspect a memory and its sources\n  memory correct <ID> <content>  Correct a memory while retaining versions\n  memory forget <ID>      Preview deletion; add --yes to proceed\n\nRestart after changing core configuration. The dailyCalls budget follows the Asia/Shanghai calendar day.`, `qiuyue-digital-life\n\n  npm run dev -- <命令> --config config.json\n\n  run                     启动唯一常驻主体\n  identities migrate      停机迁移平台标识\n  validate                检查配置、模型和凭据是否就绪（不连接QQ）\n  models [provider]       列出Pi模型及图片能力\n  status | logs           查看持续状态或运行记录\n  plugins list            查看插件运行状态与待应用修改\n  plugins reload [ID|all]  重载插件，无需重启常驻进程\n  tui                     连接实时终端（退出不停止主体）\n  webui                   启动管理网页（独立于常驻进程）\n  logs --follow           订阅实时 NDJSON 展示事件\n  pause | resume          整体暂停/恢复\n  life on | life off      开关自主生活\n  memory search <查询>    检索记忆及个人笔记\n  memory show <ID>        查看记忆及来源\n  memory correct <ID> <内容>  修正并保留版本\n  memory forget <ID>      预览删除范围；追加 --yes 执行\n\n核心配置修改后重启。dailyCalls 预算按 Asia/Shanghai 的自然日计算。`));
    return;
  }
  if (command === 'models') {
    console.log(JSON.stringify(builtinModels().getModels(positionals[1]).map(model => ({ provider: model.provider, id: model.id, input: model.input })), null, 2)); return;
  }
  // Before loading the configuration, so the page still opens to repair one that no longer loads.
  if (command === 'webui') { const { runWebUi } = await import('./webui/server.js'); await runWebUi(configPath); return; }
  if (command === 'identities' && positionals[1] === 'migrate') { const { migrateIdentities } = await import('./identity-migration.js'); console.log(JSON.stringify(await migrateIdentities(configPath))); return; }
  const config = loadConfig(configPath);
  if (command === 'tui') { const { runTui } = await import('./tui.js'); runTui(config.socket); return; }
  if (values.follow && command !== 'logs') throw new Error('--follow is only available for logs.');
  if (command === 'logs' && values.follow) {
    let lastConnection = '';
    const stop = followDisplay(config.socket, packet => {
      if (process.stdout.writableLength > 2_000_000) { process.stderr.write(ui('Log output is too slow; the display subscription was disconnected.\n', '日志输出过慢，已断开展示订阅。\n')); finish(); process.exitCode = 1; return; }
      process.stdout.write(JSON.stringify(packet) + '\n');
    }, (connected, message) => { if (message !== lastConnection) { lastConnection = message; process.stderr.write(message + '\n'); } });
    const finish = () => { stop(); process.off('SIGINT', finish); process.off('SIGTERM', finish); process.stdout.off('error', onOutputError); };
    const onOutputError = (error: NodeJS.ErrnoException) => { finish(); if (error.code !== 'EPIPE') { console.error(errorText(error)); process.exitCode = 1; } };
    process.once('SIGINT', finish); process.once('SIGTERM', finish); process.stdout.on('error', onOutputError);
    return;
  }
  if (command !== 'run' && command !== 'validate') {
    let result = await requestControl(config, { args: positionals, yes: values.yes });
    if (command === 'plugins' && positionals[1] === 'reload') {
      let job = result as PluginReloadJob;
      while (job.state !== 'done' && job.state !== 'failed') {
        await delay(250);
        const status = await requestControl(config, { args: ['plugins', 'status'] }) as { job: PluginReloadJob | null };
        if (status.job?.id !== job.id) throw new Error(`Reload ${job.id} is no longer available; inspect plugins status for the latest result.`);
        job = status.job;
      }
      result = job;
      if (job.state === 'failed') process.exitCode = 1;
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const credentials = new Credentials(credentialPaths(configPath, config.credentialsFile));
  if (command === 'validate') {
    const { problems, uses } = modelReadiness(config, credentials.get); const warnings = [];
    if (config.embedding.enabled && !credentials.get(config.embedding.apiKeyEnv)) problems.push(ui(`Missing ${config.embedding.apiKeyEnv} for embedding.`, `缺少 embedding 所需的 ${config.embedding.apiKeyEnv}。`));
    const plugins = pluginCredentials(config, credentials.get); problems.push(...plugins.problems); warnings.push(...plugins.warnings);
    if (!config.embedding.enabled) warnings.push(ui('embedding is disabled; thoughts will not recall memories on their own, though recall still works when asked for.', 'embedding 未启用；思考时不会自动想起记忆，主动回忆仍可用。'));
    console.log(JSON.stringify({ valid: problems.length === 0, problems, warnings, models: uses, runtime: process.version, snowlumaConfigured: config.adapters.some(account => account.driver === 'snowluma') }, null, 2));
    if (problems.length) process.exitCode = 1; return;
  }
  const readiness = modelReadiness(config, credentials.get);
  if (readiness.problems.length) throw new Error(readiness.problems.join('\n'));
  const store = new Store(config.database, config.life.enabled);
  const release = store.acquireDaemon();
  const monitor = new Monitor(config, store, 2000, credentials.get);
  let runtime: LifeRuntime | undefined;
  let brain: PiBrain;
  let reviewer: PiBrain;
  let plugins: PluginHost;
  const recall = config.embedding.enabled ? new SemanticRecall(config, store, new EmbeddingClient(config.embedding, fetch, credentials.get), () => plugins.knownEmojiNames()) : undefined;
  plugins = createPlugins(config, store, recall, credentials.get);
  const pluginManager = new PluginManager(config, plugins, store, () => loadConfig(configPath), credentials.get, recall, () => new Credentials(credentials.paths).get);
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  const stopServices = async () => {
    await Promise.all([pluginManager.stop(), runtime?.stop()]);
    const results = await Promise.allSettled([runtime?.stop(), recall?.stop(), plugins.stop()]);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, errors.map(errorText).join('; '));
  };
  try {
    brain = new PiBrain(config, store, createTools(config, store, () => brain.thought, recall, plugins), undefined, monitor, recall, credentials.get);
    // Review runs beside the thoughts with tools of its own; the live view follows the thoughts, and review shows there through its trace (ADR-0012).
    reviewer = new PiBrain(config, store, forReview(createTools(config, store, () => reviewer.thought, recall, plugins)), undefined, undefined, recall, credentials.get, 'review');
    runtime = new LifeRuntime(config, store, brain, reviewer);
    pluginManager.connect(runtime, () => { const changed = brain.refreshTools(); reviewer.refreshTools(); return changed; });
    server = await serveControl(config.socket, request => handleControl(store, request, runtime, pluginManager), monitor);
    // Recovery must precede live collection; perception keeps running even if paused.
    store.recover(); await pluginManager.start();
    // Messages are embedded as they arrive, so recall starts listening before perception does.
    recall?.start();
    runtime.start();
    console.log(ui(`Digital life started; management socket: ${config.socket}`, `数字生命已启动；管理入口 ${config.socket}`));
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return; stopping = true;
      try { await stopServices(); }
      finally {
        monitor.close(); server!.closeClients();
        await new Promise<void>(resolve => server!.close(() => resolve()));
        release(); store.close();
      }
    };
    const onShutdown = () => { void shutdown().catch(error => { console.error(errorText(error)); process.exitCode = 1; }); };
    process.once('SIGINT', onShutdown); process.once('SIGTERM', onShutdown);
  } catch (error) {
    try { await stopServices(); } catch (cleanupError) { console.error(errorText(cleanupError)); }
    finally { monitor.close(); server?.closeClients(); server?.close(); release(); store.close(); }
    throw error;
  }
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
