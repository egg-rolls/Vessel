---
adr: 91
title: 0.19.0 Agent / Body 内核（S1）：节点身份、presence 与 dispatch
status: accepted
date: 2026-10-23
related: [49, 67, 88]
tags: [agent, body, presence, membership, dispatch, snapshot, node-identity, session, tenancy]
---

## ADR-091：0.19.0 Agent / Body 内核（S1）：节点身份、presence 与 dispatch

- **上下文**：ADR-088 把成员能力收进 `packages/agent`，但成员仍是“session 即成员”的单层模型：快照只存状态 DTO（没有 `model` / `system_prompt` / Body 指针），成员 engine 没有注入 tenant `SessionBackend` / `eventLog`，进程重启后把非终态成员写成 `stale` 再由 `attachOwner` 复活。结果是跨进程续接只能靠 handoff，`send` 对一个没有 engine 的成员会静默入队后变 `failed`，节点身份（`node_id`）每次启动都重新生成。0.19 的方向是把「身份」与「身体」拆开：Agent 是持久身份，Body（session + engine）可重建；S1 只落最小内核，rotate / fork / Team / hub 留到后续切片。本条 ADR 只记录 **S1 已实现** 的部分；S2–S7 未实现。

- **决策**：
  1. **节点身份持久化**：新增 `src/node-identity.ts`，`<dataDir>/node.json` 形状固定 `{node_id, created_at}`，0600 原子写。优先级 `config.host.nodeId` > 文件 > 首次生成 `randomUUID()` 并写回；配置值优先时只读文件做比较，发现不一致只告警、不改写文件。文件存在但 JSON / 字段非法抛 `node_identity_corrupt`，不得静默换身份。首次写后重新读取，磁盘值优先，处理两个进程同时首启的竞态。`incarnation` 仍每进程独立，只用于事件去重（ADR-067），不与 `node_id` 混用。
  2. **Agent 记录与快照 v2**：新增 `PersistedAgentRecord`（`id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `state` / `membership` / `model?` / `system_prompt?` / `current_body?` / `forked_from?` / `current_tool?` / `last_seen?` / `usage?`）。`body_id ≡ session_id`，`epoch` 只存在 `current_body` 内，DTO 的 `epoch` 由它派生。快照写 `version: 2`；读取接受 v1 与 v2，v1 成员按旧 `MemberStatus` 形状归一。首次写 v2 前把 v1 文件备份为 `<tenant>.json.v1.bak`；备份失败则放弃本次 v2 写，避免失去旧二进制回滚点。`presence` / `rotation` 不落盘。
  3. **三层状态**：`membership`（`present|left`，持久化；S1 由 `new` / `close` 写入，Team roster 在 S3 接管）、`presence`（`live|gone`，进程内，spawn / 重启加载 / close / dispose 写）、engine 状态（`created|idle|running|waiting_permission|completed|failed|cancelled|closed`）。派生规则不存储：`canAccept = present && live && stable`、`needsResume = present && gone`、`rotating = present && rotation === 'rotating'`。`rotation` 字段由 S2 使用，S1 无写入者，恒为 `stable`。
  4. **重启规则**：`loadSnapshot` 对每条记录：`state === 'closed'` 或 `membership === 'left'` → `membership = left`、`presence = gone`、`state = closed`；其它 → `membership = present`、`presence = gone`、`state = idle`。删除按 terminal / non-terminal 推断的逻辑，不再写 `stale`。`MemberState` 联合类型保留 `stale` 仅作旧 wire / 旧快照只读兼容；除了加载旧数据，没有任何写入路径，转移表只允许 `stale → closed`。
  5. **兼容事件**：`agent.stale` 事件名保留一版，只在加载 `present` 成员时发布，payload 用新语义 `{state: 'idle', presence: 'gone'}`，标记 deprecated；S2/S3 删除。成功 resume 发布 `agent.resumed {agent_id, epoch, presence: 'live'}`。
  6. **Body engine 注入 tenant 存储**：`InProcessMemberRuntimeOptions` 新增 `session?: AgentRuntimeOptions['session']` 与 `eventLog?: AgentRuntimeOptions['eventLog']`；`spawn` 把二者传给成员 `AgentRuntime`。`src/agent-service-wiring.ts` 透传，`src/bootstrap.ts` 从 tenant bundle 注入 `bundle.session` / `bundle.eventLog`，并删除原先包 `runtimeFactory` 的 eventLog hack。成员用自己的 `session_id` 分区；同一 `session_id` 在新进程 resume 后经 `SessionBackend` 续接历史。S1 不做 `AgentSessionScope`，接受成员会话出现在 `sessions.list`（S3/S6 再过滤）。
  7. **`dispatch` 是统一投递入口**：新增 `AgentService.dispatch({to, content, from?})`。`to` 解析顺序 id → session_id → 唯一 name；未知抛 `unknown_member`，同名多个 present 返回 `invalid_input` 并列出候选。顺序：`left` / `closed` / closing → `rejected agent_left`；`rotation === 'rotating'` → 入队，`resolution: 'rotating'`；`presence === 'live'` → 入队，`resolution: 'live'`；`presence === 'gone'` → single-flight `ensureResumed()`，成功后入队 `resolution: 'resumed'`，失败 `rejected resume_failed`；不可见 `rejected not_visible`。resume 与入队之间复查 `membership` / `presence`，close 竞态不得把消息投进已关闭成员。入队复用唯一 `enqueueMessage()`，不写第二套队列逻辑。
  8. **strict `send` 不变**：`send` 仍不 resume。`left` / `closed` 返回 `member_closed`，`presence === 'gone'` 返回 `member_stale`（沿用原错误码，语义改为 gone）。`agent` 工具的 `send` 在 S1 仍走 strict send；切到 dispatch 留到 S3（没有 roster 时改走 dispatch 会得到语义半成品）。
  9. **名字只由 present 成员占用**：`new` 提供 `name` 时在 tenant 内对 `membership === 'present'` 强制唯一，重复抛 `invalid_input`；`left` 的名字可复用。旧快照里的重名容忍加载并 warning，`dispatch` 按 name 解析到多个时返回 `invalid_input`。
  10. **`attachOwner` 是唯一 left→present 例外**：root owner 由人显式重新附着，必须完整恢复（`state = idle`、`membership = present`、`presence = live`），并在 session 变化时补齐 `current_body = {session_id, epoch, started_at}`。普通成员不能借此复活。
  11. **入口**：owner 端点新增 `agent.dispatch`；新增 CLI `vessel agent dispatch <to> <content...> [--from] [--json]`，`queued` 退出 0、`rejected` 退出 1。canonical RPC 方法表不新增方法（仍 45）。

- **Delete / Downgrade**：
  - 删除所有 `stale` 写入与状态转移；保留枚举值做只读兼容。
  - 删除重启时按 terminal 推断状态；统一 `idle + gone`。
  - 快照 v1 严格版本墙降级为双版本读；新增 `.v1.bak` 回滚点（作为兼容层登记，移除条件 0.20 检查点或确认无 v1 文件）。
  - 删除 bootstrap 的 `runtimeFactory` eventLog hack，改用一等 `eventLog` 选项。
  - 删除 bootstrap 进程内 `nodeId` 生成，改由 `resolveNodeId()` 提供。

- **非目标**：
  - **未实现**：rotate / 启动嘱托 / epoch fencing（S2）；fork（S2 之后）；Team / roster / `teams.*` RPC / `@` 定向投递（S3）；budget / `conversation_id`（S4）；hub 控制面 / 节点目录（S5）；Web 群聊 / body 历史 UI（S6）；跨节点 team ↔ team（S7）。方向裁决见个人侧 DECISION-035，不属本 ADR 的实现范围。
  - 不新增持久化消息队列；队列仍只在内存，重启丢失未处理消息。`dispatch` 负责按需重新物化 Body。
  - 不做 `request_id` 去重、唤醒风暴限流、`AgentSessionScope`；需要时 additive。
  - 不恢复 `wait` / `inbox` / `status` / `cancel` 模型工具；`agent` 工具动作仍只有 `new` / `send` / `close` / `list`。

- **已知限制**：
  - 旧二进制无法读 v2 快照（返回空 registry）。回滚步骤：停进程 → 用 `<tenant>.json.v1.bak` 覆盖 `<tenant>.json` → 回退二进制。
  - `rotating` 分支在 S1 没有 producer，只有单测直接驱动状态；S2 接入 rotate。
  - `agents.tree` 仍读 serve 自己的 registry，不消费 `presence`；`gone` 只能经 CLI / AgentService 观察，展示层留到 S6。
  - 成员会话会出现在 tenant `sessions.list` 中；S1 接受这一噪声。
  - `node.json` 按 `dataDir` 共享，同一 dataDir 的多个 `--instance` 共用 `node_id`（节点身份 = 机器 / dataDir）；`gateway-command.ts` 仍只检查显式 `host.nodeId` 的跨实例重复。
  - Windows 上 0600 只是 best-effort，不声称强隔离。

- **验证**：
  - 首启生成 `node.json`，重启复用同一 `node_id`；`host.nodeId` 优先于文件；损坏文件启动失败并报 `node_identity_corrupt`。
  - 重启后非 `left` 成员为 `presence: 'gone'` + `state: 'idle'`；`vessel agent dispatch` 返回 `resolution: 'resumed'`，且 session 历史连续；并发 dispatch 只 spawn 一次。
  - `left` 成员 dispatch 返回 `rejected` / `agent_left`；strict `send` 对 gone 返回 `member_stale`、对 left 返回 `member_closed`。
  - 手写 v1 快照可加载并升级为 v2，首次写前生成 `.v1.bak`。

- **关联**：[ADR-049](ADR-049-multi-tenant-isolation.md)（tenant 存储与隔离）、[ADR-067](ADR-067-cross-node-dedup-keys.md)（`node` / `incarnation` 去重维度）、[ADR-088](ADR-088-agent-service-package.md)（AgentService 分层；本条修订其状态、快照与投递契约）。

## Addendum（0.19 S2，ADR-092）

> 0.19 S2 实现了 rotate。以下追加只说明 S2 之后的当前事实，不回写上文 S1 当时的结论。

- **rotate 已实现**：`AgentService.rotate`、owner 端点 `agent.rotate`、CLI `vessel agent rotate <to> --startup <text> [--handoff <path>] [--json]`、`agent` 工具 `action: rotate` 均已接线。上文“S2–S7 未实现”、非目标与已知限制中关于 rotate / 启动嘱托 / epoch fencing 的部分由本 Addendum 与 [ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md) 取代。
- **`rotation` 有了写入者**：上文“`rotation` 字段由 S2 使用，S1 无写入者，恒为 `stable`”在 S2 起不再成立；rotate 期间为 `rotating`，所有出口恢复 `stable`，`pump` 在 rotating 时不起轮。
- **成员侧 `agent` schema 收窄**：成员 runtime 现在可见 `agent` 工具，但 schema 只暴露 `rotate`（只能 rotate 自己）；owner 看到 `new|send|close|list|rotate`。上文“`agent` 工具动作仍只有 `new` / `send` / `close` / `list`”不再成立。
- **持久化新增 `body_history`**：`PersistedAgentRecord.body_history?` 只追加、≤20 条，当前 Body 不在其中；快照仍 `version: 2`。
- **权限回调带 session**：`notePermissionState` 以当前运行 Body 的 session 为闸门；权限请求经 `InProcessMemberRuntime.attachBridge` 的每成员 pending 集合（0.19 S4 起 `AgentService.requestPermission` 已删除）。旧 Body 的迟到回调与请求不会把 Agent 拉回 `waiting_permission`。
- **stale 轮成对终态**：旧 Body 的迟到轮发带 `stale: true` 的 `agent.turn.*`，不写 Agent state / usage、不 `deliverToParent`；另有 `agent.reply.stale` / `agent.retired` 事件。
- **strict `send` 仍未切换**：S2 的 `agent` 工具 `send` 仍走 strict send；切到 dispatch 留到 S3。
- **`agent.stale` 未删除**：S2 仍只在快照加载时发布，删除留到后续切片。
- **修正**：上文入口段落写的 CLI `vessel agent dispatch ... [--from]` 中 `--from` 从未实现；CLI 只接受 `--json`，`from` 固定为 owner。

## Addendum（0.19 S3，Team 基础）

> 0.19 S3 实现了 Team。以下只说明 S3 之后的当前事实；方向裁决见个人侧 DECISION-035。

- **canonical RPC 45 → 49**：新增 `teams.list` / `teams.get`（read）与 `teams.post` / `teams.members`（write，`action: add|remove`）。serve 通过结构化 `TeamControlLike` 注入，不依赖 `@vessel-agent/agent`；未注入时 4 个方法仍在 manifest，handler 返回 `not_found`。tenant 作用域沿用 `resolveTenantScope`。
- **Team 存储**：`<dataDir>/teams/<tenant>/<team_id>/team.json`（`atomicWrite` 0600）与 `log.ndjson`（串行只追加、有界读、坏行跳过；不是队列）。`team_id` = workspace 目录名 slug，创建后不可变；同 slug 不同 workspace 追加 hash 后缀。
- **roster 派生**：Agent 记录 additive 增加 `team_id`；roster = `team_id + membership=present`，不单独持久化。绑定后的 Agent 默认 visibility 为 `team`；unbound 保持 `private`。默认绑定只对带 `name` 的 Agent 生效，且 workspace 须精确匹配配置声明。
- **只写日志**：无 `@` 的 post 只 append 日志，绝不 dispatch / pump；`@` 用结构化 agent id，先写日志再逐条 dispatch；日志写失败不产生任何 run。成员 `send` 同 Team 时先写 `kind:'mention'` 日志，跨 Team / 无 Team 直接 dispatch 不写日志。
- **系统消息**：`agent.spawned` / `agent.rejoined` → join，`agent.closed` → leave（roster remove 标记为 archive），`agent.rotated` → rotate；只写 `team_id` 非空 Agent 的日志，不 dispatch。
- **生命周期**：`teams.members remove` 复用 `close`（membership left、dispose 当前 Body、保留 session / `body_history`）；`add` 调用 `reinstate`，保留 current_body / body_history、不 spawn，`presence='gone'`，下一次 dispatch 才 resume。
- **`reinstate` 是第二条人力 `left → present` 路径**（与 `attachOwner` 并列）：只由 roster add 调用；`closed → idle` 不得走普通 `setState`（转移表 `closed: []`），使用专用路径并注释；engine 不得复活成员。
- **成员 `agent` 工具**：动作从 `rotate` 扩为 `rotate|post|send|list`；`send` 走统一 `dispatch`（成员 `from` = 调用者 agent id，name 只在同 Team roster 内解析），`post` 永不 dispatch，`new` / `close` 仍只给 owner。owner 的 `send` 也切到 dispatch；strict `service.send` 保留给 owner 端点 / CLI。
- **S6 additive（已冻结）**：
  - `TeamSummary.online_count` = `present && presence === 'live'`，从 roster 派生，不持久化；`teams.list` / `teams.get.team` 返回。
  - `TeamMemberSummary.body_history?` 直接透传 Agent 记录的 `body_history`（≤20）；旧数据缺失不报错。
  - `TeamLogEntry.kind` 增加 `'reply'`；成员一轮 `outcome === 'completed'`、有最终文本且 `team_id` 非空时，AgentService 只发 `agent.reply.posted {message_id, agent_id, session_id, team_id, content, ts}`（content ≤64 KiB，超限截断加标记），TeamService 是唯一日志写入点，追加 `kind:'reply'` 且**不 dispatch**；`message_id` 与事件一致，供 Web 合并。`agent.turn.completed` 仍不带正文。
- **private 成员不写 Team 日志**：Team 日志对 team 可见。`onAgentEvent` fail closed，只接受 `visibility === 'team'` 或 `'tenant'`；`private` / `undefined` / 未知值一律不写。`visibility === 'private'` 且 `owner !== id` 的 roster 成员，其 `agent.spawned/rejoined/closed/rotated/retired` 系统消息与 `agent.reply.posted` 回复一律不写；id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`。private mention 在 owner 可见路径返回 `team_private_member`、canonical 不可见路径返回 `unknown_member`，两种都不入日志；private 成员作为 `send` 调用者时不写 mention 日志（消息仍可 dispatch）。根 owner（`owner === id`）例外。
- **未实现**：fork、自动 archive、budget / `conversation_id`、hub、Web、跨节点、权限审批人、Team rename / delete / Agent 跨 Team 迁移；legacy `/v1/team/*` 保持无生产装配，且与 canonical `teams.*` 无关。

