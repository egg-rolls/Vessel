---
title: 工具与权限边界
kind: current
triggers: [tool, bash, read, edit, permission, denylist, allowed_roots, agent, ask, mcp tool, 工具, 权限, 黑名单, 白名单, 根目录, 提问, 工具集, 工具名, 命名规则, snake_case, 工具名校验, 别名, 弃用提示, pii_reveal]
paths: [packages/core/src/types/tool.ts, packages/core/src/runtime/tool-name.ts, packages/core/src/runtime/plugin-host.ts, plugins/tools/**, packages/agent/**]
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
  cwd?: string; // 0.51 成员默认工作目录：只是起点，不是允许范围
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

<a id="tool-name-rule"></a>

## 工具名命名规则：snake_case

**判据（唯一真源 `packages/core/src/runtime/tool-name.ts`）**：本仓内置 / 插件工具名必须匹配

```
^[a-z][a-z0-9_]*$          // 且 ≤ 64 字符
```

即：小写字母开头，只含小写字母、数字、下划线。`web_search` / `web_fetch` / `pii_reveal` / `bash` / `read` / `edit` / `write` / `recall` / `subscribe` / `ask` / `agent` / `inbox` / `media` 都是这个形态。

**为什么不是 camelCase**（`piiReveal` 这种虽然能被 provider 收下，但一律不合规）：

1. **模型先验**：工具名是 prompt surface。生态里绝大多数工具名（以及模型见过的绝大多数函数名 / 表名 / JSON 字段）是 snake_case，拼错率与「同一个能力想出两种名字」的概率都更低。
2. **与 MCP 生态一致**：MCP 的清洗层（`plugins/mcp/client/src/naming.ts`）把非 `[A-Za-z0-9_]` 一律换成 `_` 并加 `mcp__<server>__<tool>` 前缀 —— 也就是说外部工具的落地面本来就是下划线。内置工具跟它对齐，`grep` 一次就能找出「所有工具名」。
3. **大小写不敏感环境的坑**：Windows / macOS 默认文件系统、部分注册表与环境变量都不区分大小写；`webSearch` 与 `webs_earch` 之流在大小写归一后可能撞名，而这类撞名在 Linux CI 上永远复现不出来。
4. **grep 友好**：`piiReveal` 在日志 / 事件 / 配置 / 文档里会以 `piireveal` / `PIIReveal` / `pii_reveal` 三种形态出现，搜一个漏一个；统一后只有一种拼法。
5. **provider 那条只是下限**：`tools[].function.name` 的硬约束是 `[a-zA-Z0-9_-]{1,64}`（点号会让**整个请求** 400）。snake_case 是它的子集，取交集的好处是：哪天接一个新 provider / 新网关，不用再回来查名字。

**外部来源原样透传**：MCP server 提供的工具名是**对方的名字**，我们不改写、不转换（改写等于把「模型看到的工具」与「server 认的工具」拆成两个，出错时两头都对不上）。它们走注册表的**例外通道**：同样过同一道校验，但**只报 warning、不阻断装配**，并在装配日志 / `--tools` 的 warnings 里列出来 —— 名字我们管不了，但必须可见。注册时用 `registerTool(def, { external: true, source: 'mcp:<server>' })`。

**改名必须带别名（至少一版）**：改名的登记处只有一处 —— `TOOL_NAME_ALIASES`（`alias` / `target` / `notice` / `removeIn`）。细则：

- 别名解析在**注册表一处**（`MemoryPluginHost.getTool` → `getToolAlias`），不是每个工具各写一份 if；配置层（`permission.auto_approve` / `never_auto_approve`）的换算也读同一张表（`src/legacy-tool-names.ts` 只是适配层）。
- 命中别名时**不静默**：`tool-pipeline` 把 `notice` 追加到回给模型的结果文本里（错误路径也带），例如
  `piiReveal 已重命名为 pii_reveal（0.55 起工具名统一 snake_case）；旧名保留一版，下一版移除，请改用 pii_reveal。`
- 别名只做**精确表查找**，禁止前缀 / 大小写归一 / 点号-下划线互换之类的模糊换算 —— 那等于允许任意别名，会把注册期的名字校验一起废掉。
- 旧名**不写进** `listTools()` / `--tools` 的工具清单（工具面只有现行名），但 `--tools` 末尾会单列一段 `Deprecated tool-name aliases`，所以「旧名还能用、什么时候断」写在输出里，不靠口口相传。

**校验落在哪（两道，都是运行时断言，不是靠人记）**：

| 时机 | 判据 | 不合规的结果 |
|---|---|---|
| 注册期（`MemoryPluginHost.registerTool`） | snake_case + ≤64 | 内置 / 插件工具：**直接抛错**，文案带正则与建议名（`webSearch → web_search`） |
| 装配期（`installPluginsIntoHost` 收尾 / `bootstrap` 收尾 / `--tools`） | `assertToolNameLegality(host)` 全量扫描 | 内置：抛错并**列出全部违规项**；外部：只写 warning（装配日志可见） |

已知旧名（保留一版）：`piiReveal` / `pii.reveal` → `pii_reveal`；`ask_user` → `ask`。移除计划见 `TOOL_NAME_ALIASES` 的 `removeIn`。

<a id="tools"></a>

## 工具集：能力工具为什么这么少

默认运行期工具：`plugins/tools/basic-tools` 提供能力工具 **`bash` / `read` / `edit` / `write`**（`write` 是建文件 / 整体替换 / 追加，**逐字节落盘、不经 shell**——heredoc 与重定向会把内容交给 shell，反引号与美元括号会被先展开）；`packages/agent` 提供内置 `agent`（默认注册；显式 `agent.enabled: false` 关闭）；`plugins/context/doc-subscription` 提供 `subscribe`（agent 显式订阅文件；变更只发短通知，按需 `inspect`；未 add 不通知）。成员 body 在装配层 attach 收件箱后另有 `inbox`；`ask` 按入口注册。`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `subscribe` | 默认注册（`doc-subscription` 插件）；agent 显式 add 文件后，变更只在下个 run 的系统提示里发一条短通知（path / id / rev / bytes），模型调用 `subscribe inspect` 才取 diff（首次全文）；正文不自动进历史。只接受具体文件，无 glob / 目录 / 自动发现 |
| `agent` | 默认注册；显式 `agent.enabled: false` 关闭。root owner 动作 `hire` / `send` / `close` / `list` / `rotate` / `read`（root 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `send` / `list` / `read`。写 Team 日志不是本工具的职责：`agent post` 已移除（只追加日志、不投递、不唤醒，0.50 实测导致成员报告静默丢失），需要时走 CLI `vessel team post`。`create` 建同 Team peer，`hire` 建调用者拥有的 contractor；close 审批在权限层（成员关 peer 需人类批准），每 Team present 上限与冻结见 ADR-095；权限模式与成员配置见 `agent.*`。`read` 是只读会话读取（`to` + `limit` 默认 20 / 封顶 50，返回最近 N 条消息的 role + 截断正文），数据源与 `sessions.get` 同一个 `SessionStore`，不新增 RPC；收口不再自动回传正文之后，父级要成员原文用它或 `inbox` |
| `inbox` | 成员 body 由装配层 attach 收件箱后注册（`deny` 模式也注册，只读本地队列）：`list` 是**唯一的廉价偷看**——unread / pending 计数 + 每条只给 `id` / 来源 / **前 40 字符**前缀 / `more_chars`（还有多少字符没给），永不吐正文；`read` **就等于拿走**——取原文 + 消费，`unread` 与 `held` 一视同仁（held 的那几条先取消其 queued run 再消费，所以同一段正文不会进两次上下文），不可逆；`delete` 删除未读且非 held 的消息（「不看就丢」）；`insert` 给自己追加一条消息，不启动 run、不唤醒自己。`unread` = 该自己读，`pending` = 已排程、会自动作为下一轮输入送达（同一口径由 `counts()` 派生）。0.51 的 `claim` 动作已并入 `read`：老会话仍发 `action:'claim'` 时按 `read` 的别名执行并在结果里附一行 `note`（`agents.claim` RPC 与 web 条带仍然存在，模型侧不再有这个动作）；`includeHeld` 参数已删除。返回 JSON；非法参数返回 `{ error: 'invalid_input: ...' }`，不抛错 |
| `ask` | 交互 REPL、`gateway start` / `--serve` 与 headless（`--run` / 管道）都注册；`ui.askUser: false` 可关闭。两种语义见下「ask 的 sync / async」 |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：默认 root 工具面 = 能力工具 + `agent` + `subscribe`；显式 `agent.enabled: false` 去掉 `agent`；交互 REPL 或 gateway-serve 再加 `ask`。**只有一份工具面**：成员用的就是节点有的这一份（0.51 用户裁定），所以 `tools.list` 无论传不传 `agent_id` 都是 `{ tools }` 一个形状，没有 `surface` / `source` / `unavailable`（见 [gateway-rpc](gateway-rpc.md)）。仅剩两条**行为**差异：deny（只读）档只留 `read` / `media` / `subscribe`，需要父级应答的 `ask` / `ask_user` 要求 bridge —— 判据见 [agent-structure](agent-structure.md) 的「工具面」。`inbox` 仍是成员运行期注入（节点面上暂时没有它，待 inbox 插件化后自然归位）；配置 MCP 后在基础上加 MCP 工具（数量由 server 提供）。实际清单以 `bun run src/cli.ts --tools` 输出为准，本文不写死数量。`--tools` 一次性命令按 headless 口径列出，且**不连接 MCP、不展开 `ask` 与成员侧 `inbox`**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `write` | `{ path, content, mode? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `mode` = `create`（缺省；目标已存在则**报错不覆盖**）/ `overwrite` / `append`。内容**逐字节落盘、不经 shell**，所以反引号、`$()`、`${…}`、中文、emoji 都不会被展开或吞掉。只自动创建**一级**父目录；单次上限 4 MiB；沿符号链接写到被指文件（链接本身不被替换）；覆盖沿用原文件权限位。与 `edit` 的分工：建文件 / 整体替换 / 追加用 `write`，**局部修改用 `edit`**（逐字符唯一匹配，改不中会报错） |
| `recall` | `{ compaction_id?, from_seq?, to_seq?, offset?, limit?, query? }` | 无（只读本会话日志） | 读回**被压缩替换**的历史消息（0.57）。无参 ⇒ 列出本会话的压缩段（id / 原因 / 条数 / seq 区间 / 摘要首行）；给 `compaction_id`（或 `from_seq`/`to_seq`）⇒ 返回**原始消息**，一行一条。三条上界：≤200 条 / ≤16k token / ≤20000 事件扫描；分页给 `next_offset` 与更便宜的 `next_from_seq`。压缩当刻写进摘要正文的那行 `[compacted] N messages (seq a..b) …` 就是它的入口。老会话无索引时明说，不编造。**这不是读文件** |
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

**逐题可勾选、可分批补答（0.52）**：待批页允许只回答同一请求里的某几题（`ask.respond` 的 `answers` 数组**没有长度校验**，只带勾选且已作答的那些）。**没有「一经应答即整体落定」**：`settleAnswer` 只在**所有题都有答案**时才把 `pending → answered`，否则记录仍是 `pending`、只累加 `answered_questions`，剩下的题下次还能补答。题号是去重的唯一凭据，服务端**先归一再去重**（`planAskAnswers`）：`question_id` → 正文匹配 → header → 该答案在数组里的题序位置；归一之后已答过的题一律进 `skipped`（不覆盖、不重复投递），归不到任何题的行直接丢弃 —— 记录里不会存在没有题号的答案；分批投递只带本批新增（`batch_answers`），否则第二批会把第一批重发一遍。前端因此必须：已答的题标「已回答」并锁住输入（`pending.item.answered`）；提交载荷只收**未落定**的行、每条必带 `question_id`（`ask-submit-plan` 一处判定，不带题号的旧构造器已删除）；提交成功后按服务端逐题进度刷新，重复点击走幂等（同一批重复提交 = `skipped` + `duplicate`，条数不变）。

回答入口：Web 待批页 / `vessel attention respond`（卡片带「异步」标记）。TUI 的答辩弹窗沿用既有规则——run 收口即关闭，所以 async 请求在 TUI 里答不了（用待批页）。

<a id="path-boundary"></a>

**路径边界（ADR-055；`edit` 同样适用）**：`read` / `edit` / `bash cwd` 先按真实路径（`realpath`；不存在的路径取最近已存在祖先）判定，`..` 与 symlink 不能绕过。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）命中即 `deny`；插件 `config.allowed_roots` 非空时越界为 `ask`，`config.deny_paths` 追加到内置列表。默认 `allowed_roots` 为空 = 不限制根。`bash` 只校验 `cwd`，命令本身仍可访问其它路径——这不是沙箱。读文件的插件（`media`）**默认继承** `basic-tools` 的 `allowed_roots` / `deny_paths`（自身配置优先，显式空数组 = 明确不限制根）：合并由装配层 `buildPluginConfigMap` 做，插件侧不重复解析配置。**默认工作目录（0.51）**是另一条口径，优先级 **工具参数 `cwd` > `agent.cwd`（全局默认，全 tenant 一份）> 成员 cwd（`ToolContext.cwd`，create 时显式选中 Team 的基础路径快照）> `process.cwd()`**：锚点 Team（`<dataDir>/default`、`<dataDir>/headless`）不参与，成员 cwd 是不可用的**派生值**，所以降级而不硬错（显式配置的 `agent.cwd` 仍硬错）；它只是起步位置，不放宽上面任何一条边界。

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

