# Qiuyue Digital Life

A digital life with a persistent identity and memory, built with Pi Agent. Platform adapters expose complete native APIs as tools; one Agent observes QQ or Telegram and decides when to participate, act, or stay silent.

English | [简体中文](README.zh.md)

## What it is

A locally hosted digital life with a persistent persona and memory:

- **One soul:** Shares a single identity, memory, and ongoing activity across platforms, group chats, and private chats, keeping a unified persona everywhere.
- **Autonomous socializing:** Treats incoming messages as environmental perceptions, deciding on its own when to chime in, react, send images, or stay silent—and preempts unfinished thoughts when new replies arrive.
- **Grounded growth:** Builds on the operator's core persona through independent reviews, learning group norms, expression habits, and impressions from real interaction evidence without self-reinforcing loops.
- **Personal life:** Carries pursuits across days, spends quiet stretches browsing online feeds, communities, and the web or curating its own drawing gallery, and schedules its own sleep and rest.
- **Native interaction:** Exposes complete permitted native APIs to the same Agent through platform adapters, paired with hot-reloadable plugins for system faces, semantic sticker recall, and card sharing to use platform features like a real user.
- **Local control:** Separates social requests from runtime management, with a live TUI and standalone WebUI for status, separate thinking/review/compaction models, and provenance-aware memory editing.

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

## Acknowledgments and inspiration

Thanks to the following projects and their contributors for the ideas and design references explored in our [research notes](docs/research/):

- [Letta / MemGPT](https://github.com/letta-ai/letta) and [Letta Code](https://github.com/letta-ai/letta-code): external memory, memory consolidation, and context compaction.
- [Koishi](https://github.com/koishijs/koishi): plugin composition and lifecycle, configuration schemas, platform adapters, and testing tools.
- [Pi](https://github.com/earendil-works/pi): the embedded Agent runtime used by this project, tool interfaces, and on-demand skill loading.
- [OpenClaw](https://github.com/openclaw/openclaw): layered memory, saving memories before compaction, and skill organization.
- [Generative Agents](https://arxiv.org/abs/2304.03442): experience-based reflection, memory importance, and continuing plans.
- [Mem0](https://github.com/mem0ai/mem0), [Graphiti](https://github.com/getzep/graphiti), and [Hindsight](https://github.com/vectorize-io/hindsight): memory organization, hybrid retrieval, and associations between experiences.
- [MaiBot](https://github.com/MaiM-with-u/MaiBot) and [AstrBot](https://docs.astrbot.app/use/skills.html): sticker resources, social tool use, and the separation of skills and plugins.
- [Aurabot](https://github.com/aureth-labs/dsh-aurabot-qq) and [qq-bridge](https://github.com/Derpyu520/qq-bridge): conversational expression, proactive participation, online activities, and plugin design.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): token budgeting, tool-result pruning, and context compaction.

## License

[MIT](LICENSE) for this project's original code. The SnowLuma SDK and locally prepared API catalog retain their [upstream licenses](THIRD_PARTY_NOTICES.md).
