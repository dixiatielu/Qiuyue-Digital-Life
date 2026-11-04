import { api, Badge, Card, ContextNote, DiffView, failed, html, Loading, Modal, PageHeader, Tabs, t, toast, useAsync, useState } from '../lib.js';
import { History } from './persona.js';

const markers = text => [
  [text.includes('{{persona}}'), t('{{persona}}: where the persona file goes', '{{persona}}：人格文件插入的位置')],
  [/\n<!-- current-context -->/.test(text.trimEnd()), t('<!-- current-context --> on a line of its own: before it is what old checkpoints were written with', '独占一行的 <!-- current-context -->：它之前的部分用于识别旧的检查点')],
  [null, t('<!-- allow-fiction -->…<!-- /allow-fiction -->: kept only while life.allowFiction is on (optional)', '<!-- allow-fiction -->…<!-- /allow-fiction -->：只在开启 life.allowFiction 时保留（可选）')],
];

function FinalPrompt({ template }) {
  const preview = useAsync(() => api('/api/prompt/preview', { method: 'POST', body: { template } }), [template]);
  if (!preview.data) return html`<${Loading} state=${preview} />`;
  return html`<${Card} title=${t('Final system prompt', '最终系统提示词')} actions=${html`<span class="muted small">${t(`${preview.data.chars} characters`, `${preview.data.chars} 字`)}</span><button onClick=${preview.reload}>${t('Refresh', '刷新')}</button>`}>
    <p class="muted small">${t('Current template with the saved persona and available activity guidance inserted.', '当前模板插入已保存人格和可用活动提示词后的内容。')}</p>
    <p class="muted small">${preview.data.pluginSource === 'running'
      ? t('Activity guidance comes from the running plugins. Saved changes take effect after reload or restart.', '活动提示词来自正在运行的插件；已保存的修改需重载或重启后生效。')
      : preview.data.pluginSource === 'builtin'
        ? t('The running plugin preview is unavailable. Only built-in activities from saved settings are shown; user plugin guidance is omitted.', '无法获取运行中插件的提示词；当前只显示已保存配置对应的内置活动，不包含用户插件提示词。')
        : t('Activity guidance is unavailable until the configuration can be loaded or the daemon is running.', '配置可加载或常驻进程运行后，才能预览活动提示词。')}</p><pre class="preview">${preview.data.text}</pre>
  <//>`;
}

