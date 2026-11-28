---
title: 工具与权限边界
kind: current
triggers: [tool, bash, read, edit, grep, permission, denylist, allowed_roots, agent, ask, mcp tool, vessel, bridge, guardrail, rpc, 工具, 权限, 黑名单, 白名单, 根目录, 提问, 工具集, 工具名, 命名规则, snake_case, 工具名校验, 别名, 弃用提示, pii_reveal, 控制面, 桥, 元工具, engine, pool, tools_engine, child, bridge_deny, transport, 执行位置, 双路]
paths: [packages/core/src/types/tool.ts, packages/core/src/runtime/tool-name.ts, packages/core/src/runtime/plugin-host.ts, packages/core/src/runtime/tool-pipeline.ts, packages/core/src/runtime/tool-provenance.ts, packages/core/src/runtime/permission-policy.ts, plugins/tools/**, plugins/context/doc-subscription/**, plugins/mcp/client/src/naming.ts, packages/agent/src/tool.ts, packages/agent/src/inbox.ts, packages/agent/src/service.ts, packages/agent/src/member-cwd.ts, src/runtime/vessel-meta.ts, src/tools-engine/**, src/config/legacy-tool-names.ts, src/runtime/bootstrap.ts, src/cli/commands/fleet/restart-command.ts, src/cli/commands/gateway/gateway-command.ts, src/plugin/plugin-config.ts, src/cli/ask-channel.ts, src/agent/ask-answer-delivery.ts, packages/serve/src/interactions-registry.ts, apps/web/src/domains/pending/ask-submit-plan.ts, packages/tui/src/renderer/ask-user.ts, src/tools-engine/mcp-engine-wiring.ts]
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

<a id="engine-exec"></a>

### 工具执行位置：engine 双路（child / pool）

管道的 handler 被装配层就地替换为转发 handler（def 对象身份不变 ⇒ tools[] 快照 / 前缀缓存 / install 回滚不受影响）：白名单 `read` / `edit` / `write` / `bash`（同步）恒走 engine worker（与 host 同一份 basic-tools 包源码）；`bash`（`async:true`）/ `ask` / `recall` / `pii_reveal` / `agent` / `inbox` 是 callback——engine 只回关联 id，host 查 pending 表执行原 handler（at-most-once，零 ctx 序列化）；MCP 工具 exec=worker（连接在 engine 内，per-server 硬亲和）；`subscribe` / `media` / `vessel` 不 wire，留 in-process（`src/tools-engine/wiring.ts`）。权限判定、注册权威（PluginHost）、PII、事件与 WAL 全留 host；执行位置对模型不可见。

传输双路由 `tools_engine.mode` 选择（缺省 `child`）：**child** = 每 node 一个 stdio 子进程（supervisor 重启预算 ≤3 次/10min，预算尽 disabled → 工具 fail-closed `engine_unavailable`，不静默回退 in-process）；**pool** = 显式 opt-in，node 的 PoolTransport 直连 gateway 监督的 detached engine 池（亲和 → 健康 → P2C 三步选择；进程级准入快拒 `engine_busy`，LB 换家重试，无队列）。池需 `gateway.engine_pool.size>0`（0=不建；1=fail-fast；开时 ≥2），双开关缺省关零回归；poolDir = `~/.vessel/engine-pool[-<instance>]`，**不随 `--data-dir` 移动**（`src/runtime/bootstrap.ts` / `src/cli/commands/gateway/gateway-command.ts`）。结果出口闸仍只在 core：worker 用同一份闸自裁 → 信封 `bounded:true` → host ctx re-mark，loop 不重裁。决策与拓扑细节见 [ADR-106](../adr/ADR-106-engine-pool.md)（accepted）；目标态设计史见 [0.57-tool-host](0.57-tool-host.md)（kind: target，部分被取代）。

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

- 别名解析在**注册表一处**（`MemoryPluginHost.getTool` → `getToolAlias`），不是每个工具各写一份 if；配置层（`permission.auto_approve` / `never_auto_approve`）的换算也读同一张表（`src/config/legacy-tool-names.ts` 只是适配层）。
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

默认运行期工具：`plugins/tools/basic-tools` 提供能力工具 **`bash` / `read` / `edit` / `write` / `grep`**（`write` 是建文件 / 整体替换 / 追加，**逐字节落盘、不经 shell**——heredoc 与重定向会把内容交给 shell，反引号与美元括号会被先展开；`grep` 是 q-tooling 加入的只读结构化文本搜索，见下表）；`packages/agent` 提供内置 `agent`（默认注册；显式 `agent.enabled: false` 关闭）；`plugins/context/doc-subscription` 提供 `subscribe`（agent 显式订阅文件、node 健康（`source:'health'`）或检测脚本（`source:'script'`，按名订阅用户配置 allowlist 声明的命令，机制见 [subscription-scripts](subscription-scripts.md)）；edit/write 自动订阅所改文件、read 自动订阅所读行范围（line-level），`subscribe:false` 可 opt-out 该次调用的自动订阅；订阅变更只发短通知（read 订阅可带范围 diff 明细），按需 `inspect`；未订阅不通知）。`plugins/context/skills` 提供 `skills`（管理技能库的单工具三动作：list / search 只读元数据，load 经信任门——TOFU 哈希锁，首次 / 内容变更 ask、revoked deny——把技能内容按 `<skill id source path trust>` 包裹进语言空间并记会话加载态；三来源 = 项目 `skills/`、用户 `~/.vessel/skills/`、收集库 `<dataDir>/plugins/skills/library/`，收集库根由装配层追加进 basic-tools `deny_paths` 隔离；写技能仍是 `write` / `edit` 改文件，不注册 CRUD）。成员 body 在装配层 attach 收件箱后另有 `inbox`；`ask` 按入口注册。装配层另常驻注册 **`vessel`** 控制面桥（P1 单工具面，见下「vessel 控制面桥」）。`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `subscribe` | 默认注册（`doc-subscription` 插件）；订阅状态在插件磁盘 JSON（`<stateDir>/sessions/<session_id>.json`），不在 core runtime。显式 add 或 edit/write/read 自动订阅（AfterTool hook，host 侧，attempt-based，与 handler 在哪执行无关；`subscribe:false` = 该调用完全退出自动订阅；自动订阅以当前内容为基线，自己刚做的改动不出卡）。变更感知 = host 侧 BeforeLlm polling（缺省每 run 首次 BeforeLlm 查一次；`envGranularity.files='request'` 时每请求），**不是 engine 实时推送**（engine→host 通知只有 impl.swapped / health 两类）；变化追加一条短通知（path / id / rev / bytes），模型调用 `subscribe inspect` 才取 diff（首次全文）——短通知 + 按需 inspect 是所有订阅的默认形态，与 opt-out 无关。read 订阅追踪所读行范围（line-level）：那几行变了，第一个变化条目的卡带范围 diff 明细行（行/字节预算，超限折 inspect 提示）；锚歧义回落整文件 rev。read 引用随 placeholder 清除释放（引用归零才过期；edit/manual 订阅永不自过期；passthrough 档不动；生命周期读 file backend 会话壳 JSON，sqlite 跳过）。正文不自动进历史。文件订阅只接受具体文件，无 glob / 目录 / 自动发现；换任务用 remove 清旧订阅。`source:'health'`（add 缺省 `file`）改订一个 node 的健康而非文件：`node` 给本机 node_id 或地址，健康变化 / 重启（`started_at`）产 health notice，`inspect` 回快照（与文件 inspect 同族信封）；`nodes` 仅 health add 批量。`source:'script'`（q-subscription-script）按名订阅用户配置 allowlist 的检测命令（fail-closed：未声明拒 `not_in_allowlist`，模型不能注入命令）：异步 fire-and-forget 跑（调度 run / request / interval 真 timer，idle 也跑、单飞），空输出不出卡、diff 去重、首次全量，结果经 `vessel:notice` 环境卡投递（scope `script` 兜底 / `doc-lag` / `code-heaviness` 内置专词，per-scope 节奏/通道热改）；`inspect` 回最近成功 stdout 全文 + 执行事实，`list` 带 last_exit / last_run，`remove` 清条目并 disarm timer；机制细节见 [subscription-scripts](subscription-scripts.md) |
| `agent` | 默认注册；显式 `agent.enabled: false` 关闭。root owner 动作 `hire` / `send` / `close` / `list` / `rotate` / `read`（root 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `send` / `list` / `read`。写 Team 日志不是本工具的职责：`agent post` 已移除（只追加日志、不投递、不唤醒，0.50 实测导致成员报告静默丢失），需要时走 CLI `vessel team post`。`create` 建同 Team peer，`hire` 建调用者拥有的 contractor；close 审批在权限层（成员关 peer 需人类批准），每 Team present 上限与冻结见 ADR-095；权限模式与成员配置见 `agent.*`。`read` 是只读会话读取（`to` + `limit` 默认 20 / 封顶 50，返回最近 N 条消息的 role + 截断正文），数据源与 `sessions.get` 同一个 `SessionStore`，不新增 RPC；`send` 支持 additive `refs`（仅本机成员投递路，形状归一同用户 send，地址 / `message_id` 重投不接受，见 [blocks.md](blocks.md)）；收口不再自动回传正文之后，父级要成员原文用它或 `inbox` |
| `inbox` | 成员 body 由装配层 attach 收件箱后注册（`deny` 模式也注册，只读本地队列）：`list` 是**唯一的廉价偷看**——unread / pending 计数 + 每条只给 `id` / 来源 / **前 40 字符**前缀 / `more_chars`（还有多少字符没给；遇难求救条目带 additive `distress:true` 标记，read 一并交出），永不吐正文；`read` **就等于拿走**——取原文 + 消费，`unread` 与 `held` 一视同仁（held 的那几条先取消其 queued run 再消费，所以同一段正文不会进两次上下文），不可逆；`delete` 删除未读且非 held 的消息（「不看就丢」）；`insert` 给自己追加一条消息，不启动 run、不唤醒自己。`unread` = 该自己读，`pending` = 已排程、会自动作为下一轮输入送达（同一口径由 `counts()` 派生）。0.51 的 `claim` 动作已并入 `read`：老会话仍发 `action:'claim'` 时按 `read` 的别名执行并在结果里附一行 `note`（`agents.claim` RPC 与 web 条带仍然存在，模型侧不再有这个动作）；`includeHeld` 参数已删除。返回 JSON；非法参数返回 `{ error: 'invalid_input: ...' }`，不抛错 |
| `ask` | 交互 REPL、`gateway start` / `--serve` 与 headless（`--run` / 管道）都注册；`ui.askUser: false` 可关闭。两种语义见下「ask 的 sync / async」 |
| `vessel` | 装配层常驻注册（bootstrap，先于 owner 派生；`--tools` 同口径）。单工具面控制面桥：调用本会话不可直调的已注册工具 / 既有 RPC 方法 / 经 `config.set` 改配置。见下「vessel 控制面桥」 |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：默认 root 工具面 = 能力工具 + `agent` + `subscribe` + `skills` + `vessel`（控制面桥）；显式 `agent.enabled: false` 去掉 `agent`；交互 REPL 或 gateway-serve 再加 `ask`。**只有一份工具面**：成员用的就是节点有的这一份（0.51 用户裁定），所以 `tools.list` 无论传不传 `agent_id` 都是 `{ tools }` 一个形状，没有 `surface` / `source` / `unavailable`（见 [gateway-rpc](gateway-rpc.md)）。仅剩两条**行为**差异：deny（只读）档只留 `read` / `media` / `subscribe`，需要父级应答的 `ask` / `ask_user` 要求 bridge —— 判据见 [agent-structure](agent-structure.md) 的「工具面」。`inbox` 仍是成员运行期注入（节点面上暂时没有它，待 inbox 插件化后自然归位）；配置 MCP 后在基础上加 MCP 工具（数量由 server 提供）。实际清单以 `bun run src/cli.ts --tools` 输出为准，本文不写死数量。`--tools` 一次性命令按 headless 口径列出，且**不连接 MCP、不展开 `ask` 与成员侧 `inbox`**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms?, async? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。同步超时默认 120s（`timeout_ms` 必须正数）；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常。`async:true` 起进程就返回（job id + 日志路径），完成通知经 BeforeLlm hook / 唤醒投递二选一送达。**异步缺省不限时**（0.58 用户裁定#8：`timeout_ms`/`async_timeout_ms` = 0 = 无超时，长驻命令如 `gateway start` 不被杀）；显式正数超时到点行为由 `kill_on_timeout` 决定：缺省 false = 只断连接（立即收口通知、释放并发额度，进程继续跑、输出继续追加进日志，每方向追加预算 16 MiB），true = 整棵进程树被杀（0.55 旧行为）。并发上限缺省 16（旧 4），超限显式拒绝不排队。三个配置键都在 basic-tools 插件配置（`plugins[].config`，camel/snake 双收）：`async_timeout_ms`（≥0，缺省 0）、`kill_on_timeout`（bool，缺省 false）、`max_async_jobs`（整数 1..64，缺省 16）；热应用生效，已在跑作业保持起作业时的快照。进程退出兜底仍杀全部在跑作业与 detached 进程；作业注册表是进程内存、inbox 占位卡随盘持久 ⇒ 重启时装配层先跑 `AgentService.reconcileAsyncJobs()` 把盘上遗留的 running 占位卡原位回写 failed（`swept_by=exit`，quiet 留档不起 run），收口收集失败的 catch 兜底也走唤醒投递 + `bash.job.failed`（`collect_failed=true`），占位卡不再恒 running（q-async-job-reconcile） |
| `write` | `{ path, content, mode?, expected_content?, subscribe? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `mode` = `create`（缺省；目标已存在则**报错不覆盖**）/ `overwrite` / `append`。内容**逐字节落盘、不经 shell**，所以反引号、`$()`、`${…}`、中文、emoji 都不会被展开或吞掉。只自动创建**一级**父目录；单次上限 4 MiB；沿符号链接写到被指文件（链接本身不被替换）；覆盖沿用原文件权限位。`expected_content`（可选，仅 overwrite）：写临界区内与当前内容逐字节比对，不符**报错不写**逼重读（防并发静默抹除）；不传 = 旧行为。`subscribe:false` opt-out 自动订阅。与 `edit` 的分工：建文件 / 整体替换 / 追加用 `write`，**局部修改用 `edit`**（逐字符唯一匹配，改不中会报错）。edit/write 写临界区前持 `<baseCwd>/.vessel/write.lock` 全工作区单锁（跨进程串行化写动作；合作式协议，bash/IDE/git 非合作写入者不受约束） |
| `recall` | `{ compaction_id?, from_seq?, to_seq?, offset?, limit?, query? }` | 无（只读本会话日志） | 读回**被压缩替换**的历史消息（0.57）。无参 ⇒ 列出本会话的压缩段（id / 原因 / 条数 / seq 区间 / 摘要首行）；给 `compaction_id`（或 `from_seq`/`to_seq`）⇒ 返回**原始消息**，一行一条。三条上界：≤200 条 / ≤16k token / ≤20000 事件扫描；分页给 `next_offset` 与更便宜的 `next_from_seq`。压缩当刻写进摘要正文的那行 `[compacted] N messages (seq a..b) …` 就是它的入口。老会话无索引时明说，不编造。**这不是读文件** |
| `read` | `{ path, offset?, limit?, subscribe? }` | `allow`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式。`subscribe:false` opt-out 自动订阅（缺省自动订阅所读行范围，line-level 变更感知见 subscribe 行） |
| `edit` | `{ path, old_string, new_string, replace_all?, subscribe? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换。`subscribe:false` opt-out 自动订阅（缺省自动订阅所改文件）。写临界区持工作区写锁（同 write 行） |
| `grep` | `{ pattern, path?, glob?, context?, max_count?, ignore_case?, fixed_strings? }` | `allow`；路径边界与 `read` 同一套（denylist → `deny`，`allowed_roots` 越界 → `ask`） | ripgrep 引擎文本搜索（rg 缺失时纯 TS 兜底扫描），返回结构化 `file:line:content`（context 行同形）。pattern 当**数据**收、不经 shell（无引号 / 展开问题）；`fixed_strings:true` 按字面量。尊重 `.gitignore`（rg）/ 兜底跳过 `node_modules` / `.git` / `dist` / 隐藏目录。`context` 0–50（缺省 0）、`max_count` 缺省 200（超限标注截断）；rg 子进程超时杀、兜底逐文件扫描标注 timed out。只读，敏感路径同 read 拒绝 |

<a id="vessel-bridge"></a>

### vessel 控制面桥（P1，单工具面）

`vessel` 是**结构化控制面桥**（`src/runtime/vessel-meta.ts`，装配层注册；用户裁定 2026-11-18：**模型面只有
vessel 一个工具**，不设独立执行器）：让模型在**不改会话 tools[] 前缀**的前提下够到 live 注册表里的
新工具与 Vessel 自身的 RPC 控制面。它不是注册型 meta-tool（不注册/发现工具，注册权威仍是 PluginHost），
也不占能力工具名额——与 MCP 注册面同理。正当性：工具是进程内函数不是 CLI 命令，`bash` 表达不了；
本地模式不监听端口，`bash` + RPC over HTTP 无端点可达且暴露 token；严格 provider 下旧会话的生成
被约束在冻结 tools[] 内，新工具只能经桥调用。

**两种执行边界（混用口径）**：

| op | 执行路径 | 鉴权落点 |
|---|---|---|
| `call_tool`（tool_name + args） | `vessel-bridge` guardrail（ToolCall 阶段，priority 40 先于 tool-policy 的 50）改写成目标 ToolCall（**保留原 tool_call.id**），目标 = live 注册表任意工具含 MCP | 管道对**最终目标工具 + args** authorize（ADR-058 决策 2）：auto_approve / never_auto_approve / checkPermission 按目标键控原样命中，零新鉴权逻辑。目标不存在 → 管道重 getTool 的标准 `tool_not_found`（retryable:false） |
| `rpc`（method + params） | guardrail 校验形状后原样放行，**vessel 自执行**（handler 经本地 dispatcher） | **vessel.checkPermission 按方法分层**（下表）；ask / auto_approve / remember 走既有 PermissionPolicy |
| `set_config`（key + value） | 同上，固定翻译为 `config.set` 调用 | config.set 既有白名单 / 值校验（permission.* 不可写，无自升级）+ write 审批 |

**方法级分层**（rpc / set_config；唯一真源 = dispatcher.manifest 的方法 `permission` 声明，与分发表同源）：
read→allow（RPC 层已脱敏）/ write→ask / admin→deny / 未知方法→deny；另硬禁
`permission.respond` / `ask.respond` / `permissions.setToolPolicy`（自审批/自改策略禁止，ADR-077/079/091）。
方法清单经 `op=rpc, method=capabilities.list` 发现。判定对**最终 args** 生效（BeforeTool 改写 op 也逃不过对应门）。

**gateway.restart 身份补注（q-restart-tool）**：`op=rpc, method=gateway.restart` 时 handler 把
ToolContext 的 `session_id` / `run_id` 补进缺省参数（显式传入优先；与 bash 工具注入
VESSEL_SESSION_ID / VESSEL_RUN_ID 同口径）——RPC handler 拿不到 ToolContext，触发者身份由桥侧
additive 补注，只影响本方法，其它 RPC 仍原样透传。self-restart 是平台级操作，故走 vessel RPC 面
（write→ask 确认卡）而非 agent 工具；`prompt` 可选（缺省 = 请求级续作），见
[gateway-rpc](gateway-rpc.md) 的 `gateway.restart` 条。

**fail-closed（call_tool）**：vessel 对 call_tool 与未知 op 的 checkPermission=deny、handler 永不转发——
关闭 guardrail 阶段的入口（EU delegate 等）直达 vessel 时 deny 先挡，任何入口组合都不能绕过桥校验
直达任意工具。rpc/set_config 是有界执行（启动期冻结方法表 + 逐方法门），checkPermission 在所有入口
都先于 handler 判定，故自执行不构成旁路。

**递归与准入**：单跳——call_tool 目标不得是 `vessel` 自身；其余 live 注册表工具默认可桥
（桥不放宽目标自身任何权限规则，高危分级由目标自己的 checkPermission / 默认 ask 继承）。
桥准入经配置 `permission.bridge_deny`（缺省 `[]` = 行为零变化）：精确工具名，别名经同一 `TOOL_NAME_ALIASES` 表解析；命中只拦 `call_tool` 桥可达性，不影响新会话直调；`vessel` 自身硬排除（config 不可覆盖）；列表是活引用，permission 热应用 applier 更新（`src/runtime/vessel-meta.ts` / `src/runtime/bootstrap.ts`）。`tool.call.completed/failed` 带 additive 溯源字段：`transport`（`in_process` / `engine_worker` / `engine_callback`，缺省不写 = 旧事件逐字节不变）与 `via_bridge`（vessel-bridge guardrail 改写时打标，按对象身份读取）；机制在 core `tool-provenance.ts`，打标方在装配层 / 插件。
历史与 tool.call.*：call_tool 记改写后的目标名（loop 既有语义），rpc/set_config 记 vessel 本身；
UI 按 tool_call_id 配对，用户与模型同见。RPC 执行经 bootstrap 的本地 dispatcher（与 gateway 同一方法表 /
同一权限语义，晚绑定回填）；失败折稳定错误文本回模型（run 继续），不产生新 WAL 洞。

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
| `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强（`grep` 曾同列，q-tooling 以只读结构化搜索复活：pattern 当数据收、免 shell 引号税，见上表） |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到。注意 `vessel` 不是这类——它不注册/发现工具，只是既有注册表与 RPC 控制面的结构化桥（见上「vessel 控制面桥」） |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息。**澄清**：`plugins/context/skills` 不是它的复活——管理对象是带信任边界的收集库（三来源索引 + TOFU 哈希锁 + 信任门控 load），只注册一个只读工具（list/search/load），不注册 CRUD；差异论证见 [skills 插件设计](../dev/plans/skills-plugin-design.md) §2.2 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

> MCP 不是「能力工具」，而是把外部工具接进 `PluginHost` 的插件（ADR-039）；它不占基础工具名额，也不改变能力工具的判据。evals / feishu 不注册模型工具。

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

**API surface = prompt surface**：tool 的 name / description / inputSchema 每轮都在系统提示里，新增 tool / action / field / event 都是固定 token 税；设计评审要论证“模型必须知道它”，不能只算代码实体。能被 `bash` 或现有动作组合出来的，先不加。