## Addendum（0.19 S5 / S6 收口）

> S5 Hub 与 S6 Web Team 已分别落地。本节只追加当前事实，不改写上面 S1 / S2 / S3 当时的结论。

- **canonical 在 S4 之前为 47**：0.18 移除 workflow 的 5 个方法（ADR-090）后基数为 40；S3 `teams.*`（+4）与 S5 `auth.exchange` / `auth.revoke` / `auth.tokens`（+3）合并后，canonical 方法总数 47（46 个 domain 方法 + `events.subscribe`）。上面 S3 Addendum 的“45 → 49”与 S5 Addendum 的“48”都是分支上的中间计数；S4 的 `teams.budget` 加入后为 48（见下方 S4 Addendum）。
- **`teams.*` 只注入 default tenant**：0.19 S3 只有 default tenant 的 AgentService / TeamService 注入 `TeamControlLike`；非 default tenant 调用返回 `not_found`。上面 S3 Addendum 的“tenant 作用域沿用 `resolveTenantScope`”不应被读成 per-tenant Team 已实现。
- **hub 已实现**（S5 / S5.1）：app 层 `vessel hub start`、节点 `/v1/hub/pair` 与 `/v1/hub/control`、目录 / 指针 / 配对 / scoped token / SecretStore 均已落地；S5.1 补齐 node → hub 出站（NAT）：hub 生成 join code、节点 `/v1/hub/node-control` 出站、hub 签发 hash-only node token；决策见 [ADR-093](ADR-093-hub-control-plane.md)。跨节点 A2A（S7）仍未实现。
- **Web Team 已实现**（S6）：`apps/web` 的 `team` 域消费 `teams.list|get|post`、`agent.reply.posted`、`online_count` 与 `body_history`；`waiting_permission` 映射为「等批准」；Web 不消费 hub 目录 / data token。
- **仍未实现**：fork、S7、Team rename / delete / 跨 Team 迁移、自动 archive。
- **cross-ref**：hub 见 [ADR-093](ADR-093-hub-control-plane.md)，rotate / epoch fencing 见 [ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)。

