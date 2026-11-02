# Plugin development

A plugin supplies one capability, including its tools and the hooks needed to participate in the digital life's experiences. Installed plugins are `drawing`, `web-search`, `web-reader`, `qzone-share`, `qq-stickers`, and `qq-faces`. They are local TypeScript modules registered at startup; configuration changes take effect after a restart.

The interface and host live in `src/plugins.ts`. Implementations and their composition root live in `src/plugins/`. Memory, continuing state, perception scheduling, working context, and QQ native tool registration remain built in for now.

## Configuration

`plugins` is an optional object of boolean switches, keyed by those IDs. Unknown names and non-boolean values are rejected. An omitted switch preserves existing behavior. A `false` switch removes the plugin's tools, enhancements, and activities and prevents an already held enhanced tool from executing. Original native tools remain available according to permissions.

The existing endpoint configuration is retained:

| Plugin | Additional requirements |
| --- | --- |
| `drawing` | `drawing.enabled`, an image endpoint and model |
| `web-search` | `web.enabled`, a search endpoint and its credential |
| `web-reader` | `web.enabled`; no search credential required |
| `qzone-share` | Allowed `get_qzone_share_ark` and at least one message send interface; each call also checks its actual target's send permission |
| `qq-stickers` | Defaults on; describing within a save also requires `modify_custom_face`. Suggestions require the existing embedding source; other enhancements work without it |
| `qq-faces` | Defaults on; reading an uncached directory uses `fetch_sys_faces` under its native permissions. Existing cached names and picture URLs can be reused |

The search tool remains visible without its credential, as before, and reports the missing credential when called. `validate` reports a warning; webpage reading remains usable. Explicitly disabling search suppresses that warning. The plugin switch does not grant native SnowLuma permissions.

Sticker suggestions retain `embedding.stickerThreshold` and `embedding.stickerLimit`. Turning off `qq-stickers` stops sticker indexing and suggestions and removes the save's extra `desc` parameter and image/record annotations. It preserves the existing action receipts and `sticker_vectors` rows for later reuse. Native collection management still works.

Turning off `qq-faces` removes `view_face`, face-name enhancement, and automatic pictures, without removing native reaction or message tools. The directory remains in the existing `faces` setting. Unknown faces continue to be rendered by ID; Unicode reactions still render as Unicode.

## Tools and thought state

Implement `LifePlugin` with a unique `id` and `tools(runtime)`. Use `runtime.jsonTool` for JSON results or `runtime.tool` for content blocks and execution metadata. For example:

```ts
import { Type } from 'typebox';
import type { LifePlugin } from '../plugins.js';

export function clockPlugin(): LifePlugin {
  return {
    id: 'clock',
    tools: runtime => [runtime.jsonTool(
      'read_clock', 'Read the current time.', Type.Object({}),
      () => runtime.record('clock_reading', { now: new Date().toISOString() }),
    )],
  };
}
```

Add the factory and its configuration ID to `src/plugins/index.ts`. The host rejects duplicate plugin IDs and tool names, including conflicts with built-in tools. Preserve existing registration order when changing the composition root: tool declarations participate in the persisted working-context identity. A plugin tool can specify `insertBefore` with an existing tool name when retaining its historical position; `view_face` uses this during extraction from the built-in tool set.

The daemon creates one host. The primary thinking process and memory review bind their own `ToolRuntime` to it. Resolve current thought state through `runtime.context()` at execution time; never capture a thought object during registration. Tool calls share pause, generation, life-mode, sequential-execution, and no-replay rules with built-in tools. Memory review retains its explicit tool allowlist; a new plugin tool is unavailable to review by default. Plugins can explicitly opt read-only tools into review with `reviewTools`, as `qq-faces` does for `view_face`.

An enhancement can return no new tools and implement `decorateTool(tool, runtime)`. It must preserve the tool name and call the original tool's executor for the original operation. Additional external actions use `runtime.action`. Discovery reads the decorated schema too. The host rechecks the plugin switch when a held enhanced tool executes. `qq-stickers` demonstrates adding `desc` to `add_custom_face`, stripping it before the native save, and recording the subsequent description separately. Failed or unknown description outcomes leave the successful save standing.

