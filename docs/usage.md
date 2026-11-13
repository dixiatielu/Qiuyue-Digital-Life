# Usage guide

[Back to README](../README.md) · [简体中文](usage.zh.md)

After the first-start steps in the README, use this guide for configuration and day-to-day management.

- [SnowLuma catalog](#snowluma-catalog)
- [Credentials and interface language](#credentials-and-interface-language)
- [Models](#models)
- [Optional capabilities](#optional-capabilities)
- [Persona and system prompt](#persona-and-system-prompt)
- [Terminal management](#terminal-management)
- [Management page](#management-page)
- [Gallery](#gallery)
- [Plugins](#plugins)

## SnowLuma catalog

`npm run sync:snowluma` prepares the pinned API catalog and its license in `.qiuyue-cache/snowluma/`, outside Git. Run it again after changing the SDK or source version. Development commands, tests, and the compiled program read this local catalog; `QIUYUE_SNOWLUMA_CATALOG` can name a separately prepared catalog. Build output does not include it.

## Credentials and interface language

In `credentials.json`, under `credentials`, set `MODEL_API_KEY` and, if required by SnowLuma, `SNOWLUMA_TOKEN`; set `DEEPSEEK_API_KEY` for web search and `WEBUI_TOKEN` for the management page. Keep `version` and `changes` as in the example. `credentialsFile` defaults to `credentials.json` beside the configuration; set an absolute path to keep it outside the checkout. The file is plaintext, protected by `0600` permissions. Credentials come from external environment variables first, then this file. An empty external variable or a `null` file entry disables that credential. The `apiKeyEnv`, `tokenEnv`, and `searchKeyEnv` settings are credential names. `.env` files are not read. Set `uiLanguage` to `zh` in `config.json` for Chinese, and restart the daemon and viewers after changing it.

## Models

`model.thinkingLevel` controls how much a reasoning model thinks before each turn: `off` (the default), `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. A custom model also needs `model.reasoning` set to `true`. For OpenAI Chat Completions, `model.compat.thinkingFormat` decides how the level is sent; use the format your endpoint accepts, since a gateway may reject another. With the OpenAI format, `off` sends nothing and leaves the model at its own default, so use `minimal` for the least thinking.

`model` runs everyday thinking and actions. Optional `review.model` and `compaction.model` accept the same complete model configuration, including custom endpoint capabilities, credential name, and thinking level. For example, keep a less expensive model in `model` and copy the stronger model's full configuration into both `review.model` and `compaction.model`. All three must understand images. They share one persona, long-term memory, and continuing state.

### Custom endpoints

Custom endpoints support `openai-completions`, `openai-responses`, `anthropic-messages`, and Gemini's native `google-generative-ai` API. The management page offers **Gemini (native)** for providers and all three model assignments, including model listing and connection tests. For a built-in Gemini model, use provider `google` and a model ID from `npm run dev -- models google` without setting `api`.

For a Gemini native custom endpoint, use a complete model object like this, replacing the ID and token limits with those of your model:

```json
{
  "provider": "gemini-gateway",
  "id": "your-gemini-model-id",
  "api": "google-generative-ai",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "apiKeyEnv": "GEMINI_API_KEY",
  "input": ["text", "image"],
  "contextWindow": 1048576,
  "maxTokens": 8192,
  "reasoning": true,
  "thinkingLevel": "low"
}
```

Save `GEMINI_API_KEY` through Credentials or in `credentials.json`. The native adapter sends `x-goog-api-key` and streams `models/{id}:streamGenerateContent`; `baseUrl` must include the API version, usually `/v1beta`, including any gateway prefix. Leave `compat` empty for Gemini; Pi maps `thinkingLevel` to the model's native thinking level or token budget. Model listing follows native pagination and excludes models declared to support only other methods, such as embedding. See Google's [API reference](https://ai.google.dev/api) and [model listing reference](https://aistudio.google.com/api-reference/models/list-models). This native support covers thinking, review, and compaction; embedding and drawing still use their documented OpenAI-compatible endpoints.

### Inheritance and compaction

With no `review.model`, review follows `model`. With no `compaction.model`, each context uses its own model for summaries: primary summaries follow the primary model, review summaries follow the review model. An explicit compaction model handles both. Omit an override to inherit; an empty model object or `null` is invalid. Overrides never merge fields with another model and failed requests never silently switch models. Inherited summaries do not explicitly enable extra reasoning; an independent summary uses its own `thinkingLevel` (off by default).

Review can separately set `review.limits.contextTokens` and `review.limits.outputReserveTokens`; omitted fields follow `limits`. `compaction.contextTokens` caps the summary request's window and defaults to the owner's configured window, bounded by the summary model. `compaction.summaryMaxTokens` bounds the saved summary including references. A summary must fit back into the owner's context even when the summarizer has a larger window. Validation reports model assignments, missing credentials, and insufficient budgets. Output reserves include reasoning; budget-based Anthropic reasoning requires more than 1,024 output tokens.

Primary context compaction starts in the background when the context exceeds `compaction.idleRatio` of its input budget (default 85%), thinking has been idle for `compaction.idleAfterMs` (default 30 seconds), and no events are waiting to wake it. New messages can be answered using the existing context while the summary runs. The summary replaces only its original history prefix at a request boundary or after a thought; the current tail, new exchanges, and latest runtime state stay. Requests wait for an existing summary only when the full input budget is exceeded, and compact in the foreground if no usable summary is available. Pause, deletion, and context resets invalidate background work; plugin maintenance drains it.

The management page's Models section offers all three assignments, inheritance controls, budgets, and connection tests. Changes take effect after restart. Changing only review/compaction settings retains the primary working context; changing `model` starts a fresh working context while retaining memory and continuing state. The Overview's Model usage tab separates primary thinking, review, and each owner's compaction over the last 24 hours. Attempts share the daily call budget; retries count once each. Missing usage and historical purpose information remain unknown, and zero SDK cost is not treated as free service.

## Optional capabilities

### Semantic memory (`embedding`)

To let the digital life recall memories by what people are talking about, set `enabled` to `true` and point `baseUrl` and `model` at an OpenAI-compatible embeddings endpoint. Every threshold depends on the model: `threshold` (what messages call to mind), `searchThreshold` (the few words of a deliberate `recall`, which score lower), and `stickerThreshold` (saved stickers whose descriptions fit what is said, at most `stickerLimit` of them) were calibrated at `0.65`, `0.55`, and `0.65` for `qwen3-vl-embedding`, and other models need their own values. List in `selfNames` the names people call the digital life, so a message is not matched to every memory that mentions it. Without embedding, thoughts recall nothing on their own, and `recall` searches by exact words only.

### Image generation (`drawing`)

To let the digital life generate images with `imagen`, including photorealistic photos, illustrations, stickers, and diagrams, set `enabled` to `true` and point `baseUrl` and `model` at an OpenAI-compatible `/images/generations` endpoint, with its credential named by `apiKeyEnv`. Generation takes half a minute or more, so an image comes back to the digital life as an observation when it is done, and requests give up after `timeoutMs`. Generated images are kept in `dir` (`data/drawings` beside the configuration by default) long term in the gallery, independently of chat-memory retention. There is no limit on how often it generates images; watch the endpoint's quota.

### Autonomous life (`life`)

`enabled` turns autonomous life on at first start, and `allowFiction` permits fictional daily life. While autonomous life is on, `freeTime` offers a life wake when the chats have been quiet for a stretch between `quietMinMs` and `quietMaxMs`, at least `gapMs` from any other life wake and at most `perDay` a day. The digital life holds it back by marking rest on the activity it will wake for.

## Persona and system prompt

In `persona.md`, describe the digital life's identity, world, personality, and initial preferences. The [example persona](../persona.example.md) is a complete, editable character with examples of expression and social habits. These are starting preferences that can develop through experience, not a universal style template. Plugins supply platform activities and usage guidance separately.

System instructions use [`src/prompts/system.md`](../src/prompts/system.md), maintained with the runtime and separate from the operator's `personaFile`. They are read once at startup; `npm run build` copies them into `dist`. After editing them, rebuild and restart the daemon (development runs only need a restart).

## Terminal management

Use these commands with `npm start -- <command> --config config.json` after building:

| Command | Purpose |
| --- | --- |
| `status` / `logs` | Inspect continuing state or logs |
| `pause` / `resume` | Pause or resume the digital life |
| `life on` / `life off` | Enable or disable autonomous life |
| `memory search <query>` | Search memories and personal notes |
| `memory show <ID>` | Inspect a memory and its sources |

Run `npm start -- help` for all commands, including memory correction and deletion. Restart the daemon after changing core configuration.

### Live view

```bash
npm start -- tui --config config.json
```

Exiting the live view does not stop the daemon.

The live view puts conversations first: received messages and external actions remain visible after a run ends, while tool activity and model output expand on demand. Model output is labeled “not sent to QQ”; message actions distinguish sent, awaiting receipt, failed, and unknown outcomes. Long messages preview eight lines and expand to the full text. Connection and pause status stay at the top; current activity and context usage stay at the bottom. Accents adapt to the terminal's light or dark background. Received events waiting to enter the model appear separately. Two minutes without output produces a “Waiting longer than usual” hint, not a confirmed-stall diagnosis.

Use `Alt↑↓` to select records, `Tab` to expand details, and `/details` to view full records and streaming telemetry. `/filter errors` shows failures and unknown outcomes; `/filter all` clears the filter. Type `/` to browse management commands, use `↑↓` to select and `Tab` to fill the input, then press Enter to execute. `Esc` dismisses suggestions without clearing the input. `/status` shows call and action counts; `Esc` closes status or help.

## Management page

```bash
npm start -- webui --config config.json
```

A web page for the same work: live status and timeline, pause and life switches, configuration, plugins and QQ interface permissions, the persona file and the digital life's own development, the system prompt, model providers, and the separately stored credentials. It runs apart from the daemon, so it stays up while the daemon restarts and still opens when the configuration no longer loads.

- **Access:** it listens on `webui.host`:`webui.port` (default `127.0.0.1:8848`); from another machine, use an SSH tunnel such as `ssh -L 8848:127.0.0.1:8848 <server>`. Use the value of the credential named by `webui.tokenEnv` (default `WEBUI_TOKEN`) in the login form. The credential name itself is not a token. If no token is configured, each start prints a temporary token in the terminal or service log; paste that token into the form. Tokens in URL query strings are not accepted.
- **Appearance:** seven sections organize the overview, gallery, configuration, capabilities and plugins, persona and growth, system prompt, and models and connections. The top-right Appearance control offers six accent presets, a custom HEX color, and light, dark, or system color modes. Preferences are saved in this browser and apply immediately without a restart. Duration fields accept milliseconds, seconds, minutes, or hours and are saved as milliseconds.
- **Saving:** every save checks the configuration the way the daemon loads it, refuses a file changed elsewhere since the page read it, and keeps earlier configuration, persona, and prompt versions under `data/webui/history`. Credentials have no value history; only the names, times, and kinds of the latest 100 changes are recorded in the credential file. Plugin settings can be applied with Reload on the capabilities page; core settings take effect when the daemon restarts. The page reports the running plugin versions and whether a reload renews working context; changing the persona, system prompt, model, or tool set starts a fresh one.
- **System prompt:** saving it writes `system-prompt.md` beside `config.json` (outside git) and sets `systemPromptFile`; without that setting the built-in prompt is used. The page warns when the built-in prompt has changed since your file was saved.
- **Restarts:** set `webui.service` to the daemon's systemd user unit, such as `qiuyue-digital-life.service`, to start, stop, and restart it from the page. A restart can wait until no thought or memory review is under way.
- **Credentials:** the page shows masked values and their sources, refuses edits to externally injected values, and saves new values only to `credentialsFile`. Connection tests read the latest files with the same precedence as the daemon. Reload the affected plugins to apply their credentials; core consumers still require a daemon restart, and changing the login token requires a management-page restart.
- **Providers:** the page keeps provider endpoints in `data/webui/providers.json`; choosing one copies its address, API, and key variable into the selected thinking/review/compaction model, `embedding`, or `drawing`. The daemon reads only `config.json`.

## Gallery

The management page's Gallery browses generated images with search, dates, origins, tags, favorites, archives, downloads and deletion. Successful generation saves the original and provenance regardless of sharing outcomes. The default-on built-in `gallery` plugin works even when new generation is disabled. The model uses `search_drawings`, `view_drawing` and `update_drawing`, then reuses the permanent `drawing:<uuid>` through existing message, Qzone and sticker tools. Prompts remain separate from observed descriptions. Semantic search reuses the embedding source and falls back to keywords if unavailable.

The catalog is the source of gallery entries. Startup recovers tracked, interrupted generations and deletions; it does not import old events or unregistered image files. Existing catalog entries and originals remain available. Archiving is reversible; explicit deletion permanently removes the original, thumbnail and search index, retaining a historical deletion marker. Browsing and downloading work with the daemon stopped; edits require the running daemon and gallery plugin. `plugins.gallery: false` disables tools and indexing without deleting works. Built-in source changes require one rebuild/restart; subsequent switch changes use `plugins reload gallery`.

## Plugins

See [Plugin development](plugins.md) for switches, installation, reloads, and the SDK; [Platform adapters](platform-adapters.md) for QQ, Telegram, and offline upgrades; and [Online life](online-life.md) for Bilibili and Xiaohongshu setup.
