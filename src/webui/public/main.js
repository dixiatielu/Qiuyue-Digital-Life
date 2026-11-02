import { render } from 'preact';
import { api, Badge, html, setLang, t, Toasts, useEffect, useState } from './lib.js';
import { Overview } from './pages/overview.js';
import { ConfigPage } from './pages/config.js';
import { PluginsPage } from './pages/plugins.js';
import { PersonaPage } from './pages/persona.js';
import { PromptPage } from './pages/prompt.js';
import { ModelsPage } from './pages/models.js';

const pages = () => [
  ['overview', t('Status', '状态'), Overview],
  ['config', t('Configuration', '配置'), ConfigPage],
  ['plugins', t('Plugins', '插件'), PluginsPage],
  ['persona', t('Persona', '人格'), PersonaPage],
  ['prompt', t('System prompt', '系统提示词'), PromptPage],
  ['models', t('Models', '模型'), ModelsPage],
];
const route = () => location.hash.replace(/^#\/?/, '').split('/')[0] || 'overview';

/** The overview, polled, and the daemon's live view, pushed: every page reads both. */
function useLive() {
  const [live, setLive] = useState({ connected: false, message: '', status: undefined, items: [] });
  useEffect(() => {
    const source = new EventSource('/api/live');
    source.onmessage = message => {
      const packet = JSON.parse(message.data);
      setLive(current => {
        if (packet.type === 'snapshot') return { connected: packet.connected, message: packet.message, status: packet.status, items: packet.items };
        if (packet.type === 'connection') return { ...current, connected: packet.connected, message: packet.message, ...(packet.connected ? {} : { status: undefined }) };
        const { change } = packet;
        if (change.type === 'status') return { ...current, status: change.status };
        const items = current.items.filter(item => item.id !== change.item.id);
        items.push(change.item);
        return { ...current, items: items.slice(-300) };
      });
    };
    source.onerror = () => setLive(current => ({ ...current, connected: false, message: t('Page connection lost; reconnecting', '网页连接中断，正在重连') }));
    return () => source.close();
  }, []);
  return live;
}

function App({ initial }) {
  const [page, setPage] = useState(route());
  const [overview, setOverview] = useState(initial);
  const live = useLive();
  useEffect(() => { const change = () => setPage(route()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  const refresh = () => api('/api/overview').then(setOverview, () => {});
  useEffect(() => { const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, []);
  const entry = pages().find(([id]) => id === page) ?? pages()[0];
  const Page = entry[2];
  const daemon = overview.daemon;
  const pending = daemon.running && daemon.changed.length > 0;
  return html`<div class="shell">
    <nav class="side">
      <div class="brand">${t('Qiuyue', '洛秋月')}<span class="muted small">${t('management', '管理')}</span></div>
      ${pages().map(([id, label]) => html`<a href=${`#/${id}`} class=${id === entry[0] ? 'active' : ''}>${label}</a>`)}
      <div class="side-foot">
        <div class="row"><span class=${`dot ${daemon.running ? (live.connected ? 'ok' : 'warn') : 'bad'}`}></span>${daemon.running ? t('Daemon running', '常驻进程运行中') : t('Daemon stopped', '常驻进程未运行')}</div>
        ${pending ? html`<a href="#/overview"><${Badge} kind="warn">${t('Restart needed', '待重启')}<//></a>` : null}
        ${!overview.config.valid ? html`<a href="#/config"><${Badge} kind="bad">${t('Config invalid', '配置无效')}<//></a>` : null}
      </div>
    </nav>
    <main class="content">
      <${Page} overview=${overview} live=${live} refresh=${refresh} />
    </main>
    <${Toasts} />
  </div>`;
}

const root = document.getElementById('app');
api('/api/overview').then(initial => {
  setLang(initial.lang);
  document.title = t('Qiuyue management', '秋月管理');
  render(html`<${App} initial=${initial} />`, root);
}, error => { root.textContent = error.message; });