`runtime.record(kind, result)` stores a tool result as an experience and adds its source ID to the current thought. This is how a webpage or search result remains available to `read_event` and `remember` after its tool output is truncated or leaves working context.

## Actions

Use `runtime.action` for an external action. It records the attempt before dispatch, enforces the shared action budget, reuses previous outcomes for the same triggers, and preserves `unknown` when a dispatched action has no confirmed outcome. Arguments passed to it are the stable arguments to record, before expanding media references.

Its callback receives `dispatch(name, parameters)` for the actual SnowLuma action. Preparation can call `runtime.query` for permitted SnowLuma requests that obtain the material needed by that action, such as the post and signed card for sharing. Pause, cancellation, generation, and permission checks run again before dispatch. A failure during preparation is definite; a lost send receipt is unknown. Do not blindly retry an unknown result. Record separate external actions separately.

The Qzone plugin demonstrates this: the model supplies a post reference, the plugin obtains the signed card and sends it, and the whole operation keeps one action receipt. The card need not pass through the model.

## Background work and pictures

`start` runs once before live perception begins, after store recovery. Use it to recover interrupted work. `stop` must cancel and settle outstanding work before returning. The host waits for every stop hook, even if one fails, and calling stop again does not run hooks twice. Hooks must tolerate shutdown before startup completed.

The drawing plugin persists unfinished work and its existing `drawing:<uuid>` references. Painting returns an ID immediately. Completion or failure enters the normal environment-event queue, so the same Agent decides what to do next. A plugin's own output must set `payload.origin` to `self`: it cannot alone support a personal habit or impression. Legacy drawing events retain that treatment too.

`images(event)` supplies image descriptions with a lazy loader. `autoView` requests viewing when the observation arrives; the brain applies its shared image and context limits. `deferred` tells the Agent how to view the picture later, and `unavailable` explains a missing picture. `view_event_image` uses the same loaders for indexed images.

`supplementalImages(events, thought)` supplies pictures after chat images, using the remaining image and context budget. `onShown` runs only after a picture actually enters the observation, so budget limits and failed downloads do not mark it as seen. The system-face plugin uses a weak map keyed by the thought to show each face once without keeping face-specific state in the brain. `imageViewer(label)` names the tool for viewing a picture again when it is folded out of context; existing face labels retain their `view_face` pointers.

`emojiNames(events, signal)` supplies names for observations, or for a chat record when events are omitted. The face plugin reads its directory only if relevant events or records need it. `knownEmojiNames()` supplies already cached names without network access. The semantic recall constructor receives this provider from the host, so indexing can translate known faces without waiting on a directory request. The catalog and its successful picture cache are shared by the primary process and review; cancelled downloads are immediately retryable.

`observation(events, thought)` contributes text alongside an observation; a plugin controls whether it applies during review. Use thought-local state to show a hint at most once per thought. `imageCaption` annotates a received image, and `actionCaption` supplies a chat-record line for a known action. `endsThought(tool, details)` declares that a successful result needs no follow-up model call; failures continue to the model as before. These hooks keep sticker-specific decisions out of the brain and record renderer.

The sticker plugin owns its collection queries and vector table in `stickers-store.ts` and indexing in `stickers-recall.ts`. Its `SemanticSource` dependency supplies normalized text vectors and the message vectors already made for recall. There is no second embedding request for the same incoming message. Collection indexing has its own cancellation and retry lifecycle; a rejected description does not block memory indexing.

`resolveMedia(value)` recognizes references owned by the plugin and returns their transport representation, or `undefined` for values it does not own. The host visits nested outgoing parameters. For drawings, the transport value is `base64://…`; the action record retains `drawing:<uuid>`. Missing files fail before recording or sending a native action.

## Life activities

`activities` declares activities to offer at life wakes. They appear only while the plugin and corresponding tools are available. `experienceKinds` maps tool names to stored event kinds so the Agent sees when it last did each activity. `chatActions` identifies tools that engage a target chat, allowing new addressed messages there to influence the ongoing thought. These declarations do not create another Agent or an independent focus of attention.

Use `test/plugins.test.ts` for examples of exercising a new plugin through its tools, observations, media references, and life wakes without adding capability-specific branches to the brain.
