import { html } from './lib.js';
const paths = {
  chat: 'M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8M7 8h9M7 12h6',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  memory: 'M12 5C8 2 4 3 3 4v15c4-2 6-1 9 1 3-2 5-3 9-1V4c-1-1-5-2-9 1v15M6 8l3 1M15 9l3-1M6 12l3 1M15 13l3-1',
  pulse: 'M2 12h5l3-7 4 14 3-7h5',
  connection: 'M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0M12 20h.01',
  writing: 'm15 4 5 5M4 20l5-1L21 7l-4-4L5 15z',
  reply: 'm9 5-6 6 6 6M3 11h11a7 7 0 0 1 7 7',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 9h.01M16 9h.01M8 14s1 3 4 3 4-3 4-3',
  attachment: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M5 16 16 5',
  overview: 'M3 10l9-7 9 7M5 9v11h14V9M9 20v-7h6v7',
  gallery: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M15 7h.01',
  config: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
  plugins: 'M9 3h6v4a3 3 0 1 1 4 4h2v10h-9v-3a3 3 0 1 0-6 0v3H3V11h3V7h3z',
  persona: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-3a7 7 0 0 1 14 0v3',
  prompt: 'M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6',
  models: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4',
};
export function Icon({ name }) { return html`<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${paths[name] ?? paths.plugins} /></svg>`; }
