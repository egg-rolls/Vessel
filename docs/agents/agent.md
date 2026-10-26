---
title: AgentService 与 Team 约定
kind: advisory
triggers: [agent, member, team, session, dispatch, rotate, fork, spawn, peer, contractor, owner, freeze, budget, visibility, agent tool, permission, answered_by, human, deny-after, timeout, approval]
paths: [packages/agent/**]
applies_to: [N, M]
---

# AgentService 与 Team 约定

> 改 `packages/agent/**` 前读这一篇；权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## AgentService 唯一

- 成员能力只由 `packages/agent` 实现；权限 bridge 唯一活路径是 `InProcessMemberRuntime.attachBridge`，不得恢复第二套桥；`packages/core` 不出现 member / owner / visibility / team 概念（ADR-088 / ADR-091）。
- 内置 `agent` 工具是唯一模型 schema：single 动作 `hire` / `send` / `close` / `list` / `rotate` / `post`（single 无 Team，不暴露 `create`）；成员 Body 动作 `create` / `hire` / `close` / `rotate` / `post` / `send` / `list`。工具调用者的 owner / parent 固定，模型不能伪造。
- 持久化 `role`：`single`（owner=self，无 Team）、`member`（owner=self，Team 必需）、`temporary`（owner=雇佣者，Team 可选）。`create` → member，`hire` → temporary；v3 快照读取 v2 时按旧 owner 推断 role。
- 不得新增 `wait` / `inbox` / `status` / `cancel`；等待语义是结束这一轮、回复作为新 turn 到达。
## 派生：peer / contractor

- 创建判别仍是 `kind:'peer'|'contractor'`：peer → `role:'member'`（owner=self、无 parent、必须 Team、visibility 强制 `team`）；contractor → `role:'temporary'`（owner/parent 缺省是雇佣者，有 Team 时 visibility 缺省 `team`、unbound 缺省 `private`）。
- 每 Team present 成员 ≤ 20（peer + contractor 都计入）；`create` / `hire` / `fork` / `reinstate` 增长前检查，超限必须是 `team_full`。同 Team 的幂等 reinstate 不增长，不得被上限或冻结误拦。
- 冻结是 Team 元数据 `spawn_frozen`：冻结期间 `create` / `hire` / 人类 `agents.create` / `fork` / `reinstate` 一律 `team_frozen`；只能由 `teams.spawnFrozen false` 解冻，`teams.update` 不改该字段。
- 审计：`agent.spawned` payload 带 `spawned_by`，Team join system 日志的 `from` 取它；private 成员按既有规则不写 Team 日志。

### create / hire 矩阵

| 调用者 | action | 结果 |
|---|---|---|
| single | `hire` | `temporary`；owner / parent = single；unbound（无 `team_id`） |
| 有 Team 的成员（含 temporary） | `hire` | `temporary`；owner / parent = 调用者；`team_id` = 调用者 Team，计入 20 人上限与 `team_frozen` |
| 无 Team 的成员（unbound temporary） | `hire` | `temporary`；owner / parent = 调用者；无 `team_id`，不计 Team 上限 |
| 有 Team 的成员 | `create` | `member`；owner=self；无 parent；强制调用者 Team、visibility `team` |

- 转换：`agents.update { role, team_id? }`；member 需要 Team，temporary 的 owner 是转换者，
  single 清空 Team。team-scoped token 只能转本队；不要求新 Body，只追加 `vessel:notice`。
- `hire` 对任意成员开放；single 与 unbound 成员都落 unbound 分支。`create` 只给有 Team 的成员，
  single 只能 `hire`。action 无 `new`。

## session / Body

- `create` 创建的成员初始 `session_id === id`；`rotate` 换活 Body，旧 Body 进 `body_history`。
- 状态机：`created|idle|running|waiting_permission|completed|failed|cancelled|closed`；`stale` 只读兼容、不得再写入；重启后非 `left` 成员为 `idle + presence='gone'`（ADR-091/092）。

## 投递与 Team

- `dispatch` 是统一投递入口：live / rotating 入队，gone 先 single-flight resume 再入队；不得在每个入口重写状态检查或并发 spawn。fork 只在 `gone + resume` 失败后按 policy / 显式 `allow_fork` 发生；rotate 失败保持旧身体（ADR-091/092）。
- close 的审批在权限层完成：self、owner 关闭 contractor（同 owner 或同 Team）、root owner 调用直接放行；成员关闭 peer 必须经 bridge 由人类审批；root owner 记录与跨 Team contractor 必须拒绝；无 bridge 时 ask 必须 fail closed。owner close 级联自己的 private contractor，team 可见 contractor 保留。
- Team 日志不是队列：无 `@` 的 post / reply / system 绝不产生 run；`@` 必须先写日志再 dispatch；`TeamService` 是唯一写入点。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；team-scoped token 只能访问自己的 `team_id`，不匹配 `not_found`。
- `teams.create` 仅 human / admin；`archive` 拒绝 present 成员（`team_not_empty`），不提供隐式 hard delete。

## 预算

- conversation 预算挂 `teams[].policy.budget`，不复用 `limits.*`；状态写 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除。

## 指针

- RPC 形状：[gateway-rpc.md](../architecture/gateway-rpc.md#agent-lifecycle)；配置字段：[CONFIG.md](../operations/CONFIG.md)；决策：[ADR-095](../adr/ADR-095-agent-spawn-and-contractors.md)。
- 权限默认无限 / only-human 见 AGENTS.md 硬安全规则；本文件不复述。
