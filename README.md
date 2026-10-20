# Vessel

> 可嵌入的多 agent 平台 runtime + 参考 harness 外壳。极简核心。两个插槽。一个通用循环。填 Key 即跑。

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#状态)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 这是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**：核心保持极简（单 agent loop + 9 接口 + 2 插槽），TUI / CLI / Web / Gateway 是参考 harness 外壳。它不是给你 50 个工具的 Agent，而是一个**只给最必要工具、其余能力由模型自己组合出来**的 Agent。

| | 传统 Agent 工具 | Vessel |
|---|---------------|--------|
| **能力从哪来** | 给你 50 个工具，自己挑 | 给最必要的三个能力工具，剩下的由模型用它们组合 |
| **绑谁** | 绑一个 LLM 厂商 | 填 Key 即跑，Provider 无关，高频迭代切便宜模型 |
| **范式** | 做一个场景 | 一个 while 循环兜住 Harness / Loop Engineering |
| **核心** | 框架式大 core | 9 个接口、2 个插槽、1 个循环。MIT 开源，core 可嵌入任何应用 |

三层架构：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（Claude-Code 式终端）。形态上参考 Claude Code，但 Provider 无关、范式无关、开源。

## 为谁

- **无基础用户** — 只用 TUI，填 Key 即跑。
- **弱基础用户** — 改 YAML 定义 provider 与 agent。
- **开发者** — 写 TypeScript 插件扩展能力，或把 `@vessel/core` 嵌入 Slack bot / CI / 桌面 app。

## 状态

**alpha。当前开发线 `release/0.10.0`（基线 `release/0.9.0 = 23261b3`），未发布。** 0.1 ~ 0.9 都只在分支上收口：没有 tag、没有 `npm publish`、没有合并 `main`，也没有独立二进制。0.10 正在做发版硬化（安全 / 配置 / 首启 / 错误呈现 / 可观测 / 打包 / 语言）；本文只写已合入当前分支的行为，尚未完成的部分明确标注 **0.10 计划**。

**包结构**（bun workspaces monorepo）：`@vessel/core`（运行时，零 UI 依赖、可独立嵌入）、`@vessel/config`、`@vessel/permission`、`@vessel/tui`、`@vessel/serve`，`plugins/` 下的 MCP / workflow / evals / 飞书插件，以及 `apps/web` 浏览器控制台。`@vessel/core` 的 `dependencies` 保持为空。版本号以根 `package.json` 为唯一来源（`vessel --version`）；当前为 `0.9.0`，各包 manifest 同步，不在文档里维护副本。

**语言**：默认 zh-CN。`VESSEL_LANG=en`（或 `ui.language: en`）切换英文；优先级 `VESSEL_LANG > ui.language > LANG > LC_ALL > zh-CN`。TUI 界面文案走 `t()`（zh-CN / en 两份 catalog），技术词、命令名、错误码与数据输出不翻译；CLI 的 `--help` / 一次性命令错误 / 默认空状态 / demo banner 跟随同一 locale 属于 **0.10 计划**，因此 CLI 当前尚未全量本地化。详见 [CONFIG.md](docs/operations/CONFIG.md)。

## 快速开始

