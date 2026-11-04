import { t } from './lib.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function parseDetails(value) { try { return object(JSON.parse(value)); } catch { return {}; } }
const str = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const operation = value => (value ?? '').split('__').at(-1);
export const outcomeKind = state => ({ success: 'ok', done: 'ok', running: 'info', streaming: 'info', pending: 'info', error: 'bad', failed: 'bad', unknown: 'warn', interrupted: 'warn', aborted: 'warn' })[state] ?? '';
export const outcomeLabel = state => ({
  success: t('Succeeded', '已成功'), done: t('Done', '已完成'), running: t('In progress', '进行中'), streaming: t('Writing', '正在写'), preparing: t('Preparing', '准备中'),
  pending: t('Pending', '待处理'), processing: t('Reading', '正在读取'), processed: t('Recorded', '已记录'), accepted: t('Read', '已读取'), queued: t('Waiting', '等待中'),
  error: t('Error', '出现错误'), failed: t('Failed', '未成功'), unknown: t('Outcome unconfirmed', '结果未确认'), interrupted: t('Interrupted', '已中断'), aborted: t('Stopped', '已中止'), stop: t('Done', '已完成'), toolUse: t('Continuing', '继续处理中'),
})[state] ?? t('Status recorded', '状态已记录');

export function conversationLabel(source, name) {
  if (name) return name;
  const match = /^([^:]+):[^:]+:(private|group|channel|thread):(.+)$/.exec(source ?? '');
  if (match) {
    let id = match[3]; try { id = decodeURIComponent(id); } catch { /* Keep the original identifier. */ }
    return `${({ private: t('Private chat', '私聊'), group: t('Group', '群聊'), channel: t('Channel', '频道'), thread: t('Thread', '话题') })[match[2]]} · ${id}`;
  }
  return source && !['Environment', '环境'].includes(source) ? source : '';
}
const personLabel = name => name?.replace(/^[^:]+:user:/, '') || t('Someone', '有人');
export function imageUrl(value) {
  if (typeof value !== 'string') return;
  if (/^\/api\/gallery\/drawing(?::|%3A)[a-f0-9-]+\/image$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/\/bot\d+:/i.test(url.pathname)) return url.href;
  } catch { /* Unsupported and local file URLs are shown as unavailable attachments. */ }
}
const routine = new Set(['model_request_started', 'model_request_finished', 'context_summary_completed', 'context_pruned', 'context_folded', 'context_budget', 'context_compaction_skipped']);
const alerts = new Set(['error', 'failed', 'unknown', 'interrupted', 'aborted']);
const labels = () => ({
  remember: t('Keeping a memory', '留下一段记忆'), recall: t('Looking back', '回想过往'), read_event: t('Reading an earlier event', '查看先前的经历'), read_chat_record: t('Catching up on a conversation', '翻看聊天记录'),
  set_activity: t('Updating her activity', '更新当前活动'), schedule_wake: t('Making a plan', '安排之后的事'), cancel_wake: t('Adjusting a plan', '调整之后的安排'),
  schedule_activity: t('Making a plan', '安排之后的事'), finish_activity: t('Wrapping up a plan', '结束一项安排'), update_pursuit: t('Progress on something she cares about', '给持续在做的事记下新进展'), finish_pursuit: t('Closing a pursuit', '结束一件持续在做的事'), retire_memory: t('Setting an old understanding aside', '放下一条不再适用的理解'), inspect_actions: t('Checking what happened', '确认行动的结果'), read_context: t('Revisiting an earlier exchange', '回看之前的思考记录'),
  imagen: t('Creating an image', '创作一张图片'), view_drawing: t('Looking at a drawing', '查看自己的作品'), view_event_image: t('Looking at a picture', '查看聊天图片'),
  send_group_msg: t('Sending a message', '发送消息'), send_private_msg: t('Sending a message', '发送消息'), send_msg: t('Sending a message', '发送消息'), sendMessage: t('Sending a message', '发送消息'),
  set_msg_emoji_like: t('Reacting to a message', '用表情回应消息'), send_poke: t('Poking someone', '戳一戳'), group_poke: t('Poking someone', '戳一戳'), friend_poke: t('Poking someone', '戳一戳'),
  delete_msg: t('Recalling a message', '撤回消息'), web_search: t('Searching the web', '查找网上的信息'), web_fetch: t('Reading a page', '阅读网页'),
  model_request_started: t('Waiting for the model', '正在等待模型'), model_request_finished: t('Model request finished', '模型调用结束'),
  context_summary_completed: t('Working context summarized', '工作上下文已整理'), context_compacted: t('Working context organized', '工作上下文已整理'), context_pruned: t('Older results condensed', '较早的结果已精简'), context_folded: t('Older content folded', '较早的内容已收起'), context_compaction_skipped: t('Context summarization skipped', '本次跳过上下文整理'),
  review_started: t('Looking back on recent experiences', '开始整理最近的记忆'), review_finished: t('Memory review completed', '记忆整理完成'), review_stopped: t('Memory review stopped', '记忆整理已中止'),
  connection_opened: t('Connected again', '连接已恢复'), connection_closed: t('Connection interrupted', '连接已断开'), connection_error: t('Connection needs attention', '连接出现异常'),
  runtime_error: t('Something needs attention', '运行出现异常'), thought_error: t('This thought ran into a problem', '这轮思考遇到了问题'), thought_preempted: t('New information changed her attention', '新消息打断了当前思考'),
  memory_forgotten: t('Memory removed', '已遗忘指定记忆'), control: t('Runtime settings changed', '运行状态已调整'),
});

