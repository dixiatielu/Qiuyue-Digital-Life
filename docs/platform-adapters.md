# Platform adapters

One Agent owns the persona, memory, pursuits, and action ledger. A platform adapter provides a complete catalog for a declared API revision, executes native operations, and publishes native events with platform context. Every permitted operation is a separate model tool. Catalog search or documentation never unlocks a smaller subset.

## Built-in adapters

| Driver | Coverage | Transport | Catalog provenance |
| --- | --- | --- | --- |
| `snowluma` | 212 canonical operations at the pinned revision; existing compatibility filtering retained | Official `@snowluma/sdk` 2.3.4 WebSocket client, including streaming frames | User-local catalog from SnowLuma commit `e9faec0e28298c6837ecd41d6132900c7bf08343`; restricted upstream license |
| `telegram` | All 187 `ApiMethods` members, including aliases, in `@grammyjs/types` 5.0.0 | Telegram Bot API HTTP, multipart uploads, optional long polling | Generated from MIT-licensed declarations; license included beside the catalog |

These counts describe fixed source versions, not a promise that every future upstream API is already supported. NapCat and Discord can use the same plugin contract; this change does not include their production adapters. The SnowLuma adapter uses its own native catalog; it does not claim complete NapCat coverage.

## Configuration

Existing configurations that omit `adapters` keep their unnamed SnowLuma tools and prompt. To opt into named adapters, add this array to the ordinary configuration (IDs below are examples):

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

An explicit `adapters` array replaces the legacy SnowLuma connection. A Telegram-only configuration can omit `snowluma` and needs neither a SnowLuma service nor its catalog cache. `adapters: []` runs the core and ordinary plugins without built-in platform connections. `npm ci` installs the official `@snowluma/sdk` dependency for the built-in SnowLuma adapter; it does not install or start the SnowLuma server. Run `npm run sync:snowluma` when using that adapter to prepare its versioned catalog. See [dependency licenses](../THIRD_PARTY_NOTICES.md).

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

On first binding of a named QQ adapter to an existing database's QQ account, migration adds canonical context to the old records, maps conversation review marks and development scopes, and annotates action conversations in one transaction. Event IDs, memory IDs, source links, original payloads and action IDs remain intact. Repeating the migration is safe. Reusing an instance ID for another account is rejected. Keep the same database, account ID, and instance ID when changing an adapter implementation.

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

The adapter is trusted local code. Supply a complete catalog with explicit provenance and a version; do not flatten every platform into a shared `send_message` subset. Validate account identity, preserve native payloads, honor cancellation, and retain platform-specific capabilities. `ctx.adapter` registers contributions during setup; reception starts only at activation. Adapter instances need unique tool namespaces. Other plugins can call `call.adapters.query(instance, operation, args)` or `call.adapters.action(instance, operation, args)` under host permissions and action rules. The legacy `call.snowluma` remains available only with the unnamed connection.

To regenerate Telegram declarations, run `npm run sync:telegram` and review the complete diff. The package and generator are pinned in `package-lock.json`; the generator's `glob` dependency is overridden to a patched release; generation also copies the MIT notice. Unit and integration tests use local servers and fixtures, not real platform accounts.
