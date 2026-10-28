import { ui } from './ui-language.js';
import { createConnection, type Socket } from 'node:net';
import type { DisplayCursor, DisplayPacket } from './monitor.js';

/** Reconnects only the viewer; it never starts a daemon or opens a life database. */
export function followDisplay(path: string, receive: (packet: DisplayPacket) => void, connection: (connected: boolean, message: string) => void, retryMs = 1000) {
  let cursor: DisplayCursor | undefined;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    let input = ''; let ready = false;
    const client = socket = createConnection(path);
    client.setEncoding('utf8');
    client.setTimeout(6000, () => { if (!ready) client.destroy(new Error('Live subscription handshake timed out')); });
    client.on('connect', () => client.write(JSON.stringify({ args: ['subscribe'], cursor }) + '\n'));
    client.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 2_000_000) { client.destroy(new Error('Live record exceeds the receive limit')); return; }
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        if (stopped) return;
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const packet = JSON.parse(line);
          if (packet.ok === false) {
            const error = String(packet.error);
            connection(false, error.includes('Unknown command') ? ui('The daemon does not support live display; restart run with the new version.', '常驻进程尚未支持实时展示，请重启 run 到新版本。') : error);
            client.destroy(); return;
          }
          if (!['snapshot', 'event', 'ready'].includes(packet.type) || typeof packet.cursor?.instanceId !== 'string' || !Number.isSafeInteger(packet.cursor?.seq)) throw new Error('Invalid live protocol format');
          if (packet.type === 'event' && cursor && (cursor.instanceId !== packet.cursor.instanceId || packet.cursor.seq !== cursor.seq + 1)) {
            cursor = undefined; client.destroy(new Error('Live events have a gap; resynchronizing')); return;
          }
          receive(packet as DisplayPacket); cursor = packet.cursor;
          if (!ready) { ready = true; client.setTimeout(0); connection(true, ui('Connected to daemon', '已连接常驻进程')); }
        } catch (error) { client.destroy(error instanceof Error ? error : new Error(String(error))); return; }
      }
    });
    client.on('error', error => connection(false, ui(`${(error as NodeJS.ErrnoException).code ?? error.message}; waiting for daemon, reconnecting`, `${(error as NodeJS.ErrnoException).code ?? error.message}；等待常驻进程，自动重连中`)));
    client.on('close', () => {
      if (stopped) return;
      if (ready) connection(false, ui('Daemon disconnected; reconnecting', '常驻进程连接断开，自动重连中'));
      timer = setTimeout(connect, retryMs);
    });
  };
  connect();
  return () => { stopped = true; if (timer) clearTimeout(timer); socket?.destroy(); };
}
