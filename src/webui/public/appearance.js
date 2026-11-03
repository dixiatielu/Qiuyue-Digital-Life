import { html, Modal, t, useEffect, useState } from './lib.js';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, applyAppearance, normalizeColor, readAppearance, saveAppearance } from './theme.js';

function load() { try { return readAppearance(localStorage); } catch { return { ...DEFAULT_APPEARANCE }; } }
const presets = [['Mist blue', '雾蓝', '#536FB5'], ['Iris', '鸢紫', '#8064B2'], ['Rose', '樱粉', '#BA6F8D'], ['Forest', '墨绿', '#315F4B'], ['Amber', '琥珀', '#B88637'], ['Graphite', '石墨', '#646874']];
// Apply before the API request so the saved appearance also covers loading/error states.
applyAppearance(load());
export function Appearance() {
  const [value, setValue] = useState(load);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value.accent);
  const [stored, setStored] = useState(true);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(value);
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [value]);
  useEffect(() => {
    const sync = event => { if (event.key === APPEARANCE_KEY || event.key === null) { const next = load(); setValue(next); setDraft(next.accent); } };
    addEventListener('storage', sync); return () => removeEventListener('storage', sync);
  }, []);
  const change = next => {
    setValue(next); applyAppearance(next);
    try { setStored(saveAppearance(localStorage, next)); } catch { setStored(false); }
  };
  const choose = accent => { setDraft(accent); change({ ...value, accent }); };
  const invalid = !normalizeColor(draft);
  return html`
    <button class="theme-trigger" onClick=${() => { setDraft(value.accent); setOpen(true); }}><span class="theme-chip" aria-hidden="true"></span>${t('Appearance', '主题色')}</button>
    ${open ? html`<${Modal} title=${t('Appearance', '主题色')} class="theme-dialog" onClose=${() => setOpen(false)} footer=${html`
      <button class="ghost" onClick=${() => { setDraft(DEFAULT_APPEARANCE.accent); change({ ...DEFAULT_APPEARANCE }); }}>${t('Reset', '恢复默认')}</button>
      <button class="primary" onClick=${() => setOpen(false)}>${t('Done', '完成')}</button>`}>
      <p class="muted small">${t('Choose a color. Every page updates immediately.', '选一个喜欢的颜色，整套界面立即跟着变化。')}</p>
      <h3>${t('Presets', '预设配色')}</h3>
      <div class="theme-presets">${presets.map(([en, zh, color]) => html`<button class="theme-preset" aria-pressed=${value.accent === color} aria-label=${t(en, zh)} onClick=${() => choose(color)}>
        <span class="theme-swatch" style=${`background:${color}`} aria-hidden="true"></span><span>${t(en, zh)} ${value.accent === color ? '✓' : ''}</span></button>`)}</div>
      <h3><label for="theme-hex">${t('Custom color', '自定义颜色')}</label></h3>
      <div class="theme-custom"><input type="color" aria-label=${t('Pick a color', '选择主题颜色')} value=${value.accent} onInput=${event => choose(event.currentTarget.value.toUpperCase())} />
        <input id="theme-hex" class="mono" value=${draft} maxlength="7" placeholder="#536FB5" spellcheck="false" aria-invalid=${invalid} aria-describedby="theme-error" onInput=${event => {
          const text = event.currentTarget.value; setDraft(text); const color = normalizeColor(text); if (color) change({ ...value, accent: color });
        }} /></div>
      <span id="theme-error" role="status" class="error small">${invalid ? t('Enter a 3 or 6 digit HEX color, such as #536FB5.', '请输入 3 位或 6 位 HEX 色值，例如 #536FB5。') : ''}</span>
      <h3>${t('Color mode', '显示模式')}</h3>
      <div class="segmented">${[['system', t('System', '跟随系统')], ['light', t('Light', '浅色')], ['dark', t('Dark', '深色')]].map(([id, label]) => html`<button class=${value.mode === id ? 'active' : ''} aria-pressed=${value.mode === id} onClick=${() => change({ ...value, mode: id })}>${label}</button>`)}</div>
      <p class="muted small">${t('Text contrast adjusts automatically. Success, warning and error colors stay distinct.', '文字明暗自动调整，成功、警告和错误保留各自的提示颜色。')}</p>
      <p class=${`small ${stored ? 'muted' : 'error'}`} role="status">${stored ? t('Saved in this browser. No service restart needed.', '自动保存在当前浏览器，刷新后保留，无需重启服务。') : t('Browser storage is unavailable. This choice lasts until the page closes.', '浏览器不允许存储，此次选择仅在当前页面有效。')}</p>
    <//>` : null}`;
}
