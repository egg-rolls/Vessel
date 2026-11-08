<p align="center">
  <img src="assets/Vessel.svg" alt="Vessel" width="96" />
</p>

# Vessel

**多 agent 运行时。** 一个节点内按工作目录组成 Team，成员可派生、定向通信、轮换身体；节点之间通过 Hub 与 federation 直接寻址。

> A multi-agent runtime: teams form around working directories, members can spawn, message each other, and rotate bodies; nodes discover each other through a Hub and talk directly over federation.

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#状态)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3.9-black?logo=bun)](https://bun.sh)

核心是 agent 之间的组织与通信：节点、Team、成员生命周期、定向消息与跨节点地址。单个 agent 的执行面保持最小——一个 tool-calling loop、一个工具注册表、三个能力工具（`bash` / `read` / `edit`），其余能力由模型组合或插件提供。`@vessel-agent/core` 可单独引入；TUI / CLI / Web / Gateway 是自带的参考外壳。适合需要多 agent 协作、可自托管的团队与开发者。

## 目录

- [快速开始](#快速开始)
- [特性](#特性)
- [使用示例](#使用示例)
- [配置](#配置)
- [架构与目录](#架构与目录)
- [多节点与远程](#多节点与远程)
- [能力边界](#能力边界)
- [FAQ](#faq)
- [文档](#文档)
- [贡献](#贡献)
- [许可证](#许可证)

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

### 30 秒冒烟（不需要 API Key）

```bash
vessel demo
```

`vessel demo` 用隔离的数据目录启动一次演示会话：不调真实模型，助手会调用一次无害的 `bash` 命令，能看到工具调用、权限确认与最终回复。演示数据写在 `<dataDir>/demo`，不会读取已有会话；需要交互式终端（非 TTY 直接退出，exit 1）。

调试 / CI 用 `VESSEL_MOCK=1`：

```bash
VESSEL_MOCK=1 vessel               # 模拟 REPL（默认 echo 场景）
VESSEL_MOCK=1 vessel --run "hello" # headless 冒烟，输出 Echo: hello
```

可选 `VESSEL_MOCK_SCENARIO=echo|tools|permissions|error|multi-turn`（默认 `echo`）。

### 接入真实模型

```bash
vessel doctor   # 自检：配置 / provider key / data_dir / 端口 / 插件（不联网）
vessel          # 首次启动走引导向导：API 地址、Key、模型，保存到 ~/.vessel/config.yaml
```

`vessel doctor` 列出 `ok` / `warn` / `fail` / `info` 检查项，退出码 0 = 无失败项、1 = 有失败项。也可以先 `vessel config init` 生成用户配置模板（不含真实密钥），再回填 `api_key_env` 指向的 Key。

## 特性

- **极简核心** — 核心契约 + 1 个循环 + 1 个注册表（`PluginHost`）。`@vessel-agent/core` 不出现业务概念，`dependencies` 保持为空。
- **三个能力工具** — `bash` / `read` / `edit`。能被 bash 组合出来的能力不再单开工具；MCP 工具经插件注册进同一个 `PluginHost`。
- **成员生命周期** — `create` / `hire` / `close` / `send` / `post` / `rotate` / `list`；peer 与 contractor 两条派生路径；成员关 peer 需人类审批。
- **上下文即消息** — skills 就是 Markdown 文件，`@路径` 在发送前展开为注入消息；`subscribe` 对具体文件做显式订阅，变更只发短通知，`inspect` 时取 diff。
- **Durable run** — run 在开始、每轮 tool-call 后、结束时写 checkpoint；中断后 `--resume-run` 恢复。
- **可观测** — 事件流（`<domain>.<action>.<event>`）、trace、metrics、Web 控制台时间线；`/v1/events?since=` 支持 `seq` 续订与 `gap` 标记。
- **可扩展** — 插件、MCP、evals、飞书渠道；插件以目录形式放置即注册，外部插件启动时向 stderr 告警。
- **多机** — 独立 Hub 服务、节点间 federation、远程 gateway（显式 opt-in，非回环必须 token + TLS）。
- **单公司数据根** — 一个 data dir 一个公司；成员 / Team 是使用范围，不再有 tenant 选择、隔离存储或 quota。

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

```bash
vessel gateway start --daemon       # 平台 8642 + Node API 8644（同进程）
vessel node start --daemon          # 只起 Node API（缺省 8644）
vessel gateway status --json        # 两个监听的状态
vessel node status --json
cd apps/web && npm ci && npm run build  # 生产：Platform Gateway 托管 dist
bun run dev:web                     # 开发：http://127.0.0.1:5173
VESSEL_MOCK=1 vessel --serve 8642   # legacy 单监听（保留至 G5）
```

打开控制台后把平台 token 粘到 URL fragment（`#token=...`），它只进 `sessionStorage`；本地 node 的生效凭据由 `platform.nodes.credentials` 自动交付（回环匿名时为空）。支持运行提交 / 取消、事件时间线、会话列表、工具列表、run 内联权限卡片、`ask_user` 表单、Team 列表 / 群聊 / 成员侧栏 / `@` 补全 / Body 历史。

### Headless 提问（退出码 3）

`vessel --run` 中模型调用 `ask_user` 时，进程不等待人类：请求写入
`<data_dir>/interactions-<id>.json`（`suspended: true`；`<id>` 是内部持久单 id，不是 wire 字段），run 的 checkpoint 落 `interrupted`，
退出码为 **3**。

```bash
vessel attention --json
vessel attention respond <request_id> --answers '[{"header":"Deploy","question":"Deploy now?","answer":"yes"}]'
vessel --resume-run <run_id>
```

回答以 `user.message`（`source=ask_resume`）注入下一轮。`ui.askUser: false` 会在所有入口关闭该工具。

## 配置

- 优先级：`CLI > env > project > user > default`；没有 tenant overlay / `tenant` 配置块。命令 `vessel config path|init|show`。详见 [CONFIG.md](docs/operations/CONFIG.md)。
- 默认数据根 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；单公司数据直接位于 `<data_dir>/{sessions,runs,events,inbox}/`，`tenant.json` 只保存内部持久单 id，没有 `tenants/<id>/` 层。
- 默认 `session.backend: file`；sqlite 仍可用。旧 `.vessel/sessions.db` 不会自动迁移，见 [MIGRATION.md](docs/operations/MIGRATION.md)。
- trace 默认开启 `full`，按 30 天 / 1000 runs / 1 GiB prune；详见 [TRACE.md](docs/operations/TRACE.md)。
- 没有 `--tenant` / `VESSEL_TENANT`。node token 用 `serve.tokens`（token → `{ role }`）或 legacy `serve.token`；Platform Gateway token 独立用 `gateway.token`，两者互不通用。
- 语言：默认 zh-CN。`VESSEL_LANG=en`（或 `ui.language: en`）切换到英文；Web 控制台语言在 Settings → Appearance。

### 插件与 MCP

- **MCP**：插件（`@vessel-agent/mcp-client`）。server 的工具经 `PluginHost` 注册，默认名 `mcp__<server>__<tool>`，权限默认 `ask`。密钥用 `<NAME>_env` 引用环境变量，配置层不做 `${VAR}` 插值。
- **evals**：插件 + 运行器，默认完全离线；真实 provider 需 `evals.allowNetwork: true` 与 CLI `--allow-network` 双门控。
- **飞书**：插件，官方 SDK WebSocket 长连接，只做文本；session 固定 `feishu:<chat_id>`。
- **skills**：就是 Markdown 文件，放 `skills/`（项目级）或 `~/.vessel/skills/`（用户级）；这是约定，代码里没有硬编码路径。

```yaml
mcp_servers:
  echo:
    transport: stdio
    command: bun
    args: ["run", "examples/mcp-echo-server.ts"]
    tool_prefix: true
    auto_approve_tools: []
```

## 架构与目录

**语言空间是唯一的执行面。** Vessel 做两件事：把世界折成语言（system prompt + 消息 + 工具 schema），把语言折回世界（解析 `tool_calls` → 执行 → 结果折回消息）。

当前分层（0.34 Stage 4）：

```text
Assembly → Runtime（per-node 无状态工厂）→ ExecutionUnit（per-session）
        → Run（瞬时，持 WorkingContext）→ ToolCallingLoop
```

- `Runtime` 只持单 node profile 与 `(内部单 id, sessionId)` 的 EU 目录；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。
- 事实事件 / `RunRecord` / `SessionState` 只由 Run 经 `RunJournal` 写；`WorkingContext` 每次 Run 新建。
- 核心契约：`LLMProvider` / `WorkingContext` / `EventStream` / `ToolDefinition` / `SessionStore` / `LimitChecker` / `Guardrail` / `Hook` / `Plugin` / `PluginHost`。签名见 [interfaces.md](docs/architecture/interfaces.md) 与 [state.md](docs/architecture/state.md)。

### 包结构

| 包                                                  | 职责                                              |
| --------------------------------------------------- | ------------------------------------------------- |
| `@vessel-agent/core`                                | 运行时；零 UI 依赖，可独立嵌入                    |
| `@vessel-agent/agent`                               | `AgentService` 成员与 Team 能力                   |
| `@vessel-agent/config` / `@vessel-agent/permission` | 配置解析与权限                                    |
| `@vessel-agent/tui` / `@vessel-agent/serve`         | 终端外壳与 gateway / RPC                          |
| `apps/web`                                          | 浏览器控制台                                      |
| `plugins/`                                          | MCP、evals、飞书、工具与上下文插件                |

### 目录结构

```text
.
├── packages/        core / agent / config / permission / tui / serve
├── plugins/         MCP、evals、飞书、工具与上下文插件
├── apps/web/        浏览器控制台
├── src/             CLI 装配层
├── scripts/         构建、检查与发布脚本
├── docs/            架构、ADR、操作文档
├── examples/        示例
└── assets/          品牌资源
```

细节见 [docs/architecture/INDEX.md](docs/architecture/INDEX.md)。

### 核心概念

| 概念       | 代码里的东西                                          | 职责                                                                                             |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **节点**   | 一次 Vessel 进程，`node.json` 的 `node_id` + 数据目录 | 独立执行、授权、持久化；是唯一权威                                                               |
| **Hub**    | 独立进程 `vessel hub start`                           | 登记节点 / Team / 成员 / 在线状态、推送指针；只接受 node → hub 出站 join；不代理正文、不替节点授权 |
| **Team**   | `workspace` + `team_id` + roster + 日志 + policy      | 一个工作目录一个 Team（声明后按 `workspace` 匹配当前目录）；共享日志、预算、可见性               |
| **Agent**  | 持久身份 + 可替换 Body                                | 主 Agent 可 `hire` / `close` 成员；成员可 `create` / `hire` / `close` / `send` / `post` / `list` / `rotate` |
| **地址**   | `<principal>@<node_id>:<team_id>`                     | 跨节点定向投递；`principal` 是名字，不是 agent id                                                |

成员增长与分工是**显式派发**：谁做什么由主 Agent 或人决定。这里没有内建的自治规划器或任务市场。

## 多节点与远程

一个 Vessel 进程 = 一个节点。Hub 是独立进程（`vessel hub start`，不随 gateway 启动），只做目录与指针；真正的消息走节点到节点的 federation。**默认是本机回环**，远程与跨节点都要显式配置。

- **远程客户端**：`--connect <http(s)://origin>`（或 `VESSEL_CONNECT`）。回环允许明文；非回环必须 HTTPS + token；URL 只接受 origin。
- **服务端**：`--serve-host` + `--allow-remote` + `--tls-cert` / `--tls-key`，或 `serve.*` 配置。
- **Hub 目录**：`vessel hub start` 独立启动目录进程；`vessel hub join-code` 生成一次性配对码，节点用 `vessel hub join <hub-url> --code <CODE>` 出站加入（NAT 友好）。只支持 node → hub；`hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除。
- **跨节点投递**：只走 federation（`POST /v1/federation/messages`），静态 peer allowlist + `<principal>@<node_id>:<team_id>` 地址。
- **已知限制**：没有 mDNS / 服务网格 / 自动发现 / mTLS / 全局 durable；跨节点 spawn / close / rotate / resume 未实现。

完整证书、两机配置、独立前端部署与故障排查见 [REMOTE.md](docs/operations/REMOTE.md)。

## 能力边界

### 已实现

- 单节点 Agent 生命周期：`create` / `hire` / `send` / `close` / `list` / `rotate` / `post`。
- Platform Gateway（8642）+ Node API（8644）同进程双监听（G1）；本地多 Node 独立子进程 + `nodes.json` 注册表（G3）。
- 会话分支、收件箱与三档投递：`sessions.create` / `restart` / `activate`；`inbox` 工具；`send` 的 work / urgent（`interrupt`）/ notify。
- temporary 回收（`agent.temporary_ttl_hours`，默认 2 小时，`0` 关闭）。
- peer（同 Team 平级）与 contractor（调用者拥有）两条派生路径；成员关闭 peer 经人类审批。
- Team：按工作目录匹配；roster、共享日志、预算、可见性、`@` 投递；`team freeze|unfreeze` 停止增长。
- Hub 目录：节点 / Team / 成员 / 在线状态、指针；node → hub 出站拨号（join-code / join），不接受入站。
- 跨节点定向投递、远程控制面、Durable run、evals、飞书渠道、MCP、文件级订阅。

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

能。`vessel demo` 跑一次隔离的演示会话；`VESSEL_MOCK=1 vessel` 进入模拟 REPL。

### headless 命令为什么返回 exit 3？

模型调用了 `ask_user`，run 已挂起等待人类回答。按 [Headless 提问](#headless-提问退出码-3) 的步骤回答后 `--resume-run`。

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

## 文档

| 文档                                                         | 作用                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| [docs/PRODUCT.md](docs/PRODUCT.md)                           | 产品定位、概念模型与路线                               |
| [docs/architecture/INDEX.md](docs/architecture/INDEX.md)     | 技术架构：分层、循环、接口、扩展、事件、Gateway        |
| [docs/adr/README.md](docs/adr/README.md)                     | 架构决策记录：每个关键选择的「为什么」                 |
| [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)           | 文件放哪里、路径归属、分支与发布规则                   |
| [docs/DESIGN.md](docs/DESIGN.md)                             | 跨外壳设计系统：页面骨架、表格控件、时间戳、插件 i18n  |
| [docs/operations/CONFIG.md](docs/operations/CONFIG.md)       | 配置位置、优先级、单公司数据根与密钥                   |
| [docs/operations/REMOTE.md](docs/operations/REMOTE.md)       | 跨机器远程：证书 / CA、两机配置、独立前端、故障排查    |
| [docs/operations/TRACE.md](docs/operations/TRACE.md)         | trace 留存、脱敏与重放                                 |
| [docs/operations/MIGRATION.md](docs/operations/MIGRATION.md) | sqlite / file-v1 → file-v2 迁移                        |
| [docs/operations/RELEASE.md](docs/operations/RELEASE.md)     | 发布流程                                               |
| [docs/operations/CI-CD.md](docs/operations/CI-CD.md)         | CI / CD / 自动更新                                     |
| [AGENTS.md](AGENTS.md)                                       | AI 行为约定：风格、硬规矩、怎么跑、红线                |

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
