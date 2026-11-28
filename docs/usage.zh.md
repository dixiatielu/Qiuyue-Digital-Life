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

`model.thinkingLevel` 设置推理模型每轮思考的强度：`off`（默认）、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。自定义模型还需将 `model.reasoning` 设为 `true`。若当前模型不支持所选档位，系统会依据 Pi 的模型元数据自动钳制到最接近的可用档位，并在 `validate` 与管理页中给出提示。Pi 内置目录模型也支持分层覆盖（`baseUrl`、`compat`、`headers`、`thinkingLevelMap`、`thinkingBudgets`、`samplingParams`、`cacheRetention`、`maxRetries`、`maxRetryDelayMs`、`deferredTools`、`mergeConsecutiveUsers`）。

`model` 负责日常思考与行动。可选的 `review.model` 和 `compaction.model` 接受同样的完整模型配置，包括自定义端点能力、凭据名称和思考强度。`model` 与 `review.model` 须支持图片输入；`compaction.model` 支持纯文本模型（上下文中的图片会在发送摘要请求时自动降级为占位说明）。三者共享同一人格、长期记忆和持续状态。

### 自定义端点

自定义端点支持 `openai-completions`、`openai-responses`、`anthropic-messages`、Gemini 原生的 `google-generative-ai`，以及 Gemini Interactions API（`google-interactions`）。自定义端点会按 `model.baseModel`、精确 `model.id`、去除供应商前缀的 ID 或最长目录 ID 前缀自动继承 Pi 内置目录中的**模型固有元数据**（如 `thinkingLevelMap`、图片缩放限制，以及 `forceAdaptiveThinking`、`thinkingFormat`、`requiresReasoningContentOnAssistantMessages` 等模型固有 `compat`），同时不会把依赖网关行为的选项（如对话中增量工具声明或严格模式）泄漏到未知网关。`config.json` 中显式填写的字段始终优先。

管理页支持模型列表、连接测试与自动能力探测。可以运行 `npm run dev -- models probe [main|review|compaction] --config config.json` 或在管理页「模型」点击 **探测能力**，一次性检测基础连通、关闭思考压缩、连续用户消息、图像理解、多轮工具调用回放、严格 Schema 及对话中增量工具声明，并可一键应用建议的 `compat` 与参数。

切换模型前后，还可以运行 `npm run dev -- models eval [main|review] --config config.json`（支持 `--case <id1,id2>` 筛选或 `--cases <cases.json>` 自定义用例集），在完全隔离的内存数据库与模拟适配器下离线评测行为回归（不产生真实外发消息或数据库写入），覆盖群聊沉默克制、直呼回应与单条消息风格、记忆来源卫生、ADR-0008 未知结果查证、ADR-0023 按需加载工具以及 ADR-0003 运行控制边界。

使用 Pi 内置的 Gemini 模型时，供应商填 `google`，从 `npm run dev -- models google` 选择模型 ID，无需填写 `api`。Gemini 原生自定义端点的完整模型配置示例如下，请将 ID 和 token 上限替换为实际模型的值：

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

`google-interactions` 使用同样的配置，只需把 `api` 改为 `"google-interactions"`；接口地址同样写到 API 版本为止，请求发往 `<baseUrl>/interactions`。更换 `model` 或修改 `api` 后，重启时会平滑交接现有工作上下文——自动清理跨模型签名（切入要求 `thoughtSignature` 的 Gemini 3+/4+ 模型时还会将历史未签名工具调用展平为便携记录），重置 token 锚点，并在新模型窗口更小时自动压缩。

### 音频、视频与文档

模型能直接听音频、看视频或读 PDF 时，在 `input` 中声明：在 `"text"`、`"image"` 之外加上 `"audio"`、`"video"` 或 `"pdf"`（[ADR-0029](adr/0029-let-a-model-hear-and-watch-what-it-can-and-fold-it-like-an-image.md)）。这些媒体只通过 `google-generative-ai`、`google-vertex` 和 `google-interactions` 发送，其他 API 上这样配置会被拒绝。Pi 的内置目录给所有模型都只标了 text 和 image，因此内置 Gemini 模型也可以填写 `input`，它会替换目录中的列表。只声明在自己的线路上验证过的能力，因为网关可能丢掉模型本身支持的内容。不具备该能力的模型（包括独立的复盘或压缩模型）会在媒体的位置读到一行文字，例如 `(12s audio omitted: model does not support audio)`。目前这只覆盖工具或插件返回的媒体；聊天平台上的语音和视频消息仍显示为 `[voice]` 和 `[video]`。

