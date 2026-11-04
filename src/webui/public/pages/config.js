import { api, Card, ConfigField, failed, html, Loading, PageHeader, SaveBar, t, Tabs, toast, useConfigDraft, useState } from '../lib.js';

/** The configuration sections that have no page of their own; models, plugins, and their endpoints live on theirs. */
const sections = () => [
  ['adapters', t('Platform accounts', '平台账号'), [{ path: 'adapters', type: 'json', label: t('Connections', '连接设置'), help: t('Each connection has an id, driver and accountId. Connection changes require a restart.', '每个连接包含 id、driver 和 accountId。连接修改在重启后生效。') }]],
  ['life', t('Life', '自主生活'), [
    { path: 'life.enabled', type: 'bool', label: t('Life on at first start', '首次启动时开启自主生活'), help: t('Only the first start reads this; afterwards use the switch on the status page.', '只在第一次启动时读取；之后用状态页的开关。') },
    { path: 'life.allowFiction', type: 'bool', label: t('Allow fictional daily life', '允许虚构日常'), warn: t('Part of the system prompt: changing it starts a fresh working context.', '属于系统提示词：修改后工作上下文会重新开始。') },
    { path: 'life.minWakeMs', type: 'ms', label: t('Shortest wake interval (ms)', '最短唤醒间隔（毫秒）') },
    { path: 'life.freeTime.enabled', type: 'bool', label: t('Offer free time when chats go quiet', '聊天安静时提供空闲时间') },
    { path: 'life.freeTime.quietMinMs', type: 'ms', label: t('Quiet at least (ms)', '安静至少（毫秒）'), help: t('Each quiet stretch lasts a random time between these two.', '每次安静的时长在这两个值之间随机。') },
    { path: 'life.freeTime.quietMaxMs', type: 'ms', label: t('Quiet at most (ms)', '安静至多（毫秒）') },
    { path: 'life.freeTime.gapMs', type: 'ms', label: t('Gap from other life wakes (ms)', '与其他生活唤醒的间隔（毫秒）') },
    { path: 'life.freeTime.perDay', type: 'int', label: t('Free-time wakes per day', '每天空闲唤醒次数') },
  ]],
  ['limits', t('Pace and limits', '节奏与限额'), [
    { path: 'limits.batchSize', type: 'int', label: t('Events per observation', '每次观察的事件数') },
    { path: 'limits.debounceMs', type: 'ms', label: t('Quiet before thinking (ms)', '开始思考前的静默（毫秒）'), help: t('0 starts at once.', '0 表示立即开始。') },
    { path: 'limits.maxDelayMs', type: 'ms', label: t('Longest wait before thinking (ms)', '开始思考前最长等待（毫秒）') },
    { path: 'limits.ambientDelayMs', type: 'ms', label: t('Ambient events wait (ms)', '次要事件等待（毫秒）'), help: t('How long typing notices and reactions wait for something else before being observed alone.', '“正在输入”、表情回应等次要事件在单独被观察前最多等待多久。') },
    { path: 'limits.maxPreemptions', type: 'int', label: t('Preemptions in a row', '连续打断次数'), help: t('0 turns preemption off.', '0 表示关闭打断。') },
    { path: 'limits.tickMs', type: 'ms', label: t('Scheduler tick (ms)', '调度间隔（毫秒）') },
    { path: 'limits.modelCallsPerDay', type: 'int', nullable: true, label: t('Model calls per day', '每日模型调用上限'), help: t('Counted by the Asia/Shanghai day.', '按 Asia/Shanghai 自然日计算。') },
    { path: 'limits.actionsPerHour', type: 'int', nullable: true, label: t('Actions per hour', '每小时行动上限') },
    { path: 'limits.runTimeoutMs', type: 'ms', nullable: true, label: t('Thought timeout (ms)', '单次思考超时（毫秒）') },
    { path: 'limits.maxTurnsPerRun', type: 'int', nullable: true, label: t('Turns per thought', '每次思考的轮数上限') },
    { path: 'limits.maxImages', type: 'int', label: t('Images per observation', '每次观察的图片数') },
    { path: 'limits.contextTokens', type: 'int', label: t('Context window used (tokens)', '使用的上下文窗口（tokens）') },
    { path: 'limits.outputReserveTokens', type: 'int', label: t('Output reserve (tokens)', '输出预留（tokens）') },
    { path: 'limits.contextSafetyTokens', type: 'int', label: t('Safety margin (tokens)', '安全余量（tokens）') },
  ]],
  ['compaction', t('Context compaction', '上下文整理'), [
    { path: 'compaction.keepRecentTokens', type: 'int', label: t('Recent tokens kept', '保留最近的 tokens') },
    { path: 'compaction.summaryMaxTokens', type: 'int', label: t('Summary length limit (tokens)', '摘要长度上限（tokens）') },
    { path: 'compaction.retries', type: 'int', min: 0, max: 3, label: t('Retries', '重试次数') },
    { path: 'compaction.idleRatio', type: 'number', step: 0.01, label: t('Compact when idle above (ratio)', '空闲时整理阈值（比例）') },
    { path: 'compaction.idleAfterMs', type: 'ms', label: t('Idle after (ms)', '空闲判定（毫秒）') },
  ]],
  ['memory', t('Memory', '记忆'), [
    { path: 'memory.retentionDays', type: 'int', label: t('Raw records kept (days)', '原始记录保留（天）') },
    { path: 'memory.recallLimit', type: 'int', label: t('Recall results', '回忆结果数') },
    { path: 'memory.recentEvents', type: 'int', label: t('Recent events in a snapshot', '快照中的最近事件数') },
    { path: 'memory.reflectionEveryEvents', type: 'int', label: t('Review every N events', '每多少事件整理一次记忆') },
  ]],
  ['development', t('Development size', '发展容量'), [
    { path: 'development.scopeChars', type: 'int', label: t('Characters per scope', '每个范围的字数上限') },
    { path: 'development.personChars', type: 'int', label: t('Characters per impression', '每条印象的字数上限') },
    { path: 'development.people', type: 'int', label: t('Impressions in view', '同时提供的印象数') },
    { path: 'development.recordLines', type: 'int', label: t('Chat record lines per read', '每次读取的聊天记录行数') },
  ]],
  ['webui', t('This page', '管理网页'), [
    { path: 'uiLanguage', type: 'select', label: t('Interface language', '界面语言'), options: [['en', 'English'], ['zh', '中文']], help: t('Restart the daemon and page after changing it.', '修改后重启常驻进程和管理网页。') },
    { path: 'webui.host', label: t('Listening address', '监听地址'), help: t('127.0.0.1 keeps it on this machine; reach it through an SSH tunnel.', '127.0.0.1 只在本机可访问，请通过 SSH 隧道打开。') },
    { path: 'webui.port', type: 'int', label: t('Port', '端口') },
    { path: 'webui.tokenEnv', label: t('Credential name', '凭据名称'), help: t('When unset, each start prints a new token.', '未设置时每次启动打印一个新令牌。') },
    { path: 'webui.service', label: t('systemd user unit', 'systemd 用户服务名'), help: t('Lets this page start, stop, and restart the daemon, e.g. qiuyue-digital-life.service.', '设置后网页可以启停、重启常驻进程，例如 qiuyue-digital-life.service。') },
  ]],
  ['files', t('Files', '文件路径'), [
    { path: 'credentialsFile', label: t('Credential file', '凭据文件'), help: t('Defaults to credentials.json beside config.json. An absolute path can keep it outside the checkout. Move existing credentials before changing this path.', '默认是 config.json 旁边的 credentials.json；可用绝对路径放在仓库外。更改路径前请先迁移已有凭据。') },
    { path: 'database', label: t('Database', '数据库') },
    { path: 'socket', label: t('Management socket', '管理套接字') },
    { path: 'personaFile', label: t('Persona file', '人格文件'), help: t('Edited on the persona page.', '内容在人格页编辑。') },
    { path: 'systemPromptFile', label: t('System prompt file', '系统提示词文件'), help: t('Unset uses the built-in prompt; the system prompt page sets it.', '不设置则使用内置提示词；在系统提示词页保存时会自动设置。') },
  ]],
];

