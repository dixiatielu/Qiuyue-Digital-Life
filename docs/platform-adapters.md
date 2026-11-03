# Platform adapters

One Agent owns the persona, memory, pursuits, and action ledger. Each adapter exposes a complete, versioned native catalog, with one model tool per permitted operation. Parameters and raw results are preserved; catalog lookup supplies documentation without changing tool availability.

## Built-in SnowLuma adapter

The SnowLuma adapter uses official `@snowluma/sdk` 2.3.4 for WebSocket communication, CQ parsing, and streams. Its pinned catalog contains 212 canonical operations. Run `npm run sync:snowluma` to prepare the local catalog and upstream license; see [third-party notices](../THIRD_PARTY_NOTICES.md). SnowLuma itself is installed and run separately by the operator.

Existing configurations without `adapters` retain unnamed SnowLuma tools. For named accounts:

```json
{
  "adapters": [{
    "id": "qq_main",
    "driver": "snowluma",
    "accountId": "1000000001",
    "url": "ws://127.0.0.1:3001",
    "tokenEnv": "SNOWLUMA_TOKEN",
    "groups": [],
    "tools": { "allow": "*", "deny": [] }
  }]
}
```

Replace `accountId` with the logged-in QQ account and configure its credential. The connection verifies the account before dispatch. Tools become names such as `qq_main__get_qzone_feeds`; permissions retain native operation names. An explicit `adapters` array replaces the legacy connection, and `adapters: []` runs without built-in platform connections.

Every native action uses the shared budgets, deduplication and action ledger. An unconfirmed dispatched result remains unknown and is not automatically retried. Streaming calls preserve frame order and `maxStreamBytes`; SnowLuma file paths refer to its server.

## Identity and lifecycle

The canonical conversation `qq:1000000001:group:1000000004` includes platform and account, not the implementation name. First binding of a named QQ adapter adds canonical source context to existing records and migrates review marks and memory scopes without replacing event, memory, source or action IDs. Keep the same database, account and instance ID when changing implementations. Reusing an instance ID for another account is rejected.

Connection plugins require a daemon restart so two instances cannot consume events for the same account during a reload. Ordinary capability plugins still hot-reload. For named SnowLuma, switches such as `qq-main-snowluma-tools` address scoped plugins; disabling that native plugin also stops the connection.

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

Unit and integration tests use local servers and fixtures, not real platform accounts.
