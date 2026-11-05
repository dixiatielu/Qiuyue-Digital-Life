import { api, Badge, Card, ConfigField, failed, html, Loading, PageHeader, Modal, SaveBar, Tabs, t, toast, useAsync, useConfigDraft, useEffect, useState } from '../lib.js';

const apis = [['openai-completions', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic-messages', 'Anthropic Messages'], ['google-generative-ai', 'Gemini (native)']];
const geminiBaseHelp = () => t('Include the API version, e.g. https://generativelanguage.googleapis.com/v1beta, or your gateway’s equivalent path.', '地址须包含 API 版本，例如 https://generativelanguage.googleapis.com/v1beta，或网关对应的路径。');
const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const sameEndpoint = (profile, section) => section?.baseUrl && profile.apiKeyEnv === section.apiKeyEnv && (!section.api || profile.api === section.api) && new URL(profile.baseUrl).href.replace(/\/+$/, '') === new URL(section.baseUrl).href.replace(/\/+$/, '');
const safeSame = (profile, section) => { try { return sameEndpoint(profile, section); } catch { return false; } };

function ModelList({ models, id, value }) {
  // Keep candidates in sync with the input instead of relying on native popup filtering.
  const query = (value ?? '').trim().toLowerCase();
  const matches = (models ?? []).filter(model => model.toLowerCase().includes(query));
  return html`<datalist id=${id}>${matches.map(model => html`<option key=${model} value=${model} />`)}</datalist>`;
}
async function listModels(profile, set) {
  try { const { models } = await api('/api/providers/models', { method: 'POST', body: { provider: profile } }); set(models); toast(t(`${models.length} models`, `${models.length} 个模型`), 'ok'); }
  catch (error) { failed(error); }
}

function ProviderEditor({ profile, secrets, onSave, onClose }) {
  const [draft, setDraft] = useState(profile);
  const [compat, setCompat] = useState(profile.compat ? JSON.stringify(profile.compat, null, 2) : '');
  const [models, setModels] = useState(null);
  const field = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const parsed = () => { if (!compat.trim()) return undefined; return JSON.parse(compat); };
  const save = () => { try { const { compat: _old, ...rest } = draft; const value = parsed(); onSave({ ...rest, ...(value ? { compat: value } : {}) }); } catch (error) { failed(error); } };
  return html`<${Modal} title=${profile.name ? t(`Provider: ${profile.name}`, `供应商：${profile.name}`) : t('New provider', '新供应商')} onClose=${onClose}
    footer=${html`<button class="ghost" onClick=${() => listModels(draft, setModels)}>${t('Test: list models', '测试：获取模型列表')}</button><button class="primary" onClick=${save}>${t('Save provider', '保存供应商')}</button>`}>
    <div class="fields">
      <div class="field"><div class="field-label"><label>${t('Name', '名称')}</label></div><input value=${draft.name} onInput=${event => field('name', event.currentTarget.value)} /></div>
      <div class="field"><div class="field-label"><label>API</label></div><select value=${draft.api} onChange=${event => field('api', event.currentTarget.value)}>${apis.map(([id, name]) => html`<option value=${id}>${name}</option>`)}</select></div>
      <div class="field"><div class="field-label"><label>${t('Base URL', '接口地址')}</label></div><input value=${draft.baseUrl} placeholder=${draft.api === 'google-generative-ai' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.example.com/v1'} onInput=${event => field('baseUrl', event.currentTarget.value)} spellcheck="false" />
        ${draft.api === 'google-generative-ai' ? html`<div class="field-help">${geminiBaseHelp()}</div>` : null}</div>
      <div class="field"><div class="field-label"><label>${t('Credential name', '凭据名称')}</label></div><input list="secret-names" value=${draft.apiKeyEnv} onInput=${event => field('apiKeyEnv', event.currentTarget.value)} spellcheck="false" />
        <datalist id="secret-names">${secrets.map(secret => html`<option value=${secret.name} />`)}</datalist>
        <div class="field-help">${secrets.find(secret => secret.name === draft.apiKeyEnv)?.set ? html`<${Badge} kind="ok">${t('set', '已设置')}<//>` : html`<${Badge} kind="warn">${t('not set — add it under credentials', '未设置——请在下方凭据中添加')}<//>`}</div></div>
      <div class="field wide"><div class="field-label"><label>compat</label></div><textarea class="mono" rows="5" value=${compat} placeholder=${'{ "supportsDeveloperRole": false }'} onInput=${event => setCompat(event.currentTarget.value)}></textarea>
        <div class="field-help">${draft.api === 'google-generative-ai' ? t('Leave empty for Gemini native.', 'Gemini 原生格式请留空。') : t('Options for gateways that differ from the reference API, copied into a custom model with the endpoint.', '用于与标准接口有差异的网关，选用此供应商时会随地址一起填入自定义模型。')}</div></div>
    </div>
    ${models ? html`<div class="chips">${models.map(model => html`<span class="chip mono">${model}</span>`)}</div>` : null}
  <//>`;
}

function Providers({ profiles, secrets, form, assignments }) {
  const [editing, setEditing] = useState(null);
  const save = async next => {
    try { const result = await api('/api/providers', { method: 'PUT', body: { providers: next } }); profiles.set(result); setEditing(null); toast(t('Providers saved.', '供应商已保存。'), 'ok'); }
    catch (error) { failed(error); }
  };
  const list = profiles.data.providers;
  const uses = profile => [
    ['model', form.draft?.model], ['review.model', assignments?.review.thinking ?? form.draft?.review?.model],
    ['compaction:main', assignments?.main.compaction ?? form.draft?.compaction?.model], ['compaction:review', assignments?.review.compaction],
    ['embedding', form.draft?.embedding], ['drawing', form.draft?.drawing],
  ].filter(([, section]) => safeSame(profile, section)).map(([name]) => name);
  return html`<${Card} title=${t('Providers', '模型供应商')} actions=${html`<button onClick=${() => setEditing({ id: crypto.randomUUID(), name: '', api: 'openai-completions', baseUrl: '', apiKeyEnv: 'MODEL_API_KEY' })}>${t('Add provider', '添加供应商')}</button>`}>
    <p class="muted small">${t('Endpoints you keep for choosing models. The daemon reads only config.json: choosing a provider below copies its address, API, and key variable into the model, embedding, or drawing settings.', '保存常用的接口端点，方便选择模型。常驻进程只读 config.json：在下方选择供应商时，会把它的地址、API 和密钥变量复制到模型、embedding 或画图设置里。')}</p>
    ${list.length ? html`<table class="table"><thead><tr><th>${t('Name', '名称')}</th><th>API</th><th>${t('Base URL', '接口地址')}</th><th>${t('Key', '密钥')}</th><th>${t('Used by', '使用中')}</th><th></th></tr></thead><tbody>
      ${list.map(profile => html`<tr><td><strong>${profile.name}</strong></td><td class="small">${profile.api}</td><td class="mono small">${profile.baseUrl}</td>
        <td class="mono small">${profile.apiKeyEnv} ${secrets.find(secret => secret.name === profile.apiKeyEnv)?.set ? html`<${Badge} kind="ok">✓<//>` : html`<${Badge} kind="warn">${t('missing', '缺失')}<//>`}</td>
        <td>${uses(profile).map(name => html`<${Badge} kind="info">${name}<//> `)}</td>
        <td class="nowrap"><button class="ghost tiny" onClick=${() => setEditing(profile)}>${t('Edit', '编辑')}</button><button class="ghost tiny danger" onClick=${() => confirm(t(`Remove ${profile.name}?`, `删除 ${profile.name}？`)) && save(list.filter(item => item.id !== profile.id))}>${t('Remove', '删除')}</button></td></tr>`)}
    </tbody></table>` : html`<p class="muted">${t('No providers yet.', '还没有供应商。')}</p>`}
    ${editing ? html`<${ProviderEditor} profile=${editing} secrets=${secrets} onClose=${() => setEditing(null)} onSave=${profile => save(list.some(item => item.id === profile.id) ? list.map(item => item.id === profile.id ? profile : item) : [...list, profile])} />` : null}
  <//>`;
}

function FromProvider({ profiles, onPick, label }) {
  return html`<select value="" onChange=${event => { const profile = profiles.find(item => item.id === event.currentTarget.value); if (profile) onPick(profile); }}>
    <option value="">${label ?? t('Fill from a provider…', '从供应商填入…')}</option>${profiles.map(profile => html`<option value=${profile.id}>${profile.name}</option>`)}</select>`;
}

/** Resolve draft inheritance on the server through the same module used by the daemon. Ignore stale replies. */
function useModelAssignments(draft, credentialRevision) {
  const key = JSON.stringify([draft, credentialRevision]);
  const [result, setResult] = useState({});
  useEffect(() => {
    if (!draft) return;
    let active = true;
    const timer = setTimeout(() => {
      api('/api/models/resolve', { method: 'POST', body: { raw: draft } }).then(
        data => { if (active) setResult({ key, data }); },
        error => { if (active) setResult({ key, error }); },
      );
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);
  return result.key === key ? result : {};
}

function ModelRole({ form, profiles, path, title, help, targets = [] }) {
  const independent = form.get(path) !== undefined;
  const [test, setTest] = useState(null);
  const run = async target => {
    setTest({ running: true });
    try { setTest(await api('/api/test/model', { method: 'POST', body: { model: target.model } })); }
    catch (error) { setTest({ error: error.message }); }
  };
  return html`<div class="stack">
    <${Card} title=${title}>
      <p class="muted small">${help}</p>
      <label class="check"><input type="checkbox" checked=${independent} disabled=${!independent && !targets.length} onChange=${event => { setTest(null); form.set(path, event.currentTarget.checked ? structuredClone(targets[0].model) : undefined); }} />${t('Configure independently', '独立配置')}</label>
      ${!independent ? targets.length ? html`<div class="stack">${targets.map(target => html`<div class="row wrap"><span>${target.label} · ${t('following', '跟随')} <code>${target.source}</code>: <strong>${target.model.provider}/${target.model.id}</strong> · <code>${target.model.apiKeyEnv}</code></span><button class="ghost tiny" disabled=${test?.running} onClick=${() => run(target)}>${t('Test connection', '测试连接')}</button></div>`)}</div>` : html`<p class="muted small">${t('Effective models appear after the configuration is valid.', '配置有效后会显示实际使用的模型。')}</p>` : null}
      ${test && !test.running ? test.error ? html`<p class="note error">${test.error}</p>` : html`<p class="note ok">${test.ms} ms · ${test.text || test.stopReason}</p>` : null}
    <//>
    ${independent ? html`<${ModelEditor} form=${form} profiles=${profiles} path=${path} title=${title} help=${t('Uses its own model, endpoint, credential, and reasoning setting. Takes effect after restart; the primary working context is retained.', '独立使用模型、端点、凭据和推理设置。重启后生效，保留主思考的工作上下文。')} />` : null}
  </div>`;
}

function ModelEditor({ form, profiles, path = 'model', title = t('Primary thinking', '主思考'), help = t('Everyday thinking and actions. Changing this model starts a fresh working context after restart.', '日常思考与行动使用的模型。更换后，重启时会新建工作上下文。') }) {
  const model = form.get(path) ?? {};
  const listId = `${path.replaceAll('.', '-')}-models`;
  const custom = Boolean(model.api);
  const [models, setModels] = useState(null);
  const [test, setTest] = useState(null);
  const providers = useAsync(() => custom ? Promise.resolve(null) : api('/api/catalog'), [custom]);
  const catalog = useAsync(() => custom || !model.provider ? Promise.resolve(null) : api(`/api/catalog?provider=${encodeURIComponent(model.provider)}`), [custom, model.provider]);
  const setModel = next => form.set(path, next);
  const toCatalog = () => { const { api: _a, input: _i, contextWindow: _c, maxTokens: _m, reasoning: _r, compat: _p, baseUrl: _b, ...rest } = model; setModel(rest); };
  const toCustom = () => setModel({ ...model, api: 'openai-completions', baseUrl: model.baseUrl ?? '', input: ['text', 'image'], contextWindow: model.contextWindow ?? 131072, maxTokens: model.maxTokens ?? 32768 });
  const pick = profile => { const { compat: _old, ...rest } = model; setModel({ ...rest, provider: profile.name, api: profile.api, baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv, ...(profile.compat ? { compat: profile.compat } : {}) }); };
  const run = async () => {
    setTest({ running: true });
    try { setTest(await api('/api/test/model', { method: 'POST', body: { model } })); } catch (error) { setTest({ error: error.message }); }
  };
  const input = model.input ?? [];
  return html`<${Card} title=${title} actions=${html`<button onClick=${run} disabled=${test?.running}>${test?.running ? t('Testing…', '测试中…') : t('Send a test request', '发送测试请求')}</button>`}>
    <p class="muted small">${help}</p>
    ${test && !test.running ? test.error ? html`<p class="note error">${test.error}</p>` : html`<p class="note ok">${t(`Answered in ${test.ms} ms`, `${test.ms} 毫秒内回复`)}: <span class="mono">${test.text || t('(no text)', '（无文字）')}</span> · ${test.stopReason}</p>` : null}
    <div class="row wrap">
      <label class="check"><input type="radio" checked=${!custom} onChange=${toCatalog} />${t('From the Pi catalog', 'Pi 内置模型目录')}</label>
      <label class="check"><input type="radio" checked=${custom} onChange=${toCustom} />${t('Custom endpoint', '自定义端点')}</label>
      ${custom ? html`<${FromProvider} profiles=${profiles} onPick=${pick} />` : null}
    </div>
    <div class="fields">
      ${custom ? html`<${ConfigField} form=${form} path=${`${path}.provider`} label=${t('Provider name', '供应商名称')} help=${t('Any name for a custom endpoint.', '自定义端点可以任意命名。')} />`
        : html`<div class="field"><div class="field-label"><label>${t('Provider', '供应商')}</label></div><select value=${model.provider ?? ''} onChange=${event => setModel({ ...model, provider: event.currentTarget.value, id: '' })}>
          <option value="">—</option>${(providers.data?.providers ?? []).map(id => html`<option value=${id}>${id}</option>`)}</select></div>`}
      ${custom ? html`<div class="field"><div class="field-label"><label>${t('Model ID', '模型 ID')}</label></div>
          <div class="row"><input list=${listId} value=${model.id ?? ''} onInput=${event => setModel({ ...model, id: event.currentTarget.value })} spellcheck="false" />
          <button class="ghost tiny" onClick=${() => listModels({ id: path, name: model.provider || 'model', api: model.api, baseUrl: model.baseUrl, apiKeyEnv: model.apiKeyEnv }, setModels)}>${t('List', '获取列表')}</button></div><${ModelList} id=${listId} models=${models} value=${model.id} /></div>`
        : html`<div class="field"><div class="field-label"><label>${t('Model', '模型')}</label></div><select value=${model.id ?? ''} onChange=${event => setModel({ ...model, id: event.currentTarget.value })}>
          <option value="">—</option>${(catalog.data?.models ?? []).map(item => html`<option value=${item.id} disabled=${!item.input.includes('image')}>${item.id}${item.input.includes('image') ? '' : t(' (no images)', '（不支持图片）')}${item.reasoning ? ' · reasoning' : ''}</option>`)}</select></div>`}
      ${custom ? html`
        <${ConfigField} form=${form} path=${`${path}.api`} type="select" options=${apis} label="API" />
        <${ConfigField} form=${form} path=${`${path}.baseUrl`} label=${t('Base URL', '接口地址')} help=${model.api === 'google-generative-ai' ? geminiBaseHelp() : undefined} />` : html`<${ConfigField} form=${form} path=${`${path}.baseUrl`} label=${t('Base URL override', '覆盖接口地址')} help=${t('Optional; leave empty for the provider default.', '可选；留空使用供应商默认地址。')} />`}
      <${ConfigField} form=${form} path=${`${path}.apiKeyEnv`} label=${t('Credential name', '凭据名称')} help=${t('The named credential is used for both catalog models and custom endpoints.', '内置目录模型和自定义端点都使用这里指定的凭据。')} />
      <${ConfigField} form=${form} path=${`${path}.thinkingLevel`} type="select" options=${[['', t('(off)', '（关闭）')], ...thinking.map(level => [level, level])]} label=${t('Thinking level', '思考强度')} help=${t('Only a reasoning model can think; with the OpenAI format, off sends nothing and the model uses its own default.', '只有推理模型可以思考；使用 OpenAI 格式时，off 不发送参数，模型按自身默认强度思考。')} />
      ${custom ? html`
        <div class="field"><div class="field-label"><label>${t('Input', '输入能力')}</label></div><div class="row">
          ${['text', 'image'].map(kind => html`<label class="check"><input type="checkbox" checked=${input.includes(kind)} onChange=${event => setModel({ ...model, input: event.currentTarget.checked ? [...new Set([...input, kind])] : input.filter(item => item !== kind) })} />${kind}</label>`)}</div></div>
        <${ConfigField} form=${form} path=${`${path}.contextWindow`} type="int" label=${t('Context window (tokens)', '上下文窗口（tokens）')} />
        <${ConfigField} form=${form} path=${`${path}.maxTokens`} type="int" label=${t('Largest output (tokens)', '最大输出（tokens）')} />
        <${ConfigField} form=${form} path=${`${path}.reasoning`} type="bool" label=${t('Reasoning model', '推理模型')} />
        <${ConfigField} form=${form} path=${`${path}.compat`} type="json" label="compat" help=${model.api === 'google-generative-ai' ? t('Leave empty for Gemini native.', 'Gemini 原生格式请留空。') : t('Gateway differences, such as maxTokensField or thinkingFormat.', '网关差异设置，例如 maxTokensField、thinkingFormat。')} />` : null}
    </div>
  <//>`;
}

function Endpoint({ form, profiles, section, title, help, fields, testable }) {
  const [models, setModels] = useState(null);
  const [test, setTest] = useState(null);
  const current = { ...form.effective[section], ...form.draft[section] };
  const pick = profile => form.set(section, { ...form.draft[section], baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv });
  const run = async () => {
    setTest({ running: true });
    try { setTest(await api(`/api/test/${section}`, { method: 'POST', body: { [section]: current } })); } catch (error) { setTest({ error: error.message }); }
  };
  return html`<${Card} title=${title} actions=${html`<${FromProvider} profiles=${profiles.filter(profile => profile.api !== 'google-generative-ai')} onPick=${pick} />
      <button class="ghost" onClick=${() => listModels({ id: section, name: section, api: 'openai-completions', baseUrl: current.baseUrl, apiKeyEnv: current.apiKeyEnv }, setModels)}>${t('List models', '获取模型列表')}</button>
      ${testable ? html`<button onClick=${run} disabled=${test?.running}>${t('Test', '测试')}</button>` : null}`}>
    <p class="muted small">${help}</p>
    ${test && !test.running ? test.error ? html`<p class="note error">${test.error}</p>` : html`<p class="note ok">${t(`${test.dimensions} dimensions in ${test.ms} ms`, `${test.ms} 毫秒，${test.dimensions} 维`)}</p>` : null}
    <div class="fields">
      <${ConfigField} form=${form} path=${`${section}.enabled`} type="bool" label=${t('On', '启用')} />
      <${ConfigField} form=${form} path=${`${section}.baseUrl`} label=${t('Base URL', '接口地址')} />
      <div class="field"><div class="field-label"><label>${t('Model', '模型')}</label></div><input list=${`${section}-models`} value=${form.get(`${section}.model`) ?? ''} placeholder=${form.effective[section]?.model ?? ''} onInput=${event => form.set(`${section}.model`, event.currentTarget.value || undefined)} spellcheck="false" /><${ModelList} id=${`${section}-models`} models=${models} value=${form.get(`${section}.model`)} /></div>
      <${ConfigField} form=${form} path=${`${section}.apiKeyEnv`} label=${t('Credential name', '凭据名称')} />
      ${fields.map(field => html`<${ConfigField} form=${form} ...${{ ...field, path: `${section}.${field.path}` }} />`)}
    </div>
  <//>`;
}

function Secrets({ secrets }) {
  const [editing, setOpen] = useState(null);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const setEditing = next => { setValue(''); setReveal(false); setOpen(next); };
  // Typing a new variable's name keeps the value already entered.
  const rename = name => setOpen({ ...editing, name });
  const write = async (name, next) => {
    try { secrets.set(await api('/api/secrets', { method: 'PUT', body: { name, value: next, revision: secrets.data.revision } })); setEditing(null); toast(next === null ? t(`Disabled ${name}. Restart the daemon to use this change.`, `已停用 ${name}，重启常驻进程后生效。`) : t(`Saved ${name}. Restart the daemon to use it.`, `已保存 ${name}，重启常驻进程后生效。`), 'ok'); }
    catch (error) { failed(error); }
  };
  return html`<${Card} title=${t('Credentials', '凭据')} actions=${html`<button onClick=${() => setEditing({ name: '', fresh: true })}>${t('Add credential', '添加凭据')}</button>`}>
    <p class="muted small">${t('Saved separately without value history. Changes apply to connection tests immediately and to the daemon after restart. Restart the management page after changing its login token. External environment credentials are read-only.', '凭据单独保存，不保留旧值历史。连接测试立即使用新值，常驻进程重启后生效。更改网页登录令牌后还需重启管理网页。外部环境提供的凭据只读。')}</p>
    <p class="muted small mono">${secrets.data.file}</p>
    <table class="table"><thead><tr><th>${t('Name', '名称')}</th><th>${t('Used by', '用于')}</th><th>${t('Status', '状态')}</th><th>${t('Source', '来源')}</th><th></th></tr></thead><tbody>
      ${secrets.data.entries.map(secret => html`<tr><td class="mono">${secret.name}</td><td>${secret.usedBy.map(use => html`<${Badge}>${use}<//> `)}</td>
        <td>${secret.set ? html`<span class="mono">${secret.value}</span>` : html`<${Badge} kind="warn">${secret.source === 'file' ? t('disabled', '已停用') : t('not set', '未设置')}<//>`}</td>
        <td>${({ environment: t('External environment', '外部环境'), file: t('Credential file', '凭据文件'), missing: '—' })[secret.source]}</td>
        <td class="nowrap">${secret.writable ? html`<button class="ghost tiny" onClick=${() => setEditing(secret)}>${secret.set ? t('Replace', '更换') : t('Set', '设置')}</button>
          ${secret.set ? html`<button class="ghost tiny danger" onClick=${() => confirm(t(`Disable ${secret.name}?`, `停用 ${secret.name}？`)) && write(secret.name, null)}>${t('Disable', '停用')}</button>` : null}` : html`<span class="muted small">${t('Read-only', '只读')}</span>`}</td></tr>`)}
    </tbody></table>
    ${editing ? html`<${Modal} title=${editing.fresh ? t('Add a credential', '添加凭据') : editing.name} onClose=${() => setEditing(null)}
      footer=${html`<button class="ghost" onClick=${() => setEditing(null)}>${t('Cancel', '取消')}</button><button class="primary" disabled=${!editing.name || !value} onClick=${() => write(editing.name, value)}>${t('Save', '保存')}</button>`}>
      ${editing.fresh ? html`<div class="field"><div class="field-label"><label>${t('Name', '名称')}</label></div><input class="mono" value=${editing.name} onInput=${event => rename(event.currentTarget.value.trim())} placeholder="MY_API_KEY" /></div>` : null}
      <div class="field"><div class="field-label"><label>${t('Value', '值')}</label></div><div class="row"><input class="mono" type=${reveal ? 'text' : 'password'} autocomplete="off" value=${value} onInput=${event => setValue(event.currentTarget.value)} />
        <button class="ghost tiny" onClick=${() => setReveal(!reveal)}>${reveal ? t('Hide', '隐藏') : t('Show', '显示')}</button></div></div>
    <//>` : null}
  <//>`;
}

export function ModelsPage() {
  const [tab, setTab] = useState('main');
  const form = useConfigDraft();
  const profiles = useAsync(() => api('/api/providers'));
  const secrets = useAsync(() => api('/api/secrets'));
  const resolved = useModelAssignments(form.draft, secrets.data?.revision);
  if (!form.state.data || !profiles.data || !secrets.data) return html`<${Loading} state=${!form.state.data ? form.state : !profiles.data ? profiles : secrets} />`;
  if (!form.raw) return html`<p class="note error">${t('config.json is not valid JSON; repair it on the configuration page first.', 'config.json 不是有效的 JSON，请先在配置页修复。')}</p>`;
  if (!form.draft) return html`<${Loading} state=${form.state} />`;
  const list = profiles.data.providers;
  const assignments = resolved.data;
  const reviewTargets = assignments ? [{ label: t('Review', '复盘'), model: assignments.review.thinking, source: assignments.review.thinkingSource }] : [];
  const summaryTargets = assignments ? ['main', 'review'].map(owner => ({ label: owner === 'main' ? t('Primary context', '主思考上下文') : t('Review context', '复盘上下文'), model: { ...assignments[owner].compaction, thinkingLevel: assignments[owner].compactionThinkingLevel }, source: assignments[owner].compactionSource })) : [];
  return html`
    <${PageHeader} title=${t('Models & connections', '模型与连接')} eyebrow="MODELS & PROVIDERS" description=${t('Configure thinking, recall and drawing in one place.', '为思考、回忆和创作，选择合适的模型。')} />
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['main', t('Primary thinking', '主思考')], ['review', t('Memory review', '记忆复盘')], ['compaction', t('Context compaction', '上下文压缩')], ['embedding', 'Embedding'], ['drawing', t('Drawing', '画图模型')], ['providers', t('Providers', '供应商')], ['credentials', t('Credentials', '凭据')]]} />
    ${resolved.error ? html`<p class="note error">${resolved.error.message}</p>` : assignments?.readiness.problems.length ? html`<div class="note warn">${assignments.readiness.problems.map(problem => html`<div>${problem}</div>`)}</div>` : null}
    <div hidden=${tab !== 'providers'}><${Providers} profiles=${profiles} secrets=${secrets.data.entries} form=${form} assignments=${assignments} /></div>
    <div hidden=${tab !== 'main'}><${ModelEditor} form=${form} profiles=${list} /></div>
    <div hidden=${tab !== 'review'} class="stack">
      <${ModelRole} form=${form} profiles=${list} path="review.model" title=${t('Memory review', '记忆复盘')} help=${t('Follows the primary model unless configured independently. Reviews share her persona and memory and cannot send messages.', '默认跟随主模型，也可以独立配置。复盘共享她的人格与记忆，不能发送消息。')} targets=${reviewTargets} />
      <${Card} title=${t('Review context', '复盘上下文')}><div class="fields">
        <${ConfigField} form=${form} path="review.limits.contextTokens" type="int" label=${t('Context window used (tokens)', '使用的上下文窗口（tokens）')} placeholder=${form.get('limits.contextTokens') ?? form.effective.limits?.contextTokens} help=${t('Unset follows the primary context cap.', '不设置则跟随主思考窗口上限。')} />
        <${ConfigField} form=${form} path="review.limits.outputReserveTokens" type="int" label=${t('Output reserve (tokens)', '输出预留（tokens）')} placeholder=${form.get('limits.outputReserveTokens') ?? form.effective.limits?.outputReserveTokens} help=${t('Unset follows the primary output reserve.', '不设置则跟随主思考输出预留。')} />
      </div><//>
    </div>
    <div hidden=${tab !== 'compaction'} class="stack">
      <${ModelRole} form=${form} profiles=${list} path="compaction.model" title=${t('Context compaction', '上下文压缩')} help=${t('By default, each context uses its own model for summaries. An independent model summarizes both contexts.', '默认各自使用所属上下文的模型。独立配置后，主思考和复盘都由指定模型生成摘要。')} targets=${summaryTargets} />
      <${Card} title=${t('Summary budget', '摘要预算')}><div class="fields">
        <${ConfigField} form=${form} path="compaction.contextTokens" type="int" label=${t('Summary request window (tokens)', '摘要请求窗口（tokens）')} help=${t('Unset follows each owner. The generated summary must still fit that owner’s context.', '不设置则跟随各自上下文。生成结果仍须符合原上下文的预算。')} />
        <${ConfigField} form=${form} path="compaction.summaryMaxTokens" type="int" label=${t('Summary length limit (tokens)', '摘要长度上限（tokens）')} />
      </div><//>
    </div>
    <div hidden=${tab !== 'embedding'}>
    <${Endpoint} form=${form} profiles=${list} section="embedding" testable title=${t('Embedding (recall by meaning)', 'Embedding（按语义想起）')}
      help=${t('An OpenAI-compatible /embeddings endpoint. Each threshold belongs to the model and must be calibrated again for another; these were set for qwen3-vl-embedding.', '兼容 OpenAI 的 /embeddings 接口。每个阈值都取决于模型，换模型需要重新校准；当前默认值按 qwen3-vl-embedding 校准。')}
      fields=${[
        { path: 'threshold', type: 'number', step: 0.01, label: t('Spontaneous recall threshold', '自动想起阈值') },
        { path: 'searchThreshold', type: 'number', step: 0.01, label: t('Deliberate recall threshold', '主动回忆阈值') },
        { path: 'limit', type: 'int', label: t('Memories per thought', '每次想起的记忆数') },
        { path: 'stickerThreshold', type: 'number', step: 0.01, label: t('Sticker suggestion threshold', '表情推荐阈值') },
        { path: 'stickerLimit', type: 'int', label: t('Stickers per observation', '每次推荐的表情数') },
        { path: 'timeoutMs', type: 'ms', label: t('Timeout (ms)', '超时（毫秒）') },
        { path: 'selfNames', type: 'list', label: t('Names people call her', '别人对她的称呼'), help: t('One per line; these are left out when matching, so being named does not match every memory that names her.', '每行一个；匹配时会忽略这些称呼，避免消息因为提到她就匹配上所有提到她的记忆。') },
      ]} />
    </div><div hidden=${tab !== 'drawing'}>
    <${Endpoint} form=${form} profiles=${list} section="drawing" title=${t('Drawing', '画画')}
      help=${t('An OpenAI-compatible /images/generations endpoint for the drawing plugin. Drawings take half a minute or more and are not limited in number; mind the endpoint quota.', '供画画插件使用的兼容 OpenAI 的 /images/generations 接口。画一张图要半分钟以上，次数不设上限，请留意接口额度。')}
      fields=${[{ path: 'timeoutMs', type: 'ms', label: t('Timeout (ms)', '超时（毫秒）') }, { path: 'dir', label: t('Folder for drawings', '保存目录') }]} />
    </div><div hidden=${tab !== 'credentials'}><${Secrets} secrets=${secrets} /></div>
    <${SaveBar} form=${form} onSaved=${() => { profiles.reload(); secrets.reload(); }} />`;
}