## Addendum（0.19 S4，权限 only-human 与 conversation 预算）

> S4 只追加当前事实，不改写上面 S1 / S2 / S3 / S5/S6 当时的结论。

- **权限 bridge 的唯一活路径**：`InProcessMemberRuntime.attachBridge`（成员事件流 ↔ 父 `parentEvents`）。`AgentService.requestPermission`、`AgentServiceOptions.permissionBridge`、`PermissionBridge` 已删除；`notePermissionState` 保留，仍按当前运行 Body session fencing。bridge 请求补 `team_id`（来自 `MemberRuntimeMember.team_id`）；应答只回灌该成员挂起过的 `requestId`。
- **Team 成员强制 bridge**：有非空 `team_id` 的成员忽略全局 `agent.permissionMode: 'allow'`，按 bridge 处理；显式 `deny` 保持只读工具，不放宽。没有 `parentEvents` 时 fail-closed，走既有 `permission_ask_denied` → deny，不挂起、不自动 allow；无人值守只能由 team 显式 `deny-after` 开启。
- **`conversation_id` additive 贯穿**：`dispatch` / strict `send` / Team `post` / 成员 `send`（本机 A2A）/ `reply` / `deliverToParent` / rotate startup / limit warning 都携带 `conversation_id`；Team log parser 与 `teams.get` 的 message schema 也保留该字段。人类入口无 id 时生成 `conv_<uuid>`；Team post 一次生成、所有 mention 共用；成员 send / reply / rotate 继承当前 turn。不按名字或正文分组；跨 Team 复用已属于另一 team 的 conversation 会被拒绝（`conversation_team_mismatch`）。
- **预算挂在 Team policy，不复用 `limits.*`**：`teams[].policy.budget` 的维度是 `max_hops` / `max_turns` / `max_tokens` / `max_wall_clock_seconds`，另有 `warning_threshold`（默认 0.8）与 `cycle`（`max_repeats` 默认 2、`cooldown_seconds` 默认 60）。`max_cost` 不实现（`Usage` 没有 cost 字段），validator 显式拒绝。预算只对配置了 policy 的 Team 生效；未配置时只有默认环检测。发送侧入队前检查 hops / cycle / wall-clock / 已耗尽 turns、tokens；接收侧 turn 开始前再查一次，被挡的消息留在队列（hold），由人工 override 或新会话解除。
- **预算状态持久化**：`<dataDir>/conversations/<tenant>.json`（v1，0600 原子写，debounce；turn 完成 / blocked / override 强制落盘），有界（1000 条按 `last_activity` 淘汰；带 override / blocked 的额外保留 ≤50）。损坏时 fail-closed：该 tenant 预算进入 `budget_unavailable`，不静默重置、不覆盖文件。重启保留计数 / override / blocked，丢失未消费的消息队列；进行中的 turn 崩溃可能少记一次 tokens / 完成计数（不宣称精确）。
- **事件**：`team.budget.warning`（`team_id` / `conversation_id` / `dimension` / `current` / `max` / `threshold` / `phase`）、`team.budget.blocked`（再加 `reason` / `retry_after_ts?`）、`team.budget.override`（`dimension` / `previous_max` / `max` / `by: 'human'` / `via`）。所有事件必带 `team_id`；不带正文 / tool input / prompt。
- **`teams.budget` canonical（48）**：`permission: 'write'`，`status | override`，由 `TeamControlLike.budget` 注入；未注入返回 `not_found`。**不进** `CONTROL_SCOPE_METHODS`，team-scoped control token 调用返回 `forbidden`。override 只能抬高当前限额或 `null` 清除，只对已存在的 conversation 生效；审计写 Team 日志 system 记录（`budget_override`）并发布 `team.budget.override`。owner 端点 `team.budget` 与 CLI `vessel team budget` 同步实现。S4 合并后 canonical 为 **48**；上面 S5/S6 Addendum 的 47 是 S4 之前的计数。
- **未实现**：billing / 价格表 / `max_cost` 执行、agent 审批人、`allow-after`、跨节点 hop / 预算（S7）、hub 预算投影、Web 预算 UI（S6）、持久化消息队列、unbound / root turn 预算。

