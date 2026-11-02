import { api, Badge, Card, ContextNote, DiffView, failed, html, Loading, Modal, t, toast, useAsync, useState } from '../lib.js';
import { History } from './persona.js';

const markers = text => [
  [text.includes('{{persona}}'), t('{{persona}}: where the persona file goes', '{{persona}}：人格文件插入的位置')],
  [/\n<!-- current-context -->/.test(text.trimEnd()), t('<!-- current-context --> on a line of its own: before it is what old checkpoints were written with', '独占一行的 <!-- current-context -->：它之前的部分用于识别旧的检查点')],
  [null, t('<!-- allow-fiction -->…<!-- /allow-fiction -->: kept only while life.allowFiction is on (optional)', '<!-- allow-fiction -->…<!-- /allow-fiction -->：只在开启 life.allowFiction 时保留（可选）')],
];

export function PromptPage() {
  const prompt = useAsync(() => api('/api/prompt'));
  const [text, setText] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  if (!prompt.data) return html`<${Loading} state=${prompt} />`;
  const data = prompt.data;
  const saved = data.override ?? data.builtin;
  const value = text ?? saved;
  const dirty = text !== null && text !== saved;
  const checks = markers(value);
  const valid = checks.every(([ok]) => ok !== false);
  const run = async (work, message) => {
    setBusy(true);
    try { setResult(await work()); setDialog(null); setText(null); await prompt.reload(); toast(message, 'ok'); }
    catch (error) { failed(error); } finally { setBusy(false); }
  };
  const save = () => run(() => api('/api/prompt', { method: 'PUT', body: { text: value, hash: data.hash } }), t('Saved. Restart the daemon to use it.', '已保存，重启常驻进程后生效。'));
  const reset = () => run(() => api('/api/prompt', { method: 'DELETE' }), t('Back to the built-in prompt after a restart.', '重启后恢复为内置提示词。'));
  const preview = async () => {
    try { setDialog({ type: 'preview', ...await api('/api/prompt/preview', { method: 'POST', body: { template: value } }) }); } catch (error) { failed(error); }
  };
  return html`
    <header class="page-head"><h1>${t('System prompt', '系统提示词')}</h1>
      <div class="row">${data.override !== undefined ? html`<${Badge} kind="info">${t('Your file', '覆盖文件')}: ${data.file}<//>` : html`<${Badge}>${t('Built-in', '内置版本')}<//>`}</div></header>
    <p class="muted">${t('The instructions every thought starts with; the persona file is inserted at {{persona}}. Saving writes your own file outside git and points systemPromptFile at it; the built-in prompt in the program stays as it is. Any change starts a fresh working context at the next start.', '每次思考开头的指令；人格文件插入在 {{persona}} 处。保存会写入你自己的文件（不在 git 中），并把 systemPromptFile 指向它；程序内置的提示词保持不变。任何修改都会让下次启动时工作上下文重新开始。')}</p>
    ${data.builtinChanged ? html`<div class="note warn">${t('The built-in prompt has changed since your file was last saved, and your file does not follow it.', '你上次保存覆盖文件之后，内置提示词有了更新，覆盖文件不会自动跟上。')}
      <button class="link" onClick=${() => setDialog({ type: 'upstream' })}>${t('See what changed', '查看内置版本的改动')}</button></div>` : null}
    ${result ? html`<${ContextNote} context=${result.context} />` : null}
    <div class="editor-layout">
      <${Card} title=${t('Template', '模板')} actions=${html`
        <span class="muted small">${t(`${[...value].length} characters`, `${[...value].length} 字`)}</span>
        <button class="ghost" onClick=${() => setDialog({ type: 'builtin' })}>${t('Compare with built-in', '与内置版本对比')}</button>
        <button class="ghost" onClick=${preview}>${t('Preview with persona', '预览最终提示词')}</button>
        <button class="ghost" disabled=${!dirty} onClick=${() => setText(null)}>${t('Discard', '放弃')}</button>
        <button class="primary" disabled=${!dirty || !valid} onClick=${() => setDialog({ type: 'save' })}>${t('Review and save…', '检查并保存…')}</button>`}>
        <ul class="needs">${checks.map(([ok, label]) => html`<li class=${ok === null ? '' : ok ? 'ok' : 'bad'}>${ok === null ? '·' : ok ? '✓' : '✗'} ${label}</li>`)}</ul>
        <textarea class="editor mono" spellcheck="false" value=${value} onInput=${event => setText(event.currentTarget.value)}></textarea>
        ${data.override !== undefined ? html`<div class="row"><span class="spacer"></span><button class="ghost danger" onClick=${() => setDialog({ type: 'reset' })}>${t('Use the built-in prompt again…', '恢复为内置提示词…')}</button></div>` : null}
      <//>
      <${History} kind="prompt" current=${value} onLoad=${setText} saved=${data.hash} />
    </div>
    ${dialog?.type === 'save' ? html`<${Modal} wide title=${t('Save the system prompt', '保存系统提示词')} onClose=${() => setDialog(null)}
      footer=${html`<button class="ghost" onClick=${() => setDialog(null)}>${t('Cancel', '取消')}</button><button class="primary" disabled=${busy} onClick=${save}>${t('Save', '保存')}</button>`}>
      <p class="note warn">${t('The next start begins a fresh working context.', '下次启动时工作上下文会重新开始。')}${data.override === undefined ? t(` Saved as ${'system-prompt.md'} beside config.json.`, ' 将保存为 config.json 旁边的 system-prompt.md。') : ''}</p>
      <${DiffView} before=${saved} after=${value} /><//>` : null}
    ${dialog?.type === 'reset' ? html`<${Modal} title=${t('Use the built-in prompt', '恢复内置提示词')} onClose=${() => setDialog(null)}
      footer=${html`<button class="ghost" onClick=${() => setDialog(null)}>${t('Cancel', '取消')}</button><button class="danger" disabled=${busy} onClick=${reset}>${t('Use built-in', '恢复内置')}</button>`}>
      <p>${t('systemPromptFile is removed from config.json. Your file stays on disk and in the version history. The next start begins a fresh working context.', '会从 config.json 删除 systemPromptFile。你的文件仍保留在磁盘和历史版本中。下次启动时工作上下文会重新开始。')}</p><//>` : null}
    ${dialog?.type === 'builtin' ? html`<${Modal} wide title=${t('Built-in → editor', '内置版本 → 编辑器')} onClose=${() => setDialog(null)}
      footer=${html`<button class="ghost" onClick=${() => { setText(data.builtin); setDialog(null); }}>${t('Load built-in into editor', '把内置版本载入编辑器')}</button>`}>
      <${DiffView} before=${data.builtin} after=${value} /><//>` : null}
    ${dialog?.type === 'upstream' ? html`<${Modal} wide title=${t('Built-in changes since your last save', '你上次保存以来内置版本的改动')} onClose=${() => setDialog(null)}>
      <p class="muted small">${t('Carry over what you want by hand, then save; saving marks this as seen.', '把需要的改动手动合并进编辑器后保存；保存后不再提示。')}</p>
      <${DiffView} before=${data.base} after=${data.builtin} /><//>` : null}
    ${dialog?.type === 'preview' ? html`<${Modal} wide title=${t(`Final system prompt · ${dialog.chars} characters`, `最终系统提示词 · ${dialog.chars} 字`)} onClose=${() => setDialog(null)}>
      <pre class="preview">${dialog.text}</pre><//>` : null}`;
}
