# Qiuyue Digital Life

A locally hosted digital life built with [Pi Agent](https://github.com/earendil-works/pi), with one identity, long-term memory, and continuing state across QQ and Telegram.

English | [简体中文](README.zh.md)

- **Autonomous socializing:** Perceives messages and decides when to participate, act, or stay silent.
- **Continuity and growth:** Develops habits and relationships from experience, carries activities across days, and chooses when to rest.
- **Extensible capabilities:** Platform adapters expose permitted native APIs; plugins add web browsing, image generation, and other activities.
- **Local control:** CLI, TUI, and WebUI manage operation, configuration, and memory. Runtime control stays separate from ordinary chat.

## Quick start

The steps below use QQ through SnowLuma. For Telegram or multiple accounts, see [Platform adapters](docs/platform-adapters.md). Existing installations should follow the [offline upgrade instructions](docs/platform-adapters.md#offline-upgrade) before starting the new version.

### 1. Prepare the environment

Use the Node.js version in [`.nvmrc`](.nvmrc). Start and log in to [SnowLuma](https://snowluma.github.io/en/docs/sdk) separately, enable its forward OneBot WebSocket service, and prepare credentials for a model that supports image input.

```bash
nvm install
nvm use
npm ci
npm run sync:snowluma
```

### 2. Configure

```bash
cp config.example.json config.json
cp persona.example.md persona.md
install -m 600 credentials.example.json credentials.json
npm run dev -- models openai
```

Replace `openai` with your provider when listing models, then edit:

- **`config.json`:** Set `adapters[0].url`, the logged-in QQ account as a decimal string in `adapters[0].accountId`, and `model.provider` / `model.id`. Set `personaFile` to `persona.md`. `adapters[0].groups` selects groups for history recovery; it can be empty and does not restrict live events.
- **`persona.md`:** Describe the identity, personality, and initial preferences you want the digital life to have.
- **`credentials.json`:** Fill in the values under `credentials`, keeping `version` and `changes`: `MODEL_API_KEY`, `SNOWLUMA_TOKEN` if required, `DEEPSEEK_API_KEY` for web search, and optionally `WEBUI_TOKEN` for management-page login. External environment variables take precedence; `.env` files are not read.

> The example allows all SnowLuma APIs and sets no limits on model calls or actions. Adjust `adapters[0].tools` and `limits` before starting. Autonomous life is off by default.

Optional models, semantic recall, image generation, and autonomous life are covered in the [usage guide](docs/usage.md).

### 3. Start and manage

```bash
npm run dev -- validate --config config.json
npm run build
npm start -- run --config config.json
```

Validation checks configuration, models, and credentials without connecting to QQ. In a separate terminal, open either management interface:

```bash
npm start -- tui --config config.json
# Or open the management page:
npm start -- webui --config config.json
```

The management page defaults to `http://127.0.0.1:8848`. Log in with the `WEBUI_TOKEN` value, or the temporary token printed at startup if none is configured. Exiting either interface leaves the daemon running.

Use `npm start -- help` for CLI commands such as `status`, `pause`, `resume`, and memory management. Core configuration changes require a daemon restart; see the [usage guide](docs/usage.md) for daily operation.

## Documentation

- [Usage guide](docs/usage.md) — models, credentials, optional capabilities, TUI, WebUI, and gallery.
- [Platform adapters](docs/platform-adapters.md) — QQ / Telegram setup, permissions, migration, and adapter SDK.
- [Plugins](docs/plugins.md) · [Online life](docs/online-life.md) — extensions and Bilibili / Xiaohongshu setup.
- [Glossary](GLOSSARY.md) · [Architecture decisions](docs/adr/) — domain model and design rationale.
- [Contributing](CONTRIBUTING.md) — issues, pull requests, and local checks. Chinese and English are welcome.

## Acknowledgments

Built on Pi, with ideas from Letta / MemGPT, Letta Code, Koishi, OpenClaw, Generative Agents, Mem0, Graphiti, Hindsight, MaiBot, AstrBot, Aurabot, qq-bridge, and DeepSeek Harness. Sources and design comparisons are recorded in the [research notes](docs/research/).

## License

[MIT](LICENSE) for this project's original code. The SnowLuma SDK and locally prepared API catalog retain their [upstream licenses](THIRD_PARTY_NOTICES.md).
