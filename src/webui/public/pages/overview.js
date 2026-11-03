import { ago, api, Badge, Card, ContextNote, duration, failed, html, Modal, number, PageHeader, Tabs, t, time, toast, useState } from '../lib.js';

const reasonLabel = reason => ({ thinking: t('a thought is under way', '正在思考'), reviewing: t('a memory review is under way', '正在整理记忆（review）'), calling: t('a model call is starting', '正在发起模型调用') })[reason] ?? reason;
const fileLabel = name => ({ config: 'config.json', persona: t('persona file', '人格文件'), prompt: t('system prompt file', '系统提示词文件'), env: '.env', credentials: t('credentials', '凭据文件') })[name] ?? name;
const typeLabel = type => ({ environment: t('event', '事件'), observation: t('observation', '观察'), assistant: t('her text', '她的文字'), tool: t('tool', '工具'), action: t('action', '行动'), system: t('system', '系统'), run: t('thought', '思考') })[type] ?? type;
const stateKind = state => ({ success: 'ok', done: 'ok', running: 'info', pending: 'info', error: 'bad', failed: 'bad', unknown: 'warn' })[state] ?? '';

function summary(args) {
  const message = args?.message;
  const text = Array.isArray(message) ? message.map(part => part?.data?.text ?? (part?.type ? `[${part.type}]` : '')).join('') : typeof message === 'string' ? message : '';
  const target = args?.group_id ? `group:${args.group_id}` : args?.user_id ? `user:${args.user_id}` : '';
  return [target, text || JSON.stringify(args ?? {}).slice(0, 140)].filter(Boolean).join(' · ');
}

function Stat({ label, value, sub, kind = '' }) {
  return html`<div class=${`stat ${kind}`}><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : null}</div>`;
}

function ServiceControls({ overview, refresh }) {
  const [confirm, setConfirm] = useState(null);
  const job = overview.job;
  const waiting = job && ['waiting', 'running'].includes(job.state);
  const act = async (action, whenIdle = true) => {
    setConfirm(null);
    try { await api('/api/service', { method: 'POST', body: { action, whenIdle } }); refresh(); }
    catch (error) { failed(error); }
  };
  if (!overview.service) return html`<span class="muted small">${t('Set webui.service to start and stop the daemon here.', '设置 webui.service 后可在这里启停常驻进程。')}</span>`;
  return html`
    ${overview.daemon.running
      ? html`<button disabled=${waiting} onClick=${() => setConfirm('restart')}>${t('Restart…', '重启…')}</button><button class="ghost" disabled=${waiting} onClick=${() => setConfirm('stop')}>${t('Stop…', '停止…')}</button>`
      : html`<button class="primary" onClick=${() => act('start')}>${t('Start', '启动')}</button>`}
    ${waiting && job.state === 'waiting' ? html`<button class="ghost" onClick=${() => api('/api/service/job', { method: 'DELETE' }).then(refresh, failed)}>${t('Cancel waiting', '取消等待')}</button>` : null}
    ${confirm ? html`<${Modal} title=${confirm === 'restart' ? t('Restart the daemon', '重启常驻进程') : t('Stop the daemon', '停止常驻进程')} onClose=${() => setConfirm(null)}
      footer=${html`<button class="ghost danger" onClick=${() => act(confirm, false)}>${t('Now, cutting work short', '立即执行（中断当前工作）')}</button><button class="primary" onClick=${() => act(confirm, true)}>${t('When she is idle', '等她空闲后执行')}</button>`}>
      <p>${t('Stopping throws away the thought under way and a memory review in progress. Waiting holds the restart until both are done, for up to 15 minutes, and gives up rather than cut them short.', '停止会丢弃正在进行的思考和记忆整理。选择等待会在两者都结束后再执行，最多等 15 分钟；超时则放弃，不会强行中断。')}</p>
      ${overview.busy.length ? html`<p class="note warn">${t('Right now: ', '当前：')}${overview.busy.map(reasonLabel).join('、')}</p>` : html`<p class="note ok">${t('She is idle right now.', '她现在空闲。')}</p>`}
      ${confirm === 'restart' ? html`<${ContextNote} context=${overview.context} />` : null}
    <//>` : null}`;
}

