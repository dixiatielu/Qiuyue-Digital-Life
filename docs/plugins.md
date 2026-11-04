# Plugin development

A plugin supplies one capability, including its tools and the hooks needed to participate in the digital life's experiences. Built-in plugins are `gallery`, `drawing`, `web-search`, `web-reader`, `qzone-share`, `qq-stickers`, `qq-faces`, and `snowluma-tools`. User plugins live in `plugins/<id>/` beside `config.json` and load without editing or rebuilding the program. Plugin settings and user code can be reloaded while the daemon keeps receiving events.

Bilibili and Xiaohongshu are optional user plugins in `packages/`, built separately with `npm run build:plugins` and installed into the user plugin directory. Neither is registered in the core. Both are opt-in (`plugins.bilibili: true`, `plugins.xiaohongshu: true`). Their settings are validated when loading a candidate and live in `extensions.settings` and have generated forms on the capabilities page, including while the daemon is offline. See [online life](online-life.md) for setup, reading progress, provenance, limits and current platform coverage.

The public v1 interface is [`src/plugin-sdk.ts`](../src/plugin-sdk.ts). The internal interface and host live in `src/plugins.ts`; built-in implementations live in `src/plugins/`. Memory, continuing state, perception scheduling, working context, and shared execution rules remain built in. QQ native tool registration and platform-specific life hints live in `src/plugins/snowluma-tools.ts`; platform transports and native catalog adapters live in `src/adapters/`; `src/snowluma.ts` is a compatibility export.

## Write a user plugin

Create `plugins/clock/index.mjs` (or copy [`examples/plugins/clock`](../examples/plugins/clock)). No SDK runtime import or dependency installation is needed:

```js
/** @type {import('qiuyue-digital-life/plugin-sdk').PluginDefinition} */
export default {
  id: 'clock',
  apiVersion: 1,
  name: 'Clock',
  version: '1.0.0',
  defaults: { timeZone: 'Asia/Shanghai' },
  configSchema: {
    type: 'object', additionalProperties: false,
    properties: { timeZone: { type: 'string', title: 'Time zone' } },
    required: ['timeZone'],
  },
  setup(ctx) {
    // Validate configuration during preparation; a failure keeps the old version running.
    const format = new Intl.DateTimeFormat('zh-CN', {
      timeZone: ctx.settings.timeZone, dateStyle: 'full', timeStyle: 'long',
    });
    ctx.tool({
      name: 'clock_read', description: 'Read the current local date and time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      readOnly: true, review: true,
      execute(_args, call) {
        return call.record('reading', { time: format.format(new Date()) });
      },
    });
  },
};
```

The ID must match the directory and use a lowercase letter followed by lowercase letters, numbers, or hyphens (at most 64 characters). `all` is reserved. Built-in IDs and existing tool names cannot be shadowed. `.mjs`, or `.js` with ES-module syntax, are supported; compile TypeScript to these formats before loading. The SDK declarations are exported as `qiuyue-digital-life/plugin-sdk` after `npm run build`. The plain-object form also works from a directory outside the checkout without resolving that package.

An optional `plugin.json` beside the entry module supplies static metadata, validated against the same v1 interface. It contains the definition's metadata fields (including `id` and `apiVersion`) without `setup`; its fields are authoritative when loading that source snapshot. A sidecar makes the name, description, defaults, configuration form and credential references available while disabled or while the daemon is offline, without importing code. Existing inline-only definitions continue to work.

Set `defaultEnabled: false` in the sidecar for opt-in plugins; an explicit `config.plugins[id]` overrides it. Mark a top-level string property of `configSchema.properties` with `credential: true` when its value is a credential **name**. The credential manager and redaction list discover these fields and merge their defaults with saved settings; do not place secret values in the manifest. For example:

```json
{
  "id": "reading-room",
  "apiVersion": 1,
  "name": "Reading room",
  "defaultEnabled": false,
  "defaults": { "keyName": "READING_ROOM_KEY" },
  "configSchema": {
    "type": "object",
    "properties": { "keyName": { "type": "string", "credential": true } }
  }
}
```

`setup(ctx)` declares tools and resources. Do not perform external actions, start unmanaged timers/listeners, or write files at module top level or during setup: candidates are prepared while the old version is still running. `ctx.every` starts only on activation; use `ctx.onDispose` for owned resources. Plugins run as trusted local Node code, with the daemon's privileges; the SDK is not a sandbox.

