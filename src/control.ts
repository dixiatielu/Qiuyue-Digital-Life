import { ui } from './ui-language.js';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './store.js';
import type { LifeRuntime } from './runtime.js';
import { errorText } from './domain.js';
import type { DisplayCursor, Monitor } from './monitor.js';

export interface ControlRequest { args: string[]; yes?: boolean; cursor?: DisplayCursor }
export type ControlServer = Server & { closeClients(): void };
export function handleControl(store: Store, request: ControlRequest, runtime?: LifeRuntime): unknown {
  const [command, sub, ...rest] = request.args;
  if (command === 'status') return store.status();
  if (command === 'logs') return store.logs();
  if (command === 'pause' || command === 'resume' || command === 'life') {
    if (command === 'life' && !['on', 'off'].includes(sub ?? '')) throw new Error('Usage: life on|off');
    if (runtime) return runtime.control(command, sub === 'on');
    store.transaction(() => { store.setSetting(command === 'life' ? 'lifeEnabled' : 'paused', command === 'life' ? sub === 'on' : command === 'pause'); store.bumpGeneration(); });
    return store.status();
  }
  if (command === 'memory') {
    if (sub === 'search') return store.search(rest.join(' '), 30);
    const memoryId = rest[0]; if (!memoryId) throw new Error('A memory or event ID is required.');
    if (sub === 'show') return store.memory(memoryId) ?? store.event(memoryId) ?? null;
    if (sub === 'forget') {
      if (!request.yes) return { affectedIds: store.forgetPlan(memoryId), message: ui('This also deletes the original sources and derived content and may affect other memories, activities, and commitments. Review the affected records, then use --yes to proceed.', '此操作也清除依据的原始来源及其派生内容，可能影响其他记忆、活动和承诺。检查后使用 --yes 执行。') };
      runtime?.brain.abort(); return { forgotten: store.forget(memoryId) };
    }
    if (sub === 'correct') {
      const memory = store.memory(memoryId); if (!memory) throw new Error('Memory does not exist.');
      const content = rest.slice(1).join(' '); if (!content) throw new Error('Correction content is required.');
      if (content.length > 12000 || !memory.active) throw new Error('Correction content is too long, or the record is not the current version.');
      runtime?.brain.abort();
      const source = store.receive({ key: `correction:${crypto.randomUUID()}`, kind: 'operator_correction', at: Date.now(), text: content, payload: { supersedes: memory.id } }, true)!;
      const corrected = store.writeMemory({ ...memory, content, sources: [source.id], supersedes: memory.id }, true);
      store.bumpGeneration(); return corrected;
    }
  }
  throw new Error('Unknown command. Use help to view management commands.');
}

export async function serveControl(path: string, handler: (request: ControlRequest) => unknown, monitor?: Monitor): Promise<ControlServer> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The database daemon lease must be held before removing a stale socket.
  if (existsSync(path)) unlinkSync(path);
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.setEncoding('utf8');
    let input = ''; let handled = false;
    let unsubscribe: (() => void) | undefined;
    socket.on('close', () => { unsubscribe?.(); clients.delete(socket); });
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk.toString('utf8');
      if (input.length > 64_000) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try {
        const request = JSON.parse(input.split('\n')[0]!);
        if (!Array.isArray(request.args) || request.args.some((x: unknown) => typeof x !== 'string')) throw new Error('Invalid command format.');
        if (request.args[0] === 'subscribe') {
          if (!monitor) throw new Error('The running daemon does not support live display; restart with the new version.');
          if (request.cursor !== undefined && (typeof request.cursor?.instanceId !== 'string' || !Number.isSafeInteger(request.cursor?.seq) || request.cursor.seq < 0)) throw new Error('Invalid subscription cursor format.');
          socket.setTimeout(0);
          unsubscribe = monitor.subscribe(request.cursor, packet => {
            // A slow viewer must never block perception or grow an unbounded write queue.
            if (socket.destroyed || socket.writableLength > 1_000_000) { socket.destroy(); return; }
            socket.write(JSON.stringify(packet) + '\n');
          });
          return;
        }
        socket.end(JSON.stringify({ ok: true, result: handler(request) }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ ok: false, error: errorText(error) }) + '\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { chmodSync(path, 0o600); resolve(); }); });
  return Object.assign(server, { closeClients() { for (const client of clients) client.destroy(); } });
}

export function callControl(path: string, request: ControlRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let output = '';
    socket.setTimeout(6000, () => socket.destroy(new Error('Management request timed out.')));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { output += chunk; });
    socket.on('end', () => {
      try { const response = JSON.parse(output); if (!response.ok) throw new Error(response.error); resolve(response.result); }
      catch (error) { reject(error); }
    });
  });
}