## Addendum（0.20 fork）

> fork 已实现。本节只追加当前事实，不改写上面 S1 / S2 / S3 / S4 当时的结论。

- **唯一触发点**：`AgentService.dispatch` 在目标 `presence === 'gone'` 且 resume 失败后，
  按开关尝试 fork；`live` / `rotating` 正常投递，`left` 直接 `agent_left`。
  **不新增 `agent` 工具动作，不新增 canonical RPC**（仍 48）。rotate 失败不自动 fork。
- **开关**：`teams[].policy.allowFork`（缺省 false；手写 YAML 别名 `allow_fork`）。
  `DispatchInput.allow_fork` 显式值优先，但只有 owner 端点 / CLI 能传；成员 `send` 与
  `agent` 工具永不暴露该参数。
- **新 Agent 形状**：新 `agent_id` / 新 name（`<base>-fork`，同 Team present 冲突则
  `-fork-2..100`）/ 新 `session_id`（第一具 Body 与 id 相同）；`epoch = 0`、
  `body_history = []`、`forked_from = 源 id`；继承 owner / parent_id / visibility / team_id / model。
- **prompt 与历史**：`system_prompt` = 源 prompt + `\n\nHandoff: <绝对路径>`（相对路径按
  `TeamRecord.workspace` 解析）；只拼路径，不读文件；不复制 session 消息与 Body 历史。
