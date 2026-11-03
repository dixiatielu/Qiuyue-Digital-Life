import { Fragment, render } from 'preact';
import { api, Badge, html, setLang, t, Toasts, useEffect, useState } from './lib.js';
import { Appearance } from './appearance.js';
import { Icon } from './icons.js';
import { Overview } from './pages/overview.js';
import { ConfigPage } from './pages/config.js';
import { PluginsPage } from './pages/plugins.js';
import { PersonaPage } from './pages/persona.js';
import { PromptPage } from './pages/prompt.js';
import { ModelsPage } from './pages/models.js';

const pages = () => [
  ['overview', t('Overview', '状态总览'), Overview],
  ['config', t('Configuration', '运行配置'), ConfigPage],
  ['plugins', t('Capabilities', '能力与插件'), PluginsPage],
  ['persona', t('Persona & growth', '人格与成长'), PersonaPage],
  ['prompt', t('System prompt', '系统提示词'), PromptPage],
  ['models', t('Models & connections', '模型与连接'), ModelsPage],
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
    <aside class="side">
      <a class="brand" href="#/overview"><span class="brand-moon" aria-hidden="true"></span><span>${t('Qiuyue', '洛秋月')}<small>A CONTINUING LIFE</small></span></a>
      <nav aria-label=${t('Main navigation', '主导航')}>
        ${pages().map(([id, label], index) => html`<${Fragment} key=${id}>
          ${index < 2 ? html`<div class="nav-label">${index === 0 ? t('DAY TO DAY', '日常与观察') : t('SETTINGS', '设定与管理')}</div>` : null}
          <a href=${`#/${id}`} class=${id === entry[0] ? 'active' : ''} aria-current=${id === entry[0] ? 'page' : undefined}><${Icon} name=${id} />${label}</a>
        <//>`)}
      </nav>
      <div class="side-foot">
        <div class="row"><span class=${`dot ${daemon.running ? (live.connected ? 'ok' : 'warn') : 'bad'}`}></span>${daemon.running ? t('Service running', '服务运行中') : t('Service stopped', '服务未运行')}</div>
        <span class="side-muted">${live.connected ? t('Live updates connected', '实时动态已连接') : t('Live updates disconnected', '实时动态未连接')}</span>
        ${pending ? html`<a href="#/overview"><${Badge} kind="warn">${t('Restart needed', '待重启')}<//></a>` : null}
        ${!overview.config.valid ? html`<a href="#/config"><${Badge} kind="bad">${t('Config invalid', '配置无效')}<//></a>` : null}
        <div class="operator"><span class="operator-mark">Q</span><span>${t('Operator space', '管理者空间')}<small>${t('Digital life management', '数字生命管理')}</small></span></div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="breadcrumb"><span>${t('Qiuyue’s space', '秋月的管理空间')}</span><span>/</span><strong>${entry[1]}</strong></div>
        <div class="row wrap"><${Badge} kind=${live.connected ? 'ok' : 'warn'}>${live.connected ? t('Live', '实时连接') : t('Disconnected', '连接中断')}<//><${Appearance} /></div>
      </header>
      <main class="content"><${Page} overview=${overview} live=${live} refresh=${refresh} /></main>
    </div>
    <${Toasts} />
  </div>`;
}

const root = document.getElementById('app');
api('/api/overview').then(initial => {
  setLang(initial.lang);
  document.title = t('Qiuyue management', '秋月管理');
  render(html`<${App} initial=${initial} />`, root);
}, error => { root.textContent = error.message; });
