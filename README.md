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

**alpha。0.5 已实现（`release/0.5`）；0.6 的 F5 跨机器远程 / 跨节点 team 已合入 `release/0.6`；均未发布。**

**0.2 状态：** 多 agent Kernel（Host / Scheduler / Transport）与模块 subpath exports **已实现**（`release/0.2`，**未随版本发布**）；`AgentRuntime` 仍是单 agent loop，Host 只包在它外面，不重写循环。边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §14 与 [ADR-037](docs/adr/ADR-037-modular-agent-runtime.md)。

**0.3 状态：** durable run、MCP 插件、远程监听 / TLS **已实现**（`release/0.3`，**未随版本发布**）；默认行为与 0.2 一致，新能力全部 opt-in 或默认关闭。决策边界见 [ADR-039](docs/adr/ADR-039-mcp-client-as-plugin.md) / [ADR-040](docs/adr/ADR-040-durable-run-store-checkpoint-resume.md) / [ADR-041](docs/adr/ADR-041-remote-listen-and-tls.md)。

**0.4 状态：** workflow 编排、evals harness、飞书渠道、metrics / 事件历史 / pruneRuns **已实现**（`release/0.4`，**未随版本发布**）；三个能力全部是插件、默认关闭，四个新配置块缺省时行为与 0.3 一致。决策边界见 [ADR-042](docs/adr/ADR-042-workflow-engine-as-plugin.md) / [ADR-043](docs/adr/ADR-043-evals-harness-offline.md) / [ADR-044](docs/adr/ADR-044-feishu-channel-plugin.md) / [ADR-045](docs/adr/ADR-045-0-4-observability-and-stability.md)。0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布；**0.4 只做发布干跑，不 tag、不 publish、不合并 `main`**。

**0.5 状态：** 文件优先存储、trace、统一 RPC 方法表 v1.1、多租户、YAML 主配置 **已实现**（`release/0.5`，**未随版本发布**）；默认 `session.backend: file`，trace 默认 `full`（30 天 / 1000 runs / 1 GiB），tenant 缺省 `default`。插件 tenant 行为与 `--serve` 每 tenant 独立执行面（runtime / PluginHost / session / trace / 锁）**已实现**；gateway 的 workflow / 飞书控制面仍只走 default tenant。F5 跨机器远程见 0.6 状态；微信不做。决策边界见 [ADR-046](docs/adr/ADR-046-file-first-storage.md) / [ADR-047](docs/adr/ADR-047-trace-first-observability.md) / [ADR-048](docs/adr/ADR-048-unified-rpc-method-table.md) / [ADR-049](docs/adr/ADR-049-multi-tenant-isolation.md) / [ADR-050](docs/adr/ADR-050-yaml-first-config-and-secrets.md)。

**0.6 状态：** F5 跨机器远程与跨节点调度 **已实现**（`release/0.6`，**未随版本发布**）：`--connect` 支持非回环 HTTPS + token/CA，gateway 支持 `serve.allowed_origins` 与独立前端，`transport.kind: remote` 支持静态节点、跨节点 team（`node` / `node:agent`）与按 `(node_id, seq)` 去重的事件回灌。默认仍为本机回环；跨节点 team 控制面为 default/admin-only。决策边界见 [ADR-051](docs/adr/ADR-051-remote-control-plane.md) / [ADR-052](docs/adr/ADR-052-cross-node-transport.md) / [ADR-053](docs/adr/ADR-053-remote-security-baseline.md)，运维步骤见 [REMOTE.md](docs/operations/REMOTE.md)。

**0.6.1 状态（计划中，冻结契约见 DECISION-015）：** 对标修复轮，目标是清零审计中的 2 个 P0 与全部 P1。计划内容：

