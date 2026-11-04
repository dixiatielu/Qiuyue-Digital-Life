import { Icon } from '../icons.js';
import { api, Badge, Card, ConfigField, ContextNote, failed, getPath, html, Loading, PageHeader, SaveBar, Tabs, t, time, useAsync, useConfigDraft, useEffect, useMemo, useState } from '../lib.js';

const permitted = tools => name => !(tools.deny ?? []).includes(name) && (tools.allow === '*' || (tools.allow ?? []).includes(name));

/** What each installed plugin does and what it needs beyond its switch (docs/plugins.md). */
function describe(id, value, allowed) {
  const has = path => value(path);
  const web = has('web.enabled');
  return ({
    gallery: { name: t('Gallery', '作品库'), text: t('Keeps generated images for the long term. Search by description, view originals, organize and reuse them. Available even when image generation is off.', '长期保存自己创作的图片，按内容检索、看图、整理和复用。关闭新图生成后仍然可用。'), needs: [[null, t('Embedding is optional; keyword search works without it.', '语义检索可选；未开启 embedding 时仍可按关键词查找。')]] },
    drawing: { name: t('Drawing', '画画'), text: t('Draws through an OpenAI-compatible /images/generations endpoint; a finished drawing comes back to her as an observation, and she sends it by its ID.', '通过兼容 OpenAI 的 /images/generations 接口作画；画好后作为观察回到她那里，再按 ID 发送。'),
      needs: [[has('drawing.enabled'), t('drawing.enabled on the models page', '模型页开启 drawing.enabled')], [Boolean(has('drawing.baseUrl') && has('drawing.model')), t('an image endpoint and model', '图像接口地址和模型')]] },
    'web-search': { name: t('Web search', '联网搜索'), text: t('Searches the web for public information through the configured search endpoint.', '通过配置的搜索接口检索公开信息。'),
      needs: [[web, t('web.enabled below', '下方开启 web.enabled')], [null, t('the search credential (a warning only; without it search reports the missing key)', '搜索凭据（缺少时只是警告，调用时会提示缺少密钥）')]] },
    'web-reader': { name: t('Web reader', '阅读网页'), text: t('Reads a known webpage; needs no search credential.', '阅读已知网页，不需要搜索凭据。'), needs: [[web, t('web.enabled below', '下方开启 web.enabled')]] },
    'qzone-share': { name: t('Qzone sharing', '分享空间动态'), text: t('Shares a Qzone post into a chat as a signed share card, as one action.', '把 QQ 空间动态以分享卡片的形式发到聊天里，整体算一次行动。'),
      needs: [[allowed('get_qzone_share_ark'), t('get_qzone_share_ark allowed', '允许 get_qzone_share_ark')], [allowed('send_group_msg') || allowed('send_private_msg'), t('a message send interface allowed', '允许至少一个发消息接口')]] },
    'qq-stickers': { name: t('Saved stickers', '收藏表情'), text: t('Saves a sticker with a description and brings up saved stickers that fit what is said.', '保存表情时附带描述，并在聊天时想起合适的收藏表情。'),
      needs: [[allowed('modify_custom_face'), t('modify_custom_face allowed, to describe a save', '允许 modify_custom_face（用于描述）')], [Boolean(has('embedding.enabled')), t('embedding on, for suggestions', '开启 embedding（用于推荐）')]] },
    'qq-faces': { name: t('QQ system faces', 'QQ 系统表情'), text: t('Names system faces in what she reads and shows their pictures; adds view_face.', '在她读到的内容里给系统表情标上名字并显示图片，提供 view_face。'),
      needs: [[allowed('fetch_sys_faces'), t('fetch_sys_faces allowed, to read an uncached directory', '允许 fetch_sys_faces（用于读取未缓存的表情目录）')]] },
    'snowluma-tools': { name: t('QQ native tools', 'QQ 原生接口'), text: t('Every permitted SnowLuma interface as a tool of its own name, with search_snowluma_tools and load_snowluma_tools for finding them. Turned off, she can no longer send messages, react, or poke herself; she still perceives QQ, and other plugins can still use permitted interfaces.', '把每个允许的 SnowLuma 接口作为同名工具提供，并提供 search_snowluma_tools、load_snowluma_tools 用来查找。关闭后她不能再自己发消息、回应或戳一戳；仍然能感知 QQ，其他插件也仍可使用允许的接口。'),
      needs: [[null, t('each interface follows the permissions below', '每个接口受下方权限控制')]], warn: t('Off means she cannot speak in QQ.', '关闭后她无法在 QQ 里说话。') },
  })[id] ?? { name: id, text: '', needs: [] };
}