前置：[Bun](https://bun.sh)（`bun --version` 确认可用）。**当前不通过 npm 分发**：`npm i -g vessel-agent` 尚未发布，`npx vessel` / `npx vessel-agent` 当前都不可用，请从源码运行。

```bash
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel
bun install
bun link            # 把根包的 bin 注册为全局 `vessel`
vessel --version    # 读根 package.json
```

之后本文统一用 `vessel`。不想全局链接时，在仓库根用 `bun run src/cli.ts`，参数完全相同。发布名计划为 `vessel-agent`（bin 仍是 `vessel`），打包形态与安装 smoke 属于 **0.10 计划**。

### ① 先跑起来看看（**不需要 API Key**）

```bash
vessel demo
```

`vessel demo` 用隔离的数据目录启动一次演示会话：不调真实模型，助手会调用一次无害的 `bash` 命令（`echo vessel-demo-ok`），能看到工具调用、权限确认与最终回复。演示数据写在 `<dataDir>/demo`，不会读取你已有的会话；需要交互式终端（非 TTY 直接退出，exit 1）。

调试 / CI 仍用 `VESSEL_MOCK=1`：

```bash
VESSEL_MOCK=1 vessel               # 模拟 REPL（默认 echo 场景）
VESSEL_MOCK=1 vessel --run "hello" # headless 冒烟，输出 Echo: hello
```

`VESSEL_MOCK=1` 是**模拟模式**：不调真实模型，用本地模拟响应把整条链路跑通。可选 `VESSEL_MOCK_SCENARIO=echo|tools|permissions|error|multi-turn`（默认 `echo`）。

### ② 接入真实模型

```bash
vessel doctor   # 先自检：配置 / provider key / data_dir / 端口 / 插件（不联网）
vessel          # 首次启动走引导向导：API 地址、Key、模型，保存到 ~/.vessel/config.yaml
```

`vessel doctor` 列出 `ok` / `warn` / `fail` / `info` 检查项，退出码 0 = 无失败项、1 = 有失败项；不构造 runtime、不调用 provider。也可以先 `vessel config init` 生成用户配置模板（不含真实密钥），再回填 `api_key_env` 指向的 Key。

> **thinking 模型**（DeepSeek 等）：`reasoning_content` 会随 assistant 消息保存并在下一轮请求回传（工具调用轮次也保留）；TUI / 事件流不展示思维链。详见 [ADR-038](docs/adr/ADR-038-thinking-reasoning-content.md)。

### ③ 其它常用命令

```bash
vessel --run "帮我写个冒泡排序"      # 一次性执行后退出（适合脚本）
vessel --run @prompt.md             # 从文件读 prompt（.json = 多轮 seeding）
echo "翻译这句话" | vessel --run     # 从管道读输入
vessel --session <id> --run "..."    # 续接指定会话
vessel -c                            # 继续最近会话（--continue）
vessel -r <id>                       # 恢复指定会话（--resume [id]）
vessel --serve                       # 纯 serve 常驻模式（不进 REPL）
vessel --serve 8642 --serve-host 0.0.0.0 --allow-remote \
  --tls-cert cert.pem --tls-key key.pem \
  --allowed-origin https://console.example.com  # 显式远程 + TLS（非回环必须 token + TLS）
vessel --connect https://gateway.example.com:8642 \
  --connect-token "$VESSEL_CONNECT_TOKEN" --ca ./ca.pem --run "..."  # 远程客户端
vessel --resume-run                  # 列出 interrupted durable run
vessel --resume-run <runId>          # 恢复并继续
vessel workflow run release-check    # 跑 workflow（定义在 workflow.dir）
vessel workflow list                 # 列出 workflow run
vessel eval smoke                    # 跑 eval suite（默认离线）
vessel --feishu                      # 前台运行飞书渠道（需 enabled + 凭据）
vessel --version                     # 显示版本（读根 package.json）
vessel --tools                       # 列出当前配置下的工具（不需要 Key）
vessel doctor                        # 本机配置 / 环境自检
vessel update --check                # 检查新版本（只提示，不自替换）
vessel config path                   # 两个 YAML 路径 + data_dir
vessel config init                   # 生成 ~/.vessel/config.yaml 模板（不含真实密钥）
vessel config show --sources         # 合并后的脱敏配置与来源
vessel plugin list                   # 仓库 / 用户 / 项目插件目录
vessel plugin install <path>         # 安装本地插件目录
vessel tenant list                   # tenant 元数据
vessel migrate --from sqlite --to file-v2   # 默认 dry-run
vessel trace prune --dry-run         # 查看将清理的 trace
vessel --tenant acme --run "..."     # 指定 tenant
vessel --connect http://127.0.0.1:8642 --run "..."  # 走 gateway RPC（回环或远程），不取 tenant 锁
bun test                             # 在源码仓库内跑测试
```

REPL 内用 `/help` 看全部 slash 命令（`/resume` `/new` `/history` `/tools` `/plugins` `/mcp` `/runs` `/workflows` `/metrics` `/feishu` `/setup` `/reload` `/clear` `/exit`）。

- `/clear` 清屏，**不清空会话上下文**；需要新会话用 `/new`。
- `/reload` 重新加载配置文件并刷新 provider 信息；**不重扫插件目录**，新增插件需重启进程。
- 输入里的 `@路径` 会在发送前展开为注入消息，界面上以引用块显示，用户原文保持不变。

## 架构

**语言空间是唯一的执行面。** Vessel 做两件事：把世界折成语言（system prompt + 消息 + 工具 schema），把语言折回世界（解析 tool_calls → 执行 → 结果折回消息）。

> 0.2 的 Kernel / Modules 分层（`Contracts ← Kernel ← Modules ← SDK ← Shells`）已实现、未随版本发布，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §14；本小节只描述**当前已实现**的 0.1 行为。

- **9 个接口 + 1 个循环 + 2 个插槽**：`LLMProvider` / `ContextManager` / `EventStream` / `ToolDefinition` / `SessionBackend` / `LimitChecker` / `Guardrail` / `Hook` / `Plugin` + `PluginHost`。两个插槽是**工具**（`PluginHost` 是唯一的工具注册表）与**知识**（`ContextManager`）。
- **core 不认识业务概念**：不认 skills、不认记忆、不认资产。任何要进语言空间的文本都经 `RunOptions.messages` 注入，core 只负责按序放进消息数组。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 工具集

默认运行期 **4 个**工具：三个来自 `plugins/tools/basic-tools` 的**能力工具**，加装配层注册的 `delegate_task`。`ask_user` 只在「实际进入 REPL 且 stdin 是 TTY」时注册；`team_*`（5 个）只在 `team.enabled: true` 时注册。

**能力工具（3）—— 模型干活就靠这三个：**

| 工具 | 干什么 |
|---|---|
| `bash` | 执行命令。grep / cat / ls / python / mkdir / curl / git —— 一切命令行操作 |
| `read` | 读文件，带行号，支持 `offset` / `limit` |
| `edit` | 精确字符串替换写文件，`old_string` 必须唯一匹配 |

**接缝工具 / 可选工具——装配层注册，不是能力：**

| 工具 | 何时注册 | 干什么 |
|---|---|---|
| `delegate_task` | 默认（`delegate.enabled: false` 时关闭） | 派发子 agent 处理子任务，只回收最终文本 |
| `ask_user` | 仅 REPL + TTY（serve/headless 不注册） | 向用户提问，经事件流暂停等待回答 |
| `team_*`（5 个） | 仅 `team.enabled: true`（默认关闭） | agent team：spawn / send / inbox / status / cancel |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功 | 外部 MCP 工具经 `PluginHost` 注册，数量随 server 动态变化 |

口径：默认 **4**；交互 REPL 为 **5**；启用 team 后为 **9**；配置 MCP 后为 **4 + N 个 MCP 工具**。`--tools` 一次性命令按 headless 口径列出 4 个，并注明 `ask_user (interactive only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需要实际运行/连接后，在 REPL 用 `/mcp` 或经 gateway `GET /v1/mcp/servers` 查看。

**为什么这么少？** 这是刻意的。没有 `grep` 工具、没有 file-ops——**能被 bash 组合出来的能力，就不再单开一个工具**。MCP 不是能力工具，而是把外部工具接进 `PluginHost` 的插件（ADR-039）。工具越多，模型的选错空间越大、核心越难保持小。真正的通用原语只有一个：执行命令。其余都是它的特化。

## Skills 怎么用

**skills 就是文件，不是一条加载通道。** harness 不扫描、不解析、不注入 skills —— 它只认消息。

- REPL 输入里的 `@路径` 会在发送前被展开：文件内容作为一条注入消息进本轮请求，界面上显示为引用块。用户原文保持不变。
- 技能就是 markdown 文件，放两个位置：仓库 [`skills/`](skills/)（**项目级**，随仓库提交、团队共享）与 `~/.vessel/skills/`（**用户级**，跨项目复用）。这是**约定**——代码里没有任何地方硬编码这两个路径。
- 引用方式：`@skills/code-writing.md`。

同一机制可用于引用任何文件：附件、项目约定、上下文材料。**前端负责查找与引用，core 只收消息。**

## MCP 怎么用

MCP 是**插件**（`@vessel/mcp-client`），不是 core 模块。在 `vessel.yaml` 里配置 `mcp_servers`，server 的工具会经 `PluginHost` 注册给模型：

```yaml
mcp_servers:
  echo:
    transport: stdio
    command: bun
    args: ["run", "examples/mcp-echo-server.ts"]
    tool_prefix: true
    auto_approve_tools: []
```

```yaml
mcp_servers:
  remote:
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization_env: MCP_AUTH_TOKEN   # 读环境变量 MCP_AUTH_TOKEN 作为 Authorization 头
```

- **配置层不做 `${VAR}` 字符串插值**。密钥 / 头统一用 `<NAME>_env`（`env` 与 `headers` 都支持）：`<NAME>_env: ENV_VAR` 解析为 `<NAME>`，值取 `ENV_VAR`，`_env` 键不会进入最终配置；同层显式 `<NAME>` 优先。需要 `Bearer` 前缀时，把完整值（`Bearer <token>`）放进环境变量。
- 工具名默认 `mcp__<server>__<tool>`；`tool_prefix: false` 用原名，与既有工具冲突时跳过并告警。
- 权限默认 `ask`；`auto_approve_tools` 只接受 server 返回的**原始工具名**（大小写敏感）。
- 单个 server 连不上不会导致进程启动失败；REPL 用 `/mcp` 看状态、`/mcp reconnect <name>` 重连。
- HTTP 只做 POST JSON-RPC（支持 JSON 与 SSE 响应）；不做 GET 长连接、session 恢复、OAuth。

## Durable run 怎么用

默认关闭。开启后每次 run 在开始、每轮 tool-call 后、结束时写 checkpoint：

```yaml
durable:
  enabled: true
  backend: file          # file | memory
  path: ~/.vessel/runs
  checkpoint_every: iteration
```

- 进程崩溃或中断后：`--resume-run` 列出 interrupted run，`--resume-run <runId>` 恢复；
  REPL 内用 `/runs` 与 `/runs resume <runId>`。
- 只支持本机 file / memory；不做跨机器恢复、分布式锁、跨进程并发写协调。
- resume 并发守卫是 per-Host / per-store-instance；多 Host 共享同一 `FileRunStore` 或跨进程同时恢复同一 run 属部署错误。
- 已知错误码：`run_not_found` / `run_not_resumable` / `run_already_running` / `run_store_required` / `agent_not_found`。
- `/v1/durable/*` 接收 token principal；list 按 tenant 过滤（非 default tenant 无独立 store → `forbidden`）；resume 要求 `write` 及以上角色。

## Workflow 怎么用

Workflow 是**插件**（`@vessel/workflow`），默认关闭。打开后在 `workflow.dir` 下放 YAML/JSON 定义：

```yaml
name: release-check
defaults:
  max_parallel: 2
steps:
  - id: plan
    type: agent
    agent: owner
    prompt: "分析仓库并输出计划"
  - id: check
    type: tool
    tool: read
    args:
      path: "{{steps.plan.output}}"
    depends_on: [plan]
```

```yaml
workflow:
  enabled: true
  dir: ./workflows
  path: ~/.vessel/workflows
  max_parallel: 2
  step_timeout_ms: 300000
```

```bash
vessel workflow run release-check --input repo=vessel
vessel workflow list --status failed
vessel workflow show <workflowRunId>
vessel workflow resume <workflowRunId>
vessel workflow cancel <workflowRunId>
```

- 入口只有 CLI / TUI `/workflows` / gateway；**不注册模型工具**，模型不能触发任意路径的定义。
- `resume` 会重跑 `running` / `pending` / `failed` 步骤，**不保证幂等**，重跑可能重复副作用。
- 0.8.2 起 `type: tool` 走统一的工具执行管道（guardrail / hook / 权限 / timeout），与 runtime 语义一致（ADR-058）。
- `cancel` 只支持同进程；跨进程 run 返回 `workflow_not_found`。
- 已知错误码：`workflow_not_found` / `workflow_invalid` / `workflow_already_running` / `workflow_not_resumable` / `workflow_cancelled` / `workflow_disabled`。

## Evals 怎么用

Evals 是**插件 + 运行器**（`@vessel/evals`），**默认完全离线**，使用脚本化 mock provider：

```yaml
name: smoke
defaults:
  timeout_ms: 30000
  session: fresh
cases:
  - id: basic
    input: "hello"
    mock:
      responses:
        - content: "hello"
        - content: "done"
    expect:
      - type: output_contains
        value: "hello"
      - type: no_error
```

```yaml
evals:
  enabled: true
  dir: ./evals
  out_dir: ~/.vessel/evals
  allow_network: false
```

```bash
vessel eval smoke
vessel eval smoke --json
vessel eval smoke --out ./report.json
vessel eval smoke --allow-network   # 还需 evals.allowNetwork: true
```

- 断言白名单：`output_contains` / `output_matches` / `no_error` / `tool_called` /
  `tool_not_called` / `max_duration_ms` / `max_iterations` / `usage_under`；未知类型 = 配置错误。
- 真实 provider 需要 **`evals.allowNetwork: true` 且 CLI `--allow-network`** 同时成立。
- 报告由 `@vessel/evals/report.ts` 写盘，文件名 `<suite>-<YYYYMMDDTHHmmssSSSZ>.json`；
  `GET /v1/evals/latest` 只读最近一次报告。
- 退出码：0 全部通过；1 存在 failed/error；2 配置/解析错误。

## 飞书怎么用

飞书是**插件**（`@vessel/feishu`），使用官方 SDK 的 WebSocket 长连接，只做文本：

```yaml
feishu:
  enabled: true
  app_id: ""                 # 或 VESSEL_FEISHU_APP_ID
  app_secret: ""             # 或 VESSEL_FEISHU_APP_SECRET
  domain: feishu             # feishu | lark
  allowed_chat_ids: []
  session_prefix: feishu
  reply_timeout_ms: 300000
  max_reply_chars: 4000
  max_members: 8
```

```bash
vessel --feishu            # TTY：REPL + 渠道；非 TTY：仅渠道前台
vessel --serve --feishu    # gateway + 渠道
```

- session 固定 `feishu:<chat_id>`；同一 chat 串行，不同 chat 并行；单 chat 队列上限 10。
- 只处理文本；忽略机器人自己、非文本、重复 `message_id`；超长回复截断并追加 `…(truncated)`。
- `app_secret` 永不打印，`app_id` 只显示前 4 位 + `***`；`feishu.agent_id` 已删除。
- 已知错误码：`channel_disabled` / `channel_not_connected` / `channel_auth_failed`。

## 可观测性

```yaml
observability:
  event_history: 1000        # 缺省 1000；显式 0 = 不限制；>0 = 环形缓冲
  metrics: true              # 块存在时才注入 metrics
```

- `MetricsCollector` 聚合 `runs` / `tool_calls` / `llm` / `duration_ms`；进程内、不持久化。
- `runs.cancelled` 保持 0，取消计入 `runs.failed`；resume 不计 `runs.started`。
- `pruneRuns(store, opts?)` 是显式 helper：按 `status` / `older_than_ms` / `keep_latest` 清理，
  不自动调度，不修改 `RunStore` 接口。
- gateway `GET /v1/metrics`；TUI `/metrics`；慢客户端丢事件并标记 `gap`，4 MiB 硬断开。

## 数据、trace 与租户

- 默认数据根 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；每个 tenant 在 `tenants/<id>/` 下独立存放 `sessions/`、`runs/`、`events/` 与 `tenant.json`。
- 默认 `session.backend: file`；sqlite 仍可用。旧 `.vessel/sessions.db` 不会自动迁移：先跑 `vessel migrate --from sqlite --to file-v2`（默认 dry-run），确认后加 `--apply`。详见 [MIGRATION.md](docs/operations/MIGRATION.md)。
- trace 默认开启 `full`，按 30 天 / 1000 runs / 1 GiB prune；`metadata` 只留计数与状态。详见 [TRACE.md](docs/operations/TRACE.md)。
- tenant 解析：`--tenant` > `VESSEL_TENANT` > `tenant.default` > `default`；gateway 用 `serve.tokens` 发放 tenant token，`serve.token` 仅 0.4 兼容。隔离覆盖存储、配置、工具、权限、quota、trace 与 RPC。
- 配置：`config path|init|show`；优先级 `CLI > env > tenant overlay > project > user > default`。详见 [CONFIG.md](docs/operations/CONFIG.md)。
- run checkpoint / eval 报告 / 飞书回复不做脱敏；redactor 只降低泄漏面。

## Web 控制台

`--serve` 启动本地 gateway（默认端口 8642），浏览器控制台通过 `vessel.gateway/1` 连接。

```bash
VESSEL_MOCK=1 vessel --serve 8642   # 终端打印 token
cd apps/web && npm run dev                       # 开发：http://127.0.0.1:5173
cd apps/web && npm ci && npm run build           # 生产：gateway 同源托管 dist
```

- 打开控制台后把终端里的 token 粘到 URL fragment（`#token=...`）；token 随后转入 `sessionStorage`，不写 `localStorage`、不进 URL query。
- 可用 `VESSEL_GATEWAY_TOKEN` 固定 token；优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。未设置时每次启动自动生成。
- 功能：运行提交/取消、事件时间线、会话列表、工具列表、权限弹窗、ask_user 表单；按 `hello.features` 显示 MCP server / interrupted run / workflow / metrics / 飞书面板。
- 助手文本 Markdown 渲染（代码块 / 列表 / 表格 / 链接）；`sessions.search` 服务端全文检索（返回 snippet，前端 150ms 防抖并保留本地过滤兜底）；`tool.call.started` 带 `args`、`tool.call.completed` 带 `result`（上限 8 KiB，超出截断标记），事件卡可折叠、失败默认展开。
- 协议：WS `/v1/events?since=`（`seq` 续订 / `gap`）；REST `/v1/runs`、`/v1/sessions`、`/v1/tools`、`/v1/permissions/:id`、`/v1/ask/:id`、`/v1/durable/runs`、`/v1/durable/runs/:id/resume`、`/v1/mcp/servers`、`/v1/metrics`、`/v1/workflows*`、`/v1/channels/feishu`、`/v1/evals/latest`、`/v1/team/*`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13 / §15 / §16。
- 安全默认：只绑 `127.0.0.1`，Host/Origin 校验，首帧鉴权，1 MiB 请求体上限。
- 远程 / TLS（显式 opt-in）：`--serve-host` + `--allow-remote` + `--tls-cert`/`--tls-key`，或 `serve.*` 配置；**非回环必须 token + HTTPS/WSS**，cert/key 必须成对。只做 HTTP/1.1。
- 独立前端：页面运行时可切换 gateway 地址，优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 http(s)/ws(s) origin，非回环必须 https，HTTPS 页面拒绝 http（mixed content）。跨 Origin 部署需在服务端配置 `serve.allowed_origins`（或重复使用 `--allowed-origin`），且浏览器必须信任证书。详见 [REMOTE.md](docs/operations/REMOTE.md)。
- 已知行为：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问时需替换为该机器的实际 IP / 域名（例如 `https://192.168.1.10:8642`，证书需含该 SAN）。
- 生产同源托管：CLI 会自动传 `staticDir`（`VESSEL_STATIC_DIR` 优先，否则 `apps/web/dist` 存在时使用）；开发时用 Vite proxy。
- 限制：单 runtime / 单 context，并发 1；运行与事件历史在内存，重启丢失。gateway 事件缓冲缺省 10000，慢客户端丢事件并标记 `gap`，不无界增长。

## 远程访问与跨节点 team

远程控制面与跨节点 transport 已实现；**默认仍是本机回环**，远程与跨节点都要显式配置。

```yaml
# node-b（服务端）：非回环必须 token + TLS
serve:
  hostname: 0.0.0.0
  port: 8642
  allow_remote: true
  token_env: VESSEL_GATEWAY_TOKEN
  allowed_origins:
    - https://console.example.com
  tls:
    cert_file: /etc/vessel/cert.pem
    key_file: /etc/vessel/key.pem

# node-a（远程客户端）：token + 私有 CA
connect:
  token_env: VESSEL_CONNECT_TOKEN
  ca_file: /etc/vessel/ca.pem

# node-a（父端）：静态节点表 + 跨节点 team
host:
  node_id: node-a
transport:
  kind: remote
  nodes:
    - id: node-b
      url: https://node-b.example.com:8642
      token_env: NODE_B_TOKEN
      ca_file: /etc/vessel/node-b-ca.pem
team:
  enabled: true
```

- **远程客户端**：`--connect <http(s)://origin>`（或 `VESSEL_CONNECT`）连接远端 gateway。回环允许明文；**非回环必须 HTTPS + token**。URL 只接受 origin，不能带 path/query/内嵌 token。
- **token**：优先级 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` 或 `connect.token_env`）> `connect.token`。token 不进 WS URL；WS 首帧发送 `{ kind: 'auth', token, since? }`。
- **CA**：私有 CA / 自签证书用 `--ca <pem>` 或 `connect.ca_file` 显式提供；未提供时用运行时默认信任库。浏览器不能按连接指定 CA，必须把 CA 装进系统 / 浏览器信任库。
- **服务端**：`serve.allowed_origins` 或重复 `--allowed-origin` 配置独立前端 Origin；只接受显式 http(s) origin，禁止 `*`、path、query。allowlist 命中时返回对应 CORS 头并带 `Vary: Origin`；CSP 的 `connect-src` 由 Host 与 allowlist 动态生成。
- **跨节点 team**：`transport.kind: remote` + 静态 `transport.nodes[]`；5 个 `team_*` 工具增加可选 `node`，成员地址支持 `node:agent`。`team_spawn` 用 `node` 指定目标节点；`team_status` 只传 `node` 可列出远端成员。
- **tenant 边界**：远端 tenant 由 token principal 派生；admin 可用 `--tenant` 覆盖，非 admin 指定其它 tenant 返回 `forbidden` / WS 4403。跨节点 team 控制面当前 **default/admin-only**。
- **安全收紧**：durable 端点按 principal 的 tenant 过滤并校验角色；team REST 复用 `ROLE_RANK`（GET 允许 `read`，spawn / send / cancel / close 要求 `write` / `admin`）；双向 / 网状节点丢弃 `event.node_id === 本机` 的回灌帧；远端 `team_spawn` 复用 `buildChildHost` 并传入 `memberLimits` / `memberTermination`。
- **已知限制**：跨节点无全局事件序，seq 按 `(node_id, run_id)` 解释；事件回灌按 `node:incarnation:run_id:seq` 去重（无 `run_id` 写 `-`；对端 `incarnation` 变化或 seq 回退只清该来源节点的键），消息键为 `from:id`、gateway 入站再补 tenant（`tenant:from:id`）。去重集合只在进程内，不持久化，**不宣称跨重启 exactly-once**。`request_id` 去重是进程内 Map（上限 1000、不跨重启）。`spawn` 不自动重试；`status` / `inbox` 最多一次幂等重试；结果回投失败只发 `team.transport.error`。`/health` 兜底可能把 team 端点不可用的节点显示为 healthy。没有 mDNS / 服务网格 / 自动发现 / mTLS / 全局 durable。
- 完整证书、两机配置、独立前端部署与故障排查见 [docs/operations/REMOTE.md](docs/operations/REMOTE.md)。

## 发布与更新

- 发布由 tag `v*` 触发、不由分支名触发；流程见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。0.1 ~ 0.9 均未发布，1.0 前不发布。
- 当前 `release/0.10.0` 只做发布干跑：`bun run scripts/release-dry-run.ts`。**不 tag、不 push tag、不 `npm publish`、不合并 `main`**。
- npm 分发名计划为 **`vessel-agent`**（bin 仍是 `vessel`）；**尚未发布**，因此 `npm i -g vessel-agent`、`npx vessel`、`npx vessel-agent` 当前都不可用。发布前请用 `bun link`（见快速开始）；子包 `files` / 元数据与 tarball 安装 smoke 属于 **0.10 计划**。
- **不提供独立二进制**（ADR-006）。
- `vessel update --check` 读取 Release 的 `latest.json`，只提示版本与安装命令；**不下载、不自替换**。当前仓库不生成 `latest.json`。
- 后台检查：交互 REPL 启动时每天最多一次；`update.autoCheck: false` 或 `VESSEL_NO_UPDATE_CHECK=1` 可关闭，失败静默。
- 通道：稳定版 `latest`，预发布 `beta`（`--channel` 或 `VESSEL_CHANNEL`）。

## 延后项

以下能力**尚未实现**，明确不在本期范围：

- **远程 mesh / 节点自动发现 / mTLS** —— 未实现；0.6 只支持静态节点表 + Bearer token + TLS，不做 mDNS / 服务网格 / 客户端证书。
- **跨节点 durable / 全局事件序 / 分布式锁** —— 未实现；无全局 seq、无跨机 durable、无分布式锁；workflow 仍只做本机编排。
- **workflow 可视化编辑器 / 跨机器编排** —— 未实现；workflow 定义是 YAML/JSON 文件。
- **飞书富媒体 / 卡片 / 多机器人 / OAuth** —— 未实现；只做文本、单 chat 单 session。
- **微信（公众号 / 企业微信）** —— **不做**；个人微信无官方 API。
- **per-tenant 跨节点 team** —— 未实现；跨节点 team 控制面为 default/admin-only。
- **npm 分发** —— 计划名 `vessel-agent`，尚未 publish；未发布前 `npx vessel` / `npm i -g vessel-agent` 不可用。打包与安装 smoke 属于 **0.10 计划**。
- **独立二进制 / 自替换更新** —— 不做（ADR-006 继续有效）；`vessel update` 只做版本检查与提示。
- **CLI / Web 全量本地化** —— TUI 文案已走 `t()`；CLI 的 `--help` / 错误 / 空状态 / demo banner 属于 **0.10 计划**，Web 前端未本地化。
- **版本发布** —— 0.1 ~ 0.9 均未发布；发布决定在 1。

## 文档索引

| 文档 | 作用 | 给谁看 |
|------|------|--------|
| [README.md](README.md) | 是什么 / 怎么跑 / 延后项 | 所有人，先看 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术架构：分层、循环、两个插槽、扩展模型、接口签名、事件名 | 开发者 / AI |
| [docs/adr/README.md](docs/adr/README.md) | 架构决策记录索引：每个关键选择的「为什么」（一条一文件，只追加） | 开发者 / AI |
| [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md) | 文件放哪里、路径归属、分支与发布规则 | 贡献者 / AI |
| [docs/operations/RELEASE.md](docs/operations/RELEASE.md) | 怎么发版 | 维护者 |
| [docs/operations/CI-CD.md](docs/operations/CI-CD.md) | CI / CD / 自动更新怎么跑 | 维护者 |
| [docs/operations/CONFIG.md](docs/operations/CONFIG.md) | 配置位置、优先级、tenant overlay 与密钥 | 部署者 / 维护者 |
| [docs/operations/MIGRATION.md](docs/operations/MIGRATION.md) | sqlite / file-v1 → file-v2 迁移 | 升级用户 |
| [docs/operations/TRACE.md](docs/operations/TRACE.md) | trace 留存、脱敏与重放 | 部署者 / 维护者 |
| [docs/operations/REMOTE.md](docs/operations/REMOTE.md) | 跨机器远程：证书 / CA、两机配置、独立前端、故障排查 | 部署者 / 维护者 |
| [AGENTS.md](AGENTS.md) | AI 行为约定：风格、硬规矩、怎么跑、红线 | AI 代理必读 |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