- **P0 多租户会话隔离**：显式 `session.storage_path` 下 file 后端仍传 `tenantId`，`delete()` 先校验归属；跨 tenant 读取 / 删除不可见、无效果。
- **P0 durable 控制面 / P1 team REST**：`/v1/durable/*` 接收 token principal；list 按 tenant 过滤（非 default 且无 per-tenant store → `forbidden`）；resume 要求 `write`；team REST 复用 `ROLE_RANK`（GET 允许 read，spawn/send/cancel/close 要求 write/admin）。
- **CLI**：`-c/--continue`、`-r/--resume [id]`；`--run` 保留，不再占用 `-r`。
- **配置 / 插件**：`permission.autoApprove`、`plugins[].config` 传给 `install(host, { config })`、`~/.vessel/plugins` 与 `./.vessel/plugins`、`vessel plugin list|install|remove`（仅本地目录）。
- **运行时 / TUI**：可注入真实摘要、guardrail 阻断折回工具错误、provider 429/5xx 重试、bash/edit 响应取消、工具 diff / 展开、`/compact` `/context`、输入历史与排队。
- **Web**：Markdown 渲染、`sessions.search` 全文检索、工具 args/result 折叠；durable 与 team 的角色收紧同步覆盖。
- 本轮仍**不 tag、不 publish、不合并 `main`**；未合入前不把上述能力写成“已实现”。

**已落地的包**（bun workspaces monorepo）：

| 包 | 版本 | 作用 |
|---|---|---|
| **`@vessel/core`** | 0.5.0 | Agent 运行时：tool-calling loop、provider 抽象、context / session、事件流、guardrails、hooks、Kernel、durable `RunStore`、`MetricsCollector` / `pruneRuns`。**不依赖 TUI，可独立嵌入** |
| **`@vessel/tui`** | 0.5.0 | 终端界面：Ink REPL、流式渲染、slash 命令、权限确认、`/mcp`、`/runs`、`/workflows`、`/metrics`、`/feishu` |
| **`@vessel/config`** | 0.5.0 | 声明式 YAML 配置与 schema 校验（未知键报错） |
| **`@vessel/permission`** | 0.5.0 | 共享权限原语：工具经事件流等用户授权 |
| **`@vessel/serve`** | 0.5.0 | 常驻服务（gateway；loopback / 远程 / TLS；workflow / metrics / feishu / evals 端点） |
| **`@vessel/mcp-client`** | 0.5.0 | MCP client 插件：stdio + HTTP，工具经 `PluginHost` 注册 |
| **`@vessel/workflow`** | 0.5.0 | workflow 插件：声明式 DAG（agent / tool steps）、持久化、resume、CLI/TUI/gateway 控制面 |
| **`@vessel/evals`** | 0.5.0 | eval harness：默认离线、mock provider、断言白名单、JSON 报告 |
| **`@vessel/feishu`** | 0.5.0 | 飞书渠道插件：WebSocket 长连接、文本单 chat 单 session、专用 Host |
| `apps/web` | 0.5.0 | 浏览器控制台：时间线、运行取消、权限弹窗、ask_user、MCP / interrupted run / workflow / metrics / 飞书面板（`vessel.gateway/1`） |

- CI：`.github/workflows/ci.yml`（质量门禁、跨平台矩阵、web 构建、examples 类型检查、MCP/TLS/workflow/evals/feishu 离线集成、0.6 multi-node / tls-ca / frontend-cors 专项 job、发布干跑、mock 冒烟）。
- ⚠️ **0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布**：库包版本为 `0.4.0`，发布流程已就绪；当前请从源码运行。0.4 只做发布干跑。

## 快速开始