function RawEditor({ form }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState('');
  const current = form.draft ? JSON.stringify(form.draft, null, 2) : form.state.data.text;
  const apply = async () => {
    let parsed;
    try { parsed = JSON.parse(text ?? current); } catch (problem) { setError(problem.message); return; }
    setError('');
    if (form.raw) { form.replace(parsed); setText(null); toast(t('Applied to the draft; review and save below.', '已应用到草稿，请在下方检查并保存。')); return; }
    // The file on disk is not JSON, so there is no draft to merge into: check and save directly.
    try {
      const check = await api('/api/config/check', { method: 'POST', body: { raw: parsed } });
      if (!check.valid) { setError(check.error); return; }
      await api('/api/config', { method: 'PUT', body: { raw: parsed, hash: form.hash } });
      toast(t('Saved.', '已保存。'), 'ok'); setText(null); form.reload();
    } catch (problem) { failed(problem); }
  };
  return html`<${Card} title=${t('Raw JSON', '原始 JSON')} actions=${html`<button onClick=${apply} disabled=${text === null && Boolean(form.raw)}>${form.raw ? t('Apply to draft', '应用到草稿') : t('Check and save', '检查并保存')}</button>`}>
    <p class="muted small">${t('Every key, including ones without a form field. Keys the daemon does not know are kept as they are.', '包含所有键，也包括表单里没有的。常驻进程不认识的键会原样保留。')}</p>
    ${error ? html`<p class="note error">${error}</p>` : null}
    <textarea class="mono editor" spellcheck="false" value=${text ?? current} onInput=${event => setText(event.currentTarget.value)}></textarea>
  <//>`;
}