function PluginSwitch({ value, defaultEnabled, label, onChange }) {
  const enabled = value ?? defaultEnabled;
  const options = [[true, t('On', '开')], [false, t('Off', '关')]];
  return html`<div class="segmented" role="group" aria-label=${label}>${options.map(([option, text]) => html`<button type="button" class=${enabled === option ? 'active' : ''} aria-pressed=${enabled === option} onClick=${() => onChange(option)}>${text}${option === defaultEnabled ? t(' (default)', '（默认）') : ''}</button>`)}</div>`;
}

function Permissions({ form, account }) {
  const catalog = useAsync(() => api('/api/snowluma'));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [view, setView] = useState('all');
  const tools = { allow: '*', deny: [], ...account.tools };
  const allowed = permitted(tools);
  const actions = catalog.data?.actions ?? [];
  const categories = useMemo(() => [...new Set(actions.map(action => action.category ?? ''))].filter(Boolean), [actions]);
  if (!catalog.data) return html`<${Loading} state=${catalog} />`;
  const write = next => form.set('adapters', (form.get('adapters') ?? form.effective.adapters).map(item => item.id === account.id ? { ...item, tools: { allow: next.allow, deny: [...new Set(next.deny)].sort() } } : item));
  const toggle = (name, on) => {
    if (tools.allow === '*') write({ allow: '*', deny: on ? tools.deny.filter(item => item !== name) : [...tools.deny, name] });
    else write({ allow: on ? [...new Set([...tools.allow, name])].sort() : tools.allow.filter(item => item !== name), deny: on ? tools.deny.filter(item => item !== name) : tools.deny });
  };
  const needle = query.trim().toLowerCase();
  const shown = actions.filter(action => (!category || action.category === category) && (!needle || action.name.toLowerCase().includes(needle) || (action.summary ?? '').toLowerCase().includes(needle))
    && (view === 'all' || (view === 'allowed') === allowed(action.name) || (view === 'readonly' && action.readOnly)));
  const count = actions.filter(action => allowed(action.name)).length;
  return html`<${Card} title=${`${account.id} · ${t('QQ interface permissions', 'QQ 接口权限')}`} actions=${html`<span class="muted small">${t(`${count} of ${actions.length} allowed`, `已允许 ${count} / ${actions.length}`)}</span>`}>
    <p class="muted small">${t('Native SnowLuma interfaces she may call, by their original names. Read-only queries and actions are both subject to these. A plugin switch never grants an interface.', '她可以按原名调用的 SnowLuma 原生接口。只读查询和行动都受这里限制。插件开关不会授予接口权限。')}
      ${' '}API ${catalog.data.source.commit?.slice(0, 12) ?? catalog.data.source.sdkVersion}</p>
    <div class="row wrap">
      <label class="check"><input type="radio" checked=${tools.allow === '*'} onChange=${() => write({ allow: '*', deny: tools.deny })} />${t('All except denied', '除拒绝列表外全部允许')}</label>
      <label class="check"><input type="radio" checked=${tools.allow !== '*'} onChange=${() => write({ allow: actions.filter(action => allowed(action.name)).map(action => action.name).sort(), deny: [] })} />${t('Only those listed', '只允许勾选的')}</label>
    </div>
    <div class="row wrap filters">
      <input type="search" placeholder=${t('Search name or summary', '搜索名称或说明')} value=${query} onInput=${event => setQuery(event.currentTarget.value)} />
      <select value=${category} onChange=${event => setCategory(event.currentTarget.value)}><option value="">${t('All categories', '全部分类')}</option>${categories.map(name => html`<option>${name}</option>`)}</select>
      <select value=${view} onChange=${event => setView(event.currentTarget.value)}>
        <option value="all">${t('All', '全部')}</option><option value="allowed">${t('Allowed', '已允许')}</option><option value="denied">${t('Not allowed', '未允许')}</option><option value="readonly">${t('Read-only', '只读')}</option></select>
      <button class="ghost" onClick=${() => write(shown.reduce((next, action) => next.allow === '*' ? { ...next, deny: next.deny.filter(item => item !== action.name) } : { allow: [...new Set([...next.allow, action.name])], deny: next.deny.filter(item => item !== action.name) }, tools))}>${t('Allow shown', '允许筛选结果')}</button>
      <button class="ghost" onClick=${() => write(shown.reduce((next, action) => next.allow === '*' ? { ...next, deny: [...next.deny, action.name] } : { ...next, allow: next.allow.filter(item => item !== action.name) }, tools))}>${t('Deny shown', '拒绝筛选结果')}</button>
    </div>
    <div class="table-wrap"><table class="table small"><thead><tr><th></th><th>${t('Interface', '接口')}</th><th>${t('Category', '分类')}</th><th>${t('Summary', '说明')}</th></tr></thead><tbody>
      ${shown.map(action => html`<tr key=${action.name}><td><input type="checkbox" checked=${allowed(action.name)} onChange=${event => toggle(action.name, event.currentTarget.checked)} /></td>
        <td class="mono nowrap">${action.name}${action.readOnly ? html` <${Badge}>${t('read', '只读')}<//>` : null}</td><td class="nowrap">${action.category}</td><td>${action.summary}</td></tr>`)}
    </tbody></table></div>
  <//>`;
}

