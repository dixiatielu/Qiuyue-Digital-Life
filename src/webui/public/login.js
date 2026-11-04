import { APPEARANCE_KEY, DEFAULT_APPEARANCE, applyAppearance, readAppearance } from './theme.js';

function restoreAppearance() {
  let appearance = DEFAULT_APPEARANCE;
  try { appearance = readAppearance(localStorage); } catch { /* Private browsing can deny storage. */ }
  applyAppearance(appearance);
}
restoreAppearance();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restoreAppearance);
addEventListener('storage', event => { if (event.key === APPEARANCE_KEY || event.key === null) restoreAppearance(); });

const token = document.getElementById('login-token');
const reveal = document.getElementById('login-reveal');
reveal.hidden = false;
reveal.addEventListener('click', () => {
  const visible = token.type === 'password';
  token.type = visible ? 'text' : 'password';
  reveal.setAttribute('aria-pressed', String(visible));
  reveal.textContent = visible ? reveal.dataset.hide : reveal.dataset.show;
});
token.addEventListener('input', () => {
  token.setAttribute('aria-invalid', 'false');
  const error = document.getElementById('login-error');
  if (error) error.hidden = true;
});
