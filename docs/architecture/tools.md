---
title: 工具与权限边界
kind: current
triggers: [tool, bash, read, edit, permission, denylist, allowed_roots, agent, ask, mcp tool]
paths: [packages/core/src/types/tool.ts, plugins/tools/**, packages/agent/**]
---

# 工具与权限边界

<a id="tool-definition"></a>

### `ToolDefinition`（`types/tool.ts`）

```ts
interface ToolContext {
  session_id?: string;
  run_id: string;
  messages: Message[];
  events: EventStream;
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** 超时毫秒数；缺省或 0 = 不限时 */
  timeout?: number;
  /** 执行时权限判定（allow/deny/ask）；缺省走 runtime 默认策略 */
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
}
```

工具是**自描述对象**：权限判定与超时随工具走，不集中在 runtime 的一张策略表里。core 里**没有 `ToolRegistry` 接口**——唯一的工具注册表是 `PluginHost` / `MemoryPluginHost`。

工具的实际执行统一走 `ToolPipeline`（ADR-058）：`getTool` → ToolCall guardrail → BeforeTool hook → 权限（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。`ToolPipelineStages` 可关闭调用方已在外层处理的阶段；`ExecutionUnit`（含 delegate 子 runtime）关闭 guardrail/BeforeTool/AfterTool，只复用 permission / handler / ToolResult。

<a id="tools"></a>

## 工具集：能力工具为什么这么少

默认运行期工具：`plugins/tools/basic-tools` 提供能力工具 **`bash` / `read` / `edit`**；`packages/agent` 提供内置 `agent`（默认注册；显式 `agent.enabled: false` 关闭）；`plugins/context/doc-subscription` 提供 `subscribe`（agent 显式订阅文件；变更只发短通知，按需 `inspect`；未 add 不通知）。成员 body 在装配层 attach 收件箱后另有 `inbox`；`ask` 按入口注册。`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `subscribe` | 默认注册（`doc-subscription` 插件）；agent 显式 add 文件后，变更只在下个 run 的系统提示里发一条短通知（path / id / rev / bytes），模型调用 `subscribe inspect` 才取 diff（首次全文）；正文不自动进历史。只接受具体文件，无 glob / 目录 / 自动发现 |
| `agent` | 默认注册；显式 `agent.enabled: false` 关闭。root owner 动作 `hire` / `send` / `close` / `list` / `rotate` / `read`（root 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `send` / `list` / `read`。写 Team 日志不是本工具的职责：`agent post` 已移除（只追加日志、不投递、不唤醒，0.50 实测导致成员报告静默丢失），需要时走 CLI `vessel team post`。`create` 建同 Team peer，`hire` 建调用者拥有的 contractor；close 审批在权限层（成员关 peer 需人类批准），每 Team present 上限与冻结见 ADR-095；权限模式与成员配置见 `agent.*`。`read` 是只读会话读取（`to` + `limit` 默认 20 / 封顶 50，返回最近 N 条消息的 role + 截断正文），数据源与 `sessions.get` 同一个 `SessionStore`，不新增 RPC；收口不再自动回传正文之后，父级要成员原文用它或 `inbox` |
| `inbox` | 成员 body 由装配层 attach 收件箱后注册（`deny` 模式也注册，只读本地队列）：`list` 返回 unread / pending 计数与摘要（含 held）；`read` 取原文并消费，`includeHeld: true` 时连 held 一并返回正文但**不消费、不取消投递**（结果里带 `held: true`）；`delete` 删除未读且非 held 的消息；`insert` 给自己追加一条消息，不启动 run、不唤醒自己。`unread` = 该自己读，`pending` = 已排程、会自动作为下一轮输入送达（同一口径由 `counts()` 派生）。返回 JSON；非法参数返回 `{ error: 'invalid_input: ...' }`，不抛错 |
| `ask` | 交互 REPL、`gateway start` / `--serve` 与 headless（`--run` / 管道）都注册；`ui.askUser: false` 可关闭。两种语义见下「ask 的 sync / async」 |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：默认 root 工具面 = 能力工具 + `agent` + `subscribe`；显式 `agent.enabled: false` 去掉 `agent`；交互 REPL 或 gateway-serve 再加 `ask`；成员 body 另有 `inbox`（**节点插件面看不到它**：要看成员身体实际拿到的那一份，用 `tools.list{agent_id}` —— 响应里的 `surface` 区分「活身体实取 `live`」与「无活身体时按 spawn 同一套规则推导 `derived`」，条目上的 `source: 'member'` 标出这类成员内置工具；见 [gateway-rpc](gateway-rpc.md)）。配置 MCP 后在基础上加 MCP 工具（数量由 server 提供）。实际清单以 `bun run src/cli.ts --tools` 输出为准，本文不写死数量。`--tools` 一次性命令按 headless 口径列出，且**不连接 MCP、不展开 `ask` 与成员侧 `inbox`**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `read` | `{ path, offset?, limit? }` | `allow`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式 |
| `edit` | `{ path, old_string, new_string, replace_all? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换 |

<a id="ask-sync-async"></a>

### ask 的 sync / async

`ask` 有 `mode: 'sync' | 'async'`（缺省 `sync`）。

| | sync（缺省，旧行为一字不改） | async |
|---|---|---|
| 工具返回 | 阻塞 `waitFor` 到人类回答 | **立即返回成功**（已投放、尚无答案） |
| 本次 run | 一直等；headless / 无应答者 → 请求落盘后中断（`exit 3`，可 `--resume-run`） | 不等待、不因未批失败、不挂起；run 照常跑完 |
| 答案去哪 | 工具返回值（同一轮上下文） | 一条 **user 角色**消息进该成员 inbox（`delivery: input`）+ 起一次**新 run** |
| 谁开 run | 无（本来就在跑） | gateway / 本地 dispatcher 注入的 `askAnswerDelivery`（`AgentService.admit`） |
| 未批 | 一直 pending（无自动超时） | 一直 pending：run 终态与进程重启都**不**转 `orphaned` |

`async` 的答案必须是 user 消息而不是工具返回值：新一轮 run 只能由一条 user 消息开起来（resume 同理）。工具返回体因此必须让模型自己区分「已投放待批」（async 恒为此种）与「已被回答」（sync）。

**同批应答合并成一次 run**：待批页一次「回复」是一次人类动作 —— 那批 `ask.respond` 带同一个 `batch_id`，装配层按 `(agent, session, batch_id)` 做 250ms 短窗口合并，整批答案成为**一条** user 消息（前缀里逗号分隔多个 requestId）并只起**一次** run。没有 `batch_id` 的应答（单条应答 / `vessel attention respond` / policy）保持一次一条。答案文本每题一行 `N. header（原问题摘要）: 答案`（问题截断 120 字符），所以隔几小时回来也知道回的是哪一问。

**逐题可勾选，但 settle 是整条请求**：待批页允许只回答同一请求里的某几题（`ask.respond` 的 `answers` 数组**没有长度校验**，只带勾选且已作答的那些）；但一条 ask **一经应答即整体落定**（`settleAnswer`：`pending → answered`），未勾选的题随该请求一起收口，不能事后再补答 —— 前端因此必须在提交前把这件事写明白（`pending.submit.note`），不要让人以为「剩下几题待会儿还能答」。

回答入口：Web 待批页 / `vessel attention respond`（卡片带「异步」标记）。TUI 的答辩弹窗沿用既有规则——run 收口即关闭，所以 async 请求在 TUI 里答不了（用待批页）。

<a id="path-boundary"></a>

**路径边界（ADR-055；`edit` 同样适用）**：`read` / `edit` / `bash cwd` 先按真实路径（`realpath`；不存在的路径取最近已存在祖先）判定，`..` 与 symlink 不能绕过。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）命中即 `deny`；插件 `config.allowed_roots` 非空时越界为 `ask`，`config.deny_paths` 追加到内置列表。默认 `allowed_roots` 为空 = 不限制根。`bash` 只校验 `cwd`，命令本身仍可访问其它路径——这不是沙箱。读文件的插件（`media`）**默认继承** `basic-tools` 的 `allowed_roots` / `deny_paths`（自身配置优先，显式空数组 = 明确不限制根）：合并由装配层 `buildPluginConfigMap` 做，插件侧不重复解析配置。

**拒绝要可追溯（文案契约）**：`deny` 时工具自己返回「被路径策略拒绝（deny 目录 / denylist），不是文件不存在」，`ask` 被拒时 `PermissionPolicy` 的错误说明是**工具自己的权限判定**要求确认（`… by user (the tool's own permission check asked for confirmation)`）。两种都不复述完整路径——模型自己的入参里已经带着它，重复注入只是 token 税。

**入口处不预判边界**：路径边界只在**读写的这一刻**判。上游若把路径收进数据结构（会话消息的 `Message.refs`、订阅条目、`runs.start` 的引用），那里只做形状校验（绝对路径 / 长度 / 条数 / kind）—— 用户带进来的路径是意图，提前拒等于把意图丢掉，且拒绝理由离开了它当下要读的那个文件就说不清楚。

**被判死的工具，以及为什么**：

| 删掉的 | 因为 |
|---|---|
| `grep` / `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强 |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到 |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

> MCP 不是「能力工具」，而是把外部工具接进 `PluginHost` 的插件（ADR-039）；它不占基础工具名额，也不改变能力工具的判据。

**evals / feishu 不注册模型工具**；工具口径：默认 = 能力工具 + `agent` + `subscribe`；交互模式再加 `ask`；另有 N 个 MCP 工具。

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

**API surface = prompt surface**：tool 的 name / description / inputSchema 每轮都在系统提示里，新增 tool / action / field / event 都是固定 token 税；设计评审要论证“模型必须知道它”，不能只算代码实体。能被 `bash` 或现有动作组合出来的，先不加。