export function ConfigPage() {
  const form = useConfigDraft();
  const [tab, setTab] = useState('form');
  const [section, setSection] = useState('life');
  if (!form.state.data) return html`<${Loading} state=${form.state} />`;
  const all = sections();
  return html`
    <${PageHeader} title=${t('Configuration', '运行配置')} eyebrow="CONFIGURATION" description=${t('Connections, daily rhythm and operating limits.', '把连接、生活节奏与运行边界，整理在一起。')} />
    ${form.error ? html`<p class="note error">${t('The configuration on disk does not load: ', '磁盘上的配置无法加载：')}${form.error}</p>` : null}
    <p class="muted small">${t('Saved changes take effect when the daemon restarts. Grey values are defaults; ↺ goes back to one.', '保存后在常驻进程重启时生效。灰色的值是默认值，↺ 恢复默认。')}
      ${' '}${t('Models and endpoints are on the models page; plugins and QQ interface permissions on the plugins page.', '模型和各个端点在模型页；插件和 QQ 接口权限在插件页。')}</p>
    <${Tabs} value=${form.raw ? tab : 'raw'} onChange=${setTab} tabs=${[['form', t('Grouped settings', '分组配置')], ['raw', t('Raw JSON', '原始 JSON')]]} />
    <div hidden=${!form.raw || tab !== 'form'} class="config-layout">
      <nav class="toc" aria-label=${t('Configuration groups', '配置分类')}>${all.map(([id, title]) => html`<button key=${id} class=${section === id ? 'active' : ''} aria-pressed=${section === id} onClick=${() => setSection(id)}>${title}</button>`)}</nav>
      <div>${all.map(([id, title, fields]) => html`<section key=${id} hidden=${section !== id}><${Card} title=${title}><div class="fields">${[...fields].sort((a, b) => Number(b.type === 'bool') - Number(a.type === 'bool')).map(field => html`<${ConfigField} key=${field.path} form=${form} ...${field} />`)}</div><//></section>`)}</div>
    </div>
    <div hidden=${Boolean(form.raw) && tab !== 'raw'}><${RawEditor} form=${form} /></div>
    <${SaveBar} form=${form} />`;
}
