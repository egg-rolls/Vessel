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
- 内置 `agent` 工具是唯一模型 schema：root owner 动作 `hire` / `send` / `close` / `list` / `rotate`（root owner 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `send` / `list`。Team 日志写入不在本工具内：`agent post` 已移除（它只追加日志、不投递、不唤醒，静默丢报告），需要写日志走 CLI `vessel team post`。工具调用者的 owner / parent 固定，模型不能伪造。
- 持久化 `role` 只有 `member`（owner=self，Team 必需；`main` 也是 member）与 `temporary`（owner=雇佣者，Team 可选）。0.27 的 `single` 已删除；v3 及更早快照里的 `role:'single'` 只在读取时降级为 `member` 并补绑 default Team，写回不再出现。
- 不得新增 `wait` / `status` / `cancel`；`inbox` 已是成员收件箱工具（`list` / `read` / `delete` / `insert`），等待语义仍是结束这一轮、回复作为新 turn 到达。
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
- close 的审批在权限层完成：self、owner 关闭 contractor（同 owner 或同 Team）、root owner 调用直接放行；成员关闭 peer 必须经 bridge 由人类审批；root owner 记录与跨 Team contractor 必须拒绝；无 bridge 时 ask 必须 fail closed。owner close 级联自己的 private contractor，team 可见 contractor 保留。
- Team 日志不是队列：无 `@` 的 post / reply / system 绝不产生 run；`@` 必须先写日志再逐条 `admit`；`TeamService` 是唯一写入点，reply 由 `run.completed.output` 驱动、失败 / 取消写 `system` 条目。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；team-scoped token 只能访问自己的 `team_id`，不匹配 `not_found`。
- `teams.create` 仅 human / admin；`archive` 拒绝 present 成员（`team_not_empty`），不提供隐式 hard delete。

## 预算

- conversation 预算挂 `teams[].policy.budget`，不复用 `limits.*`；状态写 `<dataDir>/conversations/<id>.json`（`0600` 原子写、损坏 fail-closed；`<id>` 是内部持久单 id，不是 wire 字段）；override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除。

## 指针

- RPC 形状：[gateway-rpc.md](../architecture/gateway-rpc.md#agent-lifecycle)；配置字段：[CONFIG.md](../operations/CONFIG.md)；决策：[ADR-095](../adr/ADR-095-agent-spawn-and-contractors.md) · [ADR-097](../adr/ADR-097-unified-agent-body-model.md)。
- 权限默认无限 / only-human 见 AGENTS.md 硬安全规则；本文件不复述。
