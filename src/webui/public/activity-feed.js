import { Badge, Card, duration, html, Modal, t, time, useState } from './lib.js';
import { Icon } from './icons.js';
import { feedItems, imageUrl, outcomeLabel } from './feed-model.js';

const partLabel = kind => ({ image: t('Image', '图片'), record: t('Voice message', '语音消息'), video: t('Video', '视频'), file: t('File', '文件'), forward: t('Forwarded conversation', '合并转发'), card: t('Shared card', '分享卡片'), face: t('Emoji', '表情'), attachment: t('Attachment', '附件') })[kind] ?? t('Attachment', '附件');

function Picture({ part, onPreview }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = imageUrl(part.url);
  const label = part.text || t('Chat image', '聊天图片');
  if (!url || failed) return html`<span class="feed-image-missing"><${Icon} name="gallery" /><span><strong>${label}</strong><small>${url ? t('The image could not load; its link may have expired.', '图片未能加载，链接可能已失效。') : t('No preview is available for this image.', '这张图片暂时没有可用的预览。')}</small></span>${url ? html`<button class="ghost tiny" onClick=${() => { setAttempt(attempt + 1); setFailed(false); }}>${t('Retry', '重试')}</button>` : null}</span>`;
  return html`<button class="feed-picture" onClick=${() => onPreview({ url, label })} aria-label=${t('Enlarge image', '放大查看图片')}>
    <img key=${`${url}:${attempt}`} src=${url} alt=${label} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError=${() => setFailed(true)} />
    <span>${t('View image', '查看大图')} ↗</span>
  </button>`;
}
function MessageContent({ parts, onPreview }) {
  return html`<div class="feed-message-content">${parts.map((part, index) => {
    if (part.kind === 'text') return html`<span key=${index}>${part.text}</span>`;
    if (part.kind === 'image') return html`<${Picture} key=${`${index}:${part.url}`} part=${part} onPreview=${onPreview} />`;
    if (part.kind === 'mention') return html`<span class="feed-mention">@${part.text === 'all' ? t('everyone', '全体成员') : part.text} </span>`;
    if (part.kind === 'reply') return html`<span class="feed-quote"><${Icon} name="reply" />${t('Reply to', '回复消息')} ${part.text}</span>`;
    return html`<span class="feed-attachment"><${Icon} name=${part.kind === 'face' ? 'smile' : 'attachment'} />${partLabel(part.kind)}${part.text ? ` · ${part.text}` : ''}</span>`;
  })}</div>`;
}
function RecordDetails({ item }) {
  return html`<details class="feed-details"><summary>${t('Record details', '记录详情')}</summary><div class="feed-record-meta">${time(item.at)} · ${item.title}${item.state ? ` · ${item.state}` : ''}</div>
    ${item.text ? html`<pre class="tl-details">${item.text}</pre>` : null}
    ${item.details ? html`<pre class="tl-details">${item.details}</pre>` : null}
  </details>`;
}
function FeedEntry({ view, onPreview }) {
  const [expanded, setExpanded] = useState(false);
  const { item, message } = view;
  const outgoing = message?.direction === 'outgoing';
  const long = view.text.length > 500;
  const timestamp = html`<time dateTime=${new Date(item.at).toISOString()} title=${time(item.at)}>${time(item.at, false)}</time>`;
  if (message) return html`<li class=${`feed-entry feed-chat ${outgoing ? 'outgoing' : 'incoming'}`}>
    <div class="feed-avatar" aria-hidden="true">${outgoing ? html`<${Icon} name="moon" />` : [...view.title][0]}</div>
    <article class="feed-chat-body" aria-label=${`${view.title} · ${time(item.at)}`}>
      <header class="feed-message-head"><strong>${view.title}</strong>${view.source ? html`<span class="feed-source">${view.source}</span>` : null}${timestamp}${view.state ? html`<${Badge} kind=${view.tone}>${outcomeLabel(view.state)}<//>` : null}</header>
      <div class=${`feed-bubble ${view.tone === 'bad' || view.tone === 'warn' ? view.tone : ''}`}>
        <div class=${long && !expanded ? 'feed-folded' : ''}><${MessageContent} parts=${message.parts} onPreview=${onPreview} /></div>
        ${long ? html`<button class="feed-more" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>${expanded ? t('Show less', '收起') : t('Read the full message', '展开整条消息')}</button>` : null}
      </div>
      <footer class="feed-message-foot">${view.stateLabel ? html`<span class=${`feed-delivery ${view.tone}`}>${item.state === 'success' || item.type === 'environment' ? '✓ ' : ''}${view.stateLabel}</span>` : null}<${RecordDetails} item=${item} /></footer>
    </article>
  </li>`;
  return html`<li class=${`feed-entry feed-event ${view.tone}`}>
    <div class="feed-event-icon" aria-hidden="true"><${Icon} name=${view.icon} /></div>
    <article class="feed-event-body">
      <header class="feed-event-head"><strong>${view.title}</strong>${timestamp}${view.state ? html`<${Badge} kind=${view.tone}>${outcomeLabel(view.state)}<//>` : null}</header>
      ${view.source ? html`<div class="feed-event-source">${view.source}</div>` : null}
      ${view.text ? html`<p class=${long && !expanded ? 'feed-prose clamp' : 'feed-prose'}>${view.text}</p>` : null}
      ${long ? html`<button class="feed-more" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>${expanded ? t('Show less', '收起') : t('Read more', '展开内容')}</button>` : null}
      ${view.facts.length ? html`<dl class="feed-facts">${view.facts.map(fact => html`<div><dt>${fact.label}</dt><dd>${fact.value}</dd></div>`)}</dl>` : null}
      <footer class="feed-event-foot">${item.durationMs != null ? html`<span>${t('Took', '用时')} ${duration(item.durationMs)}</span>` : null}<${RecordDetails} item=${item} /></footer>
    </article>
  </li>`;
}
function dayLabel(at) {
  const date = new Date(at), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? t('Today', '今天') : date.toDateString() === yesterday.toDateString() ? t('Yesterday', '昨天') : date.toLocaleDateString(t('en-US', 'zh-CN'), { year: 'numeric', month: 'long', day: 'numeric' });
}
export function ActivityFeed({ items, compact = false, onExpand, connected = false, title, limit }) {
  const [quiet, setQuiet] = useState(false);
  const [filter, setFilter] = useState('all');
  const [preview, setPreview] = useState(null);
  const shown = feedItems(items, { compact, quiet, filter, limit });
  const visible = feedItems(items, { quiet, limit: Infinity });
  let lastDay;
  return html`<${Card} class=${`activity-feed ${compact ? 'compact' : ''}`} title=${html`<span class="feed-heading"><${Icon} name="pulse" />${title ?? (compact ? t('Recent moments', '最近发生') : t('Live moments', '实时动态'))}</span>`} actions=${compact ? onExpand ? html`<button class="feed-all" onClick=${onExpand}>${t('View all', '查看全部')} <span>↗</span></button>` : null : html`<span class="feed-connection"><span class=${`dot ${connected ? 'ok' : 'warn'}`}></span>${connected ? t('Updating live', '动态实时更新中') : t('Waiting to reconnect', '等待重新连接')}</span>`}>
    ${!compact ? html`<div class="feed-toolbar"><div class="feed-filters" role="group" aria-label=${t('Filter events', '筛选动态')}>${[['all', t('All', '全部动态')], ['messages', t('Conversations', '聊天消息')], ['life', t('Life & thoughts', '生活与思考')], ['system', t('Runtime', '运行状态')]].map(([id, label]) => html`<button class=${filter === id ? 'active' : ''} aria-pressed=${filter === id} onClick=${() => setFilter(id)}>${label}<span>${visible.filter(view => id === 'all' || view.category === id).length}</span></button>`)}</div><label class="check"><input type="checkbox" checked=${quiet} onChange=${event => setQuiet(event.currentTarget.checked)} />${t('Include routine activity', '显示过程记录')}</label></div>
      <div class="feed-caption"><span>${t('A glimpse of her conversations, thoughts, and everyday life.', '看看她听到了什么、回应了什么，又做了些什么。')}</span><span>${t('Newest first', '最新在前')}</span></div>` : null}
    ${shown.length ? html`<ol class="moment-feed">${shown.flatMap(view => {
      const day = dayLabel(view.item.at), separate = !compact && day !== lastDay; lastDay = day;
      const entry = html`<${FeedEntry} key=${view.item.id} view=${view} onPreview=${setPreview} />`;
      return separate ? [html`<li class="feed-day" key=${`day:${day}`}><span>${day}</span><span></span></li>`, entry] : [entry];
    })}</ol>` : html`<div class="feed-empty"><${Icon} name=${filter === 'messages' ? 'chat' : 'moon'} /><h3>${items.length ? t('A quiet moment here', '这里暂时很安静') : t('Waiting for a new moment', '等待新的故事发生')}</h3><p>${items.length ? t('No events match this view. Try another filter or include routine activity.', '还没有符合筛选的动态，可以切换分类或显示过程记录。') : t('Conversations and everyday moments will appear here as they happen.', '收到的消息、说过的话和生活中的小事，都会出现在这里。')}</p></div>`}
    ${!compact && shown.length ? html`<div class="feed-end">${t(`${shown.length} recent records · the live feed keeps a limited history`, `已展示 ${shown.length} 条最近动态 · 此处保留最近一段记录`)}</div>` : null}
    ${preview ? html`<${Modal} title=${t('Chat image', '聊天图片')} wide class="feed-lightbox" onClose=${() => setPreview(null)} footer=${html`<a href=${preview.url} target="_blank" rel="noopener noreferrer">${t('Open original image', '打开原图')} ↗</a>`}><img src=${preview.url} alt=${preview.label} referrerPolicy="no-referrer" /><//>` : null}
  <//>`;
}
