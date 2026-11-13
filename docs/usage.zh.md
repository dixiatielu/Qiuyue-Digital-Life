# 使用指南

[返回 README](../README.zh.md) · [English](usage.md)

完成 README 中的首次启动后，按需要查阅以下配置与管理说明。

- [SnowLuma 接口目录](#snowluma-接口目录)
- [凭据与界面语言](#凭据与界面语言)
- [模型](#模型)
- [可选能力](#可选能力)
- [人设与系统提示词](#人设与系统提示词)
- [终端管理](#终端管理)
- [管理网页](#管理网页)
- [作品库](#作品库)
- [插件](#插件)

## SnowLuma 接口目录

`npm run sync:snowluma` 将固定版本的接口目录及其许可保存到 Git 忽略的 `.qiuyue-cache/snowluma/`。SDK 或目录源码版本变化后需要重新同步。开发命令、测试和编译后的程序读取这个本地目录；也可用 `QIUYUE_SNOWLUMA_CATALOG` 指定另行准备的目录文件。构建产物不会包含它。

## 凭据与界面语言

在 `credentials.json` 的 `credentials` 对象中填写 `MODEL_API_KEY`、SnowLuma 所需的 `SNOWLUMA_TOKEN`，以及联网搜索用的 `DEEPSEEK_API_KEY`、管理网页用的 `WEBUI_TOKEN`；保留示例中的 `version` 和 `changes`。`credentialsFile` 默认指向配置旁的 `credentials.json`，可设为绝对路径放在仓库外。文件仍是明文，以 `0600` 权限保护。读取顺序为：外部环境变量 → 凭据文件；空的外部变量或文件中的 `null` 会停用该凭据。`apiKeyEnv`、`tokenEnv`、`searchKeyEnv` 字段是凭据名称。程序不再读取 `.env`。中文界面请在 `config.json` 设置 `uiLanguage: "zh"`，修改后重启常驻进程和查看界面。

## 模型

`model.thinkingLevel` 设置推理模型每轮思考的强度：`off`（默认）、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。自定义模型还需将 `model.reasoning` 设为 `true`。使用 OpenAI Chat Completions 时，强度如何发送由 `model.compat.thinkingFormat` 决定，请使用接口接受的格式，网关可能拒绝其他格式。使用 OpenAI 格式时，`off` 不发送任何参数，模型按自身默认强度思考；想尽量少思考请用 `minimal`。

`model` 负责日常思考与行动。可选的 `review.model` 和 `compaction.model` 接受同样的完整模型配置，包括自定义端点能力、凭据名称和思考强度。例如，把较便宜的模型放在 `model`，再将强模型的完整配置分别复制到 `review.model` 和 `compaction.model`。三个用途都须支持图片输入，共享同一人格、长期记忆和持续状态。

### 自定义端点

自定义端点支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 Gemini 原生的 `google-generative-ai`。管理页中的供应商和三个模型用途都可选择 **Gemini (native)**，支持获取模型列表和连接测试。使用 Pi 内置的 Gemini 模型时，供应商填 `google`，从 `npm run dev -- models google` 选择模型 ID，无需填写 `api`。

Gemini 原生自定义端点的完整模型配置示例如下，请将 ID 和 token 上限替换为实际模型的值：

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

在管理页「凭据」或 `credentials.json` 中保存 `GEMINI_API_KEY`。原生适配器使用 `x-goog-api-key` 鉴权，调用 `models/{id}:streamGenerateContent`；`baseUrl` 必须包含 API 版本路径（通常为 `/v1beta`），也可包含网关的路径前缀。Gemini 的 `compat` 请留空，Pi 会将 `thinkingLevel` 映射为模型原生的思考等级或 token 预算。模型列表按原生格式翻页，并排除明确只支持 embedding 等其他方法的模型。参见 Google 的 [API 参考](https://ai.google.dev/api)和[模型列表参考](https://aistudio.google.com/api-reference/models/list-models)。原生支持适用于思考、复盘和压缩；embedding 与画图仍使用各自文档说明的 OpenAI 兼容接口。

### 继承与压缩

不设置 `review.model` 时，复盘跟随主模型。不设置 `compaction.model` 时，各自使用所属上下文的模型生成摘要；显式设置后，主思考与复盘都由该模型压缩。删除 override 表示跟随，空模型对象或 `null` 无效。独立配置不会与其他模型逐字段合并，请求失败也不会自动切换模型。跟随模式下的摘要请求不主动开启额外推理；独立压缩模型使用自己的 `thinkingLevel`，默认 off。

复盘可独立设置 `review.limits.contextTokens` 和 `review.limits.outputReserveTokens`，未设置的字段跟随 `limits`。`compaction.contextTokens` 限制摘要请求窗口，默认跟随所属上下文的窗口配置，并受摘要模型实际窗口限制；`compaction.summaryMaxTokens` 限制包含来源引用的摘要长度。即使摘要模型窗口更大，结果仍必须放得回原上下文。校验命令会列出模型分配、缺少的凭据和不足的预算。输出预留包含推理量；Anthropic 按预算推理需要超过 1,024 tokens 的输出空间。

主思考上下文超过输入预算的 `compaction.idleRatio`（默认 85%），空闲满 `compaction.idleAfterMs`（默认 30 秒），且没有待处理的唤醒事件时，会在后台压缩。新消息可以继续使用现有上下文回复；摘要在请求边界或思考结束后，仅替换启动时选定的旧历史，保留当前尾部、新增对话和最新运行状态。只有超过完整输入预算时才等待已有摘要；没有可用摘要时，才在前台压缩。暂停、删除和上下文重置会使后台任务失效，插件维护会等待它结束。

管理页的「模型」支持三种用途、继承开关、预算和连接测试。修改后重启生效；只改复盘或压缩设置会保留主工作上下文，修改 `model` 会新建工作上下文，记忆和持续状态保留。「状态总览 → 模型用量」分别展示最近 24 小时主思考、复盘及两者压缩的用量。所有尝试共用每日调用上限，每次重试只计一次。缺少的用量和旧记录的用途标为未知，SDK 中的零费用不代表免费。

## 可选能力

### 语义记忆 (`embedding`)

如需让数字生命按大家正在聊的内容想起记忆，将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 embeddings 接口。各个阈值都取决于模型：`threshold`（消息让它想起什么）、`searchThreshold`（主动 `recall` 时的几个关键词，得分通常更低）和 `stickerThreshold`（描述与大家所说相符的已存表情，最多 `stickerLimit` 个）分别按 `qwen3-vl-embedding` 校准为 `0.65`、`0.55` 和 `0.65`，其他模型需要自行校准。在 `selfNames` 中列出别人对数字生命的称呼，避免一条消息因为提到它就匹配上所有提到它的记忆。不启用时，思考不会自动想起记忆，主动调用 `recall` 只按原词检索。

### 图像生成 (`drawing`)

如需让数字生命通过 `imagen` 生成图片（包括写实照片、插画、表情包和示意图），将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 `/images/generations` 接口，凭据名称由 `apiKeyEnv` 指定。生成一张图要半分钟以上，完成后会作为一条观察回到数字生命那里；请求超过 `timeoutMs` 即放弃。生成的图片保存在 `dir`（默认是配置文件旁的 `data/drawings`），由作品库长期保存，不随聊天记忆过期清理。生成次数不设上限，请自行留意接口额度。

### 自主生活 (`life`)

`enabled` 决定首次启动时是否开启自主生活，`allowFiction` 允许虚构日常。自主生活开启时，`freeTime` 会在聊天安静一段时间（每次在 `quietMinMs` 到 `quietMaxMs` 之间随机）后提供一次 life wake，与其他 life wake 至少相隔 `gapMs`，每天最多 `perDay` 次。数字生命在安排醒来要做的活动时标记 rest，就能让它在那之前不来。

## 人设与系统提示词

在 `persona.md` 中描述数字生命的身份、世界观、性格和初始偏好。[示例人设](../persona.example.md) 提供可逐段删改的完整角色，以及常见表达和相处习惯的写法。这些是可发展的初始倾向，不是所有人物都必须遵守的表达模板；平台活动和使用说明由插件提供，不必写进人设。

系统提示词统一使用 [`src/prompts/system.md`](../src/prompts/system.md)，随运行时代码维护，与运营者的 `personaFile` 分开。提示词在启动时读取一次，`npm run build` 会将它复制到 `dist`。修改后重新构建并重启常驻进程；开发模式只需重启。

## 终端管理

构建后，使用 `npm start -- <命令> --config config.json` 执行以下命令：

| 命令 | 用途 |
| --- | --- |
| `status` / `logs` | 查看持续状态或运行记录 |
| `pause` / `resume` | 暂停或恢复数字生命 |
| `life on` / `life off` | 开启或关闭自主生活 |
| `memory search <查询>` | 搜索记忆和个人笔记 |
| `memory show <ID>` | 查看记忆及其来源 |

执行 `npm start -- help` 可查看全部命令，包括记忆修正和删除。修改核心配置后需重启常驻进程。

### 实时界面

```bash
npm start -- tui --config config.json
```

退出实时界面不会停止常驻进程。

实时界面默认以交流为主：收到的消息和秋月的对外行动在一轮结束后仍然可见，工具过程与模型输出按需展开。模型输出标明“未发送到 QQ”，消息行动分别显示已发送、等待远端回执、失败或结果未知。长正文默认预览八行，可展开全文。顶部显示连接与暂停状态，底部显示当前步骤耗时和上下文用量；配色适应终端的浅色、深色背景。新收到但尚未进入模型的事件放在待纳入区域。超过两分钟没有新输出会提示“等待较久”，这不代表已经确认卡住。

用 `Alt↑↓` 选择记录、`Tab` 展开详情，或用 `/details` 查看完整记录和流式进度；`/filter errors` 查看失败和结果未知的记录，`/filter all` 清除筛选。输入 `/` 浏览管理命令，用 `↑↓` 选择、`Tab` 补全，再按回车执行；`Esc` 关闭候选列表并保留输入。`/status` 查看调用与行动统计，`Esc` 关闭状态或帮助。

## 管理网页

```bash
npm start -- webui --config config.json
```

用网页完成同样的管理：实时状态和时间线、暂停与自主生活开关、配置、插件与 QQ 接口权限、人格文件与数字生命自己的发展、系统提示词、模型供应商，以及单独存储的凭据。它独立于常驻进程运行，常驻进程重启时网页不断开；配置无法加载时也能打开网页修复。

- **访问：** 监听 `webui.host`:`webui.port`（默认 `127.0.0.1:8848`）；从其他机器访问请用 SSH 隧道，例如 `ssh -L 8848:127.0.0.1:8848 <服务器>`。将 `webui.tokenEnv` 指定的凭据值（默认名称 `WEBUI_TOKEN`）粘贴到登录框；凭据名称本身不是令牌。如果未配置令牌，每次启动会在终端或服务日志中打印临时令牌，将它粘贴到登录框即可。URL 查询参数中的令牌不再用于登录。
- **外观：** 七个分区分别管理状态总览、作品库、运行配置、能力与插件、人格与成长、系统提示词、模型与连接。右上角「主题色」提供六组预设、自定义 HEX 颜色，以及浅色、深色、跟随系统三种显示模式；偏好保存在当前浏览器，立即生效，无需重启。时长字段可切换毫秒、秒、分钟、小时输入，保存时统一换算为毫秒。
- **保存：** 每次保存都按常驻进程的方式校验配置；如果文件在网页读取后被其他地方改过，会拒绝保存；配置、人格和提示词的历史版本保存在 `data/webui/history`。凭据不保存旧值，只在凭据文件中记录最近 100 次变更的名称、时间和操作。插件设置可在能力页通过重载应用，核心设置仍在重启后生效。网页显示实际插件版本与重载结果，并提示是否延续工作上下文：修改人格、系统提示词、模型或工具集会让工作上下文重新开始。
- **系统提示词：** 保存时写入 `config.json` 旁的 `system-prompt.md`（不在 git 中），并设置 `systemPromptFile`；不设置时使用内置提示词。内置提示词在你保存之后有更新时，网页会提示。
- **重启：** 把 `webui.service` 设为常驻进程的 systemd 用户服务名（例如 `qiuyue-digital-life.service`），就能在网页上启动、停止和重启它。重启可以等到没有思考和记忆整理在进行时再执行。
- **凭据：** 网页展示掩码和来源，外部环境提供的凭据只读，新值只写入 `credentialsFile`。连接测试按与常驻进程相同的优先级读取最新文件；插件凭据可通过重载对应插件生效，核心模块的凭据仍需重启常驻进程，修改网页登录令牌还需重启管理网页。
- **供应商：** 网页把供应商端点保存在 `data/webui/providers.json`；选用某个供应商时，会把它的地址、API 和密钥变量复制到当前选择的主思考、复盘、压缩模型，或 `embedding`、`drawing`。常驻进程只读 `config.json`。

## 作品库

管理页面的「作品库」展示自己生成的图片，支持搜索、日期/来源/标签筛选、收藏、归档、下载和删除。生成成功即保存原图和创作信息，不依赖发送成功；关闭绘画接口后仍可使用旧作。`gallery` 是默认开启、可单独重载的内置插件。模型使用 `search_drawings` 查找、`view_drawing` 看图、`update_drawing` 整理，再把原来的 `drawing:<uuid>` 交给发送、空间或表情工具。提示词与实际画面描述分开记录，语义检索复用 embedding，接口不可用时回退关键词。

图库条目以目录记录为准。启动时恢复已跟踪的中断生成任务和未完成的删除操作，不再导入旧事件或未登记的图片文件；已有目录记录和原图继续可用。归档可恢复；删除会永久清除图片、缩略图和搜索索引，并在历史中保留已删除状态。服务停止时仍可浏览和下载，修改需要服务和 `gallery` 插件运行。`plugins.gallery: false` 停用图库工具和索引，不删除作品。新增内置代码需要重新构建并重启一次，之后可用 `plugins reload gallery` 应用插件开关。

## 插件

插件开关、安装、重载与 SDK 见[插件说明](plugins.md)；QQ、Telegram 的接入与停机迁移见[平台适配器](platform-adapters.md)。B 站、小红书的安装和使用见[外部线上生活](online-life.md)。