/** Both feeds share this projection; raw records remain available only in their disclosure. */
export function presentItem(item) {
  const data = parseDetails(item.text);
  const event = object(item.eventData);
  const kind = item.eventKind ?? item.title;
  const op = operation(item.actionKind ?? item.title);
  const state = item.type === 'system' && ['error', 'aborted'].includes(data.status) ? data.status : item.state;
  const view = { item, category: 'life', icon: 'spark', title: item.title, text: '', state, tone: outcomeKind(state), source: conversationLabel(item.source, item.sourceName), quiet: Boolean(item.quiet), facts: [] };
  let message = item.message;
  // Older daemons still provide readable text and action arguments, without rich media.
  if (!message && item.type === 'environment' && kind === 'message') message = { direction: 'incoming', parts: [{ kind: 'text', text: item.text }] };
  if (!message && item.type === 'action' && ['send_group_msg', 'send_private_msg', 'send_msg', 'sendMessage'].includes(op)) {
    const text = typeof data.message === 'string' ? data.message : typeof data.text === 'string' ? data.text : Array.isArray(data.message) ? data.message.map(part => part.type === 'text' ? part.data?.text ?? '' : `[${part.type}]`).join('') : '';
    message = { direction: 'outgoing', parts: [{ kind: 'text', text }] };
  }
  if (message) {
    const outgoing = message.direction === 'outgoing';
    return { ...view, category: 'messages', icon: 'chat', title: outgoing ? t('Qiuyue', '秋月') : personLabel(item.sender), message,
      stateLabel: outgoing ? item.type === 'environment' || state === 'success' ? t('Sent', '已发送') : state === 'unknown' ? t('Delivery unconfirmed', '发送结果未确认') : state === 'failed' ? t('Not sent', '发送失败') : t('Sending', '正在发送') : undefined,
      text: message.parts.map(part => part.text).join('') };
  }
  if (item.type === 'environment') {
    if (kind === 'rest_backlog') {
      const chats = Array.isArray(event.chats) ? event.chats : [];
      view.icon = 'moon'; view.title = t('Catching up after a rest', '休息过后，接上大家的话题');
      view.text = chats.length ? t(`${chats.length} conversations continued while she rested. Their records are ready to read.`, `休息期间，${chats.length} 个会话有了新动态，现在一起补读。`) : t('Messages that arrived during her rest are ready to read together.', '休息期间积攒的聊天消息，现在一起补读。');
      view.facts = chats.map(chat => ({ label: conversationLabel(chat.conversation), value: t(`${chat.messages ?? 0} messages${chat.notices ? ` · ${chat.notices} notices` : ''}`, `${chat.messages ?? 0} 条消息${chat.notices ? ` · ${chat.notices} 条通知` : ''}`) }));
    } else if (kind === 'memory_revision') {
      view.icon = 'memory'; view.title = t('Her understanding has changed', '一些理解有了新的版本');
      view.text = t('Revised memories are available for her next thought.', '更新后的理解会带入接下来的思考。');
      if (Array.isArray(event.revisions)) view.facts.push({ label: t('Updated', '更新理解'), value: t(`${event.revisions.length} memories`, `${event.revisions.length} 条`) });
      if (event.cites?.length) view.facts.push({ label: t('To reconsider', '需要重新确认'), value: t(`${event.cites.length} related items`, `${event.cites.length} 项关联事项`) });
    } else if (kind === 'wake') {
      view.icon = 'sun'; view.title = event.freeTime ? t('A little time for herself', '有了一段自己的空闲时间') : t('Time to revisit a plan', '到了约定的时间');
      view.text = event.freeTime ? t('The chats are quiet. She can continue her own activities or rest.', '聊天暂时安静下来，可以继续自己的事，也可以休息。') : item.text.replace(/^Activity due \(decide whether it is still appropriate now\):\s*/, '');
    } else if (kind === 'memory_maintenance') {
      view.icon = 'memory'; view.title = t('Time to organize memories', '该整理一下最近的经历了'); view.text = t('Recent experiences are waiting to become lasting memories.', '把最近经历的事回顾一下，留下值得记住的部分。');
    } else if (kind === 'perception_gap') {
      view.icon = 'connection'; view.title = t('There may be a gap in what she heard', '有一段时间的消息可能没有听全'); view.text = t('The connection changed; some messages or notices may be missing.', '连接发生过变化，期间的消息或通知可能不完整。'); view.tone = 'warn';
    } else if (kind?.startsWith('notice:')) {
      view.icon = 'chat'; view.category = 'messages';
      view.title = kind.includes('poke') ? t('A little nudge', '有人戳了戳') : kind.includes('emoji') || kind.includes('reaction') ? t('A reaction to a message', '消息收到了表情回应') : kind.includes('recall') ? t('A message was recalled', '有人撤回了一条消息') : kind.includes('increase') ? t('Someone joined the group', '有新朋友加入群聊') : kind.includes('decrease') ? t('Someone left the group', '有人离开了群聊') : t('A conversation update', '会话有了新动态');
      view.text = item.sender ? personLabel(item.sender) : '';
      view.quiet ||= kind.includes('input_status');
    } else { view.title = t('A new event', '有了新的动态'); view.text = Object.keys(data).length ? '' : item.text; }
  } else if (item.type === 'run' || item.type === 'observation') {
    view.icon = 'spark'; view.quiet = item.type === 'observation';
    view.title = item.type === 'observation' ? t('Reading new events', '读到了新的动态') : state === 'running' ? t('Connecting the dots', '正在想一想') : t('A thought came to a close', '一轮思考告一段落');
    view.text = item.summary || t('Bringing recent events into the current thought.', '结合刚刚发生的事，想想接下来要做什么。');
    if (item.eventIds?.length) view.facts.push({ label: t('New events', '相关动态'), value: t(`${item.eventIds.length} events`, `${item.eventIds.length} 条`) });
  } else if (item.type === 'assistant') {
    view.icon = 'writing'; view.title = t('Words from this thought', '这一轮写下的话'); view.text = item.text;
    view.facts.push({ label: t('Visibility', '去向'), value: t('Not sent to a conversation', '未发送到聊天') });
  } else {
    view.category = item.type === 'system' ? 'system' : 'life';
    view.icon = item.type === 'system' ? 'pulse' : /remember|recall|memory|review/.test(op) ? 'memory' : /image|drawing|imagen/.test(op) ? 'gallery' : 'spark';
    view.title = labels()[op] || (item.type === 'system' ? t('A runtime update', '一条运行动态') : item.type === 'action' ? t('An external action', '一次对外行动') : t('Using a capability', '正在使用一项能力'));
    view.quiet ||= item.type === 'system' && routine.has(op) || item.type === 'tool' && /^(send_|send[A-Z]|read_|view_|get_)/.test(op);
    view.text = str(data.message || data.error || data.title || data.activity || data.query || data.prompt || data.content || data.progress || data.text);
    if (!Object.keys(data).length && item.text && !/^[\s]*[\[{]/.test(item.text)) view.text = item.text;
    if (!labels()[op]) view.facts.push({ label: t('Event', '事件'), value: op });
    if (data.model) view.facts.push({ label: t('Model', '模型'), value: str(data.model) });
    if (Number.isFinite(data.calls)) view.facts.push({ label: t('Requests', '调用'), value: str(data.calls) });
    if (op === 'connection_opened') { view.icon = 'connection'; view.tone = 'ok'; view.text = t('She can receive new events again.', '可以继续接收新的动态了。'); }
    if (op === 'review_finished') { view.icon = 'memory'; view.text ||= t('Recent experiences have been reviewed.', '最近的经历已经回顾完毕。'); }
  }
  if (alerts.has(state) || /error|stopped|closed/.test(kind ?? '')) { view.quiet = false; view.tone ||= 'warn'; }
  return view;
}

export function feedItems(items, { filter = 'all', quiet = false, compact = false, limit = compact ? 4 : 120 } = {}) {
  return items.map(presentItem).filter(view => (quiet || !view.quiet) && (filter === 'all' || view.category === filter))
    .sort((a, b) => b.item.at - a.item.at || b.item.id.localeCompare(a.item.id)).slice(0, limit);
}