export function PluginsPage() {
  const [tab, setTab] = useState('installed');
  const [submitting, setSubmitting] = useState(false);
  const form = useConfigDraft();
  const info = useAsync(() => api('/api/plugins'));
  useEffect(() => { const timer = setInterval(info.reload, 2000); return () => clearInterval(timer); }, [info.reload]);
  if (!form.state.data || !info.data) return html`<${Loading} state=${form.state.data ? info : form.state} />`;
  if (!form.raw) return html`<p class="note error">${t('config.json is not valid JSON; repair it on the configuration page first.', 'config.json 不是有效的 JSON，请先在配置页修复。')}</p>`;
  const value = path => form.get(path) ?? getPath(form.effective, path);
  const accounts = (form.get('adapters') ?? form.effective.adapters ?? []).filter(account => account.driver === 'snowluma');
  const inspected = info.data.inspected;
  const credentials = inspected?.credentials ?? { problems: [], warnings: [] };
  const running = info.data.running;
  const job = running?.job;
  const busy = submitting || (job && !['done', 'failed'].includes(job.state));
  const reload = async id => {
    setSubmitting(true);
    try { await api('/api/plugins/reload', { method: 'POST', body: { id } }); await info.reload(); }
    catch (error) { failed(error); } finally { setSubmitting(false); }
  };
  const stateName = state => ({ running: t('running', '运行中'), disabled: t('disabled', '已停用'), failed: t('failed', '加载失败'), unloaded: t('not loaded', '未加载'), preparing: t('preparing', '准备中'), waiting: t('waiting for current work', '等待当前工作结束'), applying: t('applying', '应用中'), done: t('complete', '已完成') })[state] ?? state;
  return html`
    <${PageHeader} title=${t('Capabilities', '能力与插件')} eyebrow="CAPABILITIES" description=${t('What she can do, and what each capability needs.', '她能做什么，以及每项能力需要的条件。')}>
      <button disabled=${!running?.ready || busy || form.dirty} onClick=${() => reload('all')}>${t('Reload plugins', '重载插件')}</button>
    <//>
    <p class="muted small">${t('Save settings, then reload to apply them. Reload waits for current thoughts and tasks while incoming messages keep being saved. Changes to tool declarations begin a fresh working context; memories and continuing state are kept.', '先保存设置，再通过重载应用。重载会等待当前思考和任务结束，期间继续保存收到的消息。工具声明变化会新建工作上下文，记忆和持续状态保留。')}</p>
    <p class="muted small">${t('User plugin directory: ', '用户插件目录：')}<code>${running?.directory ?? info.data.directory ?? '—'}</code></p>
    ${!running ? html`<p class="note warn">${t('Runtime plugin status is unavailable. Start a daemon with reload support to apply changes.', '暂时无法读取插件运行状态。启动支持重载的常驻进程后可应用修改。')} ${info.data.runtimeError}</p>` : null}
    ${running?.restartRequired.length ? html`<p class="note warn">${t('Other saved changes still require a restart: ', '以下其他已保存修改仍需重启：')}${running.restartRequired.join(', ')}</p>` : null}
    ${job ? html`<p class=${`note ${job.state === 'failed' ? 'error' : job.state === 'done' ? 'ok' : ''}`} role="status">
      ${t('Reload', '重载')} ${job.target} · ${stateName(job.state)}
      ${job.error ?? ''}${job.state === 'done' ? job.contextReset ? t(' · Working context renewed.', ' · 工作上下文已更新。') : t(' · Working context kept.', ' · 工作上下文已保留。') : ''}
      ${job.cleanupErrors?.length ? t(' · Some old resources did not clean up: ', ' · 部分旧资源清理异常：') + job.cleanupErrors.join('; ') : ''}
    </p>` : null}
    ${[...credentials.problems, ...credentials.warnings].map(text => html`<p class=${`note ${credentials.problems.includes(text) ? 'error' : 'warn'}`}>${text}</p>`)}
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['installed', t('Installed plugins', '已安装插件')], ['permissions', t('QQ permissions', 'QQ 接口权限')], ['web', t('Web settings', '联网设置')]]} />
    <div hidden=${tab !== 'installed'} class="plugin-grid">${info.data.ids.map(id => {
      const live = running?.plugins.find(plugin => plugin.id === id);
      const schema = live?.configSchema ? live : info.data.metadata?.[id];
      const defaultEnabled = schema?.defaultEnabled ?? live?.defaultEnabled ?? true;
      const account = accounts.find(account => id.startsWith(`${account.id.replaceAll('_', '-')}-`));
      const capability = account ? id.slice(account.id.replaceAll('_', '-').length + 1) : id;
      const user = !account && !(info.data.builtinIds ?? []).includes(id);
      const meta = user ? { name: schema?.name ?? live?.name ?? id, text: schema?.description ?? live?.description ?? '', needs: [] } : describe(capability, value, permitted({ allow: '*', deny: [], ...account?.tools }));
      const active = inspected?.plugins.includes(id);
      const pluginForm = { ...form, effective: { ...form.effective, extensions: { ...form.effective.extensions, settings: { ...form.effective.extensions?.settings, [id]: { ...schema?.defaults, ...form.effective.extensions?.settings?.[id] } } } } };
      return html`<${Card} key=${id} title=${html`<span class="plugin-name"><${Icon} name="plugins" /><span>${meta.name}<small class="muted mono">${id}</small></span></span>`} actions=${html`<${PluginSwitch} label=${meta.name} value=${form.get(`plugins.${id}`)} defaultEnabled=${defaultEnabled} onChange=${next => form.set(`plugins.${id}`, next)} />`}>
        <p>${meta.text}</p>
        ${meta.warn && form.get(`plugins.${id}`) === false ? html`<p class="note error">${meta.warn}</p>` : null}
        <ul class="needs">${meta.needs.map(([ok, text]) => html`<li class=${ok === null ? '' : ok ? 'ok' : 'bad'}>${ok === null ? '·' : ok ? '✓' : '✗'} ${text}</li>`)}</ul>
        <p class="small">${user ? t('User plugin', '用户插件') : t('Built-in', '内置插件')} ${live?.version ?? schema?.version ?? ''}
          ${live ? html` · <${Badge} kind=${live.state === 'running' ? 'ok' : ''}>${stateName(live.state)}<//>` : null}
          ${live?.pending ? html` · <${Badge}>${live.restartRequired ? t('restart required', '需重启应用') : t('pending changes', '有待应用修改')}<//>` : null}
        </p>
        ${schema?.configSchema ? html`<div class="fields">${Object.entries(schema.configSchema.properties ?? {}).map(([key, field]) => html`
          <${ConfigField} key=${key} form=${pluginForm} path=${`extensions.settings.${id}.${key}`} label=${field.title ?? key} help=${field.description}
            type=${field.type === 'boolean' ? 'bool' : field.type === 'integer' ? 'int' : field.type === 'number' ? 'number' : field.type === 'string' ? 'string' : 'json'}
            placeholder=${schema.defaults?.[key] === undefined ? '' : String(schema.defaults[key])} min=${field.minimum} max=${field.maximum} />
        `)}</div>` : html`<p class="small">${t('Saved configuration: ', '已保存的配置下：')}${inspected ? active ? t('enabled', '已启用') : t('not enabled', '未启用') : '—'}</p>`}
        ${info.data.errors?.[id] ? html`<p class="note error">${info.data.errors[id]}</p>` : null}
        ${live?.error ? html`<p class="note error">${live.error}</p>` : null}
        <div class="row wrap"><button class="ghost" disabled=${!running?.ready || busy || form.dirty || live?.restartRequired} onClick=${() => reload(id)}>${live?.restartRequired ? t('Restart to apply', '重启后应用') : t('Reload', '重载')}</button>
          ${live?.loadedAt ? html`<span class="muted small">${t('Loaded ', '加载于 ')}${time(live.loadedAt)}</span>` : null}
        </div>
      <//>`;
    })}</div>
    <div hidden=${tab !== 'web'}><${Card} title=${t('Web access', '联网')}>
      <div class="fields">
        <${ConfigField} form=${form} path="web.enabled" type="bool" label=${t('Web tools on', '开启联网工具')} />
        <${ConfigField} form=${form} path="web.searchUrl" label=${t('Search endpoint', '搜索接口')} />
        <${ConfigField} form=${form} path="web.searchKeyEnv" label=${t('Search credential', '搜索凭据名称')} />
        <${ConfigField} form=${form} path="web.timeoutMs" type="ms" label=${t('Timeout (ms)', '超时（毫秒）')} />
        <${ConfigField} form=${form} path="web.maxBytes" type="int" label=${t('Largest page (bytes)', '网页大小上限（字节）')} />
      </div>
    <//>
    </div><div hidden=${tab !== 'permissions'}>${accounts.map(account => html`<${Permissions} key=${account.id} form=${form} account=${account} />`)}</div>
    ${inspected ? html`<${ContextNote} context=${inspected} />` : null}
    <${SaveBar} form=${form} onSaved=${info.reload} savedMessage=${t('Saved. Restart for account permissions; reload ordinary plugins.', '已保存。账号权限需重启，普通插件可重载。')} />`;
}
