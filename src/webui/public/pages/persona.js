import { api, Badge, Card, ContextNote, DiffView, failed, html, Loading, PageHeader, Modal, t, Tabs, time, toast, useAsync, useMemo, useState } from '../lib.js';
import { Markdown } from '../markdown.js';

/** Versions kept for one of the operator's files, newest first, each comparable with the editor. */
export function History({ kind, current, onLoad, saved }) {
  // saved is the hash of the file as last loaded, so a save brings its new version into the list.
  const list = useAsync(() => api(`/api/history/${kind}`), [kind, saved]);
  const [open, setOpen] = useState(null);
  const view = async item => { try { setOpen({ ...item, text: (await api(`/api/history/${kind}/${item.id}`)).text }); } catch (error) { failed(error); } };
  return html`<${Card} title=${t('Versions', '历史版本')} actions=${html`<button class="ghost tiny" aria-label=${t('Refresh versions', '刷新历史版本')} title=${t('Refresh versions', '刷新历史版本')} onClick=${list.reload}>${t('Refresh', '刷新')}</button>`}>
    ${list.data?.length ? html`<ul class="versions">${list.data.map((item, index) => html`<li><button class="link" onClick=${() => view(item)}>${time(item.at)}</button>${index === 0 ? html` <${Badge}>${t('latest', '最新')}<//>` : null}<span class="muted small"> ${item.size} B</span></li>`)}</ul>`
      : html`<p class="muted small">${t('Each save keeps the version before and after it.', '每次保存都会保留修改前后的版本。')}</p>`}
    ${open ? html`<${Modal} wide title=${`${t('Version', '版本')} ${time(open.at)}`} onClose=${() => setOpen(null)}
      footer=${html`<button class="ghost" onClick=${() => setOpen(null)}>${t('Close', '关闭')}</button><button class="primary" onClick=${() => { onLoad(open.text); setOpen(null); toast(t('Loaded into the editor; save to use it.', '已载入编辑器，保存后生效。')); }}>${t('Load into editor', '载入编辑器')}</button>`}>
      <p class="muted small">${t('From this version to what the editor holds now:', '从这个版本到编辑器当前内容：')}</p>
      <${DiffView} before=${open.text} after=${current} />
    <//>` : null}
  <//>`;
}

function PersonaFile({ tab, onEdit }) {
  const file = useAsync(() => api('/api/persona'));
  const [text, setText] = useState(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!file.data) return html`<${Loading} state=${file} />`;
  const value = text ?? file.data.text;
  const dirty = text !== null && text !== file.data.text;
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('/api/persona', { method: 'PUT', body: { text: value, hash: file.data.hash } });
      setResult(saved); setReview(false); setText(null); await file.reload();
      toast(t('Persona saved. Restart the daemon to use it.', '人格已保存，重启常驻进程后生效。'), 'ok');
    } catch (error) { failed(error); } finally { setBusy(false); }
  };
  return html`<div class=${tab === 'history' ? '' : 'editor-layout'}>
    <div hidden=${tab === 'history'} class="stack">
      <${Card} class="editor-surface" title=${html`<span class="mono">${file.data.path}</span>`}>
        <textarea class="editor" aria-label=${t('Core persona editor', '核心人格编辑器')} spellcheck="false" value=${value} onInput=${event => setText(event.currentTarget.value)}></textarea>
        <div class="editor-status"><span>Markdown · UTF-8</span><span>${t(`${[...value].length} characters`, `${[...value].length} 字`)}</span></div>
        <div class="editor-actions"><span class="muted small spacer">${dirty ? t('Unsaved changes', '有未保存的修改') : t('No unsaved changes', '没有未保存的修改')}</span>
          <button class="ghost" disabled=${!dirty} onClick=${() => setText(null)}>${t('Discard', '放弃')}</button>
          <button class="primary" disabled=${!dirty || !value.trim()} onClick=${() => setReview(true)}>${t('Review and save…', '检查并保存…')}</button>
        </div>
      <//>
      ${result ? html`<${ContextNote} context=${result.context} />` : null}
    </div>
    <aside class="stack">
      <div hidden=${tab === 'history'}><${Card} title=${t('About the core persona', '关于核心人格')}>
        <p class="muted small">${t('You set her identity, background and core values. Her own habits develop through experience without overriding this file.', '她的身份、背景和核心价值观由你设定。她从经历中形成自己的习惯，但不会覆盖这里的设定。')}</p>
        <h3>${t('After saving', '修改如何生效')}</h3><p class="muted small">${t('Restart to apply. The working context starts afresh; memories, development and continuing state are kept.', '重启后生效，工作上下文会重新开始；记忆、发展和持续状态都保留。')}</p>
      <//></div>
      <${History} kind="persona" current=${value} onLoad=${text => { setText(text); onEdit(); }} saved=${file.data.hash} />
    </aside>
    ${review ? html`<${Modal} wide title=${t('Save the persona', '保存人格')} onClose=${() => setReview(false)}
      footer=${html`<button class="ghost" onClick=${() => setReview(false)}>${t('Cancel', '取消')}</button><button class="primary" disabled=${busy} onClick=${save}>${t('Save', '保存')}</button>`}>
      <p class="note warn">${t('The next start begins a fresh working context. Memories, development, and continuing state are kept.', '下次启动时工作上下文会重新开始。记忆、发展和持续状态都保留。')}</p>
      <${DiffView} before=${file.data.text} after=${value} />
    <//>` : null}
  </div>`;
}

const kindLabel = kind => ({ habit: t('Habit', '习惯'), practice: t('Practice', '惯例'), impression: t('Impression', '印象') })[kind] ?? kind;
const scopeLabel = entry => entry.scope === 'global' || !entry.scope ? t('everywhere', '全局') : `${entry.scope}${entry.scopeName ? ` · ${entry.scopeName}` : ''}`;

function MemoryDetail({ id, onClose }) {
  const detail = useAsync(() => api(`/api/memory/${encodeURIComponent(id)}`), [id]);
  return html`<${Modal} wide title=${t('Memory', '记忆')} onClose=${onClose}>
    ${!detail.data ? html`<${Loading} state=${detail} />` : html`
      <h3>${detail.data.memory.title}</h3><${Markdown} text=${detail.data.memory.content} />
      <p class="muted small mono">${detail.data.memory.id} · ${time(detail.data.memory.createdAt)}</p>
      <h3>${t('Sources', '依据')}</h3>
      <ul class="plain">${detail.data.sources.map(source => html`<li><span class="mono small">${source.id}</span> <${Badge}>${source.kind}<//> <span class="muted small">${time(source.at)}</span><div class="small pre clamp">${source.text}</div></li>`)}</ul>
      ${detail.data.versions.length ? html`<h3>${t('Earlier versions', '早先的版本')}</h3>${detail.data.versions.map((version, index) => html`<details><summary>${time(version.createdAt)} · ${version.title}</summary>
        <${DiffView} before=${version.content} after=${index === 0 ? detail.data.memory.content : detail.data.versions[index - 1].content} /></details>`)}` : null}`}
  <//>`;
}

