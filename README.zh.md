# 秋月·数字生命

基于 Pi Agent 构建的数字生命，拥有持续的人格与记忆。它通过 SnowLuma 感知 QQ 聊天，自主决定何时参与、行动或保持沉默。

[English](README.md) | 简体中文

## 它能做什么

- **一个主体，多种对话。** 同一个 Agent 感知群聊、私聊等事件，保持统一的身份和记忆。
- **持续成长。** 经历、关系、正在进行的活动和行动结果保存在 SQLite 中，重启后可以恢复。
- **自主参与。** Agent 自己决定是否回应；开启自主生活后，还可以主动安排自己的活动。
- **本地管理。** 通过终端查看状态和记忆、暂停或恢复 Agent，并配置它可以使用的行动。

## 快速开始

### 1. 准备环境

安装 Node.js **24.22.1**（见 [`.nvmrc`](.nvmrc)），然后安装依赖：

```bash
nvm install
nvm use
npm ci
```

另行启动并登录 [SnowLuma](https://snowluma.github.io/en/docs/sdk)，启用正向 OneBot WebSocket 服务。你还需要支持图片输入的模型及其凭据。

### 2. 配置数字生命

```bash
cp config.example.json config.json
cp persona.example.md persona.md
cp .env.example .env
npm run dev -- models openai
```

查看其他服务商的模型时，将 `openai` 替换为对应的服务商名称。然后编辑：

- **`config.json`：** 设置 SnowLuma 地址，将 `snowluma.selfId` 设为已登录的 QQ 账号，并将 `model.provider` 和 `model.id` 设为支持图片输入的模型。将 `personaFile` 改为 `persona.md`。`snowluma.groups` 指定连接或恢复时需要补查历史消息的群，可为空，不限制实时事件的接收范围。
- **`config.json` 中的 `model.thinkingLevel`（可选）：** 推理模型每轮思考的强度：`off`（默认）、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。自定义模型还需将 `model.reasoning` 设为 `true`。强度如何发送由 `model.compat.thinkingFormat` 决定，请使用接口接受的格式，网关可能拒绝其他格式。使用 OpenAI 格式时，`off` 不发送任何参数，模型按自身默认强度思考；想尽量少思考请用 `minimal`。
- **`config.json` 中的 `embedding`（可选）：** 如需让数字生命按大家正在聊的内容想起记忆，将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 embeddings 接口。各个阈值都取决于模型：`threshold`（消息让它想起什么）、`searchThreshold`（主动 `recall` 时的几个关键词，得分通常更低）和 `stickerThreshold`（描述与大家所说相符的已存表情，最多 `stickerLimit` 个）分别按 `qwen3-vl-embedding` 校准为 `0.65`、`0.55` 和 `0.65`，其他模型需要自行校准。在 `selfNames` 中列出别人对数字生命的称呼，避免一条消息因为提到它就匹配上所有提到它的记忆。不启用时，思考不会自动想起记忆，主动调用 `recall` 只按原词检索。
- **`config.json` 中的 `drawing`（可选）：** 如需让数字生命画画，将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 `/images/generations` 接口（例如提供 `gpt-image-2.5` 的网关），密钥放在 `apiKeyEnv` 所指的环境变量里。画一张图要半分钟以上，所以画好后会作为一条观察回到数字生命那里；请求超过 `timeoutMs` 即放弃。画好的图保存在 `dir`（默认是配置文件旁的 `data/drawings`），保留时长与记忆相同。画图次数不设上限，请自行留意接口额度。
- **`config.json` 中的 `life`：** `enabled` 决定首次启动时是否开启自主生活，`allowFiction` 允许虚构日常。自主生活开启时，`freeTime` 会在聊天安静一段时间（每次在 `quietMinMs` 到 `quietMaxMs` 之间随机）后提供一次 life wake，与其他 life wake 至少相隔 `gapMs`，每天最多 `perDay` 次。数字生命在安排醒来要做的活动时标记 rest，就能让它在那之前不来。
- **`persona.md`：** 描述数字生命的身份和人格。
- **`.env`：** 填写 `MODEL_API_KEY`，以及 SnowLuma 服务端需要的 `SNOWLUMA_TOKEN`。如需联网搜索，可填写 `DEEPSEEK_API_KEY`。设置 `QIUYUE_UI_LANGUAGE=zh` 可切换中文；常驻进程和查看终端应使用相同语言，修改后需重启常驻进程。

> **启动前请注意：** 示例配置开放了全部 SnowLuma 接口，且不限制模型调用和行动次数。请根据需要调整 `snowluma.tools` 和 `limits`。自主生活默认关闭，可单独开启。

### 3. 启动与查看

```bash
npm run dev -- validate --config config.json
npm run build
npm start -- run --config config.json
```

校验会检查配置、模型和凭据，不会连接 QQ。另开一个终端，进入实时界面：

```bash
npm start -- tui --config config.json
```

退出实时界面不会停止常驻进程。

实时界面默认使用紧凑时间线：每轮显示触发来源，工具调用以单行摘要展示，已结束的轮次、系统通知和心跳默认折叠。当前步骤单独显示本次请求或工具阶段的耗时；模型提供流式输出时，还会显示收到的片段数和距上次输出的时间。新收到但尚未进入模型的事件放在待纳入区域。超过两分钟没有新输出会提示“等待较久”，这不代表已经确认卡住。

用 `Alt↑↓` 选择记录、`Tab` 展开详情，或用 `/details` 切换完整记录；`/filter errors` 查看失败和结果未知的记录，`/filter all` 清除筛选。更新后重启常驻进程与实时界面，才能看到新增的请求进度。

## 日常管理

构建后，使用 `npm start -- <命令> --config config.json` 执行以下命令：

| 命令 | 用途 |
| --- | --- |
| `status` / `logs` | 查看持续状态或运行记录 |
| `pause` / `resume` | 暂停或恢复数字生命 |
| `life on` / `life off` | 开启或关闭自主生活 |
| `memory search <查询>` | 搜索记忆和个人笔记 |
| `memory show <ID>` | 查看记忆及其来源 |

执行 `npm start -- help` 可查看全部命令，包括记忆修正和删除。修改核心配置后需重启常驻进程。

## 工作原理

```mermaid
flowchart LR
  QQ[QQ 聊天和事件] --> SL[SnowLuma]
  SL --> DB[(SQLite)]
  DB --> RT[感知与调度]
  RT --> PI[单一 Pi Agent]
  PI -->|记忆与持续状态| DB
  PI --> Tools[行动与回执]
  Tools --> SL
  CLI[本地管理] --> RT
```

TypeScript 服务在 Agent 思考期间持续接收事件。已开放的 SnowLuma 接口以原始名称和参数提供给 Agent，可用范围由 `snowluma.tools` 控制。Agent 可以使用 `search_snowluma_tools` 搜索接口，并通过 `load_snowluma_tools` 查看详细用法。

通用系统提示词放在 [`src/prompts/system.md`](src/prompts/system.md)，随运行时代码维护，与运营者的 `personaFile` 分开。提示词在启动时读取一次，`npm run build` 会将它复制到 `dist`。修改后重新构建并重启常驻进程；开发模式只需重启。

QQ 原生工具、画画、网页搜索、网页阅读、空间卡片分享、收藏表情增强和 QQ 系统表情通过插件接入。插件可以提供工具，也可以增强已有工具，并附加观察提示、后台任务和图片。现有 `drawing`、`web` 配置继续有效；可以在 `config.json` 中增加独立开关，例如：

```json
"plugins": {
  "web-search": false,
  "web-reader": true,
  "qzone-share": true,
  "qq-stickers": true,
  "qq-faces": true,
  "snowluma-tools": true
}
```

省略开关时保持原有行为。`drawing` 插件还需开启 `drawing.enabled`，搜索和阅读还需开启 `web.enabled`；空间分享仍受 `snowluma.tools` 的接口权限限制。修改配置后重启常驻进程。开发接入方式见[插件说明](docs/plugins.md)。

`qq-stickers` 默认开启，负责收藏时附带描述、识别已收藏图片，以及根据聊天内容推荐表情。推荐复用 `embedding` 的消息向量，阈值和数量仍由 `embedding.stickerThreshold`、`embedding.stickerLimit` 控制；不开 embedding 也能使用其余增强。设为 `false` 会关闭这些增强和表情索引，原生收藏、描述、删除和发送接口继续按权限开放，已有收藏记录与向量保留。

`qq-faces` 默认开启，提供 `view_face`、系统表情名称、图片缓存，以及观察中的自动补图。同一轮只自动展示每种表情一次，补图排在聊天图片之后，并遵守统一的图片与上下文限制。设为 `false` 会关闭名称增强、补图和 `view_face`；聊天记录继续显示原始编号，原生回应和发送接口仍按权限开放，已有目录缓存保留。

`snowluma-tools` 默认开启，负责 QQ 原生工具注册、搜索与详细用法，以及空间、群相册、签到、资料修改等自主活动提示。可用原生工具继续由 `snowluma.tools.allow`、`deny` 控制。设为 `false` 会移除这组工具和提示；QQ 连接、持续感知、断线恢复和记忆仍照常运行，其他插件继续按各自的开关和接口权限工作。收藏表情的发送建议会随原生工具一起停止。

领域术语和设计决定见[术语表](GLOSSARY.md)与[架构决策记录](docs/adr/)。

## 许可证

[MIT](LICENSE)
