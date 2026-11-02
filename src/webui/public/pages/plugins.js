import { api, Badge, Card, ConfigField, ContextNote, getPath, html, Loading, SaveBar, t, useAsync, useConfigDraft, useMemo, useState } from '../lib.js';

const permitted = tools => name => !(tools.deny ?? []).includes(name) && (tools.allow === '*' || (tools.allow ?? []).includes(name));

/** What each installed plugin does and what it needs beyond its switch (docs/plugins.md). */
function describe(id, value, allowed) {
  const has = path => value(path);
  const web = has('web.enabled');
  return ({
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

function Tri({ value, onChange }) {
  const options = [[undefined, t('Default', '默认')], [true, t('On', '开')], [false, t('Off', '关')]];
  return html`<div class="segmented">${options.map(([option, label]) => html`<button class=${value === option ? 'active' : ''} onClick=${() => onChange(option)}>${label}</button>`)}</div>`;
}

function Permissions({ form }) {
  const catalog = useAsync(() => api('/api/snowluma'));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [view, setView] = useState('all');
  const tools = form.get('snowluma.tools') ?? form.effective.snowluma?.tools ?? { allow: '*', deny: [] };
  const allowed = permitted(tools);
  const actions = catalog.data?.actions ?? [];
  const categories = useMemo(() => [...new Set(actions.map(action => action.category ?? ''))].filter(Boolean), [actions]);
  if (!catalog.data) return html`<${Loading} state=${catalog} />`;
  const write = next => form.set('snowluma.tools', { allow: next.allow, deny: [...new Set(next.deny)].sort() });
  const toggle = (name, on) => {
    if (tools.allow === '*') write({ allow: '*', deny: on ? tools.deny.filter(item => item !== name) : [...tools.deny, name] });
    else write({ allow: on ? [...new Set([...tools.allow, name])].sort() : tools.allow.filter(item => item !== name), deny: on ? tools.deny.filter(item => item !== name) : tools.deny });
  };
  const needle = query.trim().toLowerCase();
  const shown = actions.filter(action => (!category || action.category === category) && (!needle || action.name.toLowerCase().includes(needle) || (action.summary ?? '').toLowerCase().includes(needle))
    && (view === 'all' || (view === 'allowed') === allowed(action.name) || (view === 'readonly' && action.readOnly)));
  const count = actions.filter(action => allowed(action.name)).length;
  return html`<${Card} title=${t('QQ interface permissions', 'QQ 接口权限')} actions=${html`<span class="muted small">${t(`${count} of ${actions.length} allowed`, `已允许 ${count} / ${actions.length}`)}</span>`}>
    <p class="muted small">${t('Native SnowLuma interfaces she may call, by their original names. Read-only queries and actions are both subject to these. A plugin switch never grants an interface.', '她可以按原名调用的 SnowLuma 原生接口。只读查询和行动都受这里限制。插件开关不会授予接口权限。')}
      ${' '}SDK ${catalog.data.source.sdkVersion}</p>
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
  const form = useConfigDraft();
  const info = useAsync(() => api('/api/plugins'));
  if (!form.state.data || !info.data) return html`<${Loading} state=${form.state.data ? info : form.state} />`;
  if (!form.raw) return html`<p class="note error">${t('config.json is not valid JSON; repair it on the configuration page first.', 'config.json 不是有效的 JSON，请先在配置页修复。')}</p>`;
  const value = path => form.get(path) ?? getPath(form.effective, path);
  const allowed = permitted(form.get('snowluma.tools') ?? form.effective.snowluma?.tools ?? { allow: '*', deny: [] });
  const inspected = info.data.inspected;
  const credentials = inspected?.credentials ?? { problems: [], warnings: [] };
  return html`
    <header class="page-head"><h1>${t('Plugins', '插件')}</h1></header>
    <p class="muted">${t('Plugins are modules built into this program; here they are switched on and off. Default leaves each to its own rule. Turning one on or off changes her tool set, so the next start begins a fresh working context.', '插件是程序内置的模块，这里只能开关。“默认”按插件自己的规则决定。开关插件会改变她的工具集，下次启动时工作上下文会重新开始。')}</p>
    ${[...credentials.problems, ...credentials.warnings].map(text => html`<p class=${`note ${credentials.problems.includes(text) ? 'error' : 'warn'}`}>${text}</p>`)}
    <div class="plugin-grid">${info.data.ids.map(id => {
      const meta = describe(id, value, allowed);
      const active = inspected?.plugins.includes(id);
      return html`<${Card} key=${id} title=${html`${meta.name} <span class="muted mono small">${id}</span>`} actions=${html`<${Tri} value=${form.get(`plugins.${id}`)} onChange=${next => form.set(`plugins.${id}`, next)} />`}>
        <p>${meta.text}</p>
        ${meta.warn && form.get(`plugins.${id}`) === false ? html`<p class="note error">${meta.warn}</p>` : null}
        <ul class="needs">${meta.needs.map(([ok, text]) => html`<li class=${ok === null ? '' : ok ? 'ok' : 'bad'}>${ok === null ? '·' : ok ? '✓' : '✗'} ${text}</li>`)}</ul>
        <p class="small">${t('Saved configuration: ', '已保存的配置下：')}${inspected ? active ? html`<${Badge} kind="ok">${t('enabled', '已启用')}<//>` : html`<${Badge} kind="bad">${t('not enabled', '未启用')}<//>` : '—'}</p>
      <//>`;
    })}</div>
    <${Card} title=${t('Web access', '联网')}>
      <div class="fields">
        <${ConfigField} form=${form} path="web.enabled" type="bool" label=${t('Web tools on', '开启联网工具')} />
        <${ConfigField} form=${form} path="web.searchUrl" label=${t('Search endpoint', '搜索接口')} />
        <${ConfigField} form=${form} path="web.searchKeyEnv" label=${t('Search key variable', '搜索密钥环境变量')} />
        <${ConfigField} form=${form} path="web.timeoutMs" type="ms" label=${t('Timeout (ms)', '超时（毫秒）')} />
        <${ConfigField} form=${form} path="web.maxBytes" type="int" label=${t('Largest page (bytes)', '网页大小上限（字节）')} />
      </div>
    <//>
    <${Permissions} form=${form} />
    ${inspected ? html`<${ContextNote} context=${inspected} />` : null}
    <${SaveBar} form=${form} onSaved=${info.reload} />`;
}
