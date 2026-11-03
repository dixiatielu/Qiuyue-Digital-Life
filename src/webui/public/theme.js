/** Appearance preferences are browser-local and never part of the daemon configuration. */
export const DEFAULT_APPEARANCE = { accent: '#315F4B', mode: 'system' };
export const APPEARANCE_KEY = 'qiuyue.webui.appearance.v1';
export function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
  if (/^[\da-f]{3}$/i.test(raw)) return `#${[...raw].map(c => c + c).join('').toUpperCase()}`;
  return null;
}
export function normalizeAppearance(value) {
  return { accent: normalizeColor(value?.accent) ?? DEFAULT_APPEARANCE.accent,
    mode: ['light', 'dark', 'system'].includes(value?.mode) ? value.mode : DEFAULT_APPEARANCE.mode };
}
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const hex = channels => `#${channels.map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const mix = (a, b, ratio) => hex(rgb(a).map((c, i) => c * (1 - ratio) + rgb(b)[i] * ratio));
const luminance = color => rgb(color).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function readable(color, surfaces, dark) {
  const target = dark ? '#FFFFFF' : '#000000';
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (surfaces.every(surface => contrastRatio(candidate, surface) >= 4.7)) return candidate;
  }
  return target;
}
export function themeTokens(color, dark = false) {
  const accent = normalizeColor(color) ?? DEFAULT_APPEARANCE.accent;
  const panel = dark ? mix('#1C1E23', accent, .06) : '#FFFFFF';
  const bg = dark ? mix('#121419', accent, .05) : mix('#FAFAFA', accent, .025);
  const soft = mix(panel, accent, dark ? .18 : .09);
  const side = mix('#17212A', accent, .3);
  const onAccent = contrastRatio(accent, '#FFFFFF') >= contrastRatio(accent, '#000000') ? '#FFFFFF' : '#000000';
  return {
    bg, panel, 'panel-2': mix(panel, accent, dark ? .1 : .035),
    text: dark ? '#EBEDF1' : '#283039', muted: dark ? '#A7AFBC' : '#626C78',
    line: dark ? mix(panel, '#FFFFFF', .12) : mix('#E4E7EA', accent, .05),
    accent: readable(accent, [bg, panel, soft], dark), 'accent-fill': accent, 'on-accent': onAccent,
    'accent-hover': mix(accent, onAccent === '#FFFFFF' ? '#000000' : '#FFFFFF', .1),
    'accent-soft': soft, 'accent-line': mix(panel, accent, dark ? .45 : .23), 'accent-art': mix(panel, accent, .6),
    'side-bg': side, 'side-hover': mix(side, '#FFFFFF', .06), 'side-text': mix(side, '#FFFFFF', .8),
    'side-muted': mix(side, '#FFFFFF', .65), 'side-line': mix(side, '#FFFFFF', .17),
    'nav-active': mix('#FFFFFF', accent, .18), 'nav-text': readable(accent, [mix('#FFFFFF', accent, .18)], false),
  };
}
export function readAppearance(storage) {
  try { return normalizeAppearance(JSON.parse(storage.getItem(APPEARANCE_KEY))); }
  catch { return { ...DEFAULT_APPEARANCE }; }
}
export function saveAppearance(storage, value) {
  try { storage.setItem(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(value))); return true; }
  catch { return false; }
}
export function applyAppearance(value, root = document.documentElement, systemDark = matchMedia('(prefers-color-scheme: dark)').matches) {
  const preference = normalizeAppearance(value);
  const dark = preference.mode === 'dark' || preference.mode === 'system' && systemDark;
  root.dataset.theme = dark ? 'dark' : 'light';
  for (const [name, color] of Object.entries(themeTokens(preference.accent, dark))) root.style.setProperty(`--${name}`, color);
}