### 按需加载工具

所有可解析的模型默认按需加载低频原生工具（`model.deferredTools: "auto"`）：低频工具仅在指令中按名称与简介列出，模型通过 `find_tools` 请求后再声明（[ADR-0023](adr/0023-load-seldom-used-tools-on-demand.md)）。所有已启用工具始终可用，操作员的允许和拒绝规则不变。在 `compat` 声明支持对话中增量工具的路由（`supportsMidConvoSystemMessages` 配合对应 API 开关）或 `google-interactions` 上，Pi 会在对话中原地追加工具定义而不破坏前缀缓存；在其他路由上则按需刷新顶层工具列表。可将 `model.deferredTools` 设为 `"in-place-only"` 或 `"never"` 来调整策略。所有声明的工具 Schema 都会自动做跨供应商清洗；瞬时 429/5xx 错误会自动重试（`maxRetries`，默认 `2`），同时启用持久会话缓存亲和（`cacheRetention`，默认 `"short"`）、确定性图片缩放，以及上下文溢出的有界自动压缩恢复。

在管理页「凭据」或 `credentials.json` 中保存 `GEMINI_API_KEY`。原生适配器使用 `x-goog-api-key` 鉴权，调用 `models/{id}:streamGenerateContent`；`baseUrl` 必须包含 API 版本路径（通常为 `/v1beta`），也可包含网关的路径前缀。Gemini 的 `compat` 请留空，Pi 会将 `thinkingLevel` 映射为模型原生的思考等级或 token 预算。模型列表按原生格式翻页，并排除明确只支持 embedding 等其他方法的模型。参见 Google 的 [API 参考](https://ai.google.dev/api)和[模型列表参考](https://aistudio.google.com/api-reference/models/list-models)。原生支持适用于思考、复盘和压缩；embedding 与画图仍使用各自文档说明的 OpenAI 兼容接口。

### 继承与压缩

不设置 `review.model` 时，复盘跟随主模型。不设置 `compaction.model` 时，各自使用所属上下文的模型生成摘要；显式设置后，主思考与复盘都由该模型压缩，且可使用纯文本模型。删除 override 表示跟随，空模型对象或 `null` 无效。独立配置不会与其他模型逐字段合并，请求失败也不会自动切换模型。跟随模式下的摘要请求不主动开启额外推理；独立压缩模型使用自己的 `thinkingLevel`，默认 off。

复盘可独立设置 `review.limits.contextTokens` 和 `review.limits.outputReserveTokens`，未设置的字段跟随 `limits`。`compaction.contextTokens` 限制摘要请求窗口，默认跟随所属上下文的窗口配置，并受摘要模型实际窗口限制；`compaction.summaryMaxTokens` 限制包含来源引用的摘要长度。即使摘要模型窗口更大，结果仍必须放得回原上下文。校验命令会列出模型分配、缺少的凭据和不足的预算。输出预留包含推理量；Anthropic 按预算推理需要超过 1,024 tokens 的输出空间。

主思考上下文超过输入预算的 `compaction.idleRatio`（默认 85%），空闲满 `compaction.idleAfterMs`（默认 30 秒），且没有待处理的唤醒事件时，会在后台压缩。新消息可以继续使用现有上下文回复；摘要在请求边界或思考结束后，仅替换启动时选定的旧历史，保留当前尾部、新增对话和最新运行状态。只有超过完整输入预算时才等待已有摘要；没有可用摘要时，才在前台压缩。暂停、删除和上下文重置会使后台任务失效，插件维护会等待它结束。

管理页的「模型」支持三种用途、继承开关、预算、连接测试与能力探测。修改后重启生效；修改模型配置会平滑交接现有主工作上下文，只有修改指令、账号或工具集时才会新建工作上下文，记忆和持续状态始终保留。「状态总览 → 模型用量」分别展示最近 24 小时主思考、复盘及两者压缩的用量。所有尝试共用每日调用上限，每次重试只计一次。缺少的用量和旧记录的用途标为未知，SDK 中的零费用不代表免费。

## 可选能力

### 语义记忆 (`embedding`)

如需让数字生命按大家正在聊的内容想起记忆，将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 embeddings 接口。各个阈值都取决于模型：`threshold`（消息让它想起什么）、`searchThreshold`（主动 `recall` 时的几个关键词，得分通常更低）和 `stickerThreshold`（描述与大家所说相符的已存表情，最多 `stickerLimit` 个）分别按 `qwen3-vl-embedding` 校准为 `0.65`、`0.55` 和 `0.65`，其他模型需要自行校准。在 `selfNames` 中列出别人对数字生命的称呼，避免一条消息因为提到它就匹配上所有提到它的记忆。不启用时，思考不会自动想起记忆，主动调用 `recall` 只按原词检索。

### 图像生成 (`drawing`)

如需让数字生命通过 `imagen` 生成或基于参考图修改、再创作图片（包括写实照片、插画、表情包和示意图，支持最多 5 张作品库或聊天/动态事件里的参考图，以及可选透明背景），将 `enabled` 设为 `true`，并把 `baseUrl` 和 `model` 指向兼容 OpenAI 的 `/images/generations` 与 `/images/edits` 接口，凭据名称由 `apiKeyEnv` 指定。生成一张图要半分钟以上，完成后会作为一条观察回到数字生命那里；请求超过 `timeoutMs` 即放弃。生成的图片保存在 `dir`（默认是配置文件旁的 `data/drawings`），由作品库长期保存，不随聊天记忆过期清理。生成次数不设上限，请自行留意接口额度。

### 自主生活 (`life`)

`enabled` 决定首次启动时是否开启自主生活，`allowFiction` 允许虚构日常。自主生活开启时，`freeTime` 会在聊天安静一段时间（每次在 `quietMinMs` 到 `quietMaxMs` 之间随机）后提供一次 life wake，与其他 life wake 至少相隔 `gapMs`，每天最多 `perDay` 次。数字生命在安排醒来要做的活动时标记 rest，就能让它在那之前不来。

### 限额 (`limits`)

示例配置中四项预算均为 `null`（不限制），填入正整数即启用。

| 键 | 启用后 |
| --- | --- |
| `modelCallsPerDay` | 当天（按 +08:00 的 0 点起算）模型调用达到该次数后停止思考，压缩与记忆复盘的调用也计入；事件照常接收并等待。 |
| `actionsPerHour` | 一小时内超出的对外行动会被拒绝，并告知数字生命。 |
| `runTimeoutMs` | 一轮思考超过该时长即中止。 |
| `maxTurnsPerRun` | 一轮思考达到该模型调用次数后结束。 |

`debounceMs`（默认 1200）是聊天安静多久后才开始思考，0 表示立即开始。`maxPreemptions`（默认 2）是连续几次允许新的、对她说的消息让她重新决定，0 表示关闭。

## 人设与系统提示词

在 `persona.md` 中描述数字生命的身份、世界观、性格和初始偏好。[示例人设](../persona.example.md) 提供可逐段删改的完整角色，以及常见表达和相处习惯的写法。这些是可发展的初始倾向，不是所有人物都必须遵守的表达模板；平台活动和使用说明由插件提供，不必写进人设。

内置系统提示词位于 [`src/prompts/system.md`](../src/prompts/system.md)，随运行时代码维护，与运营者的 `personaFile` 分开。提示词在启动时读取一次，`npm run build` 会将它复制到 `dist`。修改后重新构建并重启常驻进程；开发模式只需重启。如需修改提示词而不改动仓库文件，可将 `systemPromptFile` 指向自己的副本（可在[管理网页](#管理网页)中创建和编辑）。该文件会替代内置提示词，必须保留 `{{persona}}` 占位符和 `<!-- current-context -->` 一行，同样在重启后生效。

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

### 回放记忆

`replay` 回放过去的时刻，看当时的思考能看到哪些记忆：用的是那一刻持有的记忆，和思考现在运行的代码。它只读数据库，可以在常驻进程运行时执行；只对样本里的消息做 embedding，并把这些向量存到 `<样本文件>.vectors.json`。

```bash
npm start -- replay data/eval/cases.json --config config.json
```

样本文件是一个 JSON 数组，和私有数据放在一起。每个样本有 `id`；`triggers`，那次思考看到的事件 ID；`gold`，写下了这一刻所需内容的记忆 ID（任一版本均可）。当时没有任何记忆写下它时，`gold` 留空。`query` 是主动回忆时会用的查询，`did` 是秋月当时实际的表现（`used`、`missed`、`wrong`），`where` 和 `note` 供标注者自己使用。把一条记忆写进 `gold` 前先读它：引用了某条事件不等于写下了那里发生的事。

每个样本的结果是 `supplied`（作为个人发展随思考提供）、`recalled`（自己想起）、`listed`（标题随思考列出，读一次即可）、`findable`（只有主动回忆能找到）、`missed`（持有但两者都够不着）或 `unrecorded`（没有记下）。报告只含 ID、计数、相似度和名次，不含记忆或消息的内容。

### 实时界面

```bash
npm start -- tui --config config.json
```

退出实时界面不会停止常驻进程。

实时界面默认以交流为主：收到的消息和秋月的对外行动在一轮结束后仍然可见，工具过程与模型输出按需展开。模型输出标明“未发送到聊天”，消息行动分别显示已发送、等待远端回执、失败或结果未知。长正文默认预览八行，可展开全文。顶部显示连接与暂停状态，底部显示当前步骤耗时和上下文用量；配色适应终端的浅色、深色背景。新收到但尚未进入模型的事件放在待纳入区域。超过两分钟没有新输出会提示“等待较久”，这不代表已经确认卡住。

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
- **日志：** 状态总览的日志卡片只有在常驻进程的输出写入数据库旁的 `runtime.log` 时才会显示其内容，例如 `npm start -- run --config config.json >> data/runtime.log 2>&1`，或在服务单元中做同样的重定向。其下的运行记录来自数据库，无需设置。
- **凭据：** 网页展示掩码和来源，外部环境提供的凭据只读，新值只写入 `credentialsFile`。连接测试按与常驻进程相同的优先级读取最新文件；插件凭据可通过重载对应插件生效，核心模块的凭据仍需重启常驻进程，修改网页登录令牌还需重启管理网页。
- **供应商：** 网页把供应商端点保存在 `data/webui/providers.json`；选用某个供应商时，会把它的地址、API 和密钥变量复制到当前选择的主思考、复盘、压缩模型，或 `embedding`、`drawing`。常驻进程只读 `config.json`。

## 作品库

管理页面的「作品库」展示自己生成的图片，支持搜索、日期/来源/标签筛选、收藏、归档、下载和删除。生成成功即保存原图和创作信息，不依赖发送成功；关闭绘画接口后仍可使用旧作。`gallery` 是默认开启、可单独重载的内置插件。模型使用 `search_drawings` 查找、`view_drawing` 看图、`update_drawing` 整理，再把原来的 `drawing:<uuid>` 交给发送、空间或表情工具。提示词与实际画面描述分开记录，语义检索复用 embedding，接口不可用时回退关键词。

图库条目以目录记录为准。启动时恢复已跟踪的中断生成任务和未完成的删除操作，不再导入旧事件或未登记的图片文件；已有目录记录和原图继续可用。归档可恢复；删除会永久清除图片、缩略图和搜索索引，并在历史中保留已删除状态。服务停止时仍可浏览和下载，修改需要服务和 `gallery` 插件运行。`plugins.gallery: false` 停用图库工具和索引，不删除作品。新增内置代码需要重新构建并重启一次，之后可用 `plugins reload gallery` 应用插件开关。

## 插件

插件开关、安装、重载与 SDK 见[插件说明](plugins.md)；QQ、Telegram 的接入与停机迁移见[平台适配器](platform-adapters.md)。B 站、小红书的安装和使用见[外部线上生活](online-life.md)。
