import MarkdownIt from 'markdown-it/browser';
import { html, useMemo } from './lib.js';

// Keep raw HTML inert. The standard heading rule requires whitespace after #,
// so message references such as #a1b2c3d4 stay literal even at the start of a line.
const parser = new MarkdownIt({ html: false, breaks: true });

export function renderMarkdown(text) { return parser.render(text); }

export function Markdown({ text, class: extra = '' }) {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return html`<div class=${`markdown ${extra}`} dangerouslySetInnerHTML=${{ __html: rendered }}></div>`;
}