- **失败语义（全部零写入）**：private 源、无 Team、无 `handoff_path`、已有 present fork
  → `resume_failed`（reason 指明原因）；fork 自身 spawn 失败 → `fork_failed`；
  spawn 期间源被 close / left → 回收新 Agent 并 `agent_left`。源记录始终不变，
  仍保持 `present + gone`。
- **并发与去重**：源维度 single-flight（`Map<sourceId, Promise>`）；`already_forked`
  通过扫描现有 `forked_from + present` 判定，不新增源侧指针。
- **可见性**：private 源拒绝 fork（private 成员永不写 Team 日志，fork 会得到不可见的新 Agent）；
  `agent.forked {from,to,team_id}` + Team `system_event: 'fork'` 各一条；日志写失败只 warning。
- **父级回复**：父 Agent 已 `left` / `closed` / `gone` 时发 `agent.reply.dropped`
  （`parent_left|parent_closed|parent_gone`），不入队、不重试；父不存在仍静默返回。
- **预算**：fork 成功后对新 Agent 做发送侧预算检查；预算拒绝时 fork 已存在但本次消息不投递
  （不回滚、不关闭新 Agent）。
- **兼容**：快照仍 v2，无迁移；`DispatchResult.resolution` 增加 `'forked'`，
  rejected code 增加 `'fork_failed'`；`TeamSystemEvent` 增加 `'fork'`（开放字符串值）。

