#!/usr/bin/env node
import { ui } from './ui-language.js';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { SnowLumaAdapter } from './snowluma.js';
import { createTools } from './tools.js';
import { PiBrain } from './brain.js';
import { LifeRuntime } from './runtime.js';
import { callControl, handleControl, serveControl } from './control.js';
import { errorText } from './domain.js';
import { resolveModel } from './model.js';
import { Monitor } from './monitor.js';
import { followDisplay } from './display-client.js';

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string', default: 'config.json' }, yes: { type: 'boolean', default: false }, follow: { type: 'boolean', default: false } } });
  const configPath = resolve(values.config!);
  const envFile = resolve(dirname(configPath), '.env'); if (existsSync(envFile)) process.loadEnvFile(envFile);
  const command = positionals[0] ?? 'help';
  if (command === 'help') {
    console.log(ui(`qiuyue-digital-life\n\n  npm run dev -- <command> --config config.json\n\n  run                     Start the single daemon\n  validate                Check configuration, model, and credentials (without connecting to QQ)\n  models [provider]       List Pi models and image support\n  status | logs           Inspect continuing state or logs\n  tui                     Connect to the live terminal (exiting does not stop the daemon)\n  logs --follow           Subscribe to live NDJSON display events\n  pause | resume          Pause or resume the digital life\n  life on | life off      Enable or disable autonomous life\n  memory search <query>   Search memories and personal notes\n  memory show <ID>        Inspect a memory and its sources\n  memory correct <ID> <content>  Correct a memory while retaining versions\n  memory forget <ID>      Preview deletion; add --yes to proceed\n\nRestart after changing core configuration. The dailyCalls budget follows the Asia/Shanghai calendar day.`, `qiuyue-digital-life\n\n  npm run dev -- <命令> --config config.json\n\n  run                     启动唯一常驻主体\n  validate                检查配置、模型和凭据是否就绪（不连接QQ）\n  models [provider]       列出Pi模型及图片能力\n  status | logs           查看持续状态或运行记录\n  tui                     连接实时终端（退出不停止主体）\n  logs --follow           订阅实时 NDJSON 展示事件\n  pause | resume          整体暂停/恢复\n  life on | life off      开关自主生活\n  memory search <查询>    检索记忆及个人笔记\n  memory show <ID>        查看记忆及来源\n  memory correct <ID> <内容>  修正并保留版本\n  memory forget <ID>      预览删除范围；追加 --yes 执行\n\n核心配置修改后重启。dailyCalls 预算按 Asia/Shanghai 的自然日计算。`));
    return;
  }
  if (command === 'models') {
    console.log(JSON.stringify(builtinModels().getModels(positionals[1]).map(model => ({ provider: model.provider, id: model.id, input: model.input })), null, 2)); return;
  }
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
  if (command === 'validate') {
    const problems = []; const warnings = [];
    try {
      const model = resolveModel(config.model);
      if (Math.min(config.limits.contextTokens, model.contextWindow) <= config.limits.outputReserveTokens + config.limits.contextSafetyTokens) problems.push(ui('The model window is too small for the output reserve and safety margin.', '模型窗口不足以容纳输出预留与安全余量。'));
    } catch (error) { problems.push(errorText(error)); }
    if (!process.env[config.model.apiKeyEnv]) problems.push(ui(`Missing ${config.model.apiKeyEnv}.`, `缺少 ${config.model.apiKeyEnv}。`));
    if (config.web.enabled && !process.env[config.web.searchKeyEnv]) warnings.push(ui(`Missing ${config.web.searchKeyEnv}; web search is unavailable, but known webpages can still be read.`, `缺少 ${config.web.searchKeyEnv}；联网搜索不可用，已知网页仍可阅读。`));
    console.log(JSON.stringify({ valid: problems.length === 0, problems, warnings, runtime: process.version, snowlumaConfigured: Boolean(config.snowluma.selfId) }, null, 2));
    if (problems.length) process.exitCode = 1; return;
  }
  if (command !== 'run') {
    try { console.log(JSON.stringify(await callControl(config.socket, { args: positionals, yes: values.yes }), null, 2)); return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    const store = new Store(config.database, config.life.enabled);
    try { const release = store.acquireDaemon(); try { store.bindAccount(config.snowluma.selfId); console.log(JSON.stringify(handleControl(store, { args: positionals, yes: values.yes }), null, 2)); } finally { release(); } }
    finally { store.close(); }
    return;
  }
  if (!process.env[config.model.apiKeyEnv]) throw new Error(`Set ${config.model.apiKeyEnv} in the environment first.`);
  const store = new Store(config.database, config.life.enabled);
  const release = store.acquireDaemon();
  const monitor = new Monitor(config, store);
  let runtime: LifeRuntime | undefined;
  let brain: PiBrain;
  const social = new SnowLumaAdapter(config.snowluma, store, () => { void runtime?.tick(); });
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  try {
    store.bindAccount(config.snowluma.selfId);
    brain = new PiBrain(config, store, createTools(config, store, social, () => brain.thought), undefined, monitor);
    runtime = new LifeRuntime(config, store, brain);
    server = await serveControl(config.socket, request => handleControl(store, request, runtime), monitor);
    // Recovery must precede live collection; perception keeps running even if paused.
    store.recover();
    await social.connect();
    runtime.start();
    console.log(ui(`Digital life started; management socket: ${config.socket}`, `数字生命已启动；管理入口 ${config.socket}`));
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return; stopping = true;
      await Promise.all([social.close(), runtime!.stop()]);
      monitor.close(); server!.closeClients();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      release(); store.close();
    };
    process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) {
    await Promise.all([social.close(), runtime?.stop()]); monitor.close(); server?.closeClients(); server?.close(); release(); store.close(); throw error;
  }
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
