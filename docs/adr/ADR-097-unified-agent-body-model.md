---
adr: 97
title: 0.27 统一 agent/body 模型：单执行路径与多 Body
status: accepted
date: 2026-10-26
related: [40, 54, 81, 86, 88, 91, 92, 95, 96]
---

## ADR-097：0.27 统一 agent/body 模型：单执行路径与多 Body

- **上下文**：0.17–0.19 期间长出了三套并行事实——`AgentService` 里的 owner / member 执行二分
  （`attachOwner` 注册外部 owner、父 turn 在 `BeforeLlm` 排空 owner 队列），core 里的
  `RuntimeHost` / `AgentHandle` 执行壳，以及 serve 里的 `RunEngine` run 账本。同一件事因此有两套
  入口、两套串行语义与两类生命周期事件（`agent.turn.*` 与 `run.*`），「一个 run 对应一条消息」
  的口径在成员路径、Team 路径与单 agent 路径上各不相同。更硬的限制来自「一个 agent 一具身体」：
  `current_body` 单指针同时被写进快照形状、rotate、epoch fencing 与 checkpoint 分区，于是同一
  agent 无法并行多个会话，durable resume 只覆盖一条身体。`RunEngine` 又让 run 的 live 视图多出
  第三份账本，与 `Scheduler` + `runStore` 重复。
- **决策**：
  1. **单一准入**：所有 agent 只经 `AgentService.admit(message)` 一个入口；`main` 用普通 create
     路径（role `single`、owner=self、无 Team、visibility `private`），与其它 agent 同一条准入、
     同一个 Scheduler。`attachOwner` / `externalOwners` / `OwnerRuntimeFacade` 与「父 turn 排空
     owner 队列」都不在模型内。
  2. **只有一套执行生命周期**：`run.*` 是唯一执行生命周期，payload 带 `agent_id` 与 `session_id`；
     一条被准入的消息对应一个 run，`agent.turn.*` 不作为执行生命周期。
  3. **Team 日志由 run 终态驱动**：成功轮从 `run.completed.output` 写 `reply` 日志，失败 / 取消轮
     从 `run.failed` / `run.cancelled` 写 `system` 条目；不发射 `agent.reply.posted`。
  4. **run 视图只有两处**：live 视图来自 tenant `InProcessScheduler`，durable 视图来自 `runStore`
     checkpoint；`RunEngine` / `RunRecord` 这第三份账本不参与 run 口径。
  5. **每 body 一个 `AgentRuntime`**：每个 body 拥有独立 context、独立 session 历史、独立
     eventLog、独立 runStore 与独立 plugin 实例；一个 agent 可同时有多个 live body，不同 body
     的历史与 checkpoint 不共享。
  6. **每 agent 上限 20 个 live body**（服务可注入覆盖）：`admit` 需要新建 body 且已达上限时返回
     稳定错误 `body_limit`（带 `agent_id` / `limit`）；已有 body 的投递不受影响。
  7. **空闲 TTL 24 小时自动 retire**（0 = 关闭）：`last_active_at + TTL` 到期且无 queued /
     running / waiting 消息即退休；primary 被 retire 时提升最近活跃的 live body 为 primary，
     没有 live body 则清空 primary，下一次 `admit` 新建。
  8. **`perBodySerial`**：`ScheduledTask.serialKey` 必填且等于 body / session id；同一 body 同时
     只有一个 running，不同 body 并发。
  9. **默认并发无上限**：`maxConcurrency` 只有显式正整数才限制并发；`maxQueueSize` 保持 100。
  10. **rotate 只退休 primary body**：rotate 退休 primary 并新建 primary（新 session id）；其它
      live body、它们的 epoch 与在途 run 完全不受影响；epoch fencing 按 body 自身判定。
  11. **`body_id ≡ session_id`**：历史、事件流、`runStore` checkpoint 与 body lease 都按 body
      分区；session 没有第二个身份。
  12. **snapshot v4**：`bodies[]` 是唯一真相，`primary_body_id` 表示缺省投递目标；`current_body` /
      `body_history` 是旧数据的兼容视图（只读、不回写）。v1–v3 可读，v3 → v4 把 `current_body`
      迁成唯一 live body + primary、旧 `body_history` 迁入 `bodies[]`。
  13. **统一入口 `runs.start → AgentService.admit`**：`runs.start { agent_id?, session_id?, input }`
      先按 `session_id` 绑定的 agent / body 解析，再走同一个 admit；`agents.send` / `dispatch` /
      Team `@` / Web / REPL / TUI 全部收敛到它，没有第二套执行队列或第二个 runtime 入口。