## Addendum（0.25 canonical agent 生命周期）

> 本节只追加当前事实，不改写上面 S1 ~ S4 / fork 当时的结论。

- **canonical 51 → 54**：新增 `agents.create` / `agents.update` / `agents.close`
  （permission `write`）。三者都是批量契约，单条调用 = 单元素数组；参数为
  `{ agents: [...] }`，结果为 `{ results: [...] }`，与输入同序、单条失败互不影响
  （与 `AgentService.new` / `close` 的批量语义一致）。
- **create**：team-scoped control token 逐条 `forbidden`（与 `teams.create` 一致）。
  `team_id` 只解析**已存在** Team 的 workspace（经 `TeamControlLike.get`），再连同
  `name` 传给 `AgentService.new`；不隐式创建 Team，绑定需要 `name`。缺省 `team_id`
  走 service 的默认 workspace 规则。
- **update**：新增 `AgentService.update`（单条 + `{ updates: [...] }` 批量）。改名立即生效，
  唯一性与创建一致（同 Team present 唯一；unbound 为 tenant 唯一），冲突为稳定
  `invalid_input`。`model` / `systemPrompt` 只写入记录，由**下一次 spawn 的 Body** 使用，
  不重建当前 Body；实际变化时结果带 `applies_to: 'next_body'`。service 发布
  `agent.updated`，payload 只带变化字段名，绝不带 prompt 正文。
