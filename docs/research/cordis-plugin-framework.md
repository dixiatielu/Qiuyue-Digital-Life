# Cordis as a plugin framework

Reviewed: 2026-11-05. This note records a dated evaluation, not an accepted architecture change. It asks whether this project should replace its plugin host with [Cordis](https://github.com/cordiverse/cordis).

## Sources and limits

- Cordis package inspected: `cordis@4.0.0-rc.12`, the current npm `latest`, published 2026-10-21. Repository snapshot: [`66633488b4964857e66f3f618cd57a6bb7068da0`](https://github.com/cordiverse/cordis/tree/66633488b4964857e66f3f618cd57a6bb7068da0), last commit 2026-11-04. The core package is MIT, ESM, 72.8 KB unpacked in 13 files, with direct dependencies `cosmokit` and `@standard-schema/spec`.
- Older line inspected: `cordis@3.18.1`, last published 2024-09-17. Koishi's `@koishijs/core@4.18.11` declares `cordis: ^3.18.1`. A vendored fork, `@deepseek-ai/cordis@4.0.5`, is installed with DSH 0.2.1-rc.5; npm `latest` for that fork is 4.1.0.
- Official material: [cordis.js.org](https://cordis.js.org/), the package README and TypeScript declarations, and the DSH [Cordis primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) and [Fiber reference](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/fiber). The package README states that the API "is not yet stable and may change without notice".
- Lifecycle claims marked "probed" were reproduced against `cordis@4.0.0-rc.12` in a temporary directory: apply timing, async disposal, a throwing `apply`, and service-gated startup. No benchmark, production run, or real platform test was performed.
- Project baseline: commit `e6e33ba8e8d5e55f1e068e03b05e7962e9021d5b` plus the working tree. The investigation read the SDK, loader, manager, host, [plugin documentation](../plugins.md), and [ADR-0021](../adr/0021-reload-scoped-plugins-between-thoughts.md). `npx tsx --test test/plugins.test.ts test/plugin-reload.test.ts` passed 28 tests under Node `v24.22.1`.
- "Verified" means documented or reproduced here. "Assessment" is a design judgment for this project, not a measured improvement.

## What Cordis is

Cordis is the plugin/dependency-injection substrate Koishi is built on. It is not a chat framework and provides no Agent, memory, or platform concepts by itself.

| Concept | Verified behavior |
| --- | --- |
| Context | Service container; a service occupies a stable `ctx.<key>` and consumers look it up instead of importing an implementation. |
| Plugin | A function, object with `apply`, or `Service` subclass mounted with `ctx.plugin()`; optional `inject` and `Config`. |
| Fiber | Per-plugin lifecycle instance with `effect()`, `dispose()`, `await()`, `restart()`, and `update(config)`. |
| Inject | Declared service dependencies gate startup. A consumer with a missing service stays pending and applies once the service appears. |
| Effect | A reversible registration. `execute` runs immediately; disposers run in reverse order and are awaited on unload. |
| Events | Typed `emit`, `waterfall`, `parallel`, `serial`, and `bail` dispatch (used by DSH for its extension points). |

Probed details:

- `ctx.plugin()` returns a fiber in `LOADING`; `apply` runs after a microtask, and `await fiber` reaches `ACTIVE`. Applying is not deferred until a later commit.
- A throwing `apply` ends in `FAILED`, disposes effects created before the throw, and rethrows on `await`.
- `fiber.dispose()` awaits async disposers: a 300 ms disposer delayed resolution by 300 ms.
- A plugin declaring `inject: ['foo']` stays `PENDING` until a provider registers, then applies automatically; disposing the provider returns the consumer to `PENDING`.
- `update(config)` validates the new configuration with Standard Schema and restarts immediately; `restart()` disposes and reloads with the current configuration. `_unload()` waits for service dependents before disposing and runs disposers in reverse order.

What the core does **not** provide: configuration forms or a management UI, persistence/storage, plugin manifests, credentials, a tool registry, an action ledger, or process isolation. Configuration is Standard Schema validation only; `plugin.json`-style metadata, generated forms, and per-plugin JSON state have no Cordis equivalent. Plugins run as trusted in-process code, so there is no sandbox to gain.

## Version and maintenance status

| Line | Status | Evidence |
| --- | --- | --- |
| `cordis@4` | Release candidate; API explicitly unstable | `4.0.0-alpha.1` published 2025-03-02, `4.0.0-rc.12` on 2026-10-21; README warning; repo is active (commits on 2026-11-04) |
| `cordis@3` | Stable but frozen | `3.18.1` last published 2024-09-17; Koishi 4.18.11 still pins `^3.18.1` |
| `@deepseek-ai/cordis` | Vendored fork, actively updated | 4.0.5 installed with DSH; npm `latest` 4.1.0 (2026-11-04); source lives under DSH's `vendor/cordis` |

Adopting Cordis today therefore means choosing between a release-candidate upstream, a two-year-old frozen stable line, or a third-party vendor fork. That is a maintenance decision, not a drop-in dependency choice. The active repository and Koishi/DSH usage show the project is not abandoned; they do not make the 4.x API stable.

## Lifecycle semantics: where it collides with this project

The current host deliberately separates declaration from activation and swaps versions only after in-flight work drains:

1. `setup(ctx)` may only declare tools, observations, activities, timers, and cleanup. SDK writes such as `storage.set`, `publish`, and `background` are rejected until activation (`PluginScope.active()` / `declare()`, [loader](../../src/plugin-loader.ts#L41-L132)).
2. A candidate is built from a source snapshot, validated (manifest, settings, tool-name conflicts), and kept aside without side effects ([loader](../../src/plugin-loader.ts#L219-L249)).
3. `PluginManager.reload` pauses dispatch, quiesces retiring plugins, waits for their background work, starts candidates, atomically installs the replacement, and rolls back on failure. A drain timeout keeps the old version ([manager](../../src/plugin-manager.ts#L164-L223), [ADR-0021](../adr/0021-reload-scoped-plugins-between-thoughts.md)).

Cordis has no equivalent of steps 1–3. Its `apply` is the moment effects are created; `update` and `dispose` unload immediately (after awaiting disposers and service dependents). It can tell one plugin's teardown to wait for another plugin that consumes its service, but it cannot know that an Agent thought, a memory review, or a dispatched external action is still using the old version.

This is not a missing feature that a Cordis plugin could add cleanly: the host, not the plugin, owns the drain barrier and the action ledger. A Cordis-based rewrite would still need the manager and the staged loader, leaving only the resource-scope bookkeeping as a candidate for replacement.

## Fit with this project

The plugin infrastructure is about 940 lines: [SDK](../../src/plugin-sdk.ts#L1-L107) 107, [host and contract](../../src/plugins.ts#L1-L229) 229, [loader](../../src/plugin-loader.ts) 250, [manager](../../src/plugin-manager.ts) 229, [manifest](../../src/plugin-manifest.ts) 46, [composition](../../src/plugins/index.ts) 76. Most of it is the domain contract, not generic lifecycle code.

| Need | Current implementation | Cordis | Assessment |
| --- | --- | --- | --- |
| Public plugin contract | Plain object, no runtime import, optional `plugin.json` | Plugin imports Cordis, Context, services | Keep the v2 plain-object contract |
| Staged prepare without side effects | `setup` declares; `start` activates | `apply` creates effects immediately | Cordis cannot express the staging |
| Drain, atomic swap, rollback | `PluginManager` + `PluginHost.install` | No external barrier; `update`/`dispose` immediate | Keep the manager |
| Service dependency graph | Implicit in `createPlugins` | `inject`/`provide`/service lookup | Cordis is better only if the graph actually grows |
| Tools, observations, activities, images, native adapters, action receipts | `LifePlugin` + `ToolRuntime` | None | Keep the domain layer |
| Per-plugin storage, credentials, settings forms, offline metadata | `PluginScope`, manifest, management page | None in core | Keep |
| Failure cleanup and async disposal | `PluginScope` | Mature effect system | Cordis is somewhat stronger here |
| Sandbox / fault isolation | Trusted in-process code | Trusted in-process code | No difference |

Two migration options exist, with very different costs:

- **Internal container only.** Keep `PluginDefinition`/`PluginContext` v2 and reimplement `PluginScope` on a Cordis Context: map `onDispose`, `every`, and `background` to effects, use services only for genuinely shared capabilities, and keep the manager responsible for drain and atomic swap. This replaces a few dozen lines of bookkeeping, adds a dependency, and puts two lifecycle layers (staged scope + fibers) side by side. Benefit: a formal service graph and a better-tested disposal implementation. Cost: medium risk, little user-visible change.
- **Public API swap.** Make Cordis the plugin contract. This requires reworking the SDK, loader, [plugin documentation](../plugins.md), the `clock` example, the Bilibili/Xiaohongshu packages, and the 28 plugin/reload tests; existing user plugins break; plugin authors must learn Context, fibers, inject, and effects. It also exposes a general service container where ADR-0021 deliberately keeps lifecycle and state under host control. Cost: high; benefit: capabilities this project does not currently need.

The one real gap in the current design is declarative dependencies. [The Koishi comparison](koishi-comparison.md) already identified it: `plugin.json` has no `provides`/`requires`, and `createPlugins` wires relationships by hand. That gap can likely be closed with manifest metadata plus host-level gating in tens of lines, without adopting a framework.

## Recommendation

Do not replace the plugin framework with Cordis now. Cordis is a credible, actively developed framework, and DSH demonstrates that its service/effect model can carry an agent product with many plugins. This project's needs are narrower and its lifecycle contract is stricter than Cordis's model, so the migration would replace a small amount of code while adding a dependency, a public API break, and the risk of a release-candidate API.

Concrete next steps, in order:

1. Add `provides`/`requires` to the manifest and a host-level dependency gate when the first real cross-plugin dependency appears. This is the cheapest response to the actual gap.
2. If composition keeps growing, run a one-to-two-day spike behind the v2 facade: implement `PluginScope` on Cordis, keep `PluginManager` unchanged, and pilot one built-in plugin. Success criterion: remove a meaningful amount of custom lifecycle code while all 28 plugin/reload tests pass unchanged. Otherwise abandon the spike.
3. Revisit a wholesale switch only if one of these becomes true: plugins start providing services to each other; the same plugin needs multiple isolated instances/forks; Koishi/Satori ecosystem reuse becomes a goal; the self-maintained lifecycle layer grows well beyond its current size and bugs cluster around teardown or dependency order; or Cordis 4 reaches a stable release with settled documentation.

If a switch is ever made, keep the public contract and the manager, and adopt Cordis as an internal container. Moving the public plugin API to Cordis would be a re-architecture of the Agent's capability composition, not a framework swap, and should be justified by a product need rather than by framework features.
