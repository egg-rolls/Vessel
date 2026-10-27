---
title: Agent 结构、成员与临时
kind: current
triggers: [agent, member, peer, contractor, temporary, single, owner, team, create, hire, role, promote, demote]
paths: [packages/agent/**, apps/web/src/domains/agents/**, apps/web/src/domains/team/**, apps/web/src/stores/**]
---

# Agent 结构、成员与临时

## 角色

| role | `owner` | `parent` | `team` | 说明 |
|---|---|---|---|---|
| `single` | self | 无 | 无 | 单个 agent；只能 `hire`，不能 `create` |
| `member` | self | 无 | **必需** | visibility 强制 `team`；close 需人类审批 |
| `temporary` | 雇佣者 | 默认 owner | 可选 | close 由 owner 或自己决定 |

- 同一个 `PersistedAgentRecord`；区别是 `role` / `owner` / `parent` / `team` 的组合。
- UI：`member` = 成员，`temporary` = 临时；`single` 不在 Team roster 里。
- `main` 是普通 `single`（owner=self、无 Team、visibility `private`），走普通 create 与 `admit`；没有外部 owner，也不由父 turn 驱动。管理面 human 可见，其它 agent 不可见（ADR-097）。
- `parent_id` 是回复/投递父节点；`spawnedBy` 只进 `agent.spawned` 审计事件。

## 数据模型 v4

| 字段 | 含义 |
|---|---|
| `role` | `single` / `member` / `temporary` |
| `owner` | single/member = self，temporary = 雇佣者 |
| `parent_id` / `team_id` | 回复父节点 / Team；temporary 的 parent 默认 owner |
| `visibility` | private / team / tenant；member 强制 team |
| `bodies[]` | 全部 Body（含已退役，退役保留 ≤50）；唯一真相 |
| `primary_body_id` | 缺省投递目标（primary body 的 body_id） |
| `current_body` / `body_history` | 兼容视图：旧 primary 指针 / 已退役 primary（≤20）；只读、不回写 |
| `model` / `system_prompt` | 下一个 Body 生效 |

- `AGENT_SNAPSHOT_VERSION = 4`；v1 / v2 / v3 可读，不回写旧版本。
- v3 → v4：`current_body` 迁成唯一 live body + primary，旧 `body_history` 迁入 `bodies[]`；
  首次写 v4 前备份 `.v3.bak`（v1 / v2 各保留 `.v1.bak` / `.v2.bak`）。
- v2 → v3：`owner===id` → single；`owner` 缺省 → member；`owner≠id` → temporary；
  single/member 的 owner 补成 id。旧 `owner===undefined` / `owner===id` 判定全部改按 `role`。
- 每 agent 最多 20 个 live body；`bodies[]` 里已退役条目保留 ≤50，超限淘汰最旧。

## 创建

| 入口 | 结果 |
|---|---|
| `teams.create` | 只创建 Team |
| `agents.create kind:'peer'` | `member`，owner=self，team 必需 |
| `agents.create kind:'contractor'` | `temporary`，owner=调用者/default，team 可选 |
| `agent` 工具 `create` | `member`（调用者必须有 Team；single 不可用） |
| `agent` 工具 `hire` | `temporary`（任意成员可 hire；有 Team 则继承） |
| `teams.members add` | single → member；temporary 保持 temporary |
| Web Agents → 创建 | 选择 Team + 类型；成员需要 Team |

- **创建第一个成员**：先建 Team，再 `agents.create { kind:'peer', team_id, name }`。
  空 Team 也可以创建 member。
- Agents 视图合并 Team roster 与 canonical `agents.list`：无 Team 的 `single` 以节点级
  条目展示（不显示 Team，无 Team 入口）；人类管理面 token 能看到 private single，
  其它 agent 仍看不到。unbound 临时不在这里出现。Team 页仍只显示 member + temporary。
- `new` 不是当前 action；`create` = peer/member，`hire` = contractor/temporary。

## 转换

`agents.update` 增加 `role` / `team_id`：

| 目标 | owner | parent | team | visibility |
|---|---|---|---|---|
| `member` | self | 无 | 必需 | team |
| `temporary` | 转换者 | = owner | 可选 | team / private |
| `single` | self | 无 | 清空 | private |

- 权限：human / owner transport 可转任意可见成员；team-scoped token 只能转本队，
  不能转 single 或换 Team。
- 转换只改记录 + roster + snapshot，**不要求新 Body**；已有 Body 继续运行。
- 向成员上下文追加 `vessel:notice`（`identity changed: old → new; owner=...; team=...`），
  不启动 turn。Self Card 保持冻结，不改 system 前缀。
- 事件 `agent.role.changed`。
- Team 绑定决定 single ↔ member：加入 Team 自动变 member；显式转 single 才离开 Team。
  temporary 绑定 Team 仍是 temporary。

## Web 状态

- 使用 **Zustand** 域 store：`nodeStore` / `teamStore` / `agentStore` / `configStore`；
  `ConnectionProvider` 保留 WS/token/事件分发。
- 工具策略、config、capabilities 由 `configStore` 单一来源；保存后卡片/弹窗同步。
- `localStorage` 只放本地 UI 偏好（runtime context 可见性、orphan toast 已读）。

相关：[member-team](member-team.md)、[gateway-rpc](gateway-rpc.md)、[context](context.md)。