- **close**：team-scoped token 只能关闭 `team_id` 与作用域相同的成员（否则逐条
  `not_found`）；成功条目 `{ ok: true, agent, agent_id, closed: true }`（`agent` 为关闭后的状态）。
- **注入面**：`packages/serve` 只依赖结构化 `AgentControlLike`
  （`create` / `update` / `close` / `get`），app 侧适配 `AgentService`。handler 不依赖
  WS 连接 / `ctx.reply`，后续 loopback owner 端点可用合成 principal
  `{ kind: 'owner', tenant_id, scope: 'admin' }` 复用同一套 handler。
- **未实现**：owner 端点收口（本切片不建新传输）；Web UI 的创建 / 编辑 / 关闭入口。

## Addendum（0.26 canonical owner 传输）

> canonical RPC 是唯一契约；loopback owner 端点改为同一方法表的传输。本节只追加当前事实，
> 不改写上面 S1 ~ S4 / fork / 0.25 当时的结论。

- **canonical 54 → 57**：新增 `agents.send` / `agents.dispatch` / `agents.rotate`
  （permission `write`）。三者都是批量契约，形状与 `agents.create|update|close` 一致：
  `agents.send` / `agents.dispatch` 参数 `{ messages: [...] }`，`agents.rotate` 参数
  `{ agents: [...] }`；成功与失败统一 `{ results: [...] }`，与输入同序、单条失败隔离。
  - `send` 成功条目 `{ ok: true, queued: true, message_id, state }`（strict send，不 resume）；
  - `dispatch` 成功条目 `{ ok: true, status: 'queued', message_id, resolved_to, resolution,
    conversation_id? }`；业务拒绝（`agent_left` / `resume_failed` / `fork_failed` /
    `not_visible` / `budget_*` / `conversation_team_mismatch`）为 `{ ok: false, code, error }`；
  - `rotate` 成功条目 `{ ok: true, status: 'rotated', agent_id, from_session_id,
    to_session_id, epoch }`；失败为 `{ ok: false, code, error }`。
- **principal 身份 additive**：`RpcMethodContext.principal.agent_id?` 只由合成 owner 传输
  填入 root owner id。handler 用 `agent_id ?? 'human'` 作为 `from` / `viewer`：
  `agents.send|dispatch|rotate` 的 sender、`agents.list` 的 viewer、`teams.post|members`
  的 from、`teams.list|get` 的 viewer。gateway / team token 无 `agent_id`，行为不变。
