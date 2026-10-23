---
adr: 92
title: 0.19.0 Agent rotate 与 epoch fencing（S2）
status: accepted
date: 2026-10-23
related: [88, 91]
tags: [agent, body, rotate, epoch, fencing, snapshot, session, permission, cli]
---

## ADR-092：0.19.0 Agent rotate 与 epoch fencing（S2）

- **上下文**：ADR-091 落地了 Agent / Body 内核的 S1：Agent 是持久身份，Body（session + engine）可重建；`current_body` 是唯一持久指针，`rotation` 字段已存在但 S1 没有 producer。上下文快满时，Agent 仍只能丢历史或开新会话，没有“换一具活身体并继承名字”的路径。S2 在 S1 之上实现 rotate：旧 Body 写启动嘱托，新 Body 用新 `session_id` spawn，指针原子切换并落盘，旧 Body 跑完当前轮后退役；迟到结果按 epoch fencing 丢弃。fork / Team / hub / Web / 跨节点仍不在本切片。本条 ADR 只记录 **S2 已实现** 的部分。

- **决策**：
  1. **唯一入口 `AgentService.rotate`**：`rotate({to, startup_prompt, handoff_path?, from_session_id?, from?})` 返回 `RotateResult`。`to` 解析顺序为成员 id → 当前 Body session → 唯一 name。三条私有入口：owner 端点 `agent.rotate`（人）、CLI `vessel agent rotate <to> --startup <text> [--handoff <path>] [--json]`（人）、`agent` 工具 `action: rotate`（只能自换）。canonical RPC 方法表不新增方法（仍 45）。
  2. **只换活身体**：目标 `presence !== 'live'` 返回 `body_not_live`；`gone` 走 `dispatch` 的 resume。`left` / `closed` / closing 返回 `agent_left`；同一 Agent 已有进行中的 rotate 返回 `rotating`；external owner 不可 rotate（`owner_not_rotatable`）。
  3. **self-only 闸门**：工具调用必须带 `from_session_id`，且它必须等于目标当前 Body 的 session；否则 `not_current_body`。模型不能借 `to` 换别人的身体。第一次 rotate 成功后旧 session 不再是 current，同一轮再调必然被拒，因此不另做限流。
  4. **启动嘱托由旧 Body 写**：`startup_prompt` 必填、非空；可选 `handoff_path` 追加到第一条消息末尾并进入事件 payload（只带路径，不带正文）。新 Body 的第一条消息就是启动嘱托；平台不代写、不自动触发 rotate。
  5. **新 Body 与原子切换**：新 Body 使用新 `session_id`、`epoch = current_body.epoch + 1`，按 Agent 配置（model / system_prompt / parent / owner / visibility）spawn。顺序固定：`spawn` 成功 → 旧指针写入 `body_history` → `setCurrentBody` → `scheduleSnapshot()` → `await flushSnapshot()`。`flushSnapshot()` 返回 boolean；无 snapshot 时为 `true`。只在这一步之后才把启动嘱托 `unshift` 到队列并置 `rotation = stable`。
  6. **失败保持旧身体**：`spawn` 抛错或快照写失败 → 恢复旧 `current_body` 与 `body_history`、dispose 新 engine、`rotation` 回 `stable`、不插入启动嘱托、返回 `rotate_failed`；不自动 fork、不自动重试。失败本身不排队重试，下一次 rotate 必须由新的触发。若失败发生在 flush 已提交之后（close 竞态），指针不回滚，新 engine 由 close / 该分支回收。
  7. **rotating 期间排队**：`rotation === 'rotating'` 时 `dispatch` 以 `resolution: 'rotating'` 入队、`send` 同样入队，`pump` 不启动新 run。切换完成后队列顺序是：启动嘱托 → rotate 前已排队的消息 → rotating 期间新入队的消息，全部由新 Body 处理。旧 Body 只完成已经 `shift` 出去的那一条。
  8. **旧轮必须成对终态 + epoch fencing**：`pump` 起轮时捕获 `activeBodySession`。`executeTurn` 在 `runTurn` 返回后比较当前 `current_body.session_id`；不一致时发带 `stale: true` 的 `agent.turn.completed|failed|cancelled`（事件用旧 Body 的 session，经 `emitForSession`），再发 `agent.reply.stale`，dispose 旧 engine 并发 `agent.retired`，然后 `pump` 新 Body。stale 轮不写 Agent state / usage，不 `deliverToParent`。旧轮未结束时 rotate 不立即 dispose 旧 engine，交给轮末分支。
  9. **`entries` 按 session 键**：`InProcessMemberRuntime.entries` 从 `member.id` 改为 `member.session_id`，spawn / runTurn / cancel / dispose / bridge 守卫全部按 session 访问；同一 Agent 在 rotate 窗口内可同时持有旧 / 新两具 engine，但不并发 run。`agent_id` 仍用成员 id。
  10. **`bySession` 跟随当前 Body**：`MemberRegistry.bySession` 只索引当前 Body 的 session；`setCurrentBody` 先删旧 key 再插新 key。`resolve()` 不变，因此新 session 可寻址、退役 session 不再可寻址（第一具 Body 的 session 与 id 相同，仍可经 id 寻址）。
  11. **`MemberStatus.session_id` 报当前 Body**：DTO / 默认事件 `session_id` 取 `current_body.session_id`；`PersistedAgentRecord.session_id` 仍是第一具 Body 的兼容字段。`body_id ≡ session_id`，`epoch` 由 `current_body` 派生。
  12. **`body_history`**：`PersistedAgentRecord.body_history?` 只记录已退役 Body（`{session_id, epoch, started_at, retired_at}`），`slice(-20)`，当前 Body 不在其中；快照仍写 `version: 2`，读取时逐条校验、非法条目跳过、缺失按空数组。旧二进制回写会丢弃该字段（pre-1.0 接受）。
  13. **成员可见的 `agent` 工具收窄为 rotate**：成员 runtime 默认工具加入 `agent`（`DEFAULT_ALLOWED_TOOLS = bash/read/edit/agent`），但 schema 按调用者过滤：Body 只看到 `rotate`，owner 看到 `new|send|close|list|rotate`。成员 `permission.autoApprove` 追加 `agent`，否则交互模式 `fallbackDecision` 会把 rotate 判成 deny。handler 仍是第一道闸门，service 的 `from_session_id` 比较是最终闸门。
  14. **80% 预警到达 Agent**：成员 runtime 的 `agent.limit.warning` 经窄回调 `onMemberEvent(memberId, sessionId, event)` 回到 service；`noteMemberEvent` 只处理当前 Body 的 session，按 `${session_id}|${key}` 去重，排一条 `kind: 'limit_warning'` 的系统消息作为该 Agent 的下一轮输入。rotate 成功与 close 时清空 `warnedSignals`，并移除队列中尚未消费的 `limit_warning`，避免旧 Body 的预警发给新 Body。不新增轮询工具。
  15. **权限状态按 Body session fencing**：`notePermissionState` 只接受 `queue.turnActive && queue.activeBodySession === session_id` 的回调；权限请求只经 `InProcessMemberRuntime.attachBridge` 的每成员 pending 集合（0.19 S4 起 `AgentService.requestPermission` 已删除）。旧 Body 的迟到权限请求不会把 Agent 拉回 `waiting_permission`。
  16. **`isMemberBody`**：wiring 的 owner 注入判定改用 `AgentService.isMemberBody(sessionId)`，覆盖当前 / active / 退役 / rotating 目标 Body。旧 Body 在轮末仍被识别为成员，不会被误判成父 turn 而排空 owner 队列。
  17. **关闭覆盖两具身体**：`closeOne` 清空队列、按 active / current / 首具 / rotating 目标 session 逐个幂等 dispose，再落盘。
  18. **事件**：新增 `agent.rotating` / `agent.rotated` / `agent.rotate.failed` / `agent.retired` / `agent.reply.stale`；名称是开放字符串，payload 只带 id / epoch / 原因 / handoff 路径，不带启动嘱托正文。

