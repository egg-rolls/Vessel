# Vessel

> 分布式蜂巢智能体框架：节点是蜂巢，Hub 让蜂巢彼此可见，Team 是按工作目录形成的蜂群，
> Agent 是个体蜂，三类信息素决定它们看到什么、对谁说话。
> 同时是一个可嵌入的 runtime + 参考 harness：极简核心，两个插槽，一个通用循环，填 Key 即跑。

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#状态)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 这是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**，也是一个**分布式蜂巢智能体框架**。

单个节点内，它保持极简：单 agent loop + 9 个接口 + 2 个插槽，能力工具只有 `bash` / `read` / `edit`，其余能力由模型自己组合。TUI / CLI / Web / Gateway 是参考 harness 外壳。

多个节点之间，它不把 Agent 当成孤立的聊天机器人：每个 Vessel 进程是一个**节点（蜂巢）**，节点内按工作目录组织 **Team（蜂群）**，Team 里的 **Agent（个体蜂）** 可以创建 / 关闭成员、定向通信、轮换身体；节点通过 **Hub** 交换目录与指针，通过地址 `<principal>@<node_id>:<team_id>` 直接投递消息。

> **当前边界**：单节点蜂群、Hub 目录、静态 peer 的跨节点定向投递已实现；自动发现、成员再派生、扩散信息素订阅、跨节点 Agent 生命周期仍在路上。完整拆分见 [能力边界](#能力边界) 与 [产品设计](docs/PRODUCT.md)。

|                  | 单体 Agent 工具            | 多 Agent 编排框架      | Vessel                                              |
| ---------------- | -------------------------- | ---------------------- | --------------------------------------------------- |
| **能力从哪来**   | 给你 50 个工具，自己挑     | 预定义节点与边         | 能力工具 `bash` / `read` / `edit`，其余由模型组合   |
| **绑谁**         | 绑一个 LLM 厂商            | 绑平台 / 框架          | 填 Key 即跑，Provider 无关，高频迭代切便宜模型      |
| **组织单位**     | 一个 Agent                 | 一张图 / 一条流程      | 节点 → Team → Agent，按工作目录形成                 |
| **通信**         | 内部消息                   | 框架内状态传递         | 定向 `send` / Team 日志 / 跨节点地址                |
| **跨机器**       | 外挂                       | 依赖平台               | Hub 目录 + 点对点 federation                        |
| **核心**         | 框架式大 core              | 编排式大 core          | 9 个接口、2 个插槽、1 个循环。MIT 开源，core 可嵌入 |

分层：`@vessel-agent/core`（运行时，可独立嵌入）+ `@vessel-agent/agent`（成员与 Team 能力）+ `@vessel-agent/config` / `@vessel-agent/permission` + `@vessel-agent/tui` / `@vessel-agent/serve` / `apps/web`（外壳）。形态上参考 Claude Code，但 Provider 无关、范式无关、开源。

## 蜂巢模型

| 概念 | 代码里的东西 | 现在能做什么 |
| --- | --- | --- |
| **节点 Node** | 一次 Vessel 进程，`node.json` 的 `node_id` + 数据目录 | 独立执行、授权、持久化；是唯一权威 |
| **Hub** | `vessel hub` 目录服务 | 配对、登记节点 / Team / 成员 / 在线状态、推送指针；不代理正文、不替节点授权 |
| **Team** | `workspace` + `team_id` + roster + 日志 + policy | 一个工作目录一个 Team（声明后按 `workspace` 匹配当前目录）；共享日志、预算、可见性 |
| **Agent** | 持久身份 + 可替换 Body | 主 Agent 可 `new` / `close` 成员；成员可 `send` / `post` / `list` / `rotate` 自己 |
| **地址** | `<principal>@<node_id>:<team_id>` | 跨节点定向投递；`principal` 是名字，不是 agent id |

Hub 让其他节点「被看见」；真正的操作仍直连节点——这是刻意的权限边界。Hub 同步目录快照与 `{node_id, team_id, request_id?, reason, ts}` 指针，不代理正文；浏览器和 CLI 要操作时仍然连节点自己的 gateway。Hub 不自动发现节点：节点用配对码加入，或由 hub 用 `vessel hub node add` 纳入；自动发现仍是未实现项。

当前蜂群的增长与分工是**显式派发**：谁做什么由主 Agent 或人决定。这里的「自组织」来自这些原语的组合，不是内建的自治规划器或任务市场。

## 三层信息素

Vessel 不把上下文当成一条不断膨胀的聊天记录，而是持续把三类信号折进语言空间：

| 层 | 是什么 | 现在怎么流动 | 状态 |
| --- | --- | --- | --- |
| **环境信息素** | 文档、代码、系统状态、命令输出 | `read` / `bash` / `edit`、`@路径` 引用、skills、`AGENTS.md` | 已实现 |
| **定向信息素** | 用户对话、工具调用、指名消息 | 当前 run 的 messages、`agent(send/post)`、Team 日志、federation 地址 | 已实现 |
| **扩散信息素** | 微小状态变化：成员加入/离开、run/工具事件；文件变化尚未观察 | 事件流、presence、Hub 目录、Web 时间线 | 部分：可观测，Agent 还不能订阅 |

**下一步是订阅。** 目标是让 Agent 用工具订阅文件 / 目录 / 事件；变化在下一个 run 开始前以 diff 注入上下文，只带上次看过之后的改动，避免同一文件被反复整读。当前没有订阅 API，Agent 只能按需重新读取。设计边界见 [产品设计](docs/PRODUCT.md)。

## 为谁

- **个人** — 只用 TUI，填 Key 即跑；一个目录就是一个 Team。
- **小团队** — 同一 Team 共享 roster、日志、预算；成员可以并行干活。
- **多机 / 多团队** — Hub 目录登记节点，按地址跨节点找人。
- **开发者** — 写 TypeScript 插件扩展能力，或把 `@vessel-agent/core` 嵌入 Slack bot / CI / 桌面 app。

## 状态

**alpha。** 1.0 前不发布：没有 tag、没有 `npm publish`、没有独立二进制；代码在 `main` 上滚动，发布决定由维护者做。当前版本、已合入能力与下一步见 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)，历史版本索引见 [docs/versions/INDEX.md](docs/versions/INDEX.md)。本文的技术行为写已合入当前分支的能力；未实现项集中列在 [能力边界](#能力边界)。

**包结构**（bun workspaces monorepo）：`@vessel-agent/core`（运行时，零 UI 依赖、可独立嵌入）、`@vessel-agent/agent`（AgentService 成员能力层）、`@vessel-agent/config`、`@vessel-agent/permission`、`@vessel-agent/tui`、`@vessel-agent/serve`，`plugins/` 下的 MCP / evals / 飞书插件，以及 `apps/web` 浏览器控制台。`@vessel-agent/core` 的 `dependencies` 保持为空。版本号以根 `package.json` 为唯一来源（`vessel --version`），文档不维护副本。

**语言**：默认 zh-CN。`VESSEL_LANG=en`（或 `ui.language: en`）切换英文；优先级 `VESSEL_LANG > ui.language > LANG > LC_ALL > zh-CN`。TUI 内可直接 `/settings language <zh-CN|en>` 切换并写回用户配置（`VESSEL_LANG` 仍最高）；TUI 界面文案走 `t()`（`packages/tui/src/i18n/`），CLI 的 `--help` / 一次性命令错误 / 默认空状态 / demo banner 也跟随同一 locale（`src/i18n/`，zh-CN / en 各 85 个 key）；技术词、命令名、错误码与命令的数据输出不翻译。Web 控制台的壳层与 Settings 已支持 zh-CN / en（语言选择在 Settings → Appearance，存 `localStorage['vessel.ui.language']`，初始跟随 `navigator.language`）；未覆盖的功能页回退中文。详见 [CONFIG.md](docs/operations/CONFIG.md)。

## 快速开始

前置：[Bun](https://bun.sh)（`bun --version` 确认可用）。**当前不通过 npm 分发**：`npm i -g vessel-agent` 尚未发布，`npx vessel` / `npx vessel-agent` 当前都不可用，请从源码运行。

```bash
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel
bun install
bun link            # 把根包的 bin 注册为全局 `vessel`
vessel --version    # 读根 package.json
```

之后本文统一用 `vessel`。不想全局链接时，在仓库根用 `bun run src/cli.ts`，参数完全相同。发布名为 `vessel-agent`（bin 仍是 `vessel`），16 个可发布子包使用 `@vessel-agent/*`；打包形态与安装解析 smoke 已实现，但**尚未发布**。

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
vessel --serve                       # 纯 serve 常驻模式（前台；gateway start 的别名）
vessel gateway start --daemon        # 后台常驻 gateway（写 PID + 日志）
vessel gateway status --json         # 运行状态（纯 JSON）
vessel gateway reload                # 热重载 plugins 与 allowed_origins（其余需重启）
vessel gateway stop                  # 停止（默认等待 10s）
vessel gateway install-service       # 注册当前平台的用户级服务
vessel --serve 8642 --serve-host 0.0.0.0 --allow-remote \
  --tls-cert cert.pem --tls-key key.pem \
  --allowed-origin https://console.example.com  # 显式远程 + TLS（非回环必须 token + TLS）
vessel --connect https://gateway.example.com:8642 \
  --connect-token "$VESSEL_CONNECT_TOKEN" --ca ./ca.pem --run "..."  # 远程客户端
vessel --resume-run                  # 列出 interrupted durable run
vessel --resume-run <runId>          # 恢复并继续
vessel eval smoke                    # 跑 eval suite（默认离线）
vessel --feishu                      # 前台运行飞书渠道（需 enabled + 凭据）
vessel --version                     # 显示版本（读根 package.json）
vessel --tools                       # 列出当前配置下的工具（不需要 Key）
vessel doctor                        # 本机配置 / 环境自检
vessel update --check                # 检查新版本（只提示）
vessel update                        # 按安装形态更新（npm / bun 全局；源码只提示）
vessel config path                   # 两个 YAML 路径 + data_dir
vessel config init                   # 生成 ~/.vessel/config.yaml 模板（不含真实密钥）
vessel config show --sources         # 合并后的脱敏配置与来源
vessel config set ui.language en     # 写用户配置 ui.language（zh-CN | en）
vessel config set ui.showReasoning true   # 显示思考过程（默认 false）
vessel config set ui.statusBars both      # 状态栏：top | bottom | both | none
vessel config set agent.cwd ~/project     # 默认工作目录（bash / read / edit）
vessel plugin list                   # 仓库 / 用户 / 项目插件目录
vessel plugin install <path>         # 安装本地插件目录
vessel tenant list                   # tenant 元数据
vessel migrate --from sqlite --to file-v2   # 默认 dry-run
vessel trace prune --dry-run         # 查看将清理的 trace
vessel --tenant acme --run "..."     # 指定 tenant
vessel --connect http://127.0.0.1:8642 --run "..."  # 走 gateway RPC（回环或远程），不取 tenant 锁
bun test                             # 在源码仓库内跑测试
```

REPL 内用 `/help` 看全部 slash 命令（`/resume` `/new` `/history` `/tools` `/plugins` `/mcp` `/runs` `/metrics` `/feishu` `/setup` `/settings` `/reload` `/clear` `/exit`）。
- `/clear` 清屏，**不清空会话上下文**；需要新会话用 `/new`。
- `/settings language <zh-CN|en>` 切换界面语言并写回用户配置 `ui.language`，立即重渲染；`VESSEL_LANG` 显式设置时仍以环境变量为准。
- `/reload` 重新加载配置文件并刷新 provider 信息；**不重扫插件目录**，新增插件需重启进程。
- 输入里的 `@路径` 会在发送前展开为注入消息，界面上以引用块显示，用户原文保持不变。
- `/details [hidden|collapsed|expanded]` 控制工具轨迹详细程度（默认 `collapsed`）；只影响当前进程，不写配置。
- 启动头显示 `VESSEL · vX`；版本由装配层注入 `ReplContext.version`，缺失时显示 `VESSEL`。
- 进入 REPL 前默认清屏（仅 TTY）；想保留终端历史时在配置里设 `ui.clearOnStart: false`。
- 状态栏：上栏显示状态、模型、context、时长与路径 + branch；运行态下栏显示权限档位、bash / 子 agent 计数、session 入口、tenant 与 queue。`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume`。显隐写回用户配置 `ui.statusBars`（YAML `status_bars: top|bottom|both|none`）；`VESSEL_STATUS_BARS` 只作启动初值。终端 `<40` 列不渲染下栏，`<18` 行默认隐藏。
- 权限确认默认一直等待应答或取消，不按时间自动失败；`Esc` / `Ctrl+C` 取消本轮并 abort。等待中的请求在 gateway 重启后视为已结束（`run_ended`）。

## 架构

**语言空间是唯一的执行面。** Vessel 做两件事：把世界折成语言（system prompt + 消息 + 工具 schema），把语言折回世界（解析 tool_calls → 执行 → 结果折回消息）。

> Kernel / Modules 分层（`Contracts ← Kernel ← Modules ← SDK ← Shells`）见 [ADR-037](docs/adr/ADR-037-modular-agent-runtime.md) 与 [docs/architecture/overview.md](docs/architecture/overview.md#layering)；本小节只描述**当前已实现**的单 agent 行为。
- **9 个接口 + 1 个循环 + 2 个插槽**：`LLMProvider` / `ContextManager` / `EventStream` / `ToolDefinition` / `SessionBackend` / `LimitChecker` / `Guardrail` / `Hook` / `Plugin` + `PluginHost`。两个插槽是**工具**（`PluginHost` 是唯一的工具注册表）与**知识**（`ContextManager`）。
- **core 不认识业务概念**：不认 skills、不认记忆、不认资产。任何要进语言空间的文本都经 `RunOptions.messages` 注入，core 只负责按序放进消息数组。

细节见 [docs/architecture/INDEX.md](docs/architecture/INDEX.md)。

## 工具集

默认运行期工具：`plugins/tools/basic-tools` 提供**能力工具** `bash` / `read` / `edit`；`packages/agent` 提供内置 `agent`（默认注册；显式 `agent.enabled: false` 关闭）；`plugins/context/doc-subscription` 提供 `subscribe`（agent 显式订阅文件；未 add 不注入）。`ask_user` 在交互 REPL（TTY）或 gateway/serve 注册，`--run` / headless / 管道不注册（`ui.askUser: false` 可关闭）。`team_*` / `delegate_task` 已删除。

**能力工具（`bash` / `read` / `edit`）—— 模型干活就靠这几个：**

| 工具   | 干什么                                                                    |
| ------ | ------------------------------------------------------------------------- |
| `bash` | 执行命令。grep / cat / ls / python / mkdir / curl / git —— 一切命令行操作 |
| `read` | 读文件，带行号，支持 `offset` / `limit`                                   |
| `edit` | 精确字符串替换写文件，`old_string` 必须唯一匹配                           |

**接缝工具 / 可选工具——装配层注册，不是能力：**

| 工具                    | 何时注册                                                                                      | 干什么                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                 | 默认注册；`agent.enabled: false` 关闭                                                         | 成员生命周期：owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`（支持 batch；成员侧只暴露 `rotate` / `post` / `send` / `list`，不能 `new` / `close`）；`send` 走统一 dispatch，入队即返回，不等待结果，`to` 也接受跨节点地址 `<principal>@<node_id>:<team_id>`；`post` 只写 Team 日志，不通知任何 Agent |
| `ask_user`              | 交互 REPL（TTY）或 gateway/serve；`--run` / headless / 管道不注册；`ui.askUser: false` 可关闭 | 向用户提问，经事件流暂停等待回答                                                                                                                                                                                                                              |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功                                                         | 外部 MCP 工具经 `PluginHost` 注册，数量随 server 动态变化                                                                                                                                                                                                     |

口径：默认 **4**（3 个能力工具 + `agent`）；显式 `agent.enabled: false` 为 **3**；交互 REPL 或 gateway/serve 默认 **5**（+`ask_user`）；交互 + `agent.enabled: false` 为 **4**；配置 MCP 后为 **3 + N 个 MCP 工具**。`--tools` 一次性命令按 headless 口径列出，并注明 `ask_user (interactive REPL / gateway only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需要实际运行/连接后，在 REPL 用 `/mcp` 或经 gateway `GET /v1/mcp/servers` 查看。

**为什么这么少？** 这是刻意的。没有 `grep` 工具、没有 file-ops——**能被 bash 组合出来的能力，就不再单开一个工具**。MCP 不是能力工具，而是把外部工具接进 `PluginHost` 的插件（ADR-039）。工具越多，模型的选错空间越大、核心越难保持小。真正的通用原语只有一个：执行命令。其余都是它的特化。

## Skills 怎么用

**skills 就是文件，不是一条加载通道。** harness 不扫描、不解析、不注入 skills —— 它只认消息。
- REPL 输入里的 `@路径` 会在发送前被展开：文件内容作为一条注入消息进本轮请求，界面上显示为引用块。用户原文保持不变。
- 技能就是 markdown 文件，放两个位置：仓库 [`skills/`](skills/)（**项目级**，随仓库提交、团队共享）与 `~/.vessel/skills/`（**用户级**，跨项目复用）。这是**约定**——代码里没有任何地方硬编码这两个路径。
- 引用方式：`@skills/code-writing.md`。

同一机制可用于引用任何文件：附件、项目约定、上下文材料。**前端负责查找与引用，core 只收消息。**

## MCP 怎么用

MCP 是**插件**（`@vessel-agent/mcp-client`），不是 core 模块。在 `vessel.yaml` 里配置 `mcp_servers`，server 的工具会经 `PluginHost` 注册给模型：

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
      Authorization_env: MCP_AUTH_TOKEN # 读环境变量 MCP_AUTH_TOKEN 作为 Authorization 头
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
  backend: file # file | memory
  path: ~/.vessel/runs
  checkpoint_every: iteration
```

- 进程崩溃或中断后：`--resume-run` 列出 interrupted run，`--resume-run <runId>` 恢复；
  REPL 内用 `/runs` 与 `/runs resume <runId>`。
- 只支持本机 file / memory；不做跨机器恢复、分布式锁、跨进程并发写协调。
- resume 并发守卫是 per-Host / per-store-instance；多 Host 共享同一 `FileRunStore` 或跨进程同时恢复同一 run 属部署错误。
- 已知错误码：`run_not_found` / `run_not_resumable` / `run_already_running` / `run_store_required` / `agent_not_found`。
- `/v1/durable/*` 接收 token principal；list 按 tenant 过滤（非 default tenant 无独立 store → `forbidden`）；resume 要求 `write` 及以上角色。

## Evals 怎么用

Evals 是**插件 + 运行器**（`@vessel-agent/evals`），**默认完全离线**，使用脚本化 mock provider：

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
- 报告由 `@vessel-agent/evals/report.ts` 写盘，文件名 `<suite>-<YYYYMMDDTHHmmssSSSZ>.json`；
  `GET /v1/evals/latest` 只读最近一次报告。
- 退出码：0 全部通过；1 存在 failed/error；2 配置/解析错误。

## 飞书怎么用

飞书是**插件**（`@vessel-agent/feishu`），使用官方 SDK 的 WebSocket 长连接，只做文本：

```yaml
feishu:
  enabled: true
  app_id: "" # 或 VESSEL_FEISHU_APP_ID
  app_secret: "" # 或 VESSEL_FEISHU_APP_SECRET
  domain: feishu # feishu | lark
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
  event_history: 1000 # 缺省 1000；显式 0 = 不限制；>0 = 环形缓冲
  metrics: true # 块存在时才注入 metrics
```

- `MetricsCollector` 聚合 `runs` / `tool_calls` / `llm` / `duration_ms`；进程内、不持久化。
- `runs.cancelled` 保持 0，取消计入 `runs.failed`；resume 不计 `runs.started`。
- `pruneRuns(store, opts?)` 是显式 helper：按 `status` / `older_than_ms` / `keep_latest` 清理，
  不自动调度，不修改 `RunStore` 接口。
- gateway `GET /v1/metrics`；TUI `/metrics`；慢客户端丢事件并标记 `gap`，4 MiB 硬断开。

## 数据、trace 与租户

- 默认数据根 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；每个 tenant 在 `tenants/<id>/` 下独立存放 `sessions/`、`runs/`、`events/` 与 `tenant.json`。gateway 的权限交互记录写在数据根下的 `interactions-<tenant>.json`（`0600` 原子写，含 `pending` / `answered` / `orphaned`）。
- 默认 `session.backend: file`；sqlite 仍可用。旧 `.vessel/sessions.db` 不会自动迁移：先跑 `vessel migrate --from sqlite --to file-v2`（默认 dry-run），确认后加 `--apply`。详见 [MIGRATION.md](docs/operations/MIGRATION.md)。
- trace 默认开启 `full`，按 30 天 / 1000 runs / 1 GiB prune；`metadata` 只留计数与状态。详见 [TRACE.md](docs/operations/TRACE.md)。
- tenant 解析：`--tenant` > `VESSEL_TENANT` > `tenant.default` > `default`；gateway 用 `serve.tokens` 发放 tenant token，`serve.token` 仅作旧配置兼容。隔离覆盖存储、配置、工具、权限、quota、trace 与 RPC。
- 配置：`config path|init|show`；优先级 `CLI > env > tenant overlay > project > user > default`。详见 [CONFIG.md](docs/operations/CONFIG.md)。
- run checkpoint / eval 报告 / 飞书回复不做脱敏；redactor 只降低泄漏面。

## Web 控制台

`--serve` 启动本地 gateway（默认端口 8642），浏览器控制台通过 `vessel.gateway/1` 连接。常驻部署统一走 `vessel gateway`；`--serve` 保留为前台别名。

```bash
VESSEL_MOCK=1 vessel --serve 8642   # 终端打印 token（前台）
vessel gateway start --daemon       # 后台常驻，PID + 日志在 data_dir
vessel gateway status               # 查看 PID / 地址 / uptime / 服务注册
cd apps/web && npm run dev                       # 开发：http://127.0.0.1:5173
cd apps/web && npm ci && npm run build           # 生产：gateway 同源托管 dist
```

- 打开控制台后把终端里的 token 粘到 URL fragment（`#token=...`）；token 随后转入 `sessionStorage`，不写 `localStorage`、不进 URL query。
- 可用 `VESSEL_GATEWAY_TOKEN` 固定 token；优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。未设置时每次启动自动生成。
- 功能：运行提交/取消、事件时间线、会话列表、工具列表、run 内联权限卡片、ask_user 表单、Team 列表 / 群聊 / 成员侧栏 / `@` 补全 / Body 历史；按 `hello.features` 显示 MCP server / interrupted run / metrics / 飞书面板。
- 权限卡片内联在所属 run 卡片中，跨 session 的待处理请求由顶部条提示；其他端应答 / 过期 / run 结束会自动收起。权限等待默认不超时，应答返回 `expired` 表示已过期，`run_ended` 表示 run 已结束；`not_found` 仅表示请求从未存在。`ask_user` 内联在所属 run 卡片中，默认无限等待，由应答 / abort / run 终态收口；跨 session 的待处理条同时汇总权限与提问。工具卡与思考气泡按 Codex 式分区展示，`ui.verbosity: minimal|normal|debug` 控制信息层级（默认 `normal`）。`ui.showReasoning: true` 时思考过程折叠显示（默认关闭）。
- 助手文本 Markdown 渲染（代码块 / 列表 / 表格 / 链接）；`sessions.search` 服务端全文检索（返回 snippet，前端 150ms 防抖并保留本地过滤兜底）；`tool.call.started` 带 `args`、`tool.call.completed` 带 `result`（上限 8 KiB，超出截断标记），事件卡可折叠、失败默认展开。
- 协议：WS `/v1/events?since=`（`seq` 续订 / `gap`）；REST `/v1/runs`、`/v1/sessions`、`/v1/tools`、`/v1/permissions/:id`、`/v1/ask/:id`、`/v1/durable/runs`、`/v1/durable/runs/:id/resume`、`/v1/mcp/servers`、`/v1/metrics`、`/v1/channels/feishu`、`/v1/evals/latest`、`/v1/hub/*`（hub 控制面）。canonical RPC 见 [gateway-rpc](docs/architecture/gateway-rpc.md#rpc-methods)，Team / Hub / Web Team 见 [0.19.0](docs/versions/0.19.0.md)、[REMOTE](docs/operations/REMOTE.md) 与 [WEB-UI](docs/WEB-UI.md)。
- 安全默认：只绑 `127.0.0.1`，Host/Origin 校验，首帧鉴权，1 MiB 请求体上限。
- 远程 / TLS（显式 opt-in）：`--serve-host` + `--allow-remote` + `--tls-cert`/`--tls-key`，或 `serve.*` 配置；**非回环必须 token + HTTPS/WSS**，cert/key 必须成对。只做 HTTP/1.1。
- 独立前端：页面运行时可切换 gateway 地址，优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 http(s)/ws(s) origin，非回环必须 https，HTTPS 页面拒绝 http（mixed content）。跨 Origin 部署需在服务端配置 `serve.allowed_origins`（或重复使用 `--allowed-origin`），且浏览器必须信任证书。详见 [REMOTE.md](docs/operations/REMOTE.md)。
- 已知行为：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问时需替换为该机器的实际 IP / 域名（例如 `https://192.168.1.10:8642`，证书需含该 SAN）。
- 生产同源托管：CLI 会自动传 `staticDir`（`VESSEL_STATIC_DIR` 优先，否则 `apps/web/dist` 存在时使用）；开发时用 Vite proxy。
- 限制：单 runtime / 单 context，并发 1；运行与事件历史在内存，重启丢失。gateway 事件缓冲缺省 10000，慢客户端丢事件并标记 `gap`，不无界增长。

## 节点、Hub 与跨节点 Team

一个 Vessel 进程 = 一个节点。Hub 只做目录与指针；真正的消息走节点到节点的 federation。远程控制面与跨节点 transport 已实现；**默认仍是本机回环**，远程与跨节点都要显式配置。

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

# node-a（父端）：节点身份；transport.kind 只剩 in-process
host:
  node_id: node-a
transport:
  kind: in-process
```

- **远程客户端**：`--connect <http(s)://origin>`（或 `VESSEL_CONNECT`）连接远端 gateway。回环允许明文；**非回环必须 HTTPS + token**。URL 只接受 origin，不能带 path/query/内嵌 token。
- **token**：优先级 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` 或 `connect.token_env`）> `connect.token`。token 不进 WS URL；WS 首帧发送 `{ kind: 'auth', token, since? }`。
- **CA**：私有 CA / 自签证书用 `--ca <pem>` 或 `connect.ca_file` 显式提供；未提供时用运行时默认信任库。浏览器不能按连接指定 CA，必须把 CA 装进系统 / 浏览器信任库。
- **服务端**：`serve.allowed_origins` 或重复 `--allowed-origin` 配置独立前端 Origin；只接受显式 http(s) origin，禁止 `*`、path、query。allowlist 命中时返回对应 CORS 头并带 `Vary: Origin`；CSP 的 `connect-src` 由 Host 与 allowlist 动态生成。
- **跨节点 team**：legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除；跨节点投递只走 federation（`POST /v1/federation/messages`）。canonical `teams.*` 是本地 Team。
- **Hub 目录**：`vessel hub start` 启动独立前台目录进程；节点用 `vessel hub pair` 生成一次性配对码，hub 用 `vessel hub node add <url> --code <CODE>` 纳入。hub 同步目录快照与 `{node_id, team_id, request_id?, reason, ts}` 指针，**不代理正文**；浏览器仍需直连节点。支持 hub → node 拨号与 node → hub 出站（NAT）：hub `vessel hub join-code`、节点 `vessel hub join <hub-url> --code`。跨节点 A2A 未实现。配置见 [CONFIG.md](docs/operations/CONFIG.md) §2.13。
- **tenant 边界**：远端 tenant 由 token principal 派生；admin 可用 `--tenant` 覆盖，非 admin 指定其它 tenant 返回 `forbidden` / WS 4403。
- **安全收紧**：durable 端点按 principal 的 tenant 过滤并校验角色。
- **已知限制**：跨节点 agent transport 已删除，跨节点投递只有 federation；没有 mDNS / 服务网格 / 自动发现 / mTLS / 全局 durable。
- 完整证书、两机配置、独立前端部署与故障排查见 [docs/operations/REMOTE.md](docs/operations/REMOTE.md)。

## 发布与更新

- 发布由 tag `v*` 触发、不由分支名触发；流程见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。1.0 前不发布：当前版本只在 `main` 上滚动，不 tag、不 publish。
- 当前版本只做发布干跑：`bun run scripts/release-dry-run.ts`，并跑安装解析 smoke：`bun run scripts/smoke-install.ts`。**不 tag、不 push tag、不 `npm publish`**。
- npm 分发名为 **`vessel-agent`**（bin 仍是 `vessel`），16 个可发布子包使用 **`@vessel-agent/*`** scope；**尚未发布**，因此 `npm i -g vessel-agent`、`npx vessel`、`npx vessel-agent` 当前都不可用。发布前请用 `bun link`（见快速开始）。子包带 `files: ["src"]` 与 `license` / `repository` / `engines`，根包排除 `node_modules` 并包含 `apps/web/dist`；tarball 安装 smoke 按 `@vessel-agent/*` 覆盖安装（POSIX / Node 22，Windows 跳过）。
- **不提供独立二进制**（ADR-006）。
- `vessel update --check` 读取 Release 的 `latest.json`，只提示版本与安装命令；当前仓库不生成 `latest.json`。
- `vessel update`（不带 `--check`）按安装形态自更新：npm 全局 `npm i -g vessel-agent@latest`，bun 全局 `bun add -g vessel-agent@latest`；源码 / 开发模式只提示 `git pull && bun install`，不改工作区。默认确认，`--yes` 跳过；非 TTY 且无 `--yes` 直接失败。
- 后台检查：交互 REPL 启动时每天最多一次；`update.autoCheck: false` 或 `VESSEL_NO_UPDATE_CHECK=1` 可关闭，失败静默。
- 通道：稳定版 `latest`，预发布 `beta`（`--channel` 或 `VESSEL_CHANNEL`）。

## 能力边界

### 已实现

- **单节点 Agent 生命周期**：`new` / `send` / `close` / `list` / `rotate` / `post`。主 Agent 可创建、关闭成员；成员 Body 可发送、写 Team 日志、轮换自己。
- **Team**：声明后按工作目录匹配，一个工作目录一个 Team；roster、共享日志、预算、可见性、`@` 投递。
- **Hub 目录**：配对、节点 / Team / 成员 / 在线状态、指针；支持 hub → node 拨号与 node → hub 出站（NAT）。
- **跨节点定向投递**：静态 peer allowlist + `<principal>@<node_id>:<team_id>` 地址 + 回复；每 peer 限流、去重、hop 上界。
- **远程控制面**：`--connect`、Web 控制台、TLS / token、独立前端。

### 部分实现

- **发现**：本机 roster 用 `agent(list)`；跨节点用 `vessel federation team-info`（opt-in）或 Hub 目录，也可以经 `bash` 调 CLI。没有一等公民的 Agent 发现工具。
- **扩散信息素**：事件流与 Web 可看；Agent 侧没有订阅接口。

### 未实现（方向）

- 成员 Agent 再派生 Agent（当前只有 owner 能 `new` / `close`）；跨节点 spawn / close / rotate / resume。
- 扩散信息素订阅：文件 / 目录 / 事件 diff 在下一个 run 前注入。

### 未实现（暂不承诺）

- 自动发现 / mesh / 中继 / 离线队列 / 跨重启 exactly-once。
- A2A 协议兼容。
- 多 tenant federation：当前跨节点 Team 控制面为 default / admin-only。
- 自治调度：自动分工、任务市场。

### 明确不做

- mDNS / 服务网格 / mTLS / 客户端证书等自动网络发现与强身份。
- 飞书富媒体 / 卡片 / 多机器人 / OAuth；微信（个人微信无官方 API）。
- 独立二进制 / 二进制自替换更新（ADR-006 继续有效）；`vessel update` 只对 npm / bun 全局安装执行包级更新。
- Web 全量本地化：壳层已支持 zh-CN / en，功能页未覆盖文案回退中文，不能宣称全量本地化。
- 1.0 前不 tag、不 publish；发布决定由维护者做。

### 分发

根包名 `vessel-agent`，子包 scope `@vessel-agent/*`，**尚未 publish**；未发布前 `npx vessel` / `npm i -g vessel-agent` 不可用。打包与安装 smoke 已按新 scope 验证，发布决定由维护者做。

## 文档索引

| 文档                                                         | 作用                                                             | 给谁看          |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------- |
| [README.md](README.md)                                       | 是什么 / 怎么跑 / 能力边界                                       | 所有人，先看    |
| [docs/PRODUCT.md](docs/PRODUCT.md)                           | 产品概念模型：蜂巢、三层信息素、现状与方向                       | 所有人          |
| [docs/architecture/INDEX.md](docs/architecture/INDEX.md)     | 技术架构：模块索引（分层、循环、接口、扩展、事件、Gateway）      | 开发者 / AI     |
| [docs/adr/README.md](docs/adr/README.md)                     | 架构决策记录索引：每个关键选择的「为什么」（一条一文件，只追加） | 开发者 / AI     |
| [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)           | 文件放哪里、路径归属、分支与发布规则                             | 贡献者 / AI     |
| [docs/operations/RELEASE.md](docs/operations/RELEASE.md)     | 怎么发版                                                         | 维护者          |
| [docs/operations/CI-CD.md](docs/operations/CI-CD.md)         | CI / CD / 自动更新怎么跑                                         | 维护者          |
| [docs/operations/CONFIG.md](docs/operations/CONFIG.md)       | 配置位置、优先级、tenant overlay 与密钥                          | 部署者 / 维护者 |
| [docs/operations/MIGRATION.md](docs/operations/MIGRATION.md) | sqlite / file-v1 → file-v2 迁移                                  | 升级用户        |
| [docs/operations/TRACE.md](docs/operations/TRACE.md)         | trace 留存、脱敏与重放                                           | 部署者 / 维护者 |
| [docs/operations/REMOTE.md](docs/operations/REMOTE.md)       | 跨机器远程：证书 / CA、两机配置、独立前端、故障排查              | 部署者 / 维护者 |
| [AGENTS.md](AGENTS.md)                                       | AI 行为约定：风格、硬规矩、怎么跑、红线                          | AI 代理必读     |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
