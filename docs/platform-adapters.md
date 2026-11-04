# Platform adapters

One Agent owns the persona, memory, pursuits, and action ledger. A platform adapter provides a complete catalog for a declared API revision, executes native operations, and publishes native events with platform context. Every permitted operation is a separate model tool. Catalog search or documentation never unlocks a smaller subset.

## Built-in adapters

| Driver | Coverage | Transport | Catalog provenance |
| --- | --- | --- | --- |
| `snowluma` | 212 canonical operations at the pinned revision; existing compatibility filtering retained | Official `@snowluma/sdk` 2.4.0 WebSocket client, including streaming frames | User-local catalog from SnowLuma commit `e44e4ced17c5911b9aa9db449ba29f2d9e567d2a`; restricted upstream license |
| `telegram` | All 187 `ApiMethods` members, including aliases, in `@grammyjs/types` 5.0.0 | Telegram Bot API HTTP, multipart uploads, optional long polling | Generated from MIT-licensed declarations; license included beside the catalog |

These counts describe fixed source versions, not a promise that every future upstream API is already supported. NapCat and Discord can use the same plugin contract; this change does not include their production adapters. The SnowLuma adapter uses its own native catalog; it does not claim complete NapCat coverage.

## Configuration

Every configuration declares `adapters`. Existing installations must run the offline migration below. A new configuration includes this array (IDs below are examples):

```json
{
  "adapters": [
    {
      "id": "qq_main",
      "driver": "snowluma",
      "accountId": "1000000001",
      "url": "ws://127.0.0.1:3001",
      "tokenEnv": "SNOWLUMA_TOKEN",
      "groups": [],
      "tools": { "allow": "*", "deny": [] }
    },
    {
      "id": "telegram_main",
      "driver": "telegram",
      "accountId": "1000000002",
      "tokenEnv": "TELEGRAM_BOT_TOKEN",
      "receive": "polling",
      "tools": { "allow": "*", "deny": [] }
    }
  ]
}
```

Replace `accountId` with each actual account ID, as a decimal string. The connection verifies it before dispatch. Put the Telegram bot token in the usual credential store under `TELEGRAM_BOT_TOKEN`. The native names become `qq_main__get_qzone_feeds` and `telegram_main__sendMessage`. Permissions use original operation names. `allow: "*"` includes destructive, administrative, paid, and connection-management APIs; use `deny` or an explicit allow list when appropriate. Tool availability also depends on platform-side account permissions.

The top-level `snowluma` key and unscoped QQ plugin switches are rejected. A Telegram-only configuration needs neither a SnowLuma service nor its catalog cache. `adapters: []` runs the core and ordinary plugins without built-in platform connections. `npm ci` installs the official `@snowluma/sdk` dependency for the built-in SnowLuma adapter; it does not install or start the SnowLuma server. Run `npm run sync:snowluma` when using that adapter to prepare its versioned catalog. See [dependency licenses](../THIRD_PARTY_NOTICES.md).

Named connection plugins and user plugins registering adapters require a daemon restart when changed. This prevents two versions from polling the same account during a reload. Ordinary capability plugins still reload between thoughts. Their capability entries indicate when restart is required. For named SnowLuma, switches such as `qq-main-snowluma-tools` and `qq-main-qq-stickers` address the individual plugin; disabling the native connection plugin also stops that account's reception. The Telegram plugin ID is `adapter-telegram-main`.

## Native parameters, receipts, and media

Each tool keeps its native object schema, including nested fields, unions, and references. Telegram declarations omit repeated prose to reduce context use; `telegram_main__describe_api({"operation":"sendMessage"})` returns the complete original parameter documentation. It does not change the available tools. A large complete catalog needs a model and provider that accept the tool count and have context space for all declarations plus the conversation. The host never silently reduces that catalog to fit a provider limit.

Queries preserve native results and record their source IDs. External writes go through the same action budget, deduplication, and receipt ledger as other tools. A lost response remains `unknown`; the host never automatically retries a write. Telegram `getUpdates` is an action because its offset can acknowledge pending updates. SnowLuma streaming operations preserve ordered frames and enforce `maxStreamBytes`.

Telegram strings retain native file IDs, URLs, and `attach://` references. To upload a local file, pass an upload object where the API accepts an `InputFile`:

```json
{
  "chat_id": "1000000003",
  "photo": { "file": "/absolute/path/picture.png", "filename": "picture.png", "contentType": "image/png" },
  "caption": "A picture"
}
```

Uploads also work inside `media` arrays. The default per-file limit is 50,000,000 bytes (`maxFileBytes`). Incoming photos, image documents and sticker thumbnails can be viewed through the normal image path; downloading them requires `getFile` permission. Bot-token URLs stay inside the adapter. SnowLuma paths continue to refer to the SnowLuma server.

## Reception and identity

Telegram polling persists each update before advancing the saved offset. Replayed updates deduplicate by platform account and update ID. It requests all update types declared by the catalog, including reactions and membership changes. Telegram still controls which updates the bot can receive, and updates that expire while offline cannot be recovered.

