---
title: AgentService 与 Team 约定
kind: advisory
triggers: [agent, member, team, session, dispatch, rotate, fork, budget, visibility, agent tool, permission, answered_by, human, deny-after, timeout, approval]
paths: [packages/agent/**]
applies_to: [N, M]
---

# AgentService 与 Team 约定

> 改 `packages/agent/**` 前读这一篇；权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## AgentService 唯一

- 成员能力只由 `packages/agent` 实现；权限 bridge 唯一活路径是 `InProcessMemberRuntime.attachBridge`，不得恢复第二套桥；`packages/core` 不出现 member / owner / visibility / team 概念（ADR-088 / ADR-091）。
- 内置 `agent` 工具是唯一模型 schema：owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`；成员侧只暴露 `rotate` / `post` / `send` / `list`；工具调用者的 owner / parent 固定为 owner、模型不能伪造。
- 不得新增 `wait` / `inbox` / `status` / `cancel`；等待语义是结束这一轮、回复作为新 turn 到达。

## session / Body

- `new` 创建的成员初始 `session_id === id`；`rotate` 换活 Body，旧 Body 进 `body_history`。
- 状态机：`created|idle|running|waiting_permission|completed|failed|cancelled|closed`；`stale` 只读兼容、不得再写入；重启后非 `left` 成员为 `idle + presence='gone'`（ADR-091/092）。

## 投递与 Team

- `dispatch` 是统一投递入口：live / rotating 入队，gone 先 single-flight resume 再入队；不得在每个入口重写状态检查或并发 spawn。fork 只在 `gone + resume` 失败后按 policy / 显式 `allow_fork` 发生；rotate 失败保持旧身体（ADR-091/092）。
- Team 日志不是队列：无 `@` 的 post / reply / system 绝不产生 run；`@` 必须先写日志再 dispatch；`TeamService` 是唯一写入点。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；team-scoped token 只能访问自己的 `team_id`，不匹配 `not_found`。
- `teams.create` 仅 human / admin；`archive` 拒绝 present 成员（`team_not_empty`），不提供隐式 hard delete。

## 预算

- conversation 预算挂 `teams[].policy.budget`，不复用 `limits.*`；状态写 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除。

## 指针

- RPC 形状：[gateway-rpc.md](../architecture/gateway-rpc.md#agent-lifecycle)；配置字段：[CONFIG.md](../operations/CONFIG.md)。
- 权限默认无限 / only-human 见 AGENTS.md 硬安全规则；本文件不复述。
