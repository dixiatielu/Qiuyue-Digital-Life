import type { TSchema } from 'typebox';
import type { Config } from '../config.js';
import { errorText } from '../domain.js';
import type { LifePlugin } from '../plugins.js';
import { clipRecordText } from '../record.js';
import { nativeToolDescription, type ThoughtContext, type ToolRuntime } from '../tool-runtime.js';
import { findSnowLumaAction } from '../snowluma-catalog.js';
import type { StickerStore } from './stickers-store.js';
import type { StickerRecall } from './stickers-recall.js';

const addUsage = 'Use an accessible image URL, base64:// data, or a file:// path on the SnowLuma server for file. Check the receipt to confirm success; after a successful save, use its returned emoji_id with modify_custom_face to add a description based on the image actually seen. QQ keeps one copy of an image, so alreadySaved in the local execution information means it was saved before and this only moved it to the front; keep its description unless it is wrong. If the outcome is unknown, verify it before taking further action.';
const describedAdd = 'Use an accessible image URL, base64:// data, or a file:// path on the SnowLuma server for file. Pass desc with a concise description of the image as you actually saw it and its suitable emotional or conversational use: once the save succeeds, it is set with modify_custom_face as an action of its own within this call, whose outcome appears as described in the local execution information, so you can save a sticker and send it or reply in the same batch. QQ keeps one copy of an image, so alreadySaved in the local execution information means it was saved before and this only moved it to the front; a description it already has is kept rather than replaced by desc, so use modify_custom_face if that one is wrong. If the outcome is unknown, verify it before taking further action.';

async function describe(runtime: ToolRuntime, emojiId: string, desc: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const args = { emoji_id: emojiId, desc };
    const { outcome, reused } = await runtime.action('modify_custom_face', args, dispatch => dispatch('modify_custom_face', args), signal);
    if (outcome.status === 'success') return { actionId: outcome.id, outcome: 'success', ...(reused ? { reused } : {}) };
    return { actionId: outcome.id, outcome: outcome.status, reused, error: outcome.result, instruction: outcome.status === 'unknown' ? 'The sticker is saved, but whether its description was set is unknown; check fetch_custom_face_detail before describing it again with modify_custom_face.' : 'The sticker is saved, but its description was not set; describe it with modify_custom_face if you still want to.' };
  } catch (error) { return { outcome: 'failed', error: { message: errorText(error) }, instruction: 'The sticker is saved, but its description was not set; describe it with modify_custom_face if you still want to.' }; }
}

export function stickersPlugin(config: Config, saved: StickerStore, recall?: StickerRecall): LifePlugin {
  const shown = new WeakMap<ThoughtContext, Set<string>>();
  return {
    id: 'qq-stickers', enabled: () => config.plugins['qq-stickers'] !== false,
    tools: () => [],
    decorateTool: (tool, runtime) => {
      if (tool.name !== 'add_custom_face') return tool;
      const describes = runtime.allowed('modify_custom_face');
      const schema = tool.parameters as TSchema & { properties?: Record<string, unknown> };
      return {
        ...tool,
        description: nativeToolDescription(findSnowLumaAction(tool.name), describes ? describedAdd : addUsage),
        parameters: describes ? { ...schema, properties: { ...schema.properties, desc: { type: 'string', minLength: 1, maxLength: 500, description: 'Description of the image as actually seen and its suitable emotional or conversational use, set with modify_custom_face once the save succeeds' } } } : schema,
        execute: async (callId, parameters, signal, onUpdate) => {
          const args = { ...parameters as Record<string, unknown> };
          const desc = typeof args.desc === 'string' && args.desc.trim() ? args.desc.trim() : undefined;
          if (args.desc !== undefined && (!describes || !runtime.allowed('modify_custom_face'))) throw new Error('The operator has not enabled describing a saved sticker.');
          delete args.desc;
          const result = await tool.execute(callId, args, signal, onUpdate);
          const base = result.details as Record<string, unknown>;
          const value = base.actionId ? runtime.store.actionById(String(base.actionId))?.result : undefined;
          const emojiId = String((value as { emoji_id?: unknown } | null)?.emoji_id ?? '');
          const previous = emojiId && saved.stickerSaved(emojiId, String(base.actionId)) ? saved.stickerNote(emojiId) ?? '' : undefined;
          const alreadySaved = previous !== undefined ? { alreadySaved: true, desc: previous } : {};
          const described = emojiId && desc !== undefined && !previous ? { described: await describe(runtime, emojiId, desc, signal) } : {};
          const { truncated, ...execution } = base;
          const metadata = { ...execution, ...alreadySaved, ...described, truncated };
          return { ...result, content: [result.content[0]!, { type: 'text', text: `Local execution information: ${JSON.stringify(metadata)}` }], details: metadata };
        },
      };
    },
    observation: (events, thought) => {
      if (thought.reviewing || !recall) return [];
      const seen = shown.get(thought) ?? new Set<string>(); shown.set(thought, seen);
      const stickers = recall.suggestions(events, seen);
      for (const sticker of stickers) seen.add(sticker.emojiId);
      return stickers.length ? [`Saved stickers of yours whose descriptions fit what was just said, in case you want to send one with send_custom_face; sending none is fine too:\n${JSON.stringify(stickers.map(({ emojiId, desc }) => ({ emoji_id: emojiId, desc })))}`] : [];
    },
    imageCaption: image => {
      const sticker = saved.savedSticker(image);
      return sticker ? ` (already your saved sticker ${sticker.emojiId}${sticker.desc ? `: ${sticker.desc}` : ''})` : undefined;
    },
    actionCaption: action => {
      if (action.kind !== 'send_custom_face') return;
      const note = saved.stickerNote(String(action.args.emoji_id ?? ''));
      return `me: [saved sticker${note ? `: ${clipRecordText(note)}` : ''}]`;
    },
    endsThought: (tool, details) => tool === 'add_custom_face' && (details as { described?: { outcome?: unknown } } | undefined)?.described?.outcome === 'success',
    start: () => recall?.start(), stop: () => recall?.stop(),
  };
}