- **Delete / Downgrade**：
  - `entries` 的键从 `member.id` 替换为 `member.session_id`。
  - `bySession` 从“第一具 Body 的 session”替换为“当前 Body 的 session”。
  - `record.sessionId` 作为对外 session 降级为“第一具 Body 兼容字段”；DTO 与默认事件改用当前 Body。
  - `agent` 工具对成员从“不可见”降级为“可见但只允许 rotate”。
  - 快照 `flush()` 从吞掉写结果升级为返回 boolean。
  - 成员交互模式下 `agent` 的 deny 降级为 `autoApprove += agent` + handler 闸门。
  - strict `send` 保留；切到 dispatch 仍留到 S3。

- **非目标**：
  - **未实现**：fork / auto-fork / 自动重试 / 平台自动 rotate / Team roster / `teams.*` RPC / hub / Web / 跨节点 / 持久化消息队列 / `context.compacted` 触发 / `request_id` 去重 / 新锁原语 / `MemberStatus` 暴露 `rotation` 或 `body_history`。
  - 不立即 cancel 旧轮；旧 Body 跑完当前轮再退役。
  - `reply()` 暂不加 Body 身份（无生产调用者）；本切片只 fencing 自动最终文本。
  - `agent.stale` 事件不删（TUI 仍消费）；留到 S3 与展示层一起删。

