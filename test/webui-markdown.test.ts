import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/webui/public/markdown.js';

test('development Markdown renders Chinese prose, nested lists, quotes, tables and code', () => {
  const rendered = renderMarkdown([
    '## 表达习惯',
    '**简短自然**，使用 `reply`。',
    '下一行仍然可读。',
    '',
    '1. 先回应话题',
    '   - 根据上下文补充',
    '2. 再展开',
    '',
    '> 一条观察',
    '',
    '| 场景 | 表达 |',
    '| --- | --- |',
    '| 闲聊 | 简短 |',
    '',
    '```text',
    '**literal** <tag> #1234abcd',
    '```',
  ].join('\n'));
  assert.match(rendered, /<h2>表达习惯<\/h2>/);
  assert.match(rendered, /<strong>简短自然<\/strong>/);
  assert.match(rendered, /<code>reply<\/code>。<br>\n下一行/);
  assert.match(rendered, /<ol>\n<li>先回应话题\n<ul>\n<li>根据上下文补充<\/li>/);
  assert.match(rendered, /<blockquote>\n<p>一条观察<\/p>/);
  assert.match(rendered, /<table>[\s\S]*<th>场景<\/th>[\s\S]*<td>简短<\/td>/);
  assert.match(rendered, /<pre><code class="language-text">\*\*literal\*\* &lt;tag&gt; #1234abcd\n<\/code><\/pre>/);
});

test('message refs remain text at line starts, in lists, quotes and code, while real headings render', () => {
  const rendered = renderMarkdown([
    '#a1b2c3d4 引用的消息',
    '#1234abcd',
    'message ref#abcd5678；依据 (#abcd1234, #ef012345)。',
    '',
    '- #fedcba98 列表内的引用',
    '',
    '> #87654321 引用内的引用',
    '',
    '`#11223344`',
    '',
    '# 真正的标题',
    '## 二级标题',
  ].join('\n'));
  for (const ref of ['#a1b2c3d4', '#1234abcd', '#abcd5678', '#abcd1234', '#ef012345', '#fedcba98', '#87654321', '#11223344']) {
    assert.ok(rendered.includes(ref), ref);
  }
  assert.deepEqual(rendered.match(/<h[1-6]>.*?<\/h[1-6]>/g), ['<h1>真正的标题</h1>', '<h2>二级标题</h2>']);
  assert.match(rendered, /<code>#11223344<\/code>/);
});

test('memory content cannot inject raw HTML or executable links into the management page', () => {
  const rendered = renderMarkdown([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://example.com"></iframe>',
    '[script](javascript:alert%281%29)',
    '[encoded](jav&#x61;script:alert%281%29)',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '[file](file:///etc/passwd)',
    '[safe](https://example.com/ "A quoted title")',
    '![image](https://example.com/image.png "A & B")',
  ].join('\n\n'));
  assert.doesNotMatch(rendered, /<(?:script|iframe)\b|<img src=x|href="(?:javascript|data|file):/i);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(rendered, /<a href="https:\/\/example.com\/" title="A quoted title">safe<\/a>/);
  assert.match(rendered, /<img src="https:\/\/example.com\/image.png" alt="image" title="A &amp; B">/);
});
