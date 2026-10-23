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
- **权限回调带 session**：`notePermissionState` / `requestPermission` 以当前运行 Body 的 session 为闸门；旧 Body 的迟到回调与请求被忽略或 deny（`body_not_active`）。
- **stale 轮成对终态**：旧 Body 的迟到轮发带 `stale: true` 的 `agent.turn.*`，不写 Agent state / usage、不 `deliverToParent`；另有 `agent.reply.stale` / `agent.retired` 事件。
- **strict `send` 仍未切换**：S2 的 `agent` 工具 `send` 仍走 strict send；切到 dispatch 留到 S3。
- **`agent.stale` 未删除**：S2 仍只在快照加载时发布，删除留到后续切片。
- **修正**：上文入口段落写的 CLI `vessel agent dispatch ... [--from]` 中 `--from` 从未实现；CLI 只接受 `--json`，`from` 固定为 owner。
