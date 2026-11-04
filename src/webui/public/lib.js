import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from 'htm/preact';
export { html, useCallback, useEffect, useMemo, useRef, useState };

let lang = 'en';
export const setLang = value => { lang = value; document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en'; };
/** Every string in both languages, as the daemon's own ui() does. */
export const t = (en, zh) => lang === 'zh' ? zh : en;

export async function api(path, { method = 'GET', body } = {}) {
  const send = method !== 'GET';
  const response = await fetch(path, { method, headers: send ? { 'Content-Type': 'application/json' } : {}, body: send ? JSON.stringify(body ?? {}) : undefined });
  if (response.status === 401) { location.reload(); throw new Error(t('Signed out', '已退出登录')); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${response.status}`), { status: response.status });
  return data;
}

// --- notices ---
const toastListeners = new Set();
let toastSeq = 0;
export function toast(text, kind = 'info') {
  const item = { id: ++toastSeq, text: String(text), kind };
  for (const listener of toastListeners) listener(items => [...items, item]);
  setTimeout(() => { for (const listener of toastListeners) listener(items => items.filter(other => other.id !== item.id)); }, kind === 'error' ? 8000 : 3500);
}
export const failed = error => toast(error?.message ?? error, 'error');
export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => { toastListeners.add(setItems); return () => toastListeners.delete(setItems); }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${items.map(item => html`<div key=${item.id} class=${`toast ${item.kind}`}>${item.text}</div>`)}</div>`;
}

// --- formatting ---
const pad = value => String(value).padStart(2, '0');
export function time(ms, seconds = true) {
  if (!ms) return '—';
  const date = new Date(ms); const now = new Date();
  const day = date.toDateString() === now.toDateString() ? '' : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `;
  return `${day}${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
}
export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return t(`${s}s`, `${s} 秒`);
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m}m ${s % 60}s`, `${m} 分 ${s % 60} 秒`);
  const hours = Math.floor(m / 60);
  if (hours < 48) return t(`${hours}h ${m % 60}m`, `${hours} 小时 ${m % 60} 分`);
  return t(`${Math.floor(hours / 24)}d ${hours % 24}h`, `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`);
}
export const ago = ms => ms ? t(`${duration(Date.now() - ms)} ago`, `${duration(Date.now() - ms)}前`) : '—';
export const number = value => value == null ? '—' : Number(value).toLocaleString();

// --- paths in the configuration object ---
export function getPath(object, path) { return path.split('.').reduce((value, key) => value == null ? undefined : value[key], object); }
export function setPath(object, path, value) {
  const copy = structuredClone(object ?? {}); const keys = path.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) { if (target[key] == null || typeof target[key] !== 'object') target[key] = {}; target = target[key]; }
  if (value === undefined) delete target[keys.at(-1)]; else target[keys.at(-1)] = value;
  return copy;
}

// --- data loading ---
export function useAsync(load, deps = []) {
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(() => {
    setState(previous => ({ ...previous, loading: true }));
    return load().then(data => setState({ data }), error => setState({ error }));
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, set: data => setState({ data }) };
}

// --- line diff ---
/** Lines kept, removed, and added, by longest common subsequence after the shared start and end are set aside. */
export function diffLines(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end); const y = b.slice(start, b.length - end);
  const result = a.slice(0, start).map(text => ({ op: ' ', text }));
  if (x.length * y.length > 4_000_000) result.push(...x.map(text => ({ op: '-', text })), ...y.map(text => ({ op: '+', text })));
  else {
    const table = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0; let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { result.push({ op: ' ', text: x[i] }); i++; j++; }
      // On a tie the removed line comes first, as diffs are read.
      else if (i < x.length && (j >= y.length || table[i + 1][j] >= table[i][j + 1])) result.push({ op: '-', text: x[i++] });
      else result.push({ op: '+', text: y[j++] });
    }
  }
  result.push(...a.slice(a.length - end).map(text => ({ op: ' ', text })));
  return result;
}
/** Within a changed line, mark only the part that differs. */
function marked(text, other) {
  let start = 0; while (start < text.length && start < other.length && text[start] === other[start]) start++;
  let end = 0; while (end < text.length - start && end < other.length - start && text[text.length - 1 - end] === other[other.length - 1 - end]) end++;
  return html`${text.slice(0, start)}<mark>${text.slice(start, text.length - end)}</mark>${text.slice(text.length - end)}`;
}
export function DiffView({ before, after, context = 3 }) {
  const lines = useMemo(() => diffLines(before ?? '', after ?? ''), [before, after]);
  if (!lines.some(line => line.op !== ' ')) return html`<p class="muted">${t('No changes.', '没有改动。')}</p>`;
  const show = lines.map((line, index) => line.op !== ' ' || lines.slice(Math.max(0, index - context), index + context + 1).some(near => near.op !== ' '));
  const rows = []; let skipped = 0;
  lines.forEach((line, index) => {
    if (!show[index]) { skipped++; return; }
    if (skipped) { rows.push(html`<div class="diff-skip">… ${t(`${skipped} unchanged lines`, `${skipped} 行未改动`)}</div>`); skipped = 0; }
    const partner = line.op === '-' && lines[index + 1]?.op === '+' ? lines[index + 1].text : line.op === '+' && lines[index - 1]?.op === '-' ? lines[index - 1].text : undefined;
    rows.push(html`<div class=${`diff-line ${line.op === '+' ? 'add' : line.op === '-' ? 'del' : ''}`}><span class="diff-op">${line.op}</span><span>${partner !== undefined ? marked(line.text, partner) : line.text || ' '}</span></div>`);
  });
  if (skipped) rows.push(html`<div class="diff-skip">… ${t(`${skipped} unchanged lines`, `${skipped} 行未改动`)}</div>`);
  return html`<div class="diff">${rows}</div>`;
}

// --- building blocks ---
export function Card({ title, actions, children, class: extra = '' }) {
  return html`<section class=${`card ${extra}`}>${title || actions ? html`<header class="card-head"><h2>${title}</h2><div class="row">${actions}</div></header>` : null}${children}</section>`;
}
export function Toggle({ value, onChange, disabled, label, id }) {
  return html`<label class=${`switch ${disabled ? 'disabled' : ''}`}><input id=${id} type="checkbox" checked=${Boolean(value)} disabled=${disabled} onChange=${event => onChange(event.currentTarget.checked)} /><span class="slider"></span>${label ? html`<span>${label}</span>` : null}</label>`;
}
export function Badge({ kind = '', children }) { return html`<span class=${`badge ${kind}`}>${children}</span>`; }
export function PageHeader({ title, eyebrow, description, children }) {
  return html`<header class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${description ? html`<p class="page-description">${description}</p>` : null}</div><div class="row wrap">${children}</div></header>`;
}
export function Modal({ title, onClose, children, footer, wide, class: extra = '' }) {
  const dialog = useRef(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current.querySelector('button')?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const items = [...dialog.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
        else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
      }
    };
    addEventListener('keydown', key);
    return () => { removeEventListener('keydown', key); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return html`<div class=${`modal-back ${extra}`} onClick=${event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref=${dialog} class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title}>
      <header class="card-head"><h2>${title}</h2><button class="ghost icon" onClick=${onClose} aria-label=${t('Close', '关闭')}>✕</button></header>
      <div class="modal-body">${children}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : null}
    </div></div>`;
}
export function Tabs({ tabs, value, onChange }) {
  const move = event => {
    const index = tabs.findIndex(([id]) => id === value);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); onChange(tabs[next][0]); event.currentTarget.children[next]?.focus();
  };
  return html`<div class="tabs" role="tablist" aria-label=${t('Sections', '页面分区')} onKeyDown=${move}>${tabs.map(([id, label]) => html`<button key=${id} role="tab" tabIndex=${value === id ? 0 : -1} aria-selected=${value === id} class=${value === id ? 'active' : ''} onClick=${() => onChange(id)}>${label}</button>`)}</div>`;
}
export function Loading({ state }) {
  if (state.error) return html`<div class="card"><p class="error">${state.error.message}</p><button onClick=${state.reload}>${t('Retry', '重试')}</button></div>`;
  return html`<div class="card muted">${t('Loading…', '加载中…')}</div>`;
}
/** What saving means for the working context: kept across the restart, or begun afresh (persona, prompt, model, tools, and account make up its identity). */
export function ContextNote({ context }) {
  if (!context) return null;
  if (context.unknown) return html`<p class="note">${t('User plugin declarations are checked by the daemon when loaded. Reload reports whether the working context was kept; memories and continuing state are retained.', '用户插件的工具声明由常驻进程在加载时校验。重载结果会说明是否保留工作上下文；记忆和持续状态会保留。')}</p>`;
  if (context.continues) return html`<p class="note ok">${t('After a restart, the current working context continues.', '重启后会延续当前的工作上下文。')}</p>`;
  if (!context.saved) return html`<p class="note">${t('There is no saved working context yet; the next start begins one.', '目前没有保存的工作上下文，下次启动会新建。')}</p>`;
  return html`<p class="note warn">${t('After a restart, the working context starts afresh: the persona, system prompt, model, tool set, or account differs from the one it was saved with. Memories and continuing state are kept.', '重启后工作上下文会重新开始：人格、系统提示词、模型、工具集或账号与保存时不同。记忆和持续状态不受影响。')}</p>`;
}

/** One field of the configuration: shows the default in grey until set, and can go back to it. */
export function ConfigField({ form, path, type = 'string', label, help, nullable, options, min, max, step, warn, placeholder }) {
  const value = form.get(path);
  const fallback = getPath(form.effective, path);
  const unset = value === undefined;
  const shown = unset ? fallback : value;
  const set = next => form.set(path, next);
  const [text, setText] = useState(null);
  const [unit, setUnit] = useState(() => typeof shown === 'number' && shown >= 60000 ? 60000 : typeof shown === 'number' && shown >= 1000 ? 1000 : 1);
  const displayLabel = type === 'ms' ? label.replace(/\s*\(ms\)|（毫秒）/g, '') : label;
  let control;
  if (type === 'bool') control = html`<${Toggle} id=${`field-${path}`} value=${shown} onChange=${set} />`;
  else if (type === 'select') control = html`<select id=${`field-${path}`} value=${shown ?? ''} onChange=${event => set(event.currentTarget.value || undefined)}>${options.map(([id, name]) => html`<option value=${id}>${name}</option>`)}</select>`;
  else if (type === 'int' || type === 'number' || type === 'ms') {
    const isNull = shown === null;
    const scale = type === 'ms' ? unit : 1;
    control = html`<div class="row">
      <input id=${`field-${path}`} type="number" class="num" value=${isNull || value === undefined ? '' : value / scale} placeholder=${isNull ? t('unlimited', '不限') : fallback == null ? placeholder ?? '' : fallback / scale} min=${min == null ? undefined : min / scale} max=${max == null ? undefined : max / scale} step=${step ?? (type === 'number' || type === 'ms' ? 'any' : 1)} disabled=${isNull}
        onInput=${event => { const raw = event.currentTarget.value; set(raw === '' ? undefined : type === 'number' ? Number(raw) : Math.round(Number(raw) * scale)); }} />
      ${type === 'ms' ? html`<select class="time-unit" aria-label=${t(`${displayLabel} unit`, `${displayLabel}单位`)} value=${unit} onChange=${event => setUnit(Number(event.currentTarget.value))}>${[[1, t('ms', '毫秒')], [1000, t('seconds', '秒')], [60000, t('minutes', '分钟')], [3600000, t('hours', '小时')]].map(([scale, name]) => html`<option value=${scale}>${name}</option>`)}</select>` : null}
      ${nullable ? html`<label class="check"><input type="checkbox" checked=${isNull} onChange=${event => set(event.currentTarget.checked ? null : fallback ?? 1)} />${t('unlimited', '不限')}</label>` : null}
    </div>`;
  } else if (type === 'list' || type === 'intlist') {
    const current = Array.isArray(shown) ? shown.join('\n') : '';
    control = html`<textarea id=${`field-${path}`} rows=${Math.min(8, Math.max(2, (text ?? current).split('\n').length + 1))} value=${text ?? (unset ? '' : current)} placeholder=${unset ? current : ''}
      onInput=${event => setText(event.currentTarget.value)}
      onBlur=${() => { if (text === null) return; const items = text.split('\n').map(item => item.trim()).filter(Boolean); set(type === 'intlist' ? items.map(item => /^\d+$/.test(item) ? Number(item) : item) : items); setText(null); }}></textarea>`;
  } else if (type === 'json') {
    const current = shown === undefined ? '' : JSON.stringify(shown, null, 2);
    let invalid = false;
    if (text !== null) { try { if (text.trim()) JSON.parse(text); } catch { invalid = true; } }
    control = html`<textarea id=${`field-${path}`} class=${`mono ${invalid ? 'invalid' : ''}`} rows="6" value=${text ?? current} onInput=${event => setText(event.currentTarget.value)}
      onBlur=${() => { if (text === null) return; try { set(text.trim() ? JSON.parse(text) : undefined); setText(null); } catch { /* left for the operator to fix */ } }}></textarea>`;
  } else control = html`<input id=${`field-${path}`} type="text" value=${value ?? ''} placeholder=${fallback ?? placeholder ?? ''} onInput=${event => set(event.currentTarget.value === '' ? undefined : event.currentTarget.value)} spellcheck="false" />`;
  return html`<div class=${`field ${type === 'bool' ? 'field-bool' : ''}`}>
    <div class="field-label"><label for=${`field-${path}`}>${displayLabel}</label>${unset && fallback !== undefined ? html`<${Badge}>${t('default', '默认')}<//>` : null}
      ${!unset ? html`<button class="ghost tiny" title=${t('Back to the default', '恢复默认')} onClick=${() => { setText(null); form.set(path, undefined); }}>↺</button>` : null}</div>
    <div class="field-control">${control}</div>
    ${help ? html`<div class="field-help">${help}</div>` : null}
    ${warn ? html`<div class="field-help warn">${warn}</div>` : null}
  </div>`;
}

/**
 * The configuration as one draft shared by a page's fields. Saving sends the whole file with the version it was read at,
 * so an edit made elsewhere in the meantime is refused rather than overwritten.
 */
export function useConfigDraft() {
  const state = useAsync(() => api('/api/config'));
  const [draft, setDraft] = useState(null);
  useEffect(() => { if (state.data) setDraft(state.data.raw ? structuredClone(state.data.raw) : null); }, [state.data]);
  const raw = state.data?.raw;
  const dirty = Boolean(raw && draft && JSON.stringify(raw) !== JSON.stringify(draft));
  return {
    state, raw, draft, dirty, effective: state.data?.effective ?? {}, hash: state.data?.hash, error: state.data?.error,
    get: path => getPath(draft, path),
    set: (path, value) => setDraft(current => setPath(current, path, value)),
    replace: setDraft,
    discard: () => setDraft(structuredClone(raw)),
    reload: state.reload,
  };
}
export function SaveBar({ form, onSaved, savedMessage }) {
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!form.dirty && !review) return null;
  const open = async () => {
    setBusy(true);
    try { setReview(await api('/api/config/check', { method: 'POST', body: { raw: form.draft } })); }
    catch (error) { failed(error); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const result = await api('/api/config', { method: 'PUT', body: { raw: form.draft, hash: form.hash } });
      toast(savedMessage ?? t('Saved. Apply plugin settings on the capabilities page; core settings take effect after a restart.', '已保存。插件设置可在能力页重载应用；核心设置在重启后生效。'), 'ok');
      setReview(null); await form.reload(); onSaved?.(result);
    } catch (error) { failed(error); if (error.status === 409) setReview(null); }
    finally { setBusy(false); }
  };
  return html`
    ${form.dirty ? html`<div class="savebar"><span>${t('Unsaved changes to config.json', 'config.json 有未保存的修改')}</span>
      <div class="row"><button class="ghost" onClick=${form.discard}>${t('Discard', '放弃')}</button><button class="primary" disabled=${busy} onClick=${open}>${t('Review and save…', '检查并保存…')}</button></div></div>` : null}
    ${review ? html`<${Modal} wide title=${t('Save config.json', '保存 config.json')} onClose=${() => setReview(null)}
      footer=${html`<button class="ghost" onClick=${() => setReview(null)}>${t('Cancel', '取消')}</button><button class="primary" disabled=${busy || !review.valid} onClick=${save}>${t('Save', '保存')}</button>`}>
      ${review.valid ? html`<${ContextNote} context=${review.context} />` : html`<p class="note error">${review.error}</p>`}
      ${review.valid && review.context?.models?.problems.length ? html`<div class="note warn"><p>${t('Models are not ready to start yet:', '模型尚未就绪，启动前需要修复：')}</p>${review.context.models.problems.map(problem => html`<div>${problem}</div>`)}</div>` : null}
      <${DiffView} before=${JSON.stringify(form.raw, null, 2)} after=${JSON.stringify(form.draft, null, 2)} />
    <//>` : null}`;
}
