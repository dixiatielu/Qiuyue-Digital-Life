# Plugin development

A plugin supplies one capability, including its tools and the hooks needed to participate in the digital life's experiences. The first plugins are `drawing`, `web-search`, `web-reader`, and `qzone-share`. They are local TypeScript modules registered at startup; configuration changes take effect after a restart.

The interface and host live in `src/plugins.ts`. Implementations and their composition root live in `src/plugins/`. Memory, continuing state, perception scheduling, working context, and QQ native tool registration remain built in for now.

## Configuration

`plugins` is an optional object of boolean switches, keyed by those four IDs. Unknown names and non-boolean values are rejected. An omitted switch preserves existing behavior. A `false` switch removes the plugin's tools and activities and prevents an already held tool from executing.

The existing endpoint configuration is retained:

| Plugin | Additional requirements |
| --- | --- |
| `drawing` | `drawing.enabled`, an image endpoint and model |
| `web-search` | `web.enabled`, a search endpoint and its credential |
| `web-reader` | `web.enabled`; no search credential required |
| `qzone-share` | Allowed `get_qzone_share_ark` and at least one message send interface; each call also checks its actual target's send permission |

The search tool remains visible without its credential, as before, and reports the missing credential when called. `validate` reports a warning; webpage reading remains usable. Explicitly disabling search suppresses that warning. The plugin switch does not grant native SnowLuma permissions.

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

Add the factory and its configuration ID to `src/plugins/index.ts`. The host rejects duplicate plugin IDs and tool names, including conflicts with built-in tools. Preserve existing registration order when changing the composition root: tool declarations participate in the persisted working-context identity.

The daemon creates one host. The primary thinking process and memory review bind their own `ToolRuntime` to it. Resolve current thought state through `runtime.context()` at execution time; never capture a thought object during registration. Tool calls share pause, generation, life-mode, sequential-execution, and no-replay rules with built-in tools. Memory review retains its explicit tool allowlist; a new plugin tool is unavailable to review by default.

`runtime.record(kind, result)` stores a tool result as an experience and adds its source ID to the current thought. This is how a webpage or search result remains available to `read_event` and `remember` after its tool output is truncated or leaves working context.

## Actions

Use `runtime.action` for an external action. It records the attempt before dispatch, enforces the shared action budget, reuses previous outcomes for the same triggers, and preserves `unknown` when a dispatched action has no confirmed outcome. Arguments passed to it are the stable arguments to record, before expanding media references.

Its callback receives `dispatch(name, parameters)` for the actual SnowLuma action. Preparation can call `runtime.query` for permitted SnowLuma requests that obtain the material needed by that action, such as the post and signed card for sharing. Pause, cancellation, generation, and permission checks run again before dispatch. A failure during preparation is definite; a lost send receipt is unknown. Do not blindly retry an unknown result. Record separate external actions separately.

The Qzone plugin demonstrates this: the model supplies a post reference, the plugin obtains the signed card and sends it, and the whole operation keeps one action receipt. The card need not pass through the model.

## Background work and pictures

`start` runs once before live perception begins, after store recovery. Use it to recover interrupted work. `stop` must cancel and settle outstanding work before returning. The host waits for every stop hook, even if one fails, and calling stop again does not run hooks twice. Hooks must tolerate shutdown before startup completed.

The drawing plugin persists unfinished work and its existing `drawing:<uuid>` references. Painting returns an ID immediately. Completion or failure enters the normal environment-event queue, so the same Agent decides what to do next. A plugin's own output must set `payload.origin` to `self`: it cannot alone support a personal habit or impression. Legacy drawing events retain that treatment too.

`images(event)` supplies image descriptions with a lazy loader. `autoView` requests viewing when the observation arrives; the brain applies its shared image and context limits. `deferred` tells the Agent how to view the picture later, and `unavailable` explains a missing picture. `view_event_image` uses the same loaders for indexed images.

`resolveMedia(value)` recognizes references owned by the plugin and returns their transport representation, or `undefined` for values it does not own. The host visits nested outgoing parameters. For drawings, the transport value is `base64://…`; the action record retains `drawing:<uuid>`. Missing files fail before recording or sending a native action.

## Life activities

`activities` declares activities to offer at life wakes. They appear only while the plugin and corresponding tools are available. `experienceKinds` maps tool names to stored event kinds so the Agent sees when it last did each activity. `chatActions` identifies tools that engage a target chat, allowing new addressed messages there to influence the ongoing thought. These declarations do not create another Agent or an independent focus of attention.

Use `test/plugins.test.ts` for examples of exercising a new plugin through its tools, observations, media references, and life wakes without adding capability-specific branches to the brain.
