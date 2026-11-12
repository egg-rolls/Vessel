---
title: AgentService 与 Team 约定
kind: advisory
triggers: [agent, member, team, session, dispatch, rotate, restart, create, sessions.create, spawn, peer, contractor, owner, freeze, budget, visibility, agent tool, permission, answered_by, human, deny-after, timeout, approval]
paths: [packages/agent/**]
applies_to: [N, M]
---

# AgentService 与 Team 约定

> 改 `packages/agent/**` 前读这一篇；权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## AgentService 唯一

- 成员能力只由 `packages/agent` 实现；权限 bridge 只有一条活路径（body 创建 / 恢复时挂桥），不得恢复第二套桥；`packages/core` 不出现 member / owner / visibility / team 概念（ADR-088 / ADR-091）。
- 内置 `agent` 工具是唯一模型 schema：root owner 动作 `hire` / `send` / `close` / `list` / `rotate` / `read`（root owner 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `send` / `list` / `read`。Team 日志写入不在本工具内：`agent post` 已移除（它只追加日志、不投递、不唤醒，静默丢报告），需要写日志走 CLI `vessel team post`。工具调用者的 owner / parent 固定，模型不能伪造。
- 持久化 `role` 只有 `member`（owner=self，Team 必需；`main` 也是 member）与 `temporary`（owner=雇佣者，Team 可选）。0.27 的 `single` 已删除；v3 及更早快照里的 `role:'single'` 只在读取时降级为 `member` 并补绑 default Team，写回不再出现。
- 不得新增 `wait` / `status` / `cancel`；`inbox` 已是成员收件箱工具（`list` / `read` / `delete` / `insert`），等待语义仍是结束这一轮、回复作为新 turn 到达。
- `read` 是**只读**的会话读取面：`to`（成员 id / session id / 名字，限调用者可见 roster）+ `limit`（缺省 20，封顶 50），返回该成员当前 primary body 会话最近 N 条消息的 `role` + 截断正文（单条 1000 字符）。数据源是父入口同一个 `SessionStore`（与 `sessions.get` RPC 同一份 `SessionState`），**不新增 RPC、不改 `sessions.get` 形状**；地址形态（含 `@`）一律拒绝。它存在的理由：收口不再自动回传正文之后，父级要原文只有这一条路（另一条是 `agents.inbox`）。
- **成员停下通知（scope `peer`）**：成员 run 终态（`completed` / `failed` / `cancelled`）与成员被 close 时，向**父成员的 primary body session** 发一条 `runtime.notice`，模型侧照旧由 `runtime-notice-hook` 注入 `vessel:notice` 尾消息；**不再有**收口自动回传正文（旧 `deliverToParent` / `final: true` / `lastParentReply` 全部删除）。判据是「真的停了」：终态后延迟 2s（`PEER_STOP_WINDOW_MS`）再判一次，窗口内又有未读 / pending 收件箱消息、排队或在跑的 run、或在 rotate 窗口，就丢弃这次通知（不补发，下次真停时再判）；synthetic 摘要唤醒不算报告。**通知不带「有没有交报告」**（父级按「有没有收到消息」自己判断）；失败带稳定错误码（`provider_error` 之类；无 code 时截断人话），summary 一行按同错合并、成员名进 details（≤10 行；`runtime-notice-hook` 一并注入，一条一行、首行仍是单行摘要）。投递语义在 `src/peer-notices.ts`：`to` 定向父 session（总线按 session 游标注入，不定向会被先跑起来的别的 session 吃掉）、窗口内合并成一条、**同一父 session 一轮（两次 run 之间）最多 1 条**。
## 派生：peer / contractor

- 创建判别仍是 `kind:'peer'|'contractor'`：peer → `role:'member'`（owner=self、无 parent、必须 Team、visibility 强制 `team`）；contractor → `role:'temporary'`（owner/parent 缺省是雇佣者，有 Team 时 visibility 缺省 `team`、unbound 缺省 `private`）。
- 每 Team present 成员 ≤ 20（peer + contractor 都计入）；`create` / `hire` / 有来源 `agents.create` / `reinstate` 增长前检查，超限必须是 `team_full`。同 Team 的幂等 reinstate 不增长，不得被上限或冻结误拦。
- 冻结是 Team 元数据 `spawn_frozen`：冻结期间 `create` / `hire` / 人类 `agents.create`（含 `from_session_id`）/ `reinstate` 一律 `team_frozen`；只能由 `teams.spawnFrozen false` 解冻，`teams.update` 不改该字段。
- 审计：`agent.spawned` payload 带 `spawned_by`，Team join system 日志的 `from` 取它；private 成员按既有规则不写 Team 日志。

### create / hire 矩阵

| 调用者 | action | 结果 |
|---|---|---|
| root owner（无 Team） | `hire` | `temporary`；owner / parent = root owner；unbound（无 `team_id`） |
| 有 Team 的成员（含 temporary） | `hire` | `temporary`；owner / parent = 调用者；`team_id` = 调用者 Team，计入 20 人上限与 `team_frozen` |
| 无 Team 的成员（unbound temporary） | `hire` | `temporary`；owner / parent = 调用者；无 `team_id`，不计 Team 上限 |
| 有 Team 的成员 | `create` | `member`；owner=self；无 parent；强制调用者 Team、visibility `team` |

- 转换：`agents.update { role, team_id? }`；member 需要 Team，temporary 的 owner 是转换者，
  可在无 Team 时保持 unbound。team-scoped token 只能转本队；不要求新 Body，只追加 `vessel:notice`。
- `hire` 对任意成员开放；root owner 与 unbound 成员都落 unbound 分支。`create` 只给有 Team 的成员，
  root owner 只能 `hire`。action 无 `new`。

## session / Body

- 每 agent **恰好一具 live body**（`body_id ≡ session_id`）；唯一例外是 rotate 的 `rotating` 窗口允许新旧两具短暂共存，窗口结束回到一具（已有 live body 且非 rotation → `body_limit`）。`primary_body_id` 是缺省投递目标；`rotate` 只退休 primary body。快照 `version: 4`：`bodies[]` 是唯一真相，`current_body` / `body_history` 只读兼容。
- 状态机：`created|idle|running|waiting_permission|completed|failed|cancelled|closed`；`stale` 只读兼容、不得再写入；重启后非 `left` 成员为 `idle + presence='gone'`（ADR-091/092/097）。0.39 操作分离：`sessions.restart` 复用同一 Session 换 binding（epoch + 1；先 dispose 旧 ExecutionUnit，再建新 ExecutionUnit，同 key 租约 fence 递增）；`sessions.create{seed:'compact'}` 以父 Session 的压缩副本新建子 Session 并成为唯一 primary（父 Session 保留、源 binding 退役进 `bindingHistory`）；新 Agent 的冷建 / copy / compact 走 `agents.create{from_session_id?, seed?, keep_messages?}`，已有 Agent 的新 Session 走 `sessions.create`；`sessions.activate` 切回保留 session。旧 `agents.restart|compactFork|fork`、`sessions.rewind` 与 CLI `agent restart|compact-fork|rotate` 已删除。

## 投递与 Team

- 准入唯一：`dispatch` 与 strict `send` 共用同一条 `admit`（可投性检查 → 目标 body mailbox → `scheduler.submit`）；live / rotating 入队，gone 先 single-flight resume 再入队；不得在每个入口重写状态检查或并发 spawn。有来源创建有两条入口：`gone + resume` 失败后按 `teams[].policy.allowAutoCreate` / 显式 `allow_auto_create` 自动发生（`ensureCreatedOnDispatch` → `createDerivedAgent`），或公共 `agents.create{from_session_id}` 显式新建；rotate 失败保持旧 primary，`sessions.restart` / `sessions.create` 失败零写入（ADR-091/092/097/098）。
- **投递模式属于 inbox**（`AgentInboxDelivery`，`append(msg, { delivery })`，不是入口开关）：`input`（缺省）= 消息本体作为下一轮 run input 送达，同时可被 `inbox read`；`wake` = 只追加 inbox，并在目标空闲时排一次摘要唤醒，agent 自己去 read（run input 是固定串，不带正文；它带 `vessel:notice` 身份，因此渲染成环境信息、不是用户气泡）；`quiet` = 只落 inbox，不唤醒也不进 run。**wire 上的 `notify: true` 只是 `wake` 的别名**（RPC 参数与 agent 工具参数仍是 `notify: boolean`），service 与 team-service 内部一律按模式分派；`wake` 的预算口径只查 cycle、不 ensure conversation。观测面同源：`agent.message.queued` 一条事件用 `delivery` 区分三种投递，只有 `input` 带 `state`；旧 `agent.message.notified` 不再发布、落盘历史只读。
- close 的审批在权限层完成：self、owner 关闭 contractor（同 owner 或同 Team）、root owner 调用直接放行；成员关闭 peer 必须经 bridge 由人类审批；root owner 记录与跨 Team contractor 必须拒绝；无 bridge 时 ask 必须 fail closed。owner close 级联自己的 private contractor，team 可见 contractor 保留。
- Team 日志不是队列：无 `@` 的 post / reply / system 绝不产生 run；`@` 必须先写日志再逐条 `admit`；`TeamService` 是唯一写入点，reply 由 `run.completed.output` 驱动、失败 / 取消写 `system` 条目。
- 成员回报的唯一通路是**显式投递**：直接 `agent send` 给父级（或父级用 `agent read` / `agents.inbox` 自己读）。`send` 没有也不需要「本轮最终回报」这类结构标记；`final: true`、`lastParentReply`、`isSameParentReply` 与收口自动回传一并删除，不要以任何形式恢复（两份报告的重复是成员该自己避免的事，不是 runtime 该猜的内容判断）。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；team-scoped token 只能访问自己的 `team_id`，不匹配 `not_found`。
- `teams.create` 仅 human / admin；`archive` 拒绝 present 成员（`team_not_empty`），不提供隐式 hard delete。

## 预算

- conversation 预算挂 `teams[].policy.budget`，不复用 `limits.*`；状态写 `<dataDir>/conversations/<id>.json`（`0600` 原子写、损坏 fail-closed；`<id>` 是内部持久单 id，不是 wire 字段）；override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除。
- 环检测是不可关闭的**窗口限速**：同一有向边在每个 `cooldownSeconds` 窗口内最多 `maxRepeats` 次，越界只拒绝当次投递并带 `retry_after`，不落持久 blocked（正常多轮 hub-and-spoke 不该被判死）；要放宽持久改 `teams[].policy.budget.cycle.maxRepeats`，`budget override` 只是单条会话的临时放行。

## 待处理条带的单一持久真相（0.53 addendum）

- **inbox 条目两个 additive 字段**：`session_id`（= 这条消息是哪个会话的下一条输入）+ `refs`（附件引用，只有路径+元信息）。**只有 `input` 投递写 `session_id`**（唯一写入点 `trackInbox`，值 = 接管它的 `bindingId`），`wake` / `quiet` **不写** —— 带归属的条目会被启动恢复扫到并重投成 run input，给「只留档」的消息写归属等于让它再执行一遍。老文件缺字段 = 归属未知，读侧不回填、不猜归属。
- **`agents.inbox` 入参二选一**（`agent_id` 或 `session_id`；后者服务端 `control.resolve()` 反查 agent，因为 rotate 窗口与退役 body 会让前端 roster 过期），服务端等值过滤、缺 `session_id` 的老条目永不命中；结果带可选 `session_id` 与顶层可选 `agent_id`。**淘汰两级**：硬上界仍 200，腾位置先裁非 human 源最旧、再裁 human 源（人写的待处理输入不该被成员间投递挤掉），被裁的记 `agent.inbox.evicted` warn。**取消 / 撤回走 `agents.recall`（write）**，不是 `runs.cancel`：条目没有也不该有 run id，服务端按 message id 反查对应 queued run 一并取消，再按 source 分档 —— **human 源真删**（discard，不留墓碑）/ **agent 源 unhold 留档**（回可读 unread），正在跑的那条 `skipped: active`（撤回不是打断）。`runs.cancel` 成功后也会回调同一段收口（`releaseCancelledRun`）：否则 scheduler 摘了队列项而 `entry.queuedRuns` 永不清 ⇒ 该 agent 再也不会被 wake、消息永远 pending+held（D-a 僵尸）。**启动即扫**（gateway 开始收 RPC 之前，`recoverPendingInputs`，每进程一次）：判据 = `unread` + **未 held** + 有 `session_id` + `source === 'human'` + 该 session binding 可重建（`held` 只存内存，进程死后全部失效 ⇒ 磁盘上没被任何 body 接管的输入恰好就是孤儿集合，不需要幂等标记位）；走同一个 `admitInternal` 并带 `reuse_message_id`（同 id 幂等，磁盘上永远只有一条），带 `refs` 一起重投；失败保持 unread（**绝不 discard**，用户没取消）下次启动再试，上限 8 会话、其余记 `agent.inbox.recover_deferred` 顺延。**「重启后那条消息最终会被执行」= 会**，触发点就是下一次启动的这次扫描（不是「立刻」，也不是「等用户打开会话」）。
- **Web 条带只读盘**：数据源是 `agents.inbox{ session_id = 当前会话 }`（服务端过滤 + 客户端只留 `from === 'human'`，**缺 `session_id` 的老条目一律不显示**，宁可隐藏也不串台），刷新 / 切会话都不丢；事件只当触发器，非空时 2s 兜底轮询（空态零流量）、取数前 250ms debounce。**时间线里的排队卡已删除**（`queued` item / `queued:<runId>` key 家族整个消失）：它从来不由事件派生，删掉不回改任何已落盘事件。卡头文案「等待中」（`chat.pending.waiting`），**不编队列序号** —— 落盘后没有权威顺序；取消成功即从条带消失，没有「已取消」残留态。
## 指针

- RPC 形状：[gateway-rpc.md](../architecture/gateway-rpc.md#agent-lifecycle)；配置字段：[CONFIG.md](../operations/CONFIG.md)；决策：[ADR-095](../adr/ADR-095-agent-spawn-and-contractors.md) · [ADR-097](../adr/ADR-097-unified-agent-body-model.md)。
- 权限默认无限 / only-human 见 AGENTS.md 硬安全规则；本文件不复述。
