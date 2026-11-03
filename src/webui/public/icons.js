import { html } from './lib.js';
const paths = {
  overview: 'M3 10l9-7 9 7M5 9v11h14V9M9 20v-7h6v7',
  config: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
  plugins: 'M9 3h6v4a3 3 0 1 1 4 4h2v10h-9v-3a3 3 0 1 0-6 0v3H3V11h3V7h3z',
  persona: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-3a7 7 0 0 1 14 0v3',
  prompt: 'M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6',
  models: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4',
};
export function Icon({ name }) { return html`<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${paths[name] ?? paths.plugins} /></svg>`; }