Polling is serialized with model calls to `getUpdates`, `setWebhook`, `deleteWebhook`, `close`, and `logOut`. Existing webhooks are not removed automatically: they suspend polling. `deleteWebhook` resumes polling when `receive` is `polling`; `receive: "manual"` leaves update retrieval to explicit calls. The native webhook methods remain callable, but this release does not host a webhook receiver. Native `close` or `logOut` stops dispatch until restart.

Platform identifiers are strings. Examples of canonical conversation references are `qq:1000000001:group:1000000004`, `telegram:1000000002:private:1000000003`, and `telegram:1000000002:thread:-100123%2F17`. Conversation identity includes the platform account and excludes the implementation name. Raw native payloads remain in the event; normalized source context supplies the actor, conversation, whether the event is addressed to the Agent, and whether it is the Agent's own echo.

Reusing an instance ID for another account is rejected. Keep the same database, account ID, and instance ID when changing an adapter implementation. Development scopes use `conversation:<canonical conversation ref>` and `person:<platform>:user:<id>`; `global` remains available for habits and practices.

## Offline upgrade

Stop the daemon and management page, including any service that would restart them, then run the new code:

```sh
npm run dev -- identities migrate --config config.json
npm run build
npm start -- validate --config config.json
```

The command accepts the previous database schema, including installations already using named adapters. An unnamed QQ connection becomes `qq_main`; its `selfId` becomes the string `accountId`, connection settings move into `adapters`, and its QQ plugin switches become `qq-main-<capability>`. It needs the original QQ account configuration to resolve old records. Ambiguous or conflicting account bindings fail without committing the database conversion.

Before converting, it saves private configuration and SQLite backups next to their originals and prints both paths. SQLite backup includes committed WAL contents. The transaction converts event context, memory conversations/subjects/scopes, review marks, gallery provenance and action names/fingerprints, marks historical drawing events as self-originated, and removes obsolete local `saved` bookmark flags from reading caches while preserving notes, cursors and confirmed platform favorites; it removes old numeric identity columns and marks the database as format 2. IDs, source keys, tombstones, plans, source links and action outcomes are retained. Pending and unknown actions still prevent duplicate dispatch. Native API parameters and message payloads remain native. Historical prose and context records remain evidence rather than being text-rewritten.

The old working context is retained as a historical `context_records` entry (subject to ordinary forgetting and retention) and replaced with a fresh one at the next thought; long-term memories and continuing state remain. Sticker vectors are derived data and are rebuilt separately for each account. Run the command again after an interrupted config replacement: a committed database is recognized, so conversion is not applied twice. A completed migration returns `migrated: false` on subsequent runs. Database failures roll back; a live daemon or an existing migration lock prevents conversion. After a process crash, confirm that no migration is running before removing a stale `<database>.identities.lock` file.

Update user plugins and their `plugin.json` to SDK `apiVersion: 2`: replace `call.snowluma.query/action(name, args)` with `call.adapters.query/action(instance, name, args)`, and read canonical identity from `event.source` instead of numeric `groupId`/`actorId`. Rebuild packaged plugins with `npm run build:plugins`. If an operator-supplied system prompt names old tools or scopes, update those instructions too; the migration never rewrites user code or persona text. Restart the daemon and management page after validation.

To roll back, stop all processes, retain the migrated files separately, and restore the printed configuration and database backups together with the previous code/plugin versions. Move aside the migrated database's `-wal` and `-shm` companions before restoring its backup. Do not restore only the configuration while leaving the migrated database in place.

## External adapters

Use the existing [plugin SDK](plugins.md), not a second plugin framework. During `setup`, register an adapter:

```js
ctx.adapter({
  instance: "example_main",
  platform: "example",
  accountId: "18446744073709551615",
  version: "example-api-2026-11",
  actions: completeCatalog.actions,
  permissions: { allow: "*", deny: [] },
  execute: (operation, parameters, signal) => client.call(operation, parameters, signal),
  conversation: (operation, args) => args.channel_id
    ? { type: "channel", id: String(args.channel_id) } : undefined,
  start: async context => {
    // Validate the logged-in account, then publish every relevant native event.
    // context.publish accepts raw payload, conversation, actor, own and addressed.
    // Use context.storage for durable cursors; observe context.signal on shutdown.
  },
  stop: () => client.close()
});
```

The adapter is trusted local code. Supply a complete catalog with explicit provenance and a version; do not flatten every platform into a shared `send_message` subset. Validate account identity, preserve native payloads, honor cancellation, and retain platform-specific capabilities. `ctx.adapter` registers contributions during setup; reception starts only at activation. Adapter instances need unique tool namespaces. Other plugins can call `call.adapters.query(instance, operation, args)` or `call.adapters.action(instance, operation, args)` under host permissions and action rules. `call.snowluma` is not part of SDK v2.

To regenerate Telegram declarations, run `npm run sync:telegram` and review the complete diff. The package and generator are pinned in `package-lock.json`; the generator's `glob` dependency is overridden to a patched release; generation also copies the MIT notice. Unit and integration tests use local servers and fixtures, not real platform accounts.
