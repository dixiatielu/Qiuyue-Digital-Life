# Third-party licensing

The repository's MIT license applies to its original code. Dependencies and downloaded material keep their own licenses. This notice records dependency provenance and distribution conditions; it is not an additional permission from any dependency author.

## SnowLuma

The built-in adapter uses the official `@snowluma/sdk` 2.4.0 as an npm dependency for WebSocket communication, CQ message parsing, and streaming actions. It uses API definitions from SnowLuma commit `e44e4ced17c5911b9aa9db449ba29f2d9e567d2a`. The SDK and catalog retain the [SnowLuma Source-Available Non-Commercial License, version 1.0](https://github.com/SnowLuma/SnowLuma/blob/e44e4ced17c5911b9aa9db449ba29f2d9e567d2a/LICENSE); neither becomes MIT-licensed through this repository. The Chinese text takes precedence under that license.

SnowLuma's [SDK documentation](https://github.com/SnowLuma/SnowLuma/blob/e44e4ced17c5911b9aa9db449ba29f2d9e567d2a/packages/sdk/README.md) describes installing the package and using it in client applications. This project consumes the package without vendoring or modifying its source. Users install and run the SnowLuma server separately; this project does not bundle or deploy its server or proprietary native components.

`npm run sync:snowluma` downloads the pinned API definitions, validates their operation names against the installed SDK, applies compatibility filtering, and saves the catalog and full upstream license under ignored `.qiuyue-cache/snowluma/`. These local files are not tracked or copied into `dist/`. `QIUYUE_SNOWLUMA_CATALOG` may select an existing local catalog. Running another platform does not require this catalog or a SnowLuma service, although the default dependency installation includes the SDK.

The upstream terms restrict commercial use, require license and notice retention on redistribution, and require prior written permission for public release of modified or derivative versions. Section 4(b) also restricts other projects based on the software; its application to independently authored SDK clients is not clarified here. No additional authorization is recorded. This notice does not conclude that ordinary SDK use is prohibited or automatically makes the host a derivative work. MCP and SDK access do not provide different license exemptions.

Redistributing SDK code, modified catalogs, bundled dependencies, or historical source containing upstream material must be assessed against the applicable upstream terms. Do not include the local catalog in release artifacts without resolving its redistribution conditions. Excluding a file from new snapshots does not remove it from older Git history.

## Telegram catalog

`src/adapters/telegram/catalog.json` is generated from all API methods in `@grammyjs/types` 5.0.0, published by the [grammY types project](https://github.com/grammyjs/types) under MIT. Its copyright and full license are included at [`src/adapters/telegram/LICENSE`](src/adapters/telegram/LICENSE) and copied into builds. Generator inputs replace the generic upload type with a local upload descriptor and retain native parameter structure. This is a fixed type-package coverage statement, not an assertion of parity with future Telegram releases.

## Other dependencies

`package-lock.json` records the installed dependency versions. Their own license and notice files remain authoritative. Apart from the attributed generated Telegram catalog, the project does not vendor dependency source or build a bundled JavaScript release.