Disabled user code is not imported. Disabling an existing plugin works even if its edited source no longer loads. After an initial settings error, the daemon retains the schema for the management form so the configuration can be repaired and reloaded. Read changing stored state when a tool or task runs rather than capturing it during setup, since the old version can still be finishing work then.

| Interface | Behavior |
| --- | --- |
| `ctx.settings` | Plugin defaults merged with `extensions.settings[id]`; checked against `configSchema` |
| `ctx.tool(definition)` | Registers a JSON-result tool; parameters are validated on execution |
| `ctx.observe(events => string[])` | Adds observation material; failures are logged without failing the thought |
| `ctx.activity({activity, tools})` | Offers an activity at life wakes when its tools are available |
| `ctx.storage.get(key, fallback?)`, `set(key, value)` | JSON state scoped to this plugin ID, retained across reload and disable; writes require activation |
| `ctx.directory`, `ctx.dataDirectory` | Original source directory and persistent data directory; use the former for bundled data and the latter for files you write |
| `ctx.credential(name)` | Reads a named credential; keep credential names, not secret values, in plugin settings |
| `ctx.every(ms, work)` | Non-overlapping periodic work; suspended and drained before reload |
| `ctx.background(work)` | Starts tracked work from a tool without holding the thought; receives a lifetime `AbortSignal` |
| `ctx.publish({key, kind, text, origin, data?})` | Persists a normal environment event; keys and kinds are namespaced by plugin ID |
| `ctx.onDispose(cleanup)` | Registers cleanup, awaited in reverse order after work settles |
| `ctx.log(level, message)` | Writes a plugin-labelled trace entry; never log credential values |

A tool can declare `experienceKind: "reading"` to associate its activity with `call.record("reading", ...)`. Both map to `plugin:<id>:reading`; the next life wake can show the last actual experience without platform logic in the host.

Platform plugins can register complete native catalogs with `ctx.adapter`; see [platform adapters](platform-adapters.md) for the contract, account identity, and migration. Plugins can call `call.adapters.query(instance, operation, args)` and `call.adapters.action(instance, operation, args)` through the shared runtime. Connection plugins require restart to avoid overlapping event consumers; ordinary capability plugins retain hot reload.

At execution time, a tool receives `call.signal`, `call.reviewing`, `call.record(kind, value)`, `call.snowluma.query(name, args)`, `call.snowluma.action(name, args)`, and `call.action(kind, args, dispatch)` for another platform's action. QQ queries accept only read-only native interfaces; all QQ calls obey native permissions. External actions share the host's action budget, attempt ledger and deduplication. A dispatched generic action whose callback throws has an **unknown** outcome and is not automatically replayed. `readOnly: true` forbids SDK actions; memory review receives only tools explicitly declaring both `readOnly: true` and `review: true`. `call.action` returns `{ outcome: { id, status, result }, reused }`; only a confirmed `success` may update local state to reflect an external write. Keep credentials out of action arguments and receipts.

`await call.attachImages(sourceId, urls)` attaches actual images to the same tool result as its JSON output. The source must come from `call.record` in this invocation, and each URL must appear in its stored payload. The host handles public-address validation, redirects, cancellation, MIME checks, a 5 MB limit per image, a 12 MB total byte limit and at most `min(limits.maxImages, 20)` images per tool call. It returns `{ attached, failed, omitted }`; describe only delivered pictures as perceived. A failed download need not fail the text read. Images are attributed to the source in the tool result; their bytes are not added to the persisted experience. This is a generic SDK facility; platform URL selection and interpretation remain in the plugin.


Keep `call` inside its invocation: after it returns, its methods cannot act or write experiences. For background computation or retrieval, use `ctx.background(async signal => { ...; ctx.publish(...) })`; publish generated work with `origin: 'self'`, and actual external evidence with `origin: 'external'`. The event joins the same Agent's next observation. Background tasks must respect cancellation and must not directly create an independent thinking loop or send messages.

## Reload and inspect

```sh
npm run dev -- plugins list --config config.json
npm run dev -- plugins reload clock --config config.json
npm run dev -- plugins reload all --config config.json
```