function Correct({ entry, onClose, onDone }) {
  const [content, setContent] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api(`/api/memory/${encodeURIComponent(entry.id)}/correct`, { method: 'POST', body: { content } }); toast(t('Corrected; the old version is kept.', '已修正，旧版本保留。'), 'ok'); onDone(); }
    catch (error) { failed(error); } finally { setBusy(false); }
  };
  return html`<${Modal} wide title=${`${t('Correct', '修正')}: ${entry.title}`} onClose=${onClose}
    footer=${html`<button class="ghost" onClick=${onClose}>${t('Cancel', '取消')}</button><button class="primary" disabled=${busy || !content.trim() || content === entry.content} onClick=${save}>${t('Save correction', '保存修正')}</button>`}>
    <p class="muted small">${t('An operator correction becomes a new version citing your correction as its source; she sees the revision. It interrupts the thought under way.', '运营者修正会生成一个新版本，以你的修正作为依据，她会看到这次修订。修正会中断她正在进行的思考。')}</p>
    <textarea class="editor short" value=${content} onInput=${event => setContent(event.currentTarget.value)}></textarea>
    <${DiffView} before=${entry.content} after=${content} />
  <//>`;
}

function Forget({ entry, onClose, onDone }) {
  const plan = useAsync(() => api(`/api/memory/${encodeURIComponent(entry.id)}/forget`, { method: 'POST', body: {} }), [entry.id]);
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    setBusy(true);
    try { const result = await api(`/api/memory/${encodeURIComponent(entry.id)}/forget`, { method: 'POST', body: { yes: true } }); toast(t(`Forgot ${result.forgotten.length} records.`, `已删除 ${result.forgotten.length} 条记录。`), 'ok'); onDone(); }
    catch (error) { failed(error); } finally { setBusy(false); }
  };
  return html`<${Modal} title=${`${t('Forget', '删除')}: ${entry.title}`} onClose=${onClose}
    footer=${html`<button class="ghost" onClick=${onClose}>${t('Cancel', '取消')}</button><button class="danger" disabled=${busy || !plan.data} onClick=${forget}>${t('Forget all of these', '全部删除')}</button>`}>
    ${!plan.data ? html`<${Loading} state=${plan} />` : html`<p class="note warn">${plan.data.message}</p>
      <p>${t(`${plan.data.affectedIds.length} records go:`, `将删除 ${plan.data.affectedIds.length} 条记录：`)}</p><ul class="plain mono small">${plan.data.affectedIds.map(id => html`<li>${id}</li>`)}</ul>`}
  <//>`;
}

