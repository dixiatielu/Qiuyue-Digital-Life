import { api, Badge, html, Loading, Modal, PageHeader, t, toast, useEffect, useRef, useState } from '../lib.js';

const imageUrl = (id, suffix = '') => `/api/gallery/${encodeURIComponent(id)}/image${suffix}`;
const date = value => value ? new Date(value).toLocaleString() : '—';
const size = value => value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const name = item => item.title || t('Untitled image', '未命名作品');
const outcomes = () => ({ success: t('Confirmed', '已成功'), failed: t('Failed', '失败'), unknown: t('Unconfirmed', '结果不确定'), pending: t('In progress', '进行中') });

function DrawingDetails({ id, onClose, onChange, canEdit }) {
  const [item, setItem] = useState();
  const [draft, setDraft] = useState();
  const [error, setError] = useState();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const load = () => api(`/api/gallery/${encodeURIComponent(id)}`).then(next => {
    setItem(next); setDraft({ title: next.title, description: next.description, note: next.note, tags: next.tags.join(', '), favorite: next.favorite, archived: next.archived }); setError(undefined);
  }, setError);
  useEffect(() => { load(); }, [id]);
  const field = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(undefined);
    const changes = { ...draft, tags: draft.tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean) };
    if (!changes.title.trim()) delete changes.title;
    try {
      await api(`/api/gallery/${encodeURIComponent(id)}`, { method: 'PUT', body: { revision: item.revision, changes } });
      await load(); onChange(); toast(t('Work updated', '作品已更新'));
    } catch (error) { setError(error); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(undefined);
    try { await api(`/api/gallery/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision: item.revision } }); onChange(); onClose(); toast(t('Work deleted', '作品已删除')); }
    catch (error) { setError(error); } finally { setBusy(false); }
  };
  return html`<${Modal} wide class="gallery-modal" title=${item ? name(item) : t('Work details', '作品详情')} onClose=${() => { if (!busy) onClose(); }} footer=${item && !item.deletedAt ? html`<button class="danger" disabled=${busy || !canEdit} onClick=${() => setDeleting(true)}>${t('Delete', '删除作品')}</button><span class="spacer"></span><button disabled=${busy || !canEdit} type="submit" form="gallery-edit">${busy ? t('Saving…', '处理中…') : t('Save changes', '保存修改')}</button>` : null}>
    ${error ? html`<div class="note error" role="alert">${error.message} <button class="ghost" disabled=${busy} onClick=${load}>${t('Reload details', '重新载入')}</button></div>` : null}
    ${!item ? html`<p class="muted">${t('Loading…', '正在载入…')}</p>` : html`
      ${deleting ? html`<div class="note warn"><p>${t('Delete the original, thumbnail and search index permanently? Past usage records will remain marked as deleted. Archive the work instead if you want to keep it.', '永久删除原图、缩略图和搜索索引？历史使用记录仍会标明作品已删除。如需保留图片，可以改用归档。')}</p><div class="row"><button class="danger" disabled=${busy} onClick=${remove}>${t('Confirm deletion', '确认删除')}</button><button class="ghost" disabled=${busy} onClick=${() => setDeleting(false)}>${t('Cancel', '取消')}</button></div></div>` : null}
      <div class="gallery-detail">
        <div class="gallery-preview">
          ${item.available ? html`<img src=${imageUrl(id)} alt=${item.description || name(item)} /><a class="button ghost" href=${imageUrl(id, '?download=true')} download>${t('Download original', '下载原图')}</a>` : html`<div class="empty-state">${item.deletedAt ? t('This work has been deleted.', '作品已删除') : t('The original file is missing.', '原图文件缺失')}</div>`}
          <p class="muted small">${item.width && item.height ? `${item.width} × ${item.height} · ` : ''}${size(item.bytes)} · ${date(item.createdAt)}</p>
          ${item.timeSource === 'file' ? html`<p class="muted small">${t('Date recovered from the file; creation details are unknown.', '日期来自历史文件，原始创作信息未知。')}</p>` : null}
          <code class="gallery-id">${id}</code>
        </div>
        <form id="gallery-edit" onSubmit=${save} class="gallery-form">
          <fieldset disabled=${busy || !canEdit || Boolean(item.deletedAt)}>
            <label>${t('Title', '作品名称')}<input value=${draft.title} maxLength="160" placeholder=${t('Untitled image', '未命名作品')} onInput=${event => field('title', event.currentTarget.value)} /></label>
            <label>${t('What the image shows', '实际画面描述')}<textarea rows="4" maxLength="2000" value=${draft.description} placeholder=${t('Describe the actual image, separately from the generation prompt.', '根据实际图片填写，与创作提示词分开。')} onInput=${event => field('description', event.currentTarget.value)} /></label>
            <label>${t('Tags', '标签')}<input value=${draft.tags} placeholder=${t('Separate tags with commas', '用逗号分隔，例如：雨夜，街景，水彩')} onInput=${event => field('tags', event.currentTarget.value)} /></label>
            <label>${t('Personal note', '作品备注')}<textarea rows="2" maxLength="2000" value=${draft.note} onInput=${event => field('note', event.currentTarget.value)} /></label>
            <div class="row wrap"><label class="check"><input type="checkbox" checked=${draft.favorite} onChange=${event => field('favorite', event.currentTarget.checked)} />${t('Favorite', '收藏')}</label><label class="check"><input type="checkbox" checked=${draft.archived} onChange=${event => field('archived', event.currentTarget.checked)} />${t('Archived', '归档')}</label></div>
          </fieldset>
          ${!canEdit ? html`<p class="muted small">${t('Start the service to organize works.', '启动服务后可整理作品。')}</p>` : null}
          <details open><summary>${t('Creation prompt', '创作提示词')}</summary><p class="gallery-prose">${item.prompt || t('Unknown', '未知')}</p><p class="muted small">${t('Image model', '绘画模型')}：${item.model || t('Unknown', '未知')}</p></details>
        </form>
      </div>
      <div class="gallery-history"><h3>${t('Creation context', '创作来源')}</h3>${item.sources.length ? item.sources.map(source => html`<div class="gallery-source"><div class="muted small">${source.conversation || '—'} · ${source.name || source.person || ''} · ${date(source.at)}</div><p>${source.text || t('Original record is unavailable.', '原始记录不可用。')}</p></div>`) : html`<p class="muted">${t('No recorded social context.', '没有已记录的聊天来源。')}</p>`}
        <h3>${t('Usage history', '使用记录')}</h3>${item.uses.length ? html`<div class="table-wrap"><table class="table small"><thead><tr><th>${t('Time', '时间')}</th><th>${t('Destination', '去向')}</th><th>${t('Action', '操作')}</th><th>${t('Outcome', '结果')}</th></tr></thead><tbody>${item.uses.map(use => html`<tr key=${use.id}><td>${date(use.at)}</td><td>${use.target}</td><td>${use.kind}</td><td><${Badge} kind=${use.status === 'success' ? 'ok' : use.status === 'failed' ? 'bad' : 'warn'}>${outcomes()[use.status] || use.status}<//></td></tr>`)}</tbody></table></div>` : html`<p class="muted">${t('No recorded use yet.', '还没有使用记录。')}</p>`}
      </div>`}
  <//>`;
}

export function GalleryPage({ overview }) {
  const [form, setForm] = useState({ query: '', tag: '', person: '', conversation: '', from: '', to: '', view: 'active' });
  const [filter, setFilter] = useState(form);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ loading: true });
  const [selected, setSelected] = useState();
  const refresh = () => setVersion(value => value + 1);
  const seq = useRef(0);
  useEffect(() => {
    const current = ++seq.current, params = new URLSearchParams({ limit: '24', offset: String(offset) });
    for (const key of ['query', 'tag', 'person', 'conversation']) if (filter[key].trim()) params.set(key, filter[key].trim());
    if (filter.from) params.set('from', new Date(`${filter.from}T00:00:00`).toISOString());
    if (filter.to) params.set('to', new Date(`${filter.to}T23:59:59.999`).toISOString());
    if (filter.view === 'archived') params.set('archived', 'true');
    if (filter.view === 'all') params.set('includeArchived', 'true');
    if (filter.view === 'favorite') params.set('favorite', 'true');
    if (filter.view === 'undescribed') params.set('needsDescription', 'true');
    setState(previous => ({ ...previous, loading: true }));
    api(`/api/gallery?${params}`).then(data => { if (seq.current === current) setState({ data }); }, error => { if (seq.current === current) setState({ error }); });
    return () => { seq.current++; };
  }, [filter, offset, version]);
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const search = event => { event.preventDefault(); setOffset(0); setFilter({ ...form }); };
  const stats = state.data?.stats;
  return html`
    <${PageHeader} title=${t('Gallery', '作品库')} eyebrow="HER OWN WORKS" description=${t('Images she created, kept for another day.', '她创作过的图片，留给以后的日子。')}><button class="ghost" disabled=${state.loading} onClick=${refresh}>${t('Refresh', '刷新')}</button><//>
    ${stats ? html`<div class="gallery-stats"><span><strong>${stats.total}</strong> ${t('works', '件作品')}</span><span>${size(stats.bytes)}</span><span>${stats.needsDescription} ${t('without a description', '件待描述')}</span>${stats.missing ? html`<span class="warn">${stats.missing} ${t('missing originals', '件原图缺失')}</span>` : null}</div>` : null}
    <form class="gallery-filters" onSubmit=${search}>
      <div class="row wrap"><input class="gallery-search" type="search" aria-label=${t('Search works', '搜索作品')} placeholder=${t('Search subjects, titles, prompts…', '搜索主体、作品名、提示词…')} value=${form.query} onInput=${event => set('query', event.currentTarget.value)} />
        <select aria-label=${t('Collection', '作品范围')} value=${form.view} onChange=${event => { const next = { ...form, view: event.currentTarget.value }; setForm(next); setFilter(next); setOffset(0); }}><option value="active">${t('Current works', '未归档')}</option><option value="favorite">${t('Favorites', '收藏')}</option><option value="archived">${t('Archived', '已归档')}</option><option value="undescribed">${t('Without description', '待描述')}</option><option value="all">${t('All works', '全部作品')}</option></select>
        <button type="submit">${t('Search', '搜索')}</button>
      </div>
      <details><summary>${t('Filter by date, tag or origin', '按日期、标签或来源筛选')}</summary><div class="gallery-filter-grid">
        <label>${t('Tag', '标签')}<input value=${form.tag} onInput=${event => set('tag', event.currentTarget.value)} /></label>
        <label>${t('Person (QQ)', '相关人物（QQ 号）')}<input value=${form.person} onInput=${event => set('person', event.currentTarget.value)} /></label>
        <label>${t('Conversation', '来源聊天')}<input placeholder="group:123 / private:123" value=${form.conversation} onInput=${event => set('conversation', event.currentTarget.value)} /></label>
        <label>${t('From', '开始日期')}<input type="date" value=${form.from} onInput=${event => set('from', event.currentTarget.value)} /></label>
        <label>${t('Through', '结束日期')}<input type="date" value=${form.to} onInput=${event => set('to', event.currentTarget.value)} /></label>
      </div></details>
    </form>
    ${!state.data ? html`<${Loading} state=${state} />` : html`
      <div class="row between gallery-result-count"><span class="muted small">${state.data.total} ${t('results', '件作品')}${state.loading ? t(' · Loading…', ' · 载入中…') : ''}</span><span class="muted small">${t('Newest first; search results by relevance', '默认按时间排列，搜索按相关程度排列')}</span></div>
      ${state.data.items.length ? html`<div class="gallery-grid">${state.data.items.map(item => html`<button key=${item.id} class="gallery-card" onClick=${() => setSelected(item.id)}>
        <div class="gallery-card-image">${item.available ? html`<img loading="lazy" src=${imageUrl(item.id, '?thumbnail=true')} alt=${item.description || name(item)} />` : html`<span>${t('Original missing', '原图缺失')}</span>`}${item.favorite ? html`<span class="gallery-star" aria-label=${t('Favorite', '已收藏')}>★</span>` : null}</div>
        <div class="gallery-card-copy"><div class="row between"><strong>${name(item)}</strong>${item.archived ? html`<${Badge}>${t('Archived', '归档')}<//>` : null}</div><p>${item.description || item.prompt || t('Creation details unknown', '创作信息未知')}</p><div class="gallery-tags">${item.tags.slice(0, 4).map(tag => html`<span>${tag}</span>`)}</div><div class="muted small">${date(item.createdAt)}${item.needsDescription ? t(' · No description yet', ' · 待描述') : ''}</div></div>
      </button>`)}</div>` : html`<div class="gallery-empty"><span aria-hidden="true">◌</span><h2>${stats?.total ? t('No matching works', '没有找到匹配的作品') : t('A place for her creations', '留一处地方，放她的作品')}</h2><p>${stats?.total ? t('Try another subject or widen the filters.', '换个关键词，或扩大筛选范围。') : t('Finished images appear here automatically. Existing images are imported when the gallery plugin starts.', '生成完成的图片会自动收进来。图库插件启动时，也会整理已有图片。')}</p></div>`}
      <div class="row between gallery-pagination"><button class="ghost" disabled=${offset === 0 || state.loading} onClick=${() => setOffset(value => Math.max(0, value - 24))}>${t('Previous', '上一页')}</button><span class="muted small">${Math.floor(offset / 24) + 1} / ${Math.max(1, Math.ceil(state.data.total / 24))}</span><button class="ghost" disabled=${state.data.nextOffset === null || state.loading} onClick=${() => setOffset(state.data.nextOffset)}>${t('Next', '下一页')}</button></div>
    `}
    ${selected ? html`<${DrawingDetails} key=${selected} id=${selected} onClose=${() => setSelected(undefined)} onChange=${refresh} canEdit=${overview.daemon.running} />` : null}
  `;
}