The CLI waits for completion and exits unsuccessfully on failure. The control socket returns a job immediately; `plugins status` reports `preparing`, `waiting`, `applying`, `done`, or `failed`. The capabilities page shows each loaded version, errors and pending edits, generates fields from user configuration schemas, and provides individual/all reload buttons. Save a draft before reloading. The page never imports or executes user plugins; exact user-tool context compatibility is decided by the daemon at load time.

Preparation loads a complete source snapshot, validates settings, interface versions and tool-name conflicts, and leaves the running version intact if it fails. Dispatch of new thoughts, steering and memory reviews then pauses, while QQ perception continues saving events. Both brains and background work drain before candidates are activated and bindings switch together. Old SDK tool references are revoked; timers and cleanup belong to the old instance. A drain timeout retains the old version and configuration and resumes its timers. Cleanup errors after a successful commit are reported separately. An ongoing image generation completes before its plugin is replaced, rather than being reported as interrupted by a program restart.

Only an implementation or settings change preserves working context when tool declarations and the plugin's `contextVersion` are unchanged. Added/removed tools, modified descriptions/parameters, and a changed `contextVersion` renew working context; memory, events, activities and commitments persist. Bump `contextVersion` when observation or activity semantics change without a tool-declaration change. A plugin's release `version` alone does not reset context.

`reload ID` applies that plugin's saved switch and settings; `drawing` also applies its image endpoint settings, either web plugin applies shared `web` settings to both, and `snowluma-tools` applies native permissions together with dependent enhancements. `reload all` refreshes all plugins and these configuration groups. Replacement instances reread credential values from the same credential file; core model, embedding, connection and management-page credentials retain their own startup snapshots. Core configuration (persona, model, database, QQ connection, plugin directories and drawing storage directory) still requires a restart and is reported separately. Built-in **source** updates still require a rebuild/restart; built-in **configuration** changes can reload.

Optional configuration, with paths relative to `config.json`:

```json
{
  "extensions": {
    "directory": "plugins",
    "dataDirectory": "data/plugins",
    "reloadTimeoutMs": 120000,
    "settings": { "clock": { "timeZone": "Asia/Shanghai" } }
  },
  "plugins": { "clock": true }
}
```

Use explicit reload while developing. A unique snapshot under `<plugin>/.qiuyue-cache/` refreshes relative imports, including helpers and deleted files; it remains until disposal so lazy imports still work. `node_modules`, `.git`, and the snapshot directory are excluded. Install npm dependencies in the plugin's own directory. Changing npm dependencies can require a daemon restart because their paths remain cached by Node. Source snapshots are removed on disposal, but Node's in-process ESM cache is not unloadable; frequent long-running development can accumulate module instances. Isolated workers and automatic file watching are future extensions, not guarantees of this version.

## Configuration

`plugins` is an optional object of boolean switches, keyed by built-in or user IDs. Invalid IDs and non-boolean values are rejected; missing user source is reported in plugin status. An omitted switch preserves existing behavior. After applying it by reload, a `false` switch removes the plugin's tools, enhancements, and activities and prevents an already held tool from executing. Disabling an enhancement preserves the original native tools while `snowluma-tools` is on and permissions allow them.

The existing endpoint configuration is retained:

| Plugin | Additional requirements |
| --- | --- |
| `drawing` | `drawing.enabled`, an image endpoint and model |
| `gallery` | Defaults on; independent of generation. Embedding is optional for meaning-based search |
| `web-search` | `web.enabled`, a search endpoint and its credential |
| `web-reader` | `web.enabled`; no search credential required |
| `qzone-share` | Allowed `get_qzone_share_ark` and at least one message send interface; each call also checks its actual target's send permission |
| `qq-stickers` | Defaults on; describing within a save also requires `modify_custom_face`. Suggestions require the existing embedding source; other enhancements work without it |
| `qq-faces` | Defaults on; reading an uncached directory uses `fetch_sys_faces` under its native permissions. Existing cached names and picture URLs can be reused |
| `snowluma-tools` | Defaults on; each native tool follows `snowluma.tools.allow` and `deny`; discovery remains available while the plugin is on |

The search tool remains visible without its credential, as before, and reports the missing credential when called. `validate` reports a warning; webpage reading remains usable. Explicitly disabling search suppresses that warning. The plugin switch does not grant native SnowLuma permissions.

Sticker suggestions retain `embedding.stickerThreshold` and `embedding.stickerLimit`. Turning off `qq-stickers` stops sticker indexing and suggestions and removes the save's extra `desc` parameter and image/record annotations. It preserves the existing action receipts and `sticker_vectors` rows for later reuse. Native collection management still works.