- **team-scoped token 收窄**：`agents.send|dispatch|rotate` 进入 control scope 白名单，
  但逐条解析目标并按 `team_id` 校验；不匹配逐条 `not_found`（不泄漏存在性）。
  `agents.create` 仍禁止 team-scoped token。
- **owner 端点 = 传输**：`src/agent-owner-server.ts` 用 `defineMethods` 组装
  `createAgentMethods` + `createTeamMethods`，通过 `createRpcDispatcher` 以合成 principal
  `{ tenant_id, role: 'admin', scope: 'admin', agent_id: ownerId }` 分发；不保留第二套
  action 列表 / 参数映射 / 批量合并 / 错误映射。HTTP 状态只由 canonical 错误码映射。
- **wire 方法名迁移（pre-1.0，无别名）**：`agent.new` → `agents.create`、
  `agent.send` → `agents.send`、`agent.dispatch` → `agents.dispatch`、
  `agent.close` → `agents.close`、`agent.list` → `agents.list`、
  `agent.rotate` → `agents.rotate`；`team.*` → `teams.*`。`team.roster` 不再存在：
  mention 名字解析改用 `agents.list` 的完整成员视图（按 `team_id` 过滤），
  不依赖展示窗口。
- **owner 语义保留**：owner principal 的 sender / viewer 是 owner agent id；create 的
  owner / parent 由该身份填入，`workspace` 字段只对合成 owner 传输开放（gateway / Web
  仍只走 `team_id` 绑定已存在 Team）。private 成员对 owner 可见性、Team post 的 from、
  budget override 的审计语义与收口前一致（override 的 `via` 由 TeamService 缺省决定）。
- **`agents.list` viewer**：注入 `AgentControlLike` 且 principal 带 `agent_id` 时从
  AgentService 列成员（private 按 viewer 过滤）；条目 additive 增加 `name` / `owner` /
  `visibility` / `presence` / `membership` / `team_id` / `epoch` / `last_seen`。
  其它 principal 保持注册表派生视图。
- **Delete / Downgrade**：删除 owner 端点的 `dispatch` / `dispatchTeam` / 参数校验副本与
  `agent.*` / `team.*` wire 名；不新增 legacy 别名。CLI 用户语法不变，只消费 canonical
  结果形状。
- **验证**：owner 传输与 gateway handler 对同一混合批次返回相同逐条形状；team-scoped
  token 只能 send / dispatch / rotate 同 team 成员；owner send 的 `from` 是 owner id，
  canonical Web send 是 `human`；`bun test` / `typecheck` / `biome ci` / `check-deps` /
  `check-rpc-methods` / `check-docs` 通过。

## Errata（dispose 语义）

> 2026-10-25，只追加。上文决策 3 的括号把 `dispose` 与 `spawn` / 重启加载 / close 并列写成
> presence 的写入者，容易被读成 dispose 会改 presence；当前实现不是这样，以此条为准。

- `InProcessMemberRuntime.dispose(member)` 只做 engine 回收：按 Body `session_id` 删除 entries
  项、退订 bridge 与事件、清 pending，再调用底层 `runtime.dispose()`；按 session 幂等，
  重复调用无副作用。
- dispose **不写** `membership` / `presence` / engine state，也不落快照。失败由调用方
  best-effort 记录 `agent.dispose.failed`，不升级为 close 或 Agent 终态。
- 状态由调用方写：spawn / 重启加载写 `live` 或 `gone`；`close` 写
  `left + gone + closed`；rotate 只让新 Body 变 `live`、旧 Body 退役，不改变 Agent 身份。
- 因此 `dispose` ≠ close / left / Agent 结束；它只回收一具 Body 的执行资源。

## Errata（DECISION-035 可达性）

> 2026-10-25，只追加。上文引用的 `DECISION-035` 是个人侧裁决记录，不在本仓库；正文保留
> 原文，不改写当时结论。

- 仓库内可读的相邻决策见 [ADR-088](ADR-088-agent-service-package.md)（AgentService 分层）、
  [ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)（rotate / epoch fencing）与
  [ADR-093](ADR-093-hub-control-plane.md)（hub 控制面）。