- **备选**：
  - **(a) 只给受影响的 ADR 追加 Errata、不新增 ADR（否决）**：Errata 是散落在 13 个文件里的补丁，
    读者要拼十几段才能还原「一个 agent 可以有多个 body」这一件事；而新模型本身（多 body、上限与
    TTL、统一入口、单 run 生命周期）没有单一权威文档可引，实现者只能回到 spec 或代码。ADR 是既有
    机制，不新增目录、脚本或字段，与 ADR-091 同层次。
  - **(b) 保留双执行入口、只做重命名（否决）**：第二套队列与第二个 runtime 入口正是本次要消灭的
    故障源——两套串行语义让「默认无上限并发」与「per-body serial」无法同时成立，事件消费方也仍要
    按两套生命周期分支。重命名只把问题藏起来，改动面还更大。
  - **(c) 每 agent 单 body + 多会话复用（否决）**：无法满足 per-body checkpoint 与同 agent 并发，
    rotate 语义仍然绑死在唯一指针上。
- **后果**：
  - 正面：所有入口收敛到一个 `admit`；run 只有一份 live 视图与一份 durable 视图；同一 agent 可并
    行多个会话，每 body 独立历史 / checkpoint / 插件实例，durable resume 覆盖全部 body。
  - 代价：多 body 并发叠加默认无上限，放大 provider 与资源压力；20 个 live body 与 24 小时间
    空闲 TTL 是唯一背压。
  - 兼容风险：snapshot v3 → v4 是本次最大兼容面，旧数据可读、不回写旧版本；`current_body` /
    `body_history` 长期以兼容视图存在，不得再作为真相写入。
  - 插件生命周期：每个 body 一个 `AgentRuntime`，插件 dispose 次数由「每 agent 一次」变成
    「每 body 恰好一次」。
  - 回归保护：仓库不保留自动化测试套件（依据 `ADDENDUM-0.27-tests-removal`），本次以
    `typecheck` / `biome` 门禁、parity 走查与人工验证覆盖。
- **关联**：
  - [ADR-040](ADR-040-durable-run-store-checkpoint-resume.md)：per-body checkpoint / resume 取代
    Host 模式与「resume 不经 Scheduler」。
  - [ADR-054](ADR-054-run-execution-and-failure-isolation.md)：单 run 与失败隔离的口径扩到 body
    ——同 body 单 run，不同 body 并发。
  - [ADR-081](ADR-081-host-parity-and-serializable-snapshot.md)：per-run session、取消链路与可序列
    化快照的主语从 Host 换成 Scheduler。
  - [ADR-086](ADR-086-transparency-and-multi-instance-safety.md)：body lease / liveness 与单写者沿
    用多实例安全规则，锁粒度是 body。
  - [ADR-088](ADR-088-agent-service-package.md)：AgentService 分层的执行内核是 tenant Scheduler，
    `main` 与其它 agent 走同一条 `admit`。
  - [ADR-091](ADR-091-agent-body-and-presence.md)：Agent / Body 关系从单 `current_body` 变为
    `bodies[]` + primary；membership / presence 语义不变。
  - [ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)：rotate 只退休 primary body，epoch
    fencing 按该 body 自己的 epoch 与退役标志判定。
  - [ADR-095](ADR-095-agent-spawn-and-contractors.md)：peer / contractor 的派生与 close 审批走同
    一个 `admit`。
  - [ADR-096](ADR-096-agent-role-and-conversion.md)：role 决策（single / member / temporary）不变，
    快照版本升到 v4。
  - **本文不 supersede 任何 ADR；旧 ADR 原文保留，与本文的差异见各 ADR 的
    `## Errata（0.27 统一 agent/body）` 段落。**
  - 过程契约不进本仓库：统一的模型与删除清单见 `PLAN-0.27-unified-agent-body`（FROZEN spec），
    验收口径的测试维度由 `ADDENDUM-0.27-tests-removal` 取代。
