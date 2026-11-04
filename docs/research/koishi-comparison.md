# Koishi comparison and design references

Reviewed: 2026-11-05. This document records architectural research and candidate directions, not an accepted implementation specification or schedule.

## Sources and limits

- Qiuyue baseline: local `6c9a79b254456385c0f41addd160b55facb13ae3` and the workspace at the time of investigation. Findings were checked against the actual SDK, loader, management page, adapters, and tests, rather than relying only on the README. Existing uncommitted changes were not included in this investigation's changes.
- The investigation read Koishi's official Chinese documentation and inspected relevant implementations in its official repository. It did not run a Koishi instance or test platform compatibility or performance.
- Koishi source snapshot: [`97d5c395750cec37b772e0b94dc63c427e3bb868`](https://github.com/koishijs/koishi/tree/97d5c395750cec37b772e0b94dc63c427e3bb868), committed on 2026-10-08, with `@koishijs/core` at 4.18.11. This snapshot is not a claim about the latest stable npm release.
- Official documentation source snapshot: [`8d257bbbd369dd3d3821f6c3030f53fe4915a3ef`](https://github.com/koishijs/docs/tree/8d257bbbd369dd3d3821f6c3030f53fe4915a3ef), committed on 2026-10-08. Web pages will continue to change; important implementation findings use the pinned source below.
- "Verified" means supported by primary documentation or static source inspection. "Recommendation" means a design judgment for this project, not a demonstrated improvement in reliability, cost, or character behavior.
- Local validation: `node --import tsx --test --test-reporter=dot test/plugins.test.ts test/plugin-reload.test.ts test/platform-adapters.test.ts` passed 39 tests under Node.js `v24.22.1`. These tests cover local substitutes and loopback services, not real QQ/Telegram accounts. The full test suite was not run, and no production process was started.

## Align the concepts before comparing

Koishi provides infrastructure for chat-platform adapters, events, middleware, commands, plugins, and a console. Its `Bot` represents a platform account, while `Session` carries an event and its operational context; these should not be interpreted as an independent persona and an LLM conversation history, respectively. Koishi therefore cannot be described as inherently using "one Agent per group", nor as necessarily conflicting with our single Agent. [Adapter concepts](https://koishi.chat/zh-CN/guide/adapter/), [Session](https://koishi.chat/zh-CN/api/core/session)

This project explicitly commits to a unified persona, long-term memory, continuing state, and the Agent's judgment about whether to act. Adopting a chat framework does not automatically provide these capabilities. The comparison should focus on whether the engineering infrastructure helps us uphold those commitments. [ADR-0001](../adr/0001-one-agent-across-group-environments.md)

## What Qiuyue already has and where the gaps are

| Area | Evidence in the current implementation | Capabilities worth considering |
| --- | --- | --- |
| Plugin lifecycle and hot reload | Candidate preparation, draining thoughts and background work, an atomic switch, retaining the old instance on failure, revoking old tool references, and timer/cleanup management already exist. [PluginManager](../../src/plugin-manager.ts#L164-L223), [PluginScope](../../src/plugin-loader.ts#L41-L130) | The SDK's `PluginManifest` has no declarations for provided services or required/optional dependencies, and the manager has no corresponding dependency graph. Composition code currently handles these relationships. [SDK](../../src/plugin-sdk.ts#L42-L83), [Built-in composition](../../src/plugins/index.ts#L33-L71) |
| Configuration and management page | Static `plugin.json` manifests, JSON Schema validation, default-settings merging, and metadata access while a plugin is disabled or the daemon is offline already exist. [Manifest](../../src/plugin-manifest.ts), [Load validation](../../src/plugin-loader.ts#L238-L244) | Forms traverse only top-level properties; objects and arrays use JSON text areas, field enums are not converted to options, and load failures usually report only a plugin-level "Invalid settings" error. [Form](../../src/webui/public/pages/plugins.js#L127-L130), [ConfigField](../../src/webui/public/lib.js#L181-L220) |
| Testing and debugging | Faux models, in-memory databases, mock adapters, hot-reload tests, and cross-platform tests already exist. Automated testing is not absent. [Test helpers](../../test/helpers.ts#L22-L69), [Reload tests](../../test/plugin-reload.test.ts), [Adapter tests](../../test/platform-adapters.test.ts) | Test helpers still depend on internal repository modules, and package exports expose only plugin-sdk. No public testing toolkit or interactive virtual multi-user chat entry point was found. [Package exports](../../package.json#L6-L11), [Management page entry point](../../src/webui/public/main.js) |
| Applicability and plugin instances | Global plugin switches, native API permissions per platform account, and stable Conversation identifiers already exist. A user plugin's ID also determines its storage namespace. [Configuration](../../src/config.ts#L9-L27), [Identity](../../src/identity.ts#L1-L22), [Plugin state](../../src/plugin-loader.ts#L57-L59) | The public SDK has no declarative platform/conversation filters or contract separating plugin packages from instances. This is distinct from the existing account isolation. [SDK](../../src/plugin-sdk.ts) |
| Multiple platforms and messages | Complete pinned catalogs for SnowLuma and Telegram, native payloads, normalized sources, and DisplayMessagePart for the management interface already exist. [Adapter documentation](../platform-adapters.md), [Sources](../../src/identity.ts), [Display messages](../../src/display-message.ts) | Platform coverage remains limited, and shared message/media conversion contracts are still thin. Display code branches on QQ/TG operations. Moving display and media handling into adapters could avoid repeatedly changing central branches for each new platform. [outgoingMessage](../../src/display-message.ts#L49-L58) |
| Action reliability and rate limiting | External actions share accounting, budgets, and deduplication; pending/unknown outcomes block duplicate dispatch. Bilibili/Xiaohongshu already have request intervals, daily budgets, and cooldowns. [ToolRuntime](../../src/tool-runtime.ts#L64-L93), [Action ledger](../../src/store.ts#L648-L668), [PlatformNetwork](../../packages/online-reading/index.ts#L26-L68) | Rate limiting is not absent: the core general action budget is actionsPerHour, but there is no unified send scheduler per chat account/target. Add one only if actual platform limits and backlogs warrant it. [Configuration](../../src/config.ts#L32), [Telegram calls](../../src/adapters/telegram/index.ts#L48-L62) |
| Installation and upgrades | Plugin directories, source snapshots, apiVersion: 2, release version, contextVersion, and independent JSON state already exist. [Plugin documentation](../plugins.md), [SDK](../../src/plugin-sdk.ts#L63-L83) | Release version is mainly metadata. There is no host-version range negotiation, standard install/update workflow, or SDK-level plugin-data migration contract; apiVersion/contextVersion do not replace these. [Manifest validation](../../src/plugin-manifest.ts#L10-L16), [Storage interface](../../src/plugin-sdk.ts#L59) |

This is a comparison of infrastructure maturity, not a defect list. For example, a declared dependency graph pays off only when plugins actually need shared services; a small set of independent plugins need not gain complexity merely to match a framework.

## 1. Service dependency declarations: make plugin composition manageable at runtime

**Verified:** Koishi plugins can declare `inject.required` and `inject.optional`.

- A plugin body does not load until required services are ready. When a service changes, its consumers are disposed and reload once the service becomes available again.
- Optional dependencies do not block loading, and a change to an optional service alone does not trigger plugin disposal.
- When only part of a plugin needs a service, `ctx.inject()` creates a separate child plugin whose resources follow that dependency's lifecycle.
- Package manifests can declare `required`, `optional`, and `implements` to explain dependencies to installers; these serve a different purpose from runtime `inject`.

Sources: [Services and dependencies](https://koishi.chat/zh-CN/guide/plugin/service), [Pinned documentation source](https://github.com/koishijs/docs/blob/8d257bbbd369dd3d3821f6c3030f53fe4915a3ef/zh-CN/guide/plugin/service.md#L60-L140).

**Recommendation:** Declare the capabilities each plugin provides and consumes, reasons for missing dependencies, dependency versions, and the set affected by reload. For example, "requires the gallery to provide enhanced artwork sending" should be a relationship the host and management page understand. Address real composition needs first instead of registering every internal object as a service from the start.

**Boundary:** Koishi's documentation describes immediate disposal when services change. If this project introduces a dependency graph, retain the boundary of waiting for thoughts, reviews, and affected work to finish before replacement. Do not copy immediate unloading or expose the database or brain as freely callable services. [ADR-0021](../adr/0021-reload-scoped-plugins-between-thoughts.md)

## 2. Use configuration declarations for validation, defaults, and complete forms

**Verified:** Koishi's `Schema` supports configuration validation, defaults, and console forms. It handles arrays, dictionaries, objects, grouping, unions, descriptions, value ranges, and display roles. Conditional configuration can show the fields appropriate to the selected mode. [Configuration schemas](https://koishi.chat/zh-CN/guide/plugin/schema), [Pinned documentation source](https://github.com/koishijs/docs/blob/8d257bbbd369dd3d3821f6c3030f53fe4915a3ef/zh-CN/guide/plugin/schema.md)

**Recommendation:** Use the existing configuration schema as the single source of truth. Prioritize nested objects, array editing, enum selection, conditional fields, per-field errors, and explanations of defaults. New plugins should obtain usable forms without management-page changes. Reusing JSON Schema does not require switching to Schemastery.

Console extensions are also a formal plugin interface: plugins can add pages and attach frontend entry points to the optional console service. [Extending the console](https://koishi.chat/zh-CN/guide/console/)

**Boundary:** Improve generic forms before considering arbitrary plugin pages. "Saved successfully" and "Applied" must remain distinct. The management page should retain its separate process and recovery capabilities rather than restructuring existing boundaries to resemble Koishi. [ADR-0020](../adr/0020-a-management-page-apart-from-the-daemon.md)

## 3. Applicability, plugin groups, and reusable instances

**Verified:** Koishi filters select event contexts by platform, account, channel, group, or user. They support intersection, union, difference, and `$filter` in configuration files. The console provides graphical configuration, including application to whole plugin groups. [Filters](https://koishi.chat/zh-CN/guide/plugin/filter), [Pinned documentation source](https://github.com/koishijs/docs/blob/8d257bbbd369dd3d3821f6c3030f53fe4915a3ef/zh-CN/guide/plugin/filter.md#L83-L119)

Ordinary plugins do not support arbitrary multiple instances by default. They must explicitly declare `reusable` or design a `fork` lifecycle to coordinate multiple configurations and shared registrations. Multiple configurations should not simply mean repeating all initialization. [Lifecycle](https://koishi.chat/zh-CN/guide/plugin/lifecycle)

**Recommendation:** Move "where this capability applies" from internal plugin conditions into declarations visible to the operator, such as providing a set of tools or instructions only on one platform or in specified Conversations. Introduce stable instance identifiers and separate state namespaces if multiple configurations of the same plugin are actually needed.

**Boundary:** Filters are not a security sandbox and do not imply splitting the unified Agent's memory, persona, or Attention by group. Tools still need host authorization for their actual targets; the triggering event's source alone cannot authorize later actions across environments. Filtering plugin contributions and deciding whether to receive environment events are also separate decisions. [ADR-0001](../adr/0001-one-agent-across-group-environments.md), [ADR-0022](../adr/0022-expose-complete-native-tools-through-platform-adapters.md)

## 4. A public testing toolkit and interactive simulation environment

**Verified:** The official `@koishijs/plugin-mock` provides simulated events, clients, network requests, and reply assertions in a package that plugin developers can reuse. [Mock documentation](https://koishi.chat/zh-CN/plugins/develop/mock), [Pinned implementation](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/plugins/mock/src/adapter.ts)

The console sandbox can create virtual users, switch among participants in group chats, and observe plugin behavior without real platform accounts. The official documentation also explicitly says it cannot replace validation on real platforms. [First conversation](https://koishi.chat/zh-CN/manual/usage/adapter)

**Recommendation:** Package existing test facilities into a toolkit plugin authors can use directly, with an interactive debugging entry point driven by the same scenarios. Relevant scenarios include:

- New messages arriving in several environments while the Agent retains a single Attention.
- Continued event recording during Agent Pause, followed by reassessment after resuming.
- An external action receiving an unknown receipt, followed by observations that provide verification evidence.
- A failed plugin reload, unfinished work, or a temporarily unavailable dependency.
- Deleted experiences remaining absent from recall through related indexes and understanding.

**Boundary:** Koishi client assertions depend on message handling and `session.send`. The official documentation warns that asynchronous message listeners, background operations that are not awaited, and direct Bot API calls can produce unexpected results. Our toolkit should wait for explicit Observation, Thought, and Action phases instead of copying a completion criterion of "send one line and wait for one reply". [Mock limitations](https://koishi.chat/zh-CN/plugins/develop/mock#%E7%B1%BB-client), [Pinned client implementation](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/plugins/mock/src/client.ts#L78-L145)

The word sandbox here means a simulated chat environment; it does not establish process or permission isolation for third-party plugins.

## 5. Shared message representations alongside native capabilities

**Verified:** Koishi does not retain only the lowest common denominator. Alongside the common Bot API, `bot.internal` and `session[platform]` let plugins access native platform interfaces and raw events. Complete native-interface coverage still depends on the adapter. [Implementing a bot](https://koishi.chat/zh-CN/guide/adapter/bot)

Message elements provide a shared representation for text, mentions, images, quotes, and other content. Adapter encoders handle platform conversion, compatibility, and splitting. One logical message may produce several platform messages. [Message encoding](https://koishi.chat/zh-CN/guide/adapter/message)

**Recommendation:** Standardize host-facing message structures, media references, and rendering helpers to reduce platform-specific branches in observations, the management page, and generic plugins, while retaining raw payloads and native tools. Input and display normalization can come first without immediately unifying every sending interface.

**Boundary:** This project requires complete native tool catalogs, original parameters, and unified host permissions and receipts. Replacing all native tools with Koishi's generic sending interface would conflict with ADR-0022. If one action is split into several messages, record each part's outcome; a single success/failure must not conceal partial success or unknown outcomes. [ADR-0022](../adr/0022-expose-complete-native-tools-through-platform-adapters.md), [ADR-0008](../adr/0008-preserve-unknown-action-outcomes.md)

## 6. Distribution and upgrades: learn from package contracts before considering a marketplace

**Verified:** Koishi organizes plugin distribution through npm packages, naming conventions, semantic versions, and host `peerDependencies`. Package metadata includes descriptions, licenses, repositories, and service dependencies. The console distinguishes installation, enabling, configuration, and dependency management. [Publishing plugins](https://koishi.chat/zh-CN/guide/develop/publish), [Installation and configuration](https://koishi.chat/zh-CN/manual/usage/market)

**Recommendation:** First standardize plugin manifests, host/API compatibility ranges, pre-upgrade validation, pinned installation versions, and rollback to earlier versions. Enable third-party contributors to build, publish, and install independently before deciding whether a separate marketplace is needed. Rolling back hot-reloaded source and rolling back data across versions are different problems.

Koishi's marketplace contains many community plugins, but the official documentation explicitly does not guarantee the safety of unofficial plugins. Marketplace inclusion, a matching version, or a badge does not prove that an arbitrary plugin is safe to run. [Official installation guidance](https://koishi.chat/zh-CN/manual/usage/market)

## 7. Hot reload, queues, and databases: reference mechanisms, not direct replacements

### Hot reload

Most registrations on a Koishi Context are cleaned up automatically when the plugin unloads; external resources still need explicit disposal. The HMR implementation first attempts to load new modules, retains the module cache, and restores old plugins on certain failure paths. This does not undo external actions that have already occurred. [Lifecycle](https://koishi.chat/zh-CN/guide/plugin/lifecycle), [Pinned HMR source](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/plugins/hmr/src/index.ts#L255-L324)

This project already has a specific reload contract. Focus on dependencies and diagnosable states rather than designing generic hot reload again because Koishi has HMR. [ADR-0021](../adr/0021-reload-scoped-plugins-between-thoughts.md)

### Send queues

`sendQueued` spaces out messages, and `cancelQueued` clears the waiting queue. The pinned source uses an in-memory array and timers; scheduling the next start does not wait for the previous network send to complete. This is not a persistent outbox, a unified account-level rate limiter, or an exactly-once mechanism. [Pinned Session source](https://github.com/koishijs/koishi/blob/97d5c395750cec37b772e0b94dc63c427e3bb868/packages/core/src/session.ts#L196-L232)

In this snapshot, `session.send` also catches exceptions, logs them, and returns an empty array. It cannot directly serve as this project's action-receipt model, which preserves unknown outcomes.

**Recommendation:** If actual needs call for send pacing, add queues and expiry checks per account/target after recording the existing Action and before dispatch. Start no new actions while paused. Requests already dispatched retain their actual or unknown outcomes; cancelling a waiting task does not mean a remote request was undone. [ADR-0003](../adr/0003-separate-runtime-control-from-social-requests.md), [ADR-0008](../adr/0008-preserve-unknown-action-outcomes.md)

### Plugin data upgrades

Koishi lets plugins extend models through `model.extend()`. A field's `legacy` supports rename migrations, while `model.migrate()` handles more complex migrations. The documentation marks the latter as experimental and notes performance limits. [Data models](https://koishi.chat/zh-CN/guide/database/model)

**Recommendation:** Establish versioning and migration contracts for plugins' own persistent state; there is no need to replace SQLite to fit Koishi. Migrations and deletion must preserve experience provenance, indexes, and dependent understanding. A generic ORM does not automatically handle these domain relationships. [ADR-0003](../adr/0003-separate-runtime-control-from-social-requests.md)

## Candidate priorities

1. **First:** improve schema forms, a public testing toolkit, and an interactive simulation entry point. These directly lower the effort needed to use and validate plugins.
2. **As composition grows:** add service dependency declarations, explanations of reload impact, plugin applicability, and instance identifiers.
3. **When external distribution needs are clear:** establish package contracts, compatibility ranges, version upgrades, and plugin-data migrations.
4. **As actual platform problems arise:** add shared message/media helpers and send pacing while preserving native capabilities and actual action outcomes.

A framework feature list alone does not justify migrating wholesale to Koishi, building a plugin marketplace, or rewriting storage. These priorities are design judgments and should be weighed against current maintenance costs and concrete use cases before becoming GitHub Issues.