function JobNote({ job }) {
  if (!job || ['done', 'cancelled'].includes(job.state) && Date.now() - job.startedAt > 120_000) return null;
  const action = job.action === 'restart' ? t('Restart', '重启') : t('Stop', '停止');
  if (job.state === 'waiting') return html`<p class="note">${action} ${t('waits for: ', '等待中：')}${job.waitingFor.map(reasonLabel).join('、') || t('checking', '检查中')} · ${t('gives up at', '截止')} ${time(job.deadline, false)}</p>`;
  if (job.state === 'running') return html`<p class="note">${action} ${t('in progress…', '执行中…')}</p>`;
  if (job.state === 'failed') return html`<p class="note error">${action} ${t('did not happen: ', '未执行：')}${job.message}</p>`;
  if (job.state === 'done') return html`<p class="note ok">${action} ${t('done', '完成')} · ${ago(job.startedAt)}</p>`;
  return null;
}

function Timeline({ items, compact = false, onExpand }) {
  const [open, setOpen] = useState(null);
  const [quiet, setQuiet] = useState(false);
  const shown = items.filter(item => quiet || !item.quiet).slice(compact ? -4 : -120).reverse();
  return html`<${Card} title=${compact ? t('Recent events', '最近发生') : t('Live', '实时动态')} actions=${compact ? html`<button class="link" onClick=${onExpand}>${t('View all →', '查看全部 →')}</button>` : html`<label class="check small"><input type="checkbox" checked=${quiet} onChange=${event => setQuiet(event.currentTarget.checked)} />${t('show quiet items', '显示次要条目')}</label>`}>
    ${shown.length ? html`<ol class="timeline">${shown.map(item => html`<li key=${item.id} class=${`tl tl-${item.type}`}>
      <div class="tl-head"><span class="muted mono small">${time(item.at)}</span><${Badge}>${typeLabel(item.type)}<//><button class="timeline-toggle" aria-expanded=${open === item.id} onClick=${() => setOpen(open === item.id ? null : item.id)}>${item.title}</button>
        ${item.state ? html`<${Badge} kind=${stateKind(item.state)}>${item.state}<//>` : null}${item.summary ? html`<span class="muted small">${item.summary}</span>` : null}
        ${item.durationMs != null ? html`<span class="muted small">${duration(item.durationMs)}</span>` : null}</div>
      ${item.text ? html`<div class=${open === item.id ? 'tl-text' : 'tl-text clamp'}>${item.text}</div>` : null}
      ${open === item.id && item.details ? html`<pre class="tl-details">${item.details}</pre>` : null}
    </li>`)}</ol>` : html`<p class="muted">${t('Nothing yet. The live view fills while the daemon runs.', '暂无内容。常驻进程运行时会实时更新。')}</p>`}
  <//>`;
}

function Logs() {
  const [data, setData] = useState(null);
  const load = () => api('/api/logs?lines=300&trace=80').then(setData, failed);
  return html`<${Card} title=${t('Logs', '运行日志')} actions=${html`<button class="ghost" onClick=${load}>${data ? t('Refresh', '刷新') : t('Load', '加载')}</button>`}>
    ${data ? html`<details open><summary>runtime.log</summary><pre class="log">${data.text || t('(empty)', '（空）')}</pre></details>
      <details><summary>trace</summary><table class="table small"><tbody>${data.trace.map(row => html`<tr><td class="mono nowrap">${time(row.at)}</td><td class="mono">${row.kind}</td><td class="mono clip">${row.data}</td></tr>`)}</tbody></table></details>` : html`<p class="muted small">${t('Loads the end of runtime.log and the latest trace rows.', '加载 runtime.log 末尾和最新的 trace 记录。')}</p>`}
  <//>`;
}

export function Overview({ overview, live, refresh }) {
  const [tab, setTab] = useState('now');
  const status = overview.status ?? {};
  const display = live.status ?? {};
  const daemon = overview.daemon;
  const control = async args => {
    try { await api('/api/control', { method: 'POST', body: { args } }); toast(t('Done', '已执行'), 'ok'); refresh(); }
    catch (error) { failed(error); }
  };
  const paused = display.paused ?? status.paused;
  const lifeEnabled = display.lifeEnabled ?? status.lifeEnabled;
  const context = display.contextTokens != null ? `${number(display.contextTokens)} / ${number(display.inputBudget ?? display.contextLimit)}` : '—';
  const ratio = display.contextTokens != null ? Math.min(1, display.contextTokens / (display.inputBudget || display.contextLimit || 1)) : 0;
  const busy = display.busy;
  const available = daemon.running && live.connected;
  return html`
    <${PageHeader} title=${t('Overview', '状态总览')} eyebrow="OVERVIEW" description=${t('The present moment, and a life that continues.', '她的当下，以及正在继续的生活。')}>
      <button disabled=${!available} onClick=${() => control([paused ? 'resume' : 'pause'])}>${paused ? t('Resume thinking', '恢复思考') : t('Pause thinking', '暂停思考')}</button>
      <${ServiceControls} overview=${overview} refresh=${refresh} />
    <//>
    ${!overview.config.valid ? html`<p class="note error">${t('The configuration does not load: ', '配置无法加载：')}${overview.config.error} — <a href="#/config">${t('fix it', '去修复')}</a></p>` : null}
    ${daemon.running && daemon.changed.length ? html`<div class="note warn"><div>${t('Changed since the daemon started: ', '常驻进程启动后修改过：')}${daemon.changed.map(fileLabel).join('、')}${t('. A restart puts them to use.', '。重启后生效。')}</div><${ContextNote} context=${overview.context} /></div>` : null}
    <${JobNote} job=${overview.job} />
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['now', t('Now', '此刻')], ['timeline', t('Live', '实时动态')], ['logs', t('Logs', '运行日志')]]} />
    <div hidden=${tab !== 'now'} class="stack">
      <section class="activity-hero"><div class="hero-copy">
        <${Badge} kind=${!daemon.running ? 'bad' : !live.connected ? 'warn' : paused ? 'warn' : 'info'}>${!daemon.running ? t('Service stopped', '服务未运行') : !live.connected ? t('Reconnecting', '正在重新连接') : paused ? t('Thinking paused', '思考已暂停') : display.phase ?? t('Running', '运行中')}<//>
        <h2>${!daemon.running ? t('Waiting to start.', '等待下一次启动。') : !live.connected ? t('Waiting for live updates.', '等待实时状态恢复。') : display.activity || status.activity || t('No current activity recorded.', '暂无当前活动记录。')}</h2>
        <p>${busy ? t(`Working for ${duration(Date.now() - busy.since)} · ${busy.requestCount ?? 0} requests · ${busy.completedTools ?? 0} tools`, `已进行 ${duration(Date.now() - busy.since)} · ${busy.requestCount ?? 0} 次请求 · ${busy.completedTools ?? 0} 次工具调用`) : overview.activity.reviewing ? t('Consolidating memories', '正在整理记忆') : t('No thought or memory review in progress.', '当前没有正在进行的思考或记忆整理。')}</p>
        <div class="row wrap"><${Badge}>${lifeEnabled ? t('Autonomous life on', '自主生活已开启') : t('Autonomous life off', '自主生活已关闭')}<//>
          <button class="link" disabled=${!available} onClick=${() => control(['life', lifeEnabled ? 'off' : 'on'])}>${lifeEnabled ? t('Turn off', '关闭') : t('Turn on', '开启')}</button>
          ${paused ? html`<span class="muted small">${t('Environment events are still received and saved.', '环境事件仍会接收并保存。')}</span>` : null}
        </div>
      </div><div class="hero-orbit" aria-hidden="true"></div><div class="hero-moon" aria-hidden="true"></div></section>
      <div class="stats">
        <${Stat} label=${t('Model calls today', '今日模型调用')} value=${number(display.modelCallsToday ?? status.modelCallsToday)} />
        <${Stat} label=${t('Actions this hour', '本小时行动')} value=${number(display.actionsThisHour ?? status.actionsThisHour)} />
        <${Stat} label=${t('Pending events', '待处理事件')} value=${number(display.pendingEvents ?? status.pendingEvents)} />
        <${Stat} label=${t('Working context', '工作上下文')} value=${context} sub=${html`<div class="meter"><span style=${`width:${Math.round(ratio * 100)}%`}></span></div>`} />
      </div>
      <div class="grid2 overview-grid"><${Timeline} compact items=${live.items} onExpand=${() => setTab('timeline')} />
      <${Card} title=${t('Current activity and plans', '当前活动与计划')}>
        <p class=${display.activity || status.activity ? '' : 'muted'}>${display.activity || status.activity || t('No activity set.', '没有记录当前活动。')}</p>
        ${status.wakes?.length ? html`<table class="table"><tbody>${status.wakes.map(wake => html`<tr><td class="nowrap mono small">${time(wake.dueAt, false)}</td><td><${Badge} kind=${wake.kind === 'commitment' ? 'info' : ''}>${wake.kind === 'commitment' ? t('commitment', '承诺') : t('life', '生活')}<//>${wake.rest ? html` <${Badge} kind="warn">${t('rest', '休息')}<//>` : null}</td><td>${wake.title}</td></tr>`)}</tbody></table>` : html`<p class="muted small">${t('No scheduled wakes.', '没有安排的唤醒。')}</p>`}
        ${status.pursuits?.length ? html`<h3>${t('Pursuits', '持续在做的事')}</h3><ul class="plain">${status.pursuits.map(pursuit => html`<li><strong>${pursuit.title}</strong>${pursuit.fictional ? html` <${Badge}>${t('fiction', '虚构')}<//>` : null}<div class="muted small">${pursuit.progress} · ${ago(pursuit.updatedAt)}</div></li>`)}</ul>` : null}
      <//>
      </div>
      <div class="stats secondary">
        <${Stat} label=${t('Daemon', '常驻进程')} kind=${daemon.running ? 'ok' : 'bad'} value=${daemon.running ? t('Running', '运行中') : t('Stopped', '未运行')} sub=${daemon.running ? `PID ${daemon.pid} · ${duration(Date.now() - daemon.startedAt)}` : overview.service?.ActiveState} />
        <${Stat} label=${t('QQ connection', 'QQ 连接')} kind=${live.connected ? '' : 'warn'} value=${display.connection ?? '—'} sub=${live.connected ? display.model : live.message} />
        <${Stat} label=${t('Memory review', '记忆整理')} value=${overview.activity.reviewing ? t('Reviewing', '整理中') : t('Idle', '空闲')} sub=${overview.activity.reviewing ? duration(Date.now() - overview.activity.reviewing) : null} />
        <${Stat} label=${t('Development records', '发展记录')} value=${number(Object.values(overview.counts).reduce((a, b) => a + b, 0))} sub=${['habit', 'practice', 'impression'].map(kind => `${({ habit: t('habits', '习惯'), practice: t('practices', '惯例'), impression: t('impressions', '印象') })[kind]} ${overview.counts[kind] ?? 0}`).join(' · ')} />
      </div>
      <${Card} title=${t('Recent actions', '最近行动')}>
        ${status.actions?.length ? html`<table class="table small"><tbody>${status.actions.slice(0, 15).map(action => html`<tr><td class="nowrap mono">${time(action.createdAt)}</td><td class="mono">${action.kind}</td><td><${Badge} kind=${stateKind(action.status)}>${action.status}<//></td><td class="clip">${summary(action.args)}</td></tr>`)}</tbody></table>` : html`<p class="muted">${daemon.running ? t('No actions yet.', '暂无行动。') : t('Shown while the daemon runs.', '常驻进程运行时显示。')}</p>`}
      <//>
    </div>
    <div hidden=${tab !== 'timeline'}><${Timeline} items=${live.items} /></div>
    <div hidden=${tab !== 'logs'}><${Logs} /></div>`;
}