- **已知限制**：
  - 旧轮耗时长（权限等待 / 长工具）时，新 Body 的启动嘱托一直不跑；rotate 已提交但推进延迟。人可答权限或 close。
  - 队列只在内存：指针提交后、新 Body 消费启动嘱托前崩溃会丢失启动嘱托。handoff 文件仍在磁盘，可由人或下一次 dispatch 重新引导。
  - 旧二进制回写快照会丢掉 `body_history`。
  - `agent.limit.warning` 是 run 级限额事件，与“上下文 80%”的触发时机略有偏差；阈值同为 0.8。
  - 旧 engine dispose 抛错时进程内可能残留一个已 fencing 的 engine；close / shutdown 再兜底。

- **验证**：
  - rotate 成功后 id / name 不变，新 `session_id`，`epoch + 1`；启动嘱托是新 Body 的第一条消息（带 `--handoff` 时末尾有 `[handoff: ...]`）。
  - 新 session 可 dispatch，旧 session 返回 `unknown_member`；`MemberStatus.session_id` 报新 Body。
  - 旧 Body 的迟到回复不进入当前消息流：不写 state / usage、不 deliverToParent，只发 `stale: true` 的配对终态与 `agent.reply.stale`。
  - spawn 失败 / 快照写失败：指针不变、`rotation` 回 `stable`、排队消息留在旧 Body、返回 `rotate_failed`，不产生 fork、不自动重试。
  - 重启后 `presence = gone`，`dispatch` 返回 `resumed` 且新 session 历史连续；`body_history` ≤ 20。
  - 事件顺序 `agent.rotating` → `agent.rotated` →（旧轮结束或立即）`agent.retired`。

- **关联**：[ADR-088](ADR-088-agent-service-package.md)（AgentService 分层与唯一 schema）、[ADR-091](ADR-091-agent-body-and-presence.md)（Agent / Body 内核、快照 v2、dispatch）、[ADR-093](ADR-093-hub-control-plane.md)（S5 hub 控制面）。方向裁决见个人侧 DECISION-035 §4.6 / §14.1。

- **后续切片**：S3 Team 在 [ADR-091](ADR-091-agent-body-and-presence.md) 追加 S3 Addendum；S5 Hub 见 [ADR-093](ADR-093-hub-control-plane.md)。rotate 的入口、epoch fencing 与快照契约不变。