Turning off `qq-faces` removes `view_face`, face-name enhancement, and automatic pictures, without removing native reaction or message tools. The directory remains in the existing `faces` setting. Unknown faces continue to be rendered by ID; Unicode reactions still render as Unicode.

Turning off `snowluma-tools` removes the native catalog's tools, `search_snowluma_tools`, `load_snowluma_tools`, and their platform-specific activity hints. It does not disconnect SnowLuma or stop incoming observations and recovery (ADR-0011). Other plugins can still use permitted native interfaces through the shared runtime, such as sharing a Qzone card. Sticker send suggestions are suppressed while the native send tool is absent.

## Internal tools and thought state

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

For built-in implementations, add the factory and its configuration ID to `src/plugins/index.ts`; user plugins use the SDK above. The host rejects duplicate plugin IDs and tool names, including conflicts with built-in tools. Preserve existing registration order when changing the composition root: tool declarations participate in the persisted working-context identity. A plugin tool can specify `insertBefore` with an existing tool name when retaining its historical position; `view_face` uses this during extraction from the built-in tool set.

The daemon creates one host. The primary thinking process and memory review bind their own `ToolRuntime` to it. Resolve current thought state through `runtime.context()` at execution time; never capture a thought object during registration. Tool calls share pause, generation, life-mode, sequential-execution, and no-replay rules with built-in tools. Memory review retains its explicit tool allowlist; a new plugin tool is unavailable to review by default. Plugins can explicitly opt read-only tools into review with `reviewTools`, as `qq-faces` does for `view_face`.

An enhancement can return no new tools and implement `decorateTool(tool, runtime)`. It must preserve the tool name and call the original tool's executor for the original operation. Additional external actions use `runtime.action`. Discovery reads the decorated schema too. The host rechecks the plugin switch when a held enhanced tool executes. `qq-stickers` demonstrates adding `desc` to `add_custom_face`, stripping it before the native save, and recording the subsequent description separately. Failed or unknown description outcomes leave the successful save standing.

A tool can supply `available()` to narrow its availability within an enabled plugin. The host reevaluates it when constructing the tool set and before executing a held tool. Native tools use this for operator permissions. Register the complete catalog once per thinking process; queries for detailed usage call `runtime.decorate` so enhancements such as the save's `desc` appear without registering a second tool of the same name. `runtime.resolveMedia` expands media references only for outgoing parameters, while action receipts retain the stable references.

`runtime.record(kind, result)` stores a tool result as an experience and adds its source ID to the current thought. This is how a webpage or search result remains available to `read_event` and `remember` after its tool output is truncated or leaves working context.

## Actions

Use `runtime.action` for an external action. It records the attempt before dispatch, enforces the shared action budget, reuses previous outcomes for the same triggers, and preserves `unknown` when a dispatched action has no confirmed outcome. Arguments passed to it are the stable arguments to record, before expanding media references.

Its callback receives `dispatch(name, parameters)` for the actual SnowLuma action. Preparation can call `runtime.query` for permitted SnowLuma requests that obtain the material needed by that action, such as the post and signed card for sharing. Pause, cancellation, generation, and permission checks run again before dispatch. A failure during preparation is definite; a lost send receipt is unknown. Do not blindly retry an unknown result. Record separate external actions separately.

The Qzone plugin demonstrates this: the model supplies a post reference, the plugin obtains the signed card and sends it, and the whole operation keeps one action receipt. The card need not pass through the model.

## Background work and pictures

`start` runs once per instance, after store recovery at boot or after old work drains on reload. Use it to recover interrupted work. `quiesce` suspends new background work and returns a resume function for a failed reload; `idle` waits for existing work. `stop` cancels and settles outstanding work on shutdown and releases resources. Hooks must tolerate disposal before startup completed, including rejected candidates. Do not start work from constructors or tool binding.

The `drawing` plugin exposes `imagen` for image generation, including photorealistic photos, illustrations, stickers, and diagrams. It persists unfinished work and its existing `drawing:<uuid>` references. `imagen` returns an ID immediately. Completion or failure enters the normal environment-event queue as a `drawing` event, so the same Agent decides what to do next. A plugin's own output must set `payload.origin` to `self`: it cannot alone support a personal habit or impression. Legacy drawing events retain that treatment too.

