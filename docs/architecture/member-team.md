---
title: AgentService、Body 与 Team
kind: current
triggers: [agent, member, team, body, session, dispatch, send, rotate, fork, presence, membership, visibility, roster, budget, conversation]
paths: [packages/agent/**, src/agent-service-wiring.ts, src/team-command.ts]
---

# AgentService、Body 与 Team

> 成员能力层的当前事实。RPC 方法形状见 [gateway-rpc.md](gateway-rpc.md#agent-lifecycle)；改动前的硬约定见 [docs/agents/agent.md](../agents/agent.md)。core 不知道 member / owner / visibility（ADR-088）。

<a id="layering"></a>

## 分层与唯一实现

- `packages/agent` 是唯一成员能力实现：注册表、状态机、消息队列、可见性、回复投递、权限 bridge 与快照都在包内；入口（REPL / CLI / Gateway / Web）只解析输入、调用 `AgentService`、渲染事件。
- 装配在 `src/agent-service-wiring.ts`；owner 队列经父 turn 的 `BeforeLlm` 注入。不得在入口或插件里复制第二套成员生命周期。

<a id="identity-body"></a>

## Agent 身份与 Body

- **Agent 是持久身份，Body 是 session + engine**：`body_id ≡ session_id`，`current_body` 是唯一持久指针，`epoch` 存在 `current_body` 内。首具 Body 的 `session_id` 与 agent id 相同。
- `PersistedAgentRecord` 持久化 `membership` / `model` / `system_prompt` / `current_body` / `forked_from` / `body_history?`；`presence` / `rotation` 不落盘。`body_history` 只记录已退役 Body，最多 20 条，当前 Body 不在其中。
- 快照写 `version: 2`；读取兼容 v1，首次写 v2 前把 v1 备份为 `<tenant>.json.v1.bak`，备份失败则放弃本次写。

<a id="state"></a>

## 三层状态

| 层 | 取值 | 是否持久化 |
|---|---|---|
| `membership` | `present` / `left` | 是 |
| `presence` | `live` / `gone` | 否（进程内） |
| engine state | `created` / `idle` / `running` / `waiting_permission` / `completed` / `failed` / `cancelled` / `closed` | 快照派生 |

- 派生不存储：`canAccept = present && live && stable`；`needsResume = present && gone`；`rotating = present && rotation === 'rotating'`。
- 重启加载：`closed` 或 `membership === 'left'` → `left + gone + closed`；其它 → `present + gone + idle`。不得再写 `stale`；`stale` 只作旧快照 / 旧 wire 只读兼容，转移仅 `stale → closed`。
- `attachOwner` 是 root owner 的显式 `left → present` 例外；Team roster `add` 的 `reinstate` 是第二条人力路径，engine 不得复活成员。

<a id="dispatch"></a>

## 投递：dispatch 与 strict send

- `AgentService.dispatch({to, content, from?})` 是统一投递入口；`to` 按 id → session_id → 唯一 name 解析。
- 顺序：`left` / `closed` / closing → `agent_left`；`rotating` → 入队；`live` → 入队；`gone` → single-flight `ensureResumed()` 后入队（失败 `resume_failed`）；不可见 → `not_visible`。resume 与入队之间要复查 `membership` / `presence`，close 竞态不得投进已关闭成员。
- strict `send` 不 resume：`left` / `closed` 返回 `member_closed`，`gone` 返回 `member_stale`。两个入口都复用唯一 `enqueueMessage()`，不写第二套队列。
- fork 只有一个触发点：`dispatch` 在 `presence === 'gone'` 且 resume 失败后，按 `teams[].policy.allowFork` / owner 显式 `allow_fork` 尝试；不新增工具动作或 RPC。失败零写入，源记录保持不变。

<a id="rotate"></a>

## rotate 与 epoch fencing

- 只有活 Body 可 rotate：`presence !== 'live'` 返回 `body_not_live`；同一 Agent 已有进行中的 rotate 返回 `rotating`。模型侧 `agent` 工具只能 rotate 自己，靠 `from_session_id` 等于当前 Body 做最终闸门。
- 切换顺序固定：spawn 新 Body → 旧指针写入 `body_history` → `setCurrentBody` → 快照落盘 → 启动嘱托入队 → `rotation = stable`。spawn 或快照失败时恢复旧指针、dispose 新 engine、返回 `rotate_failed`，不自动重试。
- 旧轮按 epoch fencing：当前 Body 已变化时，发带 `stale: true` 的配对终态与 `agent.reply.stale`，不写 state / usage、不 `deliverToParent`。
- 事件：`agent.rotating` / `agent.rotated` / `agent.rotate.failed` / `agent.retired` / `agent.reply.stale`；payload 不带启动嘱托正文。

<a id="team"></a>

## Team、可见性与预算

- roster 是派生视图：`team_id + membership = present`，不单独持久化。Team 记录与日志在 `<dataDir>/teams/<tenant>/<team_id>/`；`TeamService` 是日志唯一写入点。
- **Team 日志不是队列**：无 `@` 的 post / reply / system 记录只追加，不 dispatch、不产生 run；`@` 必须先写日志再逐条 dispatch。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；Team 成员强制权限 bridge，只有 human / policy 能应答。
- conversation 预算挂 `teams[].policy.budget`，状态写 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人抬高或清除。

## 约束

- canonical `agents.*` / `teams.*` 是唯一契约，owner 端点只做传输；不要恢复 `agent.*` / `team.*` legacy wire 名（ADR-091 0.26 Addendum）。
- 消息队列只在内存，重启丢失未处理消息；不新增持久化消息队列。
- 成员会话会出现在 tenant `sessions.list` 中；不得把 `packages/core` 变成 member-aware。

## 指针

- [gateway-rpc.md](gateway-rpc.md#agent-lifecycle) · [assembly.md](assembly.md#assembly) · [config.md](config.md#config-model) · [docs/agents/agent.md](../agents/agent.md)
- 决策：[ADR-088](../adr/ADR-088-agent-service-package.md) · [ADR-091](../adr/ADR-091-agent-body-and-presence.md) · [ADR-092](../adr/ADR-092-agent-rotate-and-epoch-fencing.md) · [ADR-087](../adr/ADR-087-unified-agent-tool-phase-a.md)
