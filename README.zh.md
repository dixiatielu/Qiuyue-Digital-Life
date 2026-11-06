# 秋月·数字生命

基于 [Pi Agent](https://github.com/earendil-works/pi) 构建、常驻本地的数字生命，在 QQ、Telegram 等环境中共享同一个身份、长期记忆与持续状态。

[English](README.md) | 简体中文

- **自主社交：** 感知消息，自己决定何时参与、行动或保持沉默。
- **持续成长：** 从经历中形成习惯与人际关系，跨天推进活动，自主安排休息。
- **能力扩展：** 平台适配器按权限提供原生接口，插件接入网页浏览、图像生成等活动。
- **本地管理：** 通过 CLI、TUI 和 WebUI 管理运行、配置与记忆，运行控制与普通聊天分离。

## 快速开始

以下以通过 SnowLuma 接入 QQ 为例。Telegram 和多账号配置见[平台适配器](docs/platform-adapters.md)；已有安装请先按[停机迁移说明](docs/platform-adapters.md#offline-upgrade)升级，再启动新版。

### 1. 准备环境

使用 [`.nvmrc`](.nvmrc) 指定的 Node.js 版本。另行启动并登录 [SnowLuma](https://snowluma.github.io/en/docs/sdk)，启用正向 OneBot WebSocket 服务，并准备支持图片输入的模型及其凭据。

```bash
nvm install
nvm use
npm ci
npm run sync:snowluma
```

### 2. 配置

```bash
cp config.example.json config.json
cp persona.example.md persona.md
install -m 600 credentials.example.json credentials.json
npm run dev -- models openai
```

查看其他服务商的模型时，将 `openai` 替换为对应名称，然后编辑：

- **`config.json`：** 设置 `adapters[0].url`，将 `adapters[0].accountId` 设为已登录 QQ 账号的十进制字符串，填写 `model.provider` / `model.id`，将 `personaFile` 改为 `persona.md`。`adapters[0].groups` 指定需要补查历史的群，可为空，不限制实时事件。中文界面可设置 `uiLanguage: "zh"`。
- **`persona.md`：** 描述数字生命的身份、性格与初始偏好。
- **`credentials.json`：** 在 `credentials` 中填写凭据值，保留 `version` 和 `changes`：模型用 `MODEL_API_KEY`，SnowLuma 按需填写 `SNOWLUMA_TOKEN`，网页搜索用 `DEEPSEEK_API_KEY`，管理网页登录可设置 `WEBUI_TOKEN`。外部环境变量优先于凭据文件，程序不读取 `.env`。

> 示例配置开放了全部 SnowLuma 接口，且不限制模型调用与行动次数。启动前请按需调整 `adapters[0].tools` 和 `limits`。自主生活默认关闭。

独立模型、语义记忆、图像生成与自主生活等可选配置见[使用指南](docs/usage.zh.md)。

### 3. 启动与管理

```bash
npm run dev -- validate --config config.json
npm run build
npm start -- run --config config.json
```

校验会检查配置、模型和凭据，不会连接 QQ。另开终端，选择一种管理界面：

```bash
npm start -- tui --config config.json
# 或启动管理网页：
npm start -- webui --config config.json
```

管理网页默认位于 `http://127.0.0.1:8848`。使用 `WEBUI_TOKEN` 的值登录；未配置时，使用启动日志中打印的临时令牌。退出管理界面不会停止常驻进程。

执行 `npm start -- help` 查看 `status`、`pause`、`resume` 和记忆管理等命令。修改核心配置后需重启常驻进程；日常操作见[使用指南](docs/usage.zh.md)。

## 文档

- [使用指南](docs/usage.zh.md)：模型、凭据、可选能力、TUI、WebUI 与作品库。
- [平台适配器](docs/platform-adapters.md)：QQ / Telegram 配置、权限、迁移与适配器 SDK。
- [插件说明](docs/plugins.md) · [外部线上生活](docs/online-life.md)：扩展能力与 B 站、小红书接入。
- [术语表](GLOSSARY.md) · [架构决策](docs/adr/)：领域概念与设计依据。
- [贡献指南](CONTRIBUTING.md)：Issue、PR 与本地检查，欢迎使用中文或英文参与。

## 感谢

本项目基于 Pi 构建，并参考了 Letta / MemGPT、Letta Code、Koishi、OpenClaw、Generative Agents、Mem0、Graphiti、Hindsight、MaiBot、AstrBot、Aurabot、qq-bridge 与 DeepSeek Harness 的思路。来源与设计对比见[调研记录](docs/research/)。

## 许可证

本项目原创代码采用 [MIT](LICENSE) 许可。SnowLuma SDK 和本地准备的接口目录保留各自的[上游许可](THIRD_PARTY_NOTICES.md)。
