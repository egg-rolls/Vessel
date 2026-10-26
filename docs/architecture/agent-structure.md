---
title: Agent 结构、成员与临时
kind: current
triggers: [agent, member, peer, contractor, temporary, owner, team, create, hire, roster, promote, demote]
paths: [packages/agent/**, apps/web/src/domains/agents/**, apps/web/src/domains/team/**]
---

# Agent 结构、成员与临时

## 身份与归属

| 身份 | `owner` | `parent` | `team` | 说明 |
|---|---|---|---|---|
| root owner | `owner === id` | 无 | 无 | 人类主 agent；只能 `hire`，不能 `create` |
| 成员（peer） | 无 | 无 | **必需** | visibility 强制 `team`；close 需人类审批 |
| 临时（contractor） | 有（root / 调用者） | 默认 = owner | 可选 | close 由 owner 或自己决定 |

- **成员/临时不是两个模型**：同一个 `PersistedAgentRecord`，区别只是 `owner` / `parent` / `team` 的组合。
- `spawnedBy` 只进 `agent.spawned` 审计事件；`parentId` 是回复/投递父节点，contractor 默认等于 owner。
- UI 文案：peer = 成员，contractor = 临时（内部仍叫 contractor）。

## 数据模型

`PersistedAgentRecord` / `MemberStatus` 关键字段：

| 字段 | 含义 |
|---|---|
| `id` / `session_id` | 持久身份 / 当前 Body（`body_id ≡ session_id`） |
| `owner?` | 归属 principal；缺省 = peer；root 自指 |
| `parent_id?` | 回复父节点；contractor 默认 owner |
| `team_id?` | 所属 Team；peer 必需 |
| `visibility` | `private` / `team` / `tenant`；peer 强制 team |
| `membership` / `state` | present/left；engine 状态 |
| `current_body` / `body_history` | 当前 Body 与退役 Body（≤20） |
| `model` / `system_prompt` | 下一个 Body 生效 |

`AgentMessage` 带 `from` / `source`（human/agent/system）/ `channel`（team/direct）；
`AgentEvent` 带 `agent_id` / `team_id` / `parent_id` / `spawned_by`。

## 创建路径

| 入口 | 能创建什么 | 关键约束 |
|---|---|---|
| `teams.create` | 只有 Team | 不创建成员 |
| `agents.create`（canonical） | peer 或 contractor | peer 必须 `team_id`；contractor 可带 `team_id` 或 unbound |
| `agent` 工具 `create` | peer | 调用者必须是有 Team 的成员；root 不可用 |
| `agent` 工具 `hire` | contractor | 任意成员可 hire；root 创建 unbound；有 Team 时继承 |
| `teams.members add` | 把已有成员/临时绑定到 Team | 不改变 owner/kind |
| Web Agents → 创建 | 成员/临时 | 选择 Team + 类型；成员需要 Team |
| CLI / owner transport | 同上 | 走 `agents.create`，可带 `workspace` |

- **创建第一个成员**：先创建 Team，再 `agents.create { kind:'peer', team_id, name }`。
  Team 为空也可以创建 peer；不需要先有成员的 Team。
- Web 的 Agents 视图只聚合 **Team roster 的 present 成员**；unbound 临时不在这里出现。
- `new` 不是当前 action；`create` = peer，`hire` = contractor。完整矩阵见
  [docs/agents/agent.md](../agents/agent.md)。

## 临时 ↔ 成员转换（设计，未实现）

理论等价：**成员 = owner 为空的临时**。转换需要同时处理 owner / parent / team / visibility：

| 方向 | owner | parent | team | visibility |
|---|---|---|---|---|
| 临时 → 成员 | 清空 | 清空 | 必需（未绑定则要求选择） | 强制 `team` |
| 成员 → 临时 | 设为 root / 调用者 | = owner | 保留或清除 | 默认 team（绑定）或 private |

建议入口：扩展 canonical `agents.update`，增加 `kind` 与可选 `team_id`；只允许 human /
owner transport 调用。**已有 Body 的 team / 权限 bridge 是 spawn 期决定的**，所以转换要么
要求先 rotate，要么明确“下一个 Body 生效”；不能只改快照假装立即生效。

## Web 状态

- 没有 Pinia。Web 使用 React Context（`ConnectionProvider` / `NodeProvider`）、
  `useResource` 与 `useSyncExternalStore`；服务端 RPC 是唯一真相源。
- 工具策略：每次 `config.get` 独立；保存后由父面板 `reload()`，卡片徽章才更新。
- `localStorage` 只放本地 UI 偏好（runtime context 可见性、orphan toast 已读）。

相关：[member-team](member-team.md)、[gateway-rpc](gateway-rpc.md)、[context](context.md)。