export function PromptPage() {
  const [tab, setTab] = useState('edit');
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
  return html`
    <${PageHeader} title=${t('System prompt', '系统提示词')} eyebrow="SYSTEM PROMPT" description=${t('Edit the starting point of each thought, with every change visible.', '编辑每次思考的起点，清楚看见每次修改。')}>
      <${Badge}>${data.override !== undefined ? t('Custom template', '自定义模板') : t('Built-in template', '内置模板')}<//>
    <//>
    ${data.builtinChanged ? html`<div class="note warn">${t('The built-in prompt has changed since your template was last saved.', '你上次保存覆盖文件之后，内置提示词有了更新，覆盖文件不会自动跟上。')}
      <button class="link" onClick=${() => setDialog({ type: 'upstream' })}>${t('See changes', '查看内置版本的改动')}</button></div>` : null}
    ${result ? html`<${ContextNote} context=${result.context} />` : null}
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[['edit', t('Template', '模板编辑')], ['preview', t('Final prompt', '最终提示词')], ['diff', t('Compare with built-in', '与内置版本对比')], ['history', t('Versions', '版本记录')]]} />
    <div hidden=${tab !== 'edit'} class="editor-layout">
      <${Card} class="editor-surface" title=${html`<span class="mono">${data.file ?? 'system-prompt.md'}</span>`}>
        <textarea class="editor mono" aria-label=${t('System prompt editor', '系统提示词编辑器')} spellcheck="false" value=${value} onInput=${event => setText(event.currentTarget.value)}></textarea>
        <div class="editor-status"><span>Markdown · UTF-8</span><span>${t(`${[...value].length} characters`, `${[...value].length} 字`)}</span></div>
        <div class="editor-actions"><span class="muted small spacer">${dirty ? t('Unsaved changes', '有未保存的修改') : t('No unsaved changes', '没有未保存的修改')}</span>
          <button class="ghost" disabled=${!dirty} onClick=${() => setText(null)}>${t('Discard', '放弃')}</button>
          <button class="primary" disabled=${!dirty || !valid} onClick=${() => setDialog({ type: 'save' })}>${t('Review and save…', '检查并保存…')}</button>
        </div>
      <//>
      <aside class="stack">
        <${Card} title=${t('Template checks', '模板检查')}><ul class="needs">${checks.map(([ok, label]) => html`<li class=${ok === null ? '' : ok ? 'ok' : 'bad'}>${ok === null ? '·' : ok ? '✓' : '✗'} ${label}</li>`)}</ul><h3>${t('After saving', '修改如何生效')}</h3><p class="muted small">${t('Saved as a separate override file. Restarting begins a fresh working context; memories are kept.', '保存为独立覆盖文件。重启后工作上下文重新开始，记忆保留。')}</p><//>
        <${Card} title=${t('Editing tools', '修改辅助')}><div class="stack"><button onClick=${() => setTab('preview')}>${t('Preview final prompt', '预览最终提示词')}</button>
          ${data.override !== undefined ? html`<button class="ghost danger" onClick=${() => setDialog({ type: 'reset' })}>${t('Use built-in again…', '恢复为内置提示词…')}</button>` : null}
          <p class="muted small">${t('The built-in prompt stays in the program. Your override does not automatically follow its updates.', '内置提示词保留在程序中，自定义文件不会自动跟随内置版本更新。')}</p></div><//>
      </aside>
    </div>
    ${tab === 'preview' ? html`<${FinalPrompt} template=${value} />` : null}
    <div hidden=${tab !== 'diff'}><${Card} title=${t('Built-in → editor', '内置版本 → 当前草稿')} actions=${html`<button onClick=${() => { setText(data.builtin); setTab('edit'); }}>${t('Load built-in into editor', '把内置版本载入编辑器')}</button>`}><${DiffView} before=${data.builtin} after=${value} /><//></div>
    <div hidden=${tab !== 'history'}><${History} kind="prompt" current=${value} onLoad=${text => { setText(text); setTab('edit'); }} saved=${data.hash} /></div>
    ${dialog?.type === 'save' ? html`<${Modal} wide title=${t('Save the system prompt', '保存系统提示词')} onClose=${() => setDialog(null)}
      footer=${html`<button class="ghost" onClick=${() => setDialog(null)}>${t('Cancel', '取消')}</button><button class="primary" disabled=${busy} onClick=${save}>${t('Save', '保存')}</button>`}>
      <p class="note warn">${t('The next start begins a fresh working context.', '下次启动时工作上下文会重新开始。')}${data.override === undefined ? t(` Saved as ${'system-prompt.md'} beside config.json.`, ' 将保存为 config.json 旁边的 system-prompt.md。') : ''}</p>
      <${DiffView} before=${saved} after=${value} /><//>` : null}
    ${dialog?.type === 'reset' ? html`<${Modal} title=${t('Use the built-in prompt', '恢复内置提示词')} onClose=${() => setDialog(null)}
      footer=${html`<button class="ghost" onClick=${() => setDialog(null)}>${t('Cancel', '取消')}</button><button class="danger" disabled=${busy} onClick=${reset}>${t('Use built-in', '恢复内置')}</button>`}>
      <p>${t('systemPromptFile is removed from config.json. Your file stays on disk and in the version history. The next start begins a fresh working context.', '会从 config.json 删除 systemPromptFile。你的文件仍保留在磁盘和历史版本中。下次启动时工作上下文会重新开始。')}</p><//>` : null}
    ${dialog?.type === 'upstream' ? html`<${Modal} wide title=${t('Built-in changes since your last save', '你上次保存以来内置版本的改动')} onClose=${() => setDialog(null)}>
      <p class="muted small">${t('Carry over what you want by hand, then save; saving marks this as seen.', '把需要的改动手动合并进编辑器后保存；保存后不再提示。')}</p>
      <${DiffView} before=${data.base} after=${data.builtin} /><//>` : null}
    `;
}