前置：[Bun](https://bun.sh)（`bun --version` 确认可用）。

```bash
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel
bun install
```

### ① 先跑起来看看（**不需要 API Key**）

```bash
VESSEL_MOCK=1 bun run src/cli.ts
```

`VESSEL_MOCK=1` 是**模拟模式**：不调真实模型，用本地模拟响应把整条链路跑通 —— **没有 Key 也能完整体验对话、工具调用、流式渲染与会话管理。**

### ② 接入真实模型

```bash
bun run src/cli.ts
```

首次启动走**引导向导**，填 API 地址、Key、选模型，保存到 `~/.vessel/config.yaml`，之后无需重填。

> **thinking 模型**（DeepSeek 等）：`reasoning_content` 会随 assistant 消息保存并在下一轮请求回传（工具调用轮次也保留）；TUI / 事件流不展示思维链。详见 [ADR-038](docs/adr/ADR-038-thinking-reasoning-content.md)。

### ③ 其它常用命令

```bash
bun run src/cli.ts --run "帮我写个冒泡排序"      # 一次性执行后退出（适合脚本）
bun run src/cli.ts --run @prompt.md            # 从文件读 prompt（.json = 多轮 seeding）
echo "翻译这句话" | bun run src/cli.ts --run    # 从管道读输入
bun run src/cli.ts --session <id> --run "..."   # 续接指定会话
bun run src/cli.ts -c                           # 0.6.1 计划：继续最近会话（-c/--continue）
bun run src/cli.ts -r <id>                      # 0.6.1 计划：恢复指定会话（-r/--resume [id]）
bun run src/cli.ts --serve                      # 纯 serve 常驻模式（不进 REPL）
bun run src/cli.ts --serve 8642 --serve-host 0.0.0.0 --allow-remote \
  --tls-cert cert.pem --tls-key key.pem \
  --allowed-origin https://console.example.com  # 显式远程 + TLS（非回环必须 token + TLS）
bun run src/cli.ts --connect https://gateway.example.com:8642 \
  --connect-token "$VESSEL_CONNECT_TOKEN" --ca ./ca.pem --run "..."  # 远程客户端
bun run src/cli.ts --resume-run                 # 列出 interrupted durable run
bun run src/cli.ts --resume-run <runId>         # 恢复并继续
bun run src/cli.ts workflow run release-check   # 跑 workflow（定义在 workflow.dir）
bun run src/cli.ts workflow list                # 列出 workflow run
bun run src/cli.ts eval smoke                   # 跑 eval suite（默认离线）
bun run src/cli.ts --feishu                     # 前台运行飞书渠道（需 enabled + 凭据）
bun run src/cli.ts --version                    # 显示版本（读根 package.json）
bun run src/cli.ts --tools                      # 列出当前配置下的工具（不需要 Key）
bun run src/cli.ts update --check               # 检查新版本（只提示，不自替换）
bun run src/cli.ts config path                  # 两个 YAML 路径 + data_dir
bun run src/cli.ts config init                  # 生成 ~/.vessel/config.yaml 模板（不含真实密钥）
bun run src/cli.ts config show --sources        # 合并后的脱敏配置与来源
bun run src/cli.ts plugin list                  # 0.6.1 计划：仓库 / 用户 / 项目插件目录
bun run src/cli.ts plugin install <path>        # 0.6.1 计划：安装本地插件目录
bun run src/cli.ts tenant list                  # tenant 元数据
bun run src/cli.ts migrate --from sqlite --to file-v2   # 默认 dry-run
bun run src/cli.ts trace prune --dry-run        # 查看将清理的 trace
bun run src/cli.ts --tenant acme --run "..."    # 指定 tenant
bun run src/cli.ts --connect http://127.0.0.1:8642 --run "..."  # 走 gateway RPC（回环或远程），不取 tenant 锁
bun test                                        # 跑测试
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
      Authorization: "Bearer ${TOKEN}"
```

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
- **0.6.1 计划**：`/v1/durable/*` 接收 token principal；list 按 tenant 过滤（非 default tenant 无独立 store → `forbidden`）；resume 要求 `write` 及以上角色。

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
bun run src/cli.ts workflow run release-check --input repo=vessel
bun run src/cli.ts workflow list --status failed
bun run src/cli.ts workflow show <workflowRunId>
bun run src/cli.ts workflow resume <workflowRunId>
bun run src/cli.ts workflow cancel <workflowRunId>
```

- 入口只有 CLI / TUI `/workflows` / gateway；**不注册模型工具**，模型不能触发任意路径的定义。
- `resume` 会重跑 `running` / `pending` / `failed` 步骤，**不保证幂等**，重跑可能重复副作用。
- `type: tool` 直接调 handler，绕过 runtime 的 guardrail / hook；需要 guardrail 的步骤用 `type: agent`。
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
bun run src/cli.ts eval smoke
bun run src/cli.ts eval smoke --json
bun run src/cli.ts eval smoke --out ./report.json
bun run src/cli.ts eval smoke --allow-network   # 还需 evals.allowNetwork: true
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
bun run src/cli.ts --feishu            # TTY：REPL + 渠道；非 TTY：仅渠道前台
bun run src/cli.ts --serve --feishu    # gateway + 渠道
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

## 数据、trace 与租户（0.5）

- 默认数据根 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；每个 tenant 在 `tenants/<id>/` 下独立存放 `sessions/`、`runs/`、`events/` 与 `tenant.json`。
- 默认 `session.backend: file`；sqlite 仍可用。旧 `.vessel/sessions.db` 不会自动迁移：先跑 `vessel migrate --from sqlite --to file-v2`（默认 dry-run），确认后加 `--apply`。详见 [MIGRATION.md](docs/operations/MIGRATION.md)。
- trace 默认开启 `full`，按 30 天 / 1000 runs / 1 GiB prune；`metadata` 只留计数与状态。详见 [TRACE.md](docs/operations/TRACE.md)。
- tenant 解析：`--tenant` > `VESSEL_TENANT` > `tenant.default` > `default`；gateway 用 `serve.tokens` 发放 tenant token，`serve.token` 仅 0.4 兼容。隔离覆盖存储、配置、工具、权限、quota、trace 与 RPC。
- 配置：`config path|init|show`；优先级 `CLI > env > tenant overlay > project > user > default`。详见 [CONFIG.md](docs/operations/CONFIG.md)。
- 0.5 不脱敏 run checkpoint / eval 报告 / 飞书回复；redactor 只降低泄漏面。

## Web 控制台

`--serve` 启动本地 gateway（默认端口 8642），浏览器控制台通过 `vessel.gateway/1` 连接。

```bash
VESSEL_MOCK=1 bun run src/cli.ts --serve 8642   # 终端打印 token
cd apps/web && npm run dev                       # 开发：http://127.0.0.1:5173
cd apps/web && npm ci && npm run build           # 生产：gateway 同源托管 dist
```

- 打开控制台后把终端里的 token 粘到 URL fragment（`#token=...`）；token 随后转入 `sessionStorage`，不写 `localStorage`、不进 URL query。
- 可用 `VESSEL_GATEWAY_TOKEN` 固定 token；优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。未设置时每次启动自动生成。
- 功能：运行提交/取消、事件时间线、会话列表、工具列表、权限弹窗、ask_user 表单；按 `hello.features` 显示 MCP server / interrupted run / workflow / metrics / 飞书面板（0.4）。
- **0.6.1 计划**：助手文本 Markdown 渲染（代码块 / 列表 / 表格 / 链接）；`sessions.search` 服务端全文检索（返回 snippet，前端 150ms 防抖并保留本地过滤兜底）；`tool.call.started` 带 `args`、`tool.call.completed` 带 `result`（上限 8 KiB，超出截断标记），事件卡可折叠、失败默认展开。
- 协议：WS `/v1/events?since=`（`seq` 续订 / `gap`）；REST `/v1/runs`、`/v1/sessions`、`/v1/tools`、`/v1/permissions/:id`、`/v1/ask/:id`、`/v1/durable/runs`、`/v1/durable/runs/:id/resume`、`/v1/mcp/servers`、`/v1/metrics`、`/v1/workflows*`、`/v1/channels/feishu`、`/v1/evals/latest`、`/v1/team/*`（0.6）。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13 / §15 / §16。
- 安全默认：只绑 `127.0.0.1`，Host/Origin 校验，首帧鉴权，1 MiB 请求体上限。
- 远程 / TLS（显式 opt-in）：`--serve-host` + `--allow-remote` + `--tls-cert`/`--tls-key`，或 `serve.*` 配置；**非回环必须 token + HTTPS/WSS**，cert/key 必须成对。只做 HTTP/1.1。
- 独立前端（0.6）：页面运行时可切换 gateway 地址，优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 http(s)/ws(s) origin，非回环必须 https，HTTPS 页面拒绝 http（mixed content）。跨 Origin 部署需在服务端配置 `serve.allowed_origins`（或重复使用 `--allowed-origin`），且浏览器必须信任证书。详见 [REMOTE.md](docs/operations/REMOTE.md)。
- 已知行为：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问时需替换为该机器的实际 IP / 域名（例如 `https://192.168.1.10:8642`，证书需含该 SAN）。
- 生产同源托管：CLI 会自动传 `staticDir`（`VESSEL_STATIC_DIR` 优先，否则 `apps/web/dist` 存在时使用）；开发时用 Vite proxy。
- 限制：单 runtime / 单 context，并发 1；运行与事件历史在内存，重启丢失。0.4 gateway 事件缓冲缺省 10000，慢客户端丢事件并标记 `gap`，不无界增长。

## 远程访问与跨节点 team（0.6）

0.6 的 F5 已实现远程控制面与跨节点 transport；**默认仍是本机回环**，远程与跨节点都要显式配置。

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
- **0.6.1 计划（安全收紧）**：durable 端点按 principal 的 tenant 过滤并校验角色；team REST 复用 `ROLE_RANK`（GET 允许 `read`，spawn / send / cancel / close 要求 `write` / `admin`）；双向 / 网状节点丢弃 `event.node_id === 本机` 的回灌帧；远端 `team_spawn` 复用 `buildChildHost` 并传入 `memberLimits` / `memberTermination`。
- **已知限制**：跨节点无全局事件序，seq 按 `(node_id, run_id)` 解释；事件回灌按 `(node_id, wire seq)` 去重。`request_id` 去重是进程内 Map（上限 1000、不跨重启）。`spawn` 不自动重试；`status` / `inbox` 最多一次幂等重试；结果回投失败只发 `team.transport.error`。`/health` 兜底可能把 team 端点不可用的节点显示为 healthy。没有 mDNS / 服务网格 / 自动发现 / mTLS / 全局 durable。
- 完整证书、两机配置、独立前端部署与故障排查见 [docs/operations/REMOTE.md](docs/operations/REMOTE.md)。

## 发布与更新

- 发布由 tag `v*` 触发，流程见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。
- **0.5 / 0.6 / 0.6.1 只做发布干跑**：`bun run scripts/release-dry-run.ts`。**不 tag、不 push tag、不 `npm publish`、不合并 `main`**；发布仍等 1.0.0 之后。
- 当前可发布包包括 5 个 `@vessel/*` 库包与 13 个插件包（含 `@vessel/mcp-client`、`@vessel/workflow`、`@vessel/evals`、`@vessel/feishu`），版本均为 `0.5.0`；**根 CLI 暂不发布到 npm，`npx vessel` 当前不可用**。
- **0.6.1 计划**：打通分发闭环（根包可发布或 `@vessel/cli`、loader 扫描 `node_modules/@vessel/*`、修正 update 安装提示）；是否实际 publish 仍由用户决定。
- **不提供独立二进制**（ADR-006 继续有效）。
- 当前不生成 `latest.json`；未来发布时仍为 `version` / `channel` / `assets: {}`。
- `vessel update --check` 已实现：读取 Release 的 `latest.json`，只提示版本与安装命令；**不下载、不自替换**。
- 后台检查：交互 REPL 启动时每天最多一次；`update.autoCheck: false` 或 `VESSEL_NO_UPDATE_CHECK=1` 可关闭，失败静默。
- 通道：稳定版 `latest`，预发布 `beta`（`--channel` 或 `VESSEL_CHANNEL`）。

## 延后项

以下能力**尚未实现**，明确不在本期范围：

- **远程 mesh / 节点自动发现 / mTLS** —— 未实现；0.6 只支持静态节点表 + Bearer token + TLS，不做 mDNS / 服务网格 / 客户端证书。
- **跨节点 durable / 全局事件序 / 分布式锁** —— 未实现；0.6 无全局 seq、无跨机 durable、无分布式锁；workflow 仍只做本机编排。
- **workflow 可视化编辑器 / 跨机器编排** —— 未实现；workflow 定义是 YAML/JSON 文件。
- **飞书富媒体 / 卡片 / 多机器人 / OAuth** —— 未实现；只做文本、单 chat 单 session。
- **微信（公众号 / 企业微信）** —— **不做**；个人微信无官方 API。
- **per-tenant 跨节点 team** —— 未实现；0.6 的跨节点 team 控制面为 default/admin-only。
- **npm CLI** —— 当前只发库包与插件包，根 CLI 未发布，`npx vessel` 不可用；0.6.1 计划打通分发闭环。
- **独立二进制 / 自替换更新** —— 不做（ADR-006 继续有效）；`vessel update` 只做版本检查与提示。
- **0.1.0 / 0.2 / 0.3.0 / 0.4.0 发布** —— 均未发布；0.4 只干跑；发布决定在 1。

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
