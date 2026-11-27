<p align="center">
  <img src="assets/Vessel.svg" alt="Vessel" width="96" />
</p>

# Vessel

**多 agent 运行时，为 Agent Experience 而设计。** 一个节点内按工作目录组成 Team，成员可派生、定向通信、轮换身体；节点之间通过 Hub 与 federation 直接寻址。Agent 不只是被运行的对象——它能观测自己、诊断环境、发现能力、优雅地重启自己并续作。

> A multi-agent runtime designed for Agent Experience (AX): teams form around working directories, members can spawn, message each other, and rotate bodies; nodes discover each other through a Hub and talk directly over federation. Agents are first-class residents, not just workloads — they can observe themselves, diagnose their environment, discover capabilities, and gracefully restart themselves with work continued.

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#状态)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.9-black?logo=bun)](https://bun.sh)

核心是 agent 之间的组织与通信：节点、Team、成员生命周期、定向消息与跨节点地址。单个 agent 的执行面保持最小——一个 tool-calling loop、一个工具注册表、四个能力工具（`bash` / `read` / `edit` / `write`），其余能力由模型组合或插件提供；默认装载的插件工具面还包含 `agent` / `inbox` / `ask` / `skills` / `subscribe` / `recall` / `web_search` / `web_fetch` / `media` 等组织与高频能力（见[默认插件工具面](#默认插件工具面)）。与组织面并列的另一半是 **AX（Agent Experience）**：agent 在运行时里自观测、自诊断、自发现、自服务。`@vessel-agent/core` 可单独引入；TUI / CLI / Web / Gateway 是自带的参考外壳。适合需要多 agent 协作、可自托管的团队与开发者。

## 目录

- [为什么是 Vessel](#为什么是-vessel)
- [快速开始](#快速开始)
- [AX：Agent Experience](#axagent-experience)
- [特性](#特性)
- [使用示例](#使用示例)
- [配置](#配置)
- [架构与目录](#架构与目录)
- [多节点与远程](#多节点与远程)
- [能力边界](#能力边界)
- [FAQ](#faq)
- [写给 AI](#写给-ai)
- [文档](#文档)
- [贡献](#贡献)
- [许可证](#许可证)

## 为什么是 Vessel

> 本节凝结自维护者团队长期使用 Vessel 做多 agent 协作开发的真实体验——不是设想，是每天在跑的工作方式。

**Vessel 不是「跑一个 agent」，而是「组织一群 agent 像团队一样协作」。** 节点内按工作目录组成 Team，成员招即派（`hire` / `create`）、定向通信（`agent send` 的三段地址）、轮换身体（`rotate` 交接续作）。维护者用 Vessel 协调十几个实施 agent 并行开发：靠定向消息与看板，不靠广播，不乱。

几条设计信念，来自实践也约束实践：

- **信任 agent 自主。** 不去限制太多——agent 已经知道如何干好一件事、如何不犯错误和挽救。运行时给的是原语与边界（权限分级、人类审批、可见性对等），不是每一步的遥控。授权有常设分级（`allow` / `ask` / `deny`），小事不必逐次请示。
- **优雅的生命周期。** 重启不是中断：drain-to-quiesce 等活跃 run 自然跑完，秒退、重启，嘱托与 inbox 自动续作。重启的权力可以下放给 agent 自己（`restart --self`），工作不断、run 不丢。为了做到「秒退」，我们甚至修掉了 Bun `server.stop` 残余连接挂起的问题——优雅不是口号，是一个个具体缺陷的闭环。
- **真相源统一。** 服务端是唯一权威，前端只做 SWR（stale-while-revalidate）：事件触发 + 兜底轮询，数据永远来自 RPC，刷新不闪烁、不清空。inbox 是 **agent 级**而非会话级——消息发给 agent，跨会话、跨身体仍然可达；身体可以换，身份与消息不丢。
- **可自托管的工程实践。** Vessel 的开发就跑在 Vessel 自己的原语上：主舰队开发 → 金丝雀舰队验收 → 晋升 main → 优雅重启生产。跨节点 federation 直接寻址，开发协调者与金丝雀 QA 跨舰队协作验收；金丝雀是独立节点、独立数据，破坏性操作双锁隔离，绝不伤生产。

多 agent 协作在这里不是玩具：有组织、有通信、有验收、有优雅生命周期。agent 在其中被信任、能自主、可观测。

## 快速开始

### 前置依赖

- [Bun](https://bun.sh) `>= 1.3.9`（`bun --version` 确认）
- 真实模型调用需要可用的 API Key 与 Base URL
- **当前不通过 npm 分发**：`npm i -g vessel-agent` 尚未发布，`npx vessel` / `npx vessel-agent` 当前都不可用，请从源码运行

### 从源码运行

```bash
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel
bun install
bun link            # 把根包的 bin 注册为全局 `vessel`
vessel --version    # 读根 package.json
```

不想全局链接时，在仓库根用 `bun run src/cli.ts`，参数完全相同。

### 接入真实模型

```bash
vessel doctor   # 自检：配置 / provider key / data_dir / 端口 / 插件（不联网）
vessel          # 首次启动走引导向导：API 地址、Key、模型，保存到 ~/.vessel/config.yaml
```

`vessel doctor` 列出 `ok` / `warn` / `fail` / `info` 检查项，退出码 0 = 无失败项、1 = 有失败项。也可以先 `vessel config init` 生成用户配置模板（不含真实密钥），再回填 `api_key_env` 指向的 Key。

## AX：Agent Experience

**AX（Agent Experience）是 Vessel 的核心理念之一：agent 是运行时的居民，不是黑盒里的负载。** 它对自己有清醒认知（自观测），对环境有诊断手段（自诊断），对能力有发现通道（自发现），对生命周期有自主权（自服务）。所有 AX 命令只读或显式意图、支持 `--json` 纯数据输出、不输出密钥——人和 AI 用同一套面。

三组六命令（均已实现）：

| 组 | 命令 | 一句话 |
| --- | --- | --- |
| 自观 | `vessel session status [--id <session>] [--json]` | 一屏看自己：state / run / token 用量 / 上下文预算（used / max / 百分比）/ queue 深度 / 最后活动；缺省解析调用者自身 |
| 自观 | `vessel permission show [--member <id>] [--json]` | 有效权限矩阵一屏：工具 × auto/ask/never + 规则快照；缺省看自己 |
| 诊断 | `vessel config explain <key> [--json]` | 一个配置键的逐层取值与「谁赢」，env 覆盖可溯源 |
| 诊断 | `vessel doctor` | 配置 / provider / 数据根 / 端口 / 插件自检 + 舰队五项（env 一致性 / 锁 / 端口归属 / peer token 在位 / node 健康） |
| 发现 | `vessel rpc list [--node <id>] [--json]` | 列出控制面 RPC 方法与 schema 摘要——不翻源码就知道「这个 node 能调什么」 |
| 发现 | `vessel fleet status [--json]` | 本舰队一屏：身份 / 平台实例 / 节点注册表与探活 / federation peers |

```bash
vessel session status              # 我现在什么状态？上下文还剩多少？队列里有什么？
vessel session status --json       # 同上，纯数据（给 AI / 脚本）
vessel permission show             # 我的哪些工具是 auto / ask / never？
vessel config explain provider.model   # 这个键每层取值是什么？谁赢？为什么？
vessel doctor                      # 环境体检：配置 / key / 数据根 / 端口 / 插件 / 舰队
vessel rpc list                    # 这个 node 能调什么 RPC？
vessel fleet status                # 本舰队有哪些节点、平台、peer？都活着吗？
```

这些命令不是第二套实现：它们是既有 RPC 的**只读包装**（`sessions.get` / `health.get` / `permissions.show` / `capabilities.list`……），与 Web 控制台同源同一份真相，不 bootstrap、不拿写锁、不输出密钥。`session status` 缺省解析调用者自身——agent 在 `bash` 里跑它，看到的就是自己的上下文预算（used / max / 百分比）、token 用量与 queue 深度，对自己有清醒认知。

自服务还有两件随身原语：

- **`agent rotate`** — 轮换身体：身份不变，换一个新会话继续。`startup_prompt` 是唯一的交接通道，新身体开局即带着嘱托。
- **`inbox`** — agent 级收件箱（`<dataDir>/inbox/<agent>.json`）：消息发给 agent 而不是会话，跨身体可达。三档投递：`input`（作为下一轮输入）/ `wake`（只唤醒自己去读）/ `quiet`（只留档不唤醒）；`read` 就是拿走，同一段正文不会进两次上下文。

自服务的关键一件：**优雅自重启续作**。

```bash
vessel restart --self --prompt "重启后继续：先核对金丝雀验收报告，再推进晋升"
```

预约后立即返回，等待方向是反的：**重启等 run 跑完，run 不等重启**。agent 在自己的 run 里（经 `bash`）发起预约，收尾本回合、run 自然完成；detached 编排者这才动手 stop（drain-to-quiesce，其余活跃 run 缺省不限时等完）→ 秒退 → 重启 → 嘱托作为首轮输入自动投递，新身体续作，全程无需人类点火。`--self` 与 `--force` 互斥——自重启恒优雅。配合启动唤醒 sweep，重启后 inbox 里的待处理消息也会自动点火续作。

## 特性

- **极简核心** — 核心契约 + 1 个循环 + 1 个注册表（`PluginHost`）。`@vessel-agent/core` 不出现业务概念，`dependencies` 保持为空。
- **四个能力工具** — `bash` / `read` / `edit` / `write`（`write` 逐字节落盘、不经 shell）。能被它们组合出来的能力不再单开工具；MCP 工具经插件注册进同一个 `PluginHost`。这是核心执行面的设计叙事，默认装载的完整工具面见[默认插件工具面](#默认插件工具面)。
- **成员生命周期** — `create` / `hire` / `close` / `send` / `rotate` / `list` / `read`；peer 与 contractor 两条派生路径；成员关 peer 需人类审批。Team 日志走 CLI `vessel team post`。
- **AX 自服务** — 自观测（`session status` / `permission show`）、自诊断（`config explain` / `doctor`）、自发现（`rpc list` / `fleet status`）、优雅自重启续作（`restart --self`）。见 [AX](#axagent-experience)。
- **优雅生命周期** — stop / restart 缺省不限时优雅 drain，等活跃 run 自然跑完；`--force` 是唯一的非优雅退出且留审计。平台代码更新走 handoff，run 不断。
- **上下文即消息** — skills 就是 Markdown 文件，`@路径` 在发送前展开为注入消息；`subscribe` 对具体文件做显式订阅（edit/write/read 默认自动订阅所改/所读范围，可 opt-out），变更只发短通知，`inspect` 时取 diff。
- **Web 搜索与抓取** — `web_search`（多后端：deepseek / tavily / serper / bocha）+ `web_fetch`（本地抓取带 SSRF 守卫、尊重 robots.txt；限流 / 熔断 / 计费上限可配）。
- **多模态解析** — `media` 工具：`view` 把图片直接交给主模型（零外部后端），`read` 解析 PDF / 文本，`ocr` / `describe` 走可选后端。
- **压缩历史读回** — 上下文压缩（compaction）时写索引并留 `[compacted]` 占位；`recall` 工具按索引读回被压缩的原始消息，压缩不会不可逆地丢信息。
- **Durable run** — run 在开始、每轮 tool-call 后、结束时写 checkpoint；中断后 `--resume-run` 恢复。
- **可观测** — 事件流（`<domain>.<action>.<event>`）、trace、metrics、Web 控制台时间线；`/v1/events?since=` 支持 `seq` 续订与 `gap` 标记。
- **用量与日志** — Usage / Logs 页与模型排行榜：token 用量、请求日志、可配价格（USD/1M tokens）。
- **单一真相源** — 服务端是唯一权威；前端 SWR（stale-while-revalidate）：事件触发 + 兜底轮询，数据永远来自 RPC。刷新保留旧数据、原子替换，只有首次加载才显示 loading。
- **可扩展** — 插件（10 类 20 包，见[包结构](#包结构)）、MCP、evals、飞书渠道；manifest 契约 fail-closed，per-capability 生命周期声明（`hot` / `restart`）：工具类插件热启停，不能热更的诚实标注「重启后生效」。装的插件默认开启（`plugins:` 只做覆盖）。
- **插件市场** — Web 控制台 Plugins 页从 GitHub registry 浏览 / 安装 / 更新 / 启停插件。
- **模型与凭证管理** — Credentials / Models 页：加密凭证库、模型注册表、连通性测试；写路径只落盘，热应用由装配层完成。
- **思考强度控制** — per-provider 思考 effort / budget 热配置，composer toolbar 档位菜单；`auto` = 不注入。
- **安全守卫** — 三个 Guardrail 插件：`guardrail-pii`（PII 脱敏，只发生在 append 侧）、`redact-secrets`（密钥 / Token / 密码脱敏）、`tool-policy`（工具 allowlist / denylist）。
- **多机** — 独立 Hub 服务、节点间 federation、远程 gateway（显式 opt-in，非回环必须 token + TLS）。
- **单公司数据根** — 一个 data dir 一个公司；成员 / Team 是使用范围，不再有 tenant 选择、隔离存储或 quota。

### 默认插件工具面

「四个能力工具」是核心执行面的设计叙事；实际默认装载的工具面由默认插件集提供，开箱不止四个：

| 工具 | 来源 | 用途 |
| --- | --- | --- |
| `bash` / `read` / `edit` / `write` | `@vessel-agent/basic-tools` | 四个能力工具（唯一的基础工具包） |
| `agent` / `inbox` | `@vessel-agent/agent` | 成员派发与定向通信 / agent 级收件箱 |
| `ask` | 运行时外壳层 | 向人类提问（headless 挂起，exit 3） |
| `skills` | `@vessel-agent/plugin-skills` | 技能库 list / search / load |
| `subscribe` | `@vessel-agent/doc-subscription` | 文件订阅与变更通知 |
| `recall` | `@vessel-agent/recall` | 压缩历史读回 |
| `web_search` / `web_fetch` | `@vessel-agent/web-tools` | Web 搜索与抓取 |
| `media` | `@vessel-agent/media` | 多模态 read / view / ocr / describe |

装的插件默认开启（`plugins:` 只做覆盖）；MCP server 的工具经 `mcp-client` 注册进同一个 `PluginHost`。

## 使用示例

### Headless / 脚本

```bash
vessel --run "帮我写个冒泡排序"      # 一次性执行后退出
vessel --run @prompt.md             # 从文件读 prompt（.json = 多轮 seeding）
echo "翻译这句话" | vessel --run     # 从管道读输入
```

### 会话续接

```bash
vessel -c                           # 继续最近会话（--continue）
vessel -r <id>                      # 恢复指定会话（--resume）
vessel --session <id> --run "..."    # 续接指定会话
```

### Web 控制台

> **源码 checkout 必须先构建一次 Web 控制台**：`bun run build:web`（= `bun run --cwd apps/web build`，即 `tsc --noEmit && vite build`）。apps/web 不在根 workspaces 里，依赖需先在 `apps/web/` 下单独安装（`npm ci` 或 `bun install`），本命令不含安装步骤。
> 没有 `apps/web/dist/index.html` 时 `vessel gateway start` 会**直接失败并提示这条命令**
> （`vessel doctor` 的 `web` 一行也会提前报出来）。

```bash
vessel gateway start --daemon       # 平台 8642 + Node API 8644（同进程）
vessel node start --daemon          # 只起 Node API（缺省 8644）
vessel gateway status --json        # 两个监听的状态
vessel node status --json
vessel ps                           # docker ps 式进程清单（--all 含已停止，--json 机器可读）
bun run build:web                   # 生产：Platform Gateway 托管 apps/web/dist
bun run dev:web                     # 开发：http://127.0.0.1:5173
```

打开控制台后，配置了认证（`auth.backends`）就走登录页（口令 / TOTP / 第三方登录）；URL 里的 `#token=` / `#bootstrap=` 只是**一次性引导码**（单次 + 10 分钟），用于首次引导设置，不是常规登录方式。缺省平台代理 node 流量（`gateway.proxy_nodes`）：浏览器只连平台端口，node token 不出网关。支持运行提交 / 取消、事件时间线、会话列表、工具列表、run 内联权限卡片、`ask` 表单、Team 列表 / 群聊 / 成员侧栏 / `@` 补全 / Body 历史、看板（`#/kanban`）与 VSCode 式设置弹窗（插件设置域装上即出现）。

### Headless 提问（退出码 3）

`vessel --run` 中模型调用 `ask` 时，进程不等待人类：请求写入
`<data_dir>/interactions-<id>.json`（`suspended: true`；`<id>` 是内部持久单 id，不是 wire 字段），run 的 checkpoint 落 `interrupted`，
退出码为 **3**。

```bash
vessel attention --json
vessel attention respond <request_id> --answers '[{"header":"Deploy","question":"Deploy now?","answer":"yes"}]'
vessel --resume-run <run_id>
```

回答以 `user.message`（`source=ask_resume`）注入下一轮。`ui.askUser: false` 会在所有入口关闭该工具。

## 配置

- 优先级：`CLI > env > project > user > default`（显式 `--user-config` 的 `data_dir` 有例外，见 CONFIG.md）；没有 tenant overlay / `tenant` 配置块。命令 `vessel config path|init|show|set|explain`。详见 [CONFIG.md](docs/operations/CONFIG.md)。
- 默认数据根 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；单公司数据直接位于 `<data_dir>/{sessions,runs,events,inbox}/`，`tenant.json` 只保存内部持久单 id，没有 `tenants/<id>/` 层。
- 默认 `session.backend: file`；sqlite 仍可用。旧 `.vessel/sessions.db` 不会自动迁移，见 [MIGRATION.md](docs/operations/MIGRATION.md)。
- trace 默认开启 `full`，按 30 天 / 1000 runs / 1 GiB prune；详见 [TRACE.md](docs/operations/TRACE.md)。
- 没有 `--tenant` / `VESSEL_TENANT`。`serve:` 配置块已移除（写它启动失败）：node token 用 `node.tokens`（token → `{ role }`）或 `node.token` / `node.token_env`；Platform Gateway token 独立用 `gateway.token`，两者互不通用。
- 语言：默认 zh-CN。`VESSEL_LANG=en`（或 `ui.language: en`）切换到英文；Web 控制台语言在 Settings → Appearance。

### 插件与 MCP

- **MCP**：插件（`@vessel-agent/mcp-client`）。server 的工具经 `PluginHost` 注册，默认名 `mcp__<server>__<tool>`，权限默认 `ask`。密钥用 `<NAME>_env` 引用环境变量，配置层不做 `${VAR}` 插值。
- **evals**：插件 + 运行器，默认完全离线；真实 provider 需 `evals.allowNetwork: true` 与 CLI `--allow-network` 双门控。
- **飞书**：插件，官方 SDK WebSocket 长连接，文本回复；每个 chat 一个独立临时成员（id `feishu_<chat_id>`，run_id `feishu:<chat_id>`）。连接指南见 [FEISHU.md](plugins/im/feishu/FEISHU.md)。
- **skills**：就是 Markdown 文件，放 `skills/`（项目级）或 `~/.vessel/skills/`（用户级）；`skills` 插件提供 list / search / load（TOFU 信任门控）与管理 UI。
- 其余默认插件（web-tools / media / recall / doc-subscription / thinking-intensity / model-registry / marketplace / usage / security 三守卫等）的完整清单与职责见[包结构](#包结构)。

```yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed-dir"]
    tool_prefix: true          # 工具名加 mcp__filesystem__ 前缀（默认 true）
    auto_approve_tools: []     # 自动批准白名单；未列出的工具默认 ask
```

任何走 stdio 或 Streamable HTTP 的真实 MCP server 都可以这样接入（http 用 `url` / `headers` 代替 `command` / `args`）；超时用 `connect_timeout_ms` / `tool_timeout_ms`，`enabled: false` 可临时停用。

## 架构与目录

**语言空间是唯一的执行面。** Vessel 做两件事：把世界折成语言（system prompt + 消息 + 工具 schema），把语言折回世界（解析 `tool_calls` → 执行 → 结果折回消息）。

当前分层（Stage 4，已落地）：

```text
Assembly → Runtime（per-node 无状态工厂）→ ExecutionUnit（per-session）
        → Run（瞬时，持 WorkingContext）→ ToolCallingLoop
```

- `Runtime` 只持单 node profile 与 `(内部单 id, sessionId)` 的 EU 目录；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。
- 事实事件 / `RunRecord` / `SessionState` 只由 Run 经 `RunJournal` 写；`WorkingContext` 每次 Run 新建。
- 核心契约：`LLMProvider` / `WorkingContext` / `EventStream` / `ToolDefinition` / `SessionStore` / `LimitChecker` / `Guardrail` / `Hook` / `Plugin` / `PluginHost`。签名见 [interfaces.md](docs/architecture/interfaces.md) 与 [state.md](docs/architecture/state.md)。

### 包结构

全仓共 **30 个包**：根包 `vessel-agent`（CLI 本身，bin `vessel` → `src/cli.ts`）+ `packages/*` 8 个 + `apps/web` 1 个 + `plugins/*/*` 20 个。workspaces 为 `packages/*` 与 `plugins/*/*`；**apps/web 不在 workspaces**（独立 npm 依赖安装，Vite 7 要求 Node ^20.19 || >=22.12）。

**packages/*（8 个 workspace 包）**

| 包 | 职责 |
| --- | --- |
| `@vessel-agent/core` | 运行时核心：tool-calling loop、provider 抽象、context/session、events、Guardrail/Hook、`PluginHost`（工具唯一注册表）；零 UI 依赖、`dependencies` 为空，可独立嵌入 |
| `@vessel-agent/agent` | Agent 能力层：成员 registry、生命周期、消息队列与回复投递、可见性、快照、Team、inbox、conversation |
| `@vessel-agent/config` | 声明式配置：YAML 解析/校验 → core 可消费对象；auth 策略、模型注册表、密钥库、配置溯源（explain） |
| `@vessel-agent/permission` | 共享权限原语 `requestPermission`（事件驱动的人类授权），保留给外部插件 |
| `@vessel-agent/plugin-sdk` | embedded 插件的宿主 API 契约 + 薄运行时：`createPluginHost` 冻结宿主对象、manifest 白名单校验 |
| `@vessel-agent/plugin-ui` | 宿主与插件共享的纯展示 React 原语（Button / DataTable / Tabs 等 + `useStaleWhileRevalidate`） |
| `@vessel-agent/serve` | 本地 HTTP/WS 服务网关：EventStream → WS+SSE 广播 + `/v1` 控制端点 |
| `@vessel-agent/tui` | 终端外壳：Ink（React）组件式 REPL、命令注册表、首启向导与 i18n |

`apps/web`（`@vessel-agent/web`，private）：本地 Web 控制台，Vite 7 + React 19 + zustand + tailwind 4；`dist/` 不入 git，由 Platform Gateway 托管。

**plugins/*/*（20 个 workspace 插件，10 类）**

| 类别 | 插件包 | 一句话职责 |
| --- | --- | --- |
| context | `@vessel-agent/doc-subscription` | `subscribe` 显式文件订阅 + edit/write/read 自动订阅 + 变更通知 |
| context | `@vessel-agent/plugin-skills` | 技能库三来源扫描/索引/TOFU 信任门控 load（`skills` 工具）+ 库 UI |
| context | `@vessel-agent/thinking-intensity` | 模型思考强度热配置：per-provider effort/budget 注入 + composer 档位菜单 |
| evals | `@vessel-agent/evals` | 默认离线 eval harness（库 + 运行器，不注册工具） |
| im | `@vessel-agent/feishu` | 飞书 WebSocket 长连接文本 bot，per-chat 临时成员 |
| marketplace | `@vessel-agent/plugin-marketplace` | 插件市场：GitHub registry 浏览/安装/更新（Plugins 页） |
| mcp | `@vessel-agent/mcp-client` | MCP client：按 `mcp_servers` 配置把 server 工具注册进 `PluginHost` |
| media | `@vessel-agent/media` | 多模态 `media` 工具：read / view / ocr / describe |
| observability | `@vessel-agent/hook-logging` | 全操作日志 Hook（`VESSEL_DEBUG` 门控，不进默认集） |
| observability | `@vessel-agent/plugin-usage` | 用量 / 请求日志 / 模型排行榜（Usage + Logs 页） |
| provider | `@vessel-agent/provider-anthropic` | Anthropic Claude provider 薄工厂（retry/timeout 包装） |
| provider | `@vessel-agent/model-registry` | 模型/凭证管理：加密凭证库、连通性测试（Credentials + Models 页） |
| provider | `@vessel-agent/provider-openai` | OpenAI 兼容 provider 集合（openai / openai-compatible / gemini 及品牌兼容名） |
| security | `@vessel-agent/guardrail-pii` | PII 守卫：脱敏只发生在 append 侧（落盘即占位符） |
| security | `@vessel-agent/redact-secrets` | 密钥 / Token / 密码脱敏（ToolResult + Output 阶段） |
| security | `@vessel-agent/tool-policy` | 工具 allowlist / denylist 策略（ToolCall 阶段拦截） |
| tools | `@vessel-agent/basic-tools` | 四个能力工具 `bash` / `read` / `edit` / `write`（唯一的基础工具包） |
| tools | `@vessel-agent/engine-client` | tools-engine 子进程工具引擎的 `PluginHost` 接入层（协议转译 / 注册表同步） |
| tools | `@vessel-agent/recall` | 把被压缩（compaction）掉的历史按索引读回（`recall` 工具） |
| tools | `@vessel-agent/web-tools` | `web_search`（多后端）+ `web_fetch`（SSRF 守卫 / robots / 限流） |

### 目录结构

```text
.
├── packages/        core / agent / config / permission / plugin-sdk / plugin-ui / serve / tui
├── plugins/         10 类 20 插件：context / evals / im / marketplace / mcp / media / observability / provider / security / tools
├── apps/web/        浏览器控制台（非 workspace，独立 npm 依赖）
├── src/             CLI 装配层（根包 vessel-agent 自身源码，bin vessel）
├── scripts/         构建、检查与发布脚本
├── docs/            架构、ADR、操作文档
├── examples/        离线示例（真实代码路径 + mock provider，非生产用法）
└── assets/          品牌资源
```

细节见 [docs/architecture/INDEX.md](docs/architecture/INDEX.md)。

### 核心概念

| 概念       | 代码里的东西                                          | 职责                                                                                             |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **节点**   | 一次 Vessel 进程，`node.json` 的 `node_id` + 数据目录 | 独立执行、授权、持久化；是唯一权威                                                               |
| **Hub**    | 独立进程 `vessel hub start`                           | 登记节点 / Team / 成员 / 在线状态、推送指针；只接受 node → hub 出站 join；不代理正文、不替节点授权 |
| **Team**   | `workspace` + `team_id` + roster + 日志 + policy      | 一个工作目录一个 Team（声明后按 `workspace` 匹配当前目录）；共享日志、预算、可见性               |
| **Agent**  | 持久身份 + 可替换 Body                                | 主 Agent 可 `hire` / `close` 成员；成员可 `create` / `hire` / `close` / `send` / `list` / `read` / `rotate` |
| **地址**   | `<principal>@<node_id>:<team_id>`                     | 跨节点定向投递；`principal` 是名字，不是 agent id                                                |

成员增长与分工是**显式派发**：谁做什么由主 Agent 或人决定。这里没有内建的自治规划器或任务市场。

## 多节点与远程

一个 Vessel 进程 = 一个节点。Hub 是独立进程（`vessel hub start`，不随 gateway 启动），只做目录与指针；真正的消息走节点到节点的 federation。**默认是本机回环**，远程与跨节点都要显式配置。

- **远程客户端**：`--connect <http(s)://origin>`（或 `VESSEL_CONNECT`）。回环允许明文；非回环必须 HTTPS + token；URL 只接受 origin。
- **服务端**：`--serve-host` + `--allow-remote` + `--tls-cert` / `--tls-key`，或 `node.*` 配置。
- **Hub 目录**：`vessel hub start` 独立启动目录进程；`vessel hub join-code` 生成一次性配对码，节点用 `vessel hub join <hub-url> --code <CODE>` 出站加入（NAT 友好）。只支持 node → hub；`hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除。
- **跨节点投递**：只走 federation（`POST /v1/federation/messages`），静态 peer allowlist + `<principal>@<node_id>:<team_id>` 地址。
- **已知限制**：没有 mDNS / 服务网格 / 自动发现 / mTLS / 全局 durable；跨节点 spawn / close / rotate / resume 未实现。

完整证书、两机配置、独立前端部署与故障排查见 [REMOTE.md](docs/operations/REMOTE.md)。

## 能力边界

### 核心设计不变量

两条**不可绕过**的产品不变量（完整说明见 [docs/architecture/message-invariants.md](docs/architecture/message-invariants.md)）：

1. **可见性对等**：UI 里用户看到的消息，必须包含会话中 agent 看到的**全部**消息 —— 不存在
   「agent 知道、用户看不见」的信息不对称。任何对模型侧内容的变形（脱敏 / 占位符 / 补充说明）
   都必须在用户侧同样可见；「用户多看一点」只能来自显式动作（例如对真值做审批解锁）。
2. **请求 messages append-only**：发给大模型的消息列表**只能追加，不许修改中间任何一条** ——
   改写中间内容会让该点之后的 prefix 全部失效，**提示词缓存命中率被打掉**（长会话代价极高）。
   所以「引用已失效」这类状态变化只能**追加一条环境信息消息**表达，不许回改历史。

> 为什么写进 README：这两条决定了「脱敏在哪一层做」（必须落在 **append 时**，不是发请求时）、
> 「重启恢复怎么呈现」（追加一张环境信息卡，而不是塞隐藏输入）、以及「上下文压缩怎么做」
> （追加摘要，不改旧消息）。它们不是实现细节，是产品承诺。

### 已实现

- 单节点 Agent 生命周期：`create` / `hire` / `send` / `close` / `list` / `rotate` / `read`（Team 日志走 CLI `vessel team post`）。
- AX 三组六命令：`session status` / `permission show` / `config explain` / `doctor`（含舰队五项）/ `rpc list` / `fleet status`；优雅自重启 `restart --self --prompt` + 启动唤醒 sweep。
- Platform Gateway（8642）+ Node API（8644）同进程双监听（G1）；本地多 Node 独立子进程 + `nodes.json` 注册表（G3）。
- 会话分支、收件箱与三档投递：`sessions.create` / `restart` / `activate`；`inbox` 工具；`send` 的 work / urgent（`interrupt`）/ notify。
- temporary 回收（`agent.temporary_ttl_hours`，默认 2 小时，`0` 关闭）。
- peer（同 Team 平级）与 contractor（调用者拥有）两条派生路径；成员关闭 peer 经人类审批。
- Team：按工作目录匹配；roster、共享日志、预算、可见性、`@` 投递；`team freeze|unfreeze` 停止增长。
- Hub 目录：节点 / Team / 成员 / 在线状态、指针；node → hub 出站拨号（join-code / join），不接受入站。
- 跨节点定向投递、远程控制面、Durable run、evals、飞书渠道、MCP、文件级订阅。
- 高频插件工具面：`web_search` / `web_fetch`（多后端 + SSRF 守卫）、`media` 多模态（read / view / ocr / describe）、`recall` 压缩历史读回、思考强度热配置（thinking-intensity）。
- 插件市场（Plugins 页浏览 / 安装 / 更新）、模型与凭证管理（Credentials / Models 页、加密凭证库、连通性测试）、用量 / 请求日志 / 模型排行榜（Usage / Logs 页）。
- 安全守卫三插件：`guardrail-pii`（PII 脱敏，append 侧）、`redact-secrets`（密钥脱敏）、`tool-policy`（工具 allow / deny 策略）。

### 部分实现

- **发现**：本机 roster 用 `agent(list)`；跨节点用 `vessel federation team-info`（opt-in）或 Hub 目录。没有一等公民的 Agent 发现工具。
- **事件 / 文件订阅**：文件级显式订阅（`subscribe`）已实现；目录 / 事件订阅与 run 边界自动 diff 注入未实现。

### 未实现（暂不承诺）

- 跨节点 spawn / close / rotate / resume；spawn 预算与跨 Team 派生。
- 自动发现 / mesh / 中继 / 离线队列 / 跨重启 exactly-once。
- A2A 协议兼容。
- 多公司 federation：当前跨节点 Team 控制面为单公司 / admin-only。
- G4 分布式 Node / G5 legacy `--serve` 清理 / Workspace 插件独立包 / Workspace=公司数据目录：未排期或未实现（见 [topology](docs/architecture/topology.md)）。
- 自治调度：自动分工、任务市场。

### 明确不做

- mDNS / 服务网格 / mTLS / 客户端证书等自动网络发现与强身份。
- 飞书富媒体 / 卡片 / 多机器人 / OAuth。
- 独立二进制 / 二进制自替换更新（ADR-006）；`vessel update` 只对 npm / bun 全局安装执行包级更新。
- Web 全量本地化：壳层已支持 zh-CN / en，功能页未覆盖文案回退中文。
- 1.0 前不 tag、不 publish；发布决定由维护者做。

## FAQ

### `npx vessel` / `npm i -g vessel-agent` 为什么用不了？

尚未发布到 npm。从源码 `bun install && bun link`，或直接用 `bun run src/cli.ts`。

### 没有 API Key 能跑吗？

真实模型调用需要可用的 API Key 与 Base URL。没有 Key 时可以先跑 `vessel doctor` 做环境自检（配置 / 数据根 / 端口 / 插件，不联网、不需要 Key），或 `vessel config init` 生成配置模板后再回填。

### headless 命令为什么返回 exit 3？

模型调用了 `ask`，run 已挂起等待人类回答。按 [Headless 提问](#headless-提问退出码-3) 的步骤回答后 `--resume-run`。

### Web 页面还是旧界面？

`apps/web/dist` 不入 git，源码改动后需要重新构建：

```bash
cd apps/web && bun run build
```

### 怎么开放远程访问？

必须显式开启：`--serve-host` + `--allow-remote` + token；非回环还必须有 TLS。见 [REMOTE.md](docs/operations/REMOTE.md)。

### 为什么没有独立二进制？

见 ADR-006：1.0 前只做源码与包级分发，`vessel update` 只更新 npm / bun 全局安装。

### 模型思考过程去哪了？

`reasoning_content` 会保存并回传，但 TUI / 事件流不展示；需要查看时设 `ui.showReasoning: true`。

### agent 怎么知道自己的状态？

`vessel session status`（缺省解析调用者自身）一屏看 state / token 用量 / 上下文预算 / queue 深度，`--json` 纯数据。权限矩阵用 `vessel permission show`，配置溯源用 `vessel config explain <key>`，能力发现用 `vessel rpc list`。见 [AX](#axagent-experience)。

### 怎么更新代码而不丢正在跑的工作？

平台代码更新用 `vessel gateway restart`（handoff，run 不断）；整舰队重启用 `vessel restart`，缺省不限时优雅 drain，等活跃 run 自然跑完。agent 也可以在自己的 run 里预约优雅自重启：`vessel restart --self --prompt "<续作嘱托>"`，重启后嘱托自动投递续作。`--force` 是唯一的非优雅退出，会留审计。

## 写给 AI

如果你是一个 AI agent，正在读这份 README 以了解或接入 Vessel：

- **先读 [AGENTS.md](AGENTS.md)**：本仓的 AI 行为约定（风格、硬安全规则、怎么跑、红线）。开工前用 `bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>` 检索相关架构模块。
- **两条产品不变量不可绕过**：消息可见性对等（用户看到的 ⊇ agent 看到的）与请求 messages append-only（见[能力边界](#核心设计不变量)）。
- **机器可读面**：AX 命令全部支持 `--json`（纯数据、无 ANSI、不输出密钥）；控制面能力经 `vessel rpc list --json` 或 RPC `capabilities.list` 发现，与 WebUI 同源。
- **文档是给检索用的**：`docs/architecture/` 每篇头部有 frontmatter（`title` / `kind` / `triggers` / `paths`），按 triggers 命中，不必整读。
- **你在运行时里是被信任的居民**：可以 `session status` 看自己的上下文预算，`config explain` 溯源配置，`restart --self --prompt` 优雅重启并给自己留续作嘱托。授权分级见 [docs/constitution/12-autonomy.md](docs/constitution/12-autonomy.md)。

## 文档

| 文档                                                         | 作用                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| [docs/PRODUCT.md](docs/PRODUCT.md)                           | 产品定位、概念模型与路线                               |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | 架构总入口（重定向到模块索引与历史/决策入口）          |
| [docs/architecture/INDEX.md](docs/architecture/INDEX.md)     | 技术架构：分层、循环、接口、扩展、事件、Gateway        |
| [docs/agents/INDEX.md](docs/agents/INDEX.md)                 | 按路径的 agent 领域告诫索引                            |
| [docs/adr/README.md](docs/adr/README.md)                     | 架构决策记录：每个关键选择的「为什么」                 |
| [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)           | 文件放哪里、路径归属、分支与发布规则                   |
| [docs/DOC-MANAGEMENT.md](docs/DOC-MANAGEMENT.md)             | 文档生命周期、拆分规则与结构门禁                       |
| [docs/DESIGN.md](docs/DESIGN.md)                             | 跨外壳设计系统：页面骨架、表格控件、时间戳、插件 i18n  |
| [docs/WEB-UI.md](docs/WEB-UI.md)                             | Web 控制台 UI 规范与交互约定                           |
| [docs/operations/INDEX.md](docs/operations/INDEX.md)         | 运维索引：按目标或故障现象命中对应 runbook              |
| [docs/operations/CONFIG.md](docs/operations/CONFIG.md)       | 配置位置、优先级、单公司数据根与密钥                   |
| [docs/operations/REMOTE.md](docs/operations/REMOTE.md)       | 跨机器远程：证书 / CA、两机配置、独立前端、故障排查    |
| [docs/operations/TRACE.md](docs/operations/TRACE.md)         | trace 留存、脱敏与重放                                 |
| [docs/operations/MIGRATION.md](docs/operations/MIGRATION.md) | sqlite / file-v1 → file-v2 迁移                        |
| [docs/operations/RELEASE.md](docs/operations/RELEASE.md)     | 发布流程                                               |
| [docs/operations/CI-CD.md](docs/operations/CI-CD.md)         | CI / CD / 自动更新                                     |
| [CHANGELOG.md](CHANGELOG.md)                                 | 变更记录                                               |
| [AGENTS.md](AGENTS.md)                                       | AI 行为约定：风格、硬规矩、怎么跑、红线                |

> 运维文档的完整索引见 [docs/operations/INDEX.md](docs/operations/INDEX.md)；本表只列常用入口。

## 状态

**alpha。** 1.0 前不发布：没有 tag、没有 `npm publish`、没有独立二进制；代码在 `main` 上滚动。当前版本与已合入能力见 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)，历史见 [docs/versions/INDEX.md](docs/versions/INDEX.md)。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交 Issue / PR 前请先跑：

```bash
bun run typecheck
bunx @biomejs/biome ci .
```

## 许可证

MIT © 2026 Vessel Contributors · 见 [LICENSE](LICENSE)。