/** Long entries open on request, so one review's notes do not fill the screen. */
function Folded({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600 || text.split('\n').length > 12;
  return html`<${Markdown} text=${text} class=${long && !open ? 'folded' : ''} />${long ? html`<button class="link small" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? t('Fold', '收起') : t(`Show all ${[...text].length} characters`, `展开全部 ${[...text].length} 字`)}</button>` : null}`;
}

function Development() {
  const list = useAsync(() => api('/api/development'));
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const entries = list.data ?? [];
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(entry => (!kind || entry.kind === kind) && (!needle || `${entry.title}\n${entry.content}\n${entry.scope}\n${entry.scopeName ?? ''}`.toLowerCase().includes(needle)));
  }, [entries, kind, query]);
  if (!list.data) return html`<${Loading} state=${list} />`;
  const close = () => setDialog(null);
  const done = () => { setDialog(null); list.reload(); };
  return html`<div>
    <p class="muted">${t('What she has formed herself from experience: habits, practices she has noticed around her, and impressions of people. You can inspect, correct, and forget each one; the persona file still takes precedence.', '她从经历中自己形成的：习惯、她注意到的周围人的惯例、对人的印象。你可以查看、修正或删除每一条；人格文件仍然优先。')}</p>
    <div class="row wrap filters">
      <${Tabs} value=${kind} onChange=${setKind} tabs=${[['', `${t('All', '全部')} ${entries.length}`], ...['habit', 'practice', 'impression'].map(item => [item, `${kindLabel(item)} ${entries.filter(entry => entry.kind === item).length}`])]} />
      <input type="search" placeholder=${t('Search', '搜索')} value=${query} onInput=${event => setQuery(event.currentTarget.value)} />
      <button class="ghost" onClick=${list.reload}>${t('Refresh', '刷新')}</button>
    </div>
    <div class="dev-list">${shown.map(entry => html`<article class="dev" key=${entry.id}>
      <header><${Badge} kind=${entry.kind === 'impression' ? 'info' : ''}>${kindLabel(entry.kind)}<//> <strong>${entry.title}</strong> <span class="muted small">${scopeLabel(entry)}</span></header>
      <${Folded} text=${entry.content} />
      <footer class="row"><span class="muted small">${time(entry.createdAt)} · ${t('importance', '重要度')} ${entry.importance} · ${t(`${entry.sources.length} sources`, `${entry.sources.length} 条依据`)}</span>
        <span class="spacer"></span>
        <button class="ghost tiny" onClick=${() => setDialog({ type: 'detail', entry })}>${t('Details', '详情')}</button>
        <button class="ghost tiny" onClick=${() => setDialog({ type: 'correct', entry })}>${t('Correct', '修正')}</button>
        <button class="ghost tiny danger" onClick=${() => setDialog({ type: 'forget', entry })}>${t('Forget', '删除')}</button></footer>
    </article>`)}</div>
    ${!shown.length ? html`<p class="muted">${t('Nothing here.', '没有内容。')}</p>` : null}
    ${dialog?.type === 'detail' ? html`<${MemoryDetail} id=${dialog.entry.id} onClose=${close} />` : null}
    ${dialog?.type === 'correct' ? html`<${Correct} entry=${dialog.entry} onClose=${close} onDone=${done} />` : null}
    ${dialog?.type === 'forget' ? html`<${Forget} entry=${dialog.entry} onClose=${close} onDone=${done} />` : null}
  </div>`;
}

export function PersonaPage() {
  const [tab, setTab] = useState('file');
  return html`
    <${PageHeader} title=${t('Persona & growth', '人格与成长')} eyebrow="PERSONA & DEVELOPMENT" description=${t('The persona you define, and what she learns through experience.', '你设定的核心人格，她从经历中形成的自己。')} />
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['file', t('Core persona', '核心人格')], ['development', t('Her development', '她的发展')], ['history', t('Versions', '版本记录')]]} />
    <div hidden=${tab === 'development'}><${PersonaFile} tab=${tab} onEdit=${() => setTab('file')} /></div>
    <div hidden=${tab !== 'development'}><${Development} /></div>`;
}