`images(event)` supplies image descriptions with a lazy loader. `autoView` requests viewing when the observation arrives; the brain applies its shared image and context limits. `deferred` tells the Agent how to view the picture later, and `unavailable` explains a missing picture. `view_event_image` uses the same loaders for indexed images.

`supplementalImages(events, thought)` supplies pictures after chat images, using the remaining image and context budget. `onShown` runs only after a picture actually enters the observation, so budget limits and failed downloads do not mark it as seen. The system-face plugin uses a weak map keyed by the thought to show each face once without keeping face-specific state in the brain. `imageViewer(label)` names the tool for viewing a picture again when it is folded out of context; existing face labels retain their `view_face` pointers.

`emojiNames(events, signal)` supplies names for observations, or for a chat record when events are omitted. The face plugin reads its directory only if relevant events or records need it. `knownEmojiNames()` supplies already cached names without network access. The semantic recall constructor receives this provider from the host, so indexing can translate known faces without waiting on a directory request. The catalog and its successful picture cache are shared by the primary process and review; cancelled downloads are immediately retryable.

`observation(events, thought)` contributes text alongside an observation; a plugin controls whether it applies during review. Use thought-local state to show a hint at most once per thought. `imageCaption` annotates a received image, and `actionCaption` supplies a chat-record line for a known action. `endsThought(tool, details)` declares that a successful result needs no follow-up model call; failures continue to the model as before. These hooks keep sticker-specific decisions out of the brain and record renderer.

The sticker plugin owns its collection queries and vector table in `stickers-store.ts` and indexing in `stickers-recall.ts`. Its `SemanticSource` dependency supplies normalized text vectors and the message vectors already made for recall. There is no second embedding request for the same incoming message. Collection indexing has its own cancellation and retry lifecycle; a rejected description does not block memory indexing.

`resolveMedia(value)` recognizes references owned by the plugin and returns their transport representation, or `undefined` for values it does not own. The host visits nested outgoing parameters. For drawings, the transport value is `base64://…`; the action record retains `drawing:<uuid>`. Missing files fail before recording or sending a native action.

## Life activities

`activities` declares activities to offer at life wakes. They appear only while the plugin and corresponding tools are available. `experienceKinds` maps tool names to stored event kinds so the Agent sees when it last did each activity. An activity can provide `currentValue` with the setting tool and a function reading its last successful arguments, as QQ signatures and online status do. `insertBefore` can retain an activity's historical position relative to a built-in activity. `activityInstructions` adds tool-usage guidance only while the plugin is enabled.

`chatActions` and `chatTarget(tool, args)` identify the chat engaged by a tool call, allowing new addressed messages there to influence the ongoing thought. `staleActions` selects calls that should be skipped if a newer addressed message arrived in their target chat before execution. `endsThought` identifies successful social actions that need no follow-up call. The QQ plugin supplies these rules for its native sends, reactions, and pokes; the brain performs the generic steering and interruption logic. These declarations do not create another Agent or an independent focus of attention.

Use `test/plugins.test.ts` for examples of exercising a new plugin through its tools, observations, media references, and life wakes without adding capability-specific branches to the brain.

## Gallery lifecycle

`gallery` owns `search_drawings`, `view_drawing`, `update_drawing`, its catalog and vector tables, legacy migration, and background indexing. Its constructor and tool binding do not write state or start work. Activation migrates old files and events; `quiesce` suspends indexing, `idle` drains the active request, failed reload resumes it, and `stop` cancels it and releases subscriptions. A late vector cannot restore a deleted work or overwrite an edited description. Indexing reuses `SemanticSource`; no separate embedding credentials or service is introduced.

The generator writes durable gallery records even when gallery tools are disabled. Turning off `drawing` or `drawing.enabled` leaves `gallery` and its media resolution available; turning off `gallery` keeps its records and files. Completion images are supplied once, by the generator when active and otherwise by the gallery. `onShown` marks actual observation or explicit viewing, not a deferred image.

Built-in plugins may expose an operator-only `manage(command, args)` hook. `plugins manage ID COMMAND JSON` dispatches through the active host and rejects requests while reload or shutdown is under way. These are not model tools or part of the public user SDK v1. The gallery accepts revision-checked `update` and `delete` commands; the webpage reads through `LifeReader` and never falls back to direct database writes.
