---
title: Agent 结构、成员与临时
kind: current
triggers: [agent, member, peer, contractor, temporary, owner, team, create, hire, role, promote, demote]
paths: [packages/agent/**, apps/web/src/domains/agents/**, apps/web/src/domains/team/**, apps/web/src/stores/**]
---

# Agent 结构、成员与临时

## 角色

| role | `owner` | `parent` | `team` | 说明 |
|---|---|---|---|---|
| `member` | self | 无 | **必需** | visibility 强制 `team`；close 需人类审批 |
| `temporary` | 雇佣者（缺省 `human`） | 默认 owner | 可选 | close 由 owner 或自己决定 |

- 同一个 `PersistedAgentRecord`；区别是 `role` / `owner` / `parent` / `team` 的组合。
- UI：`member` = 成员，`temporary` = 临时。
- `main` 是普通 `member`（owner=self、必须有 Team、visibility `team`），用 `kind:'peer'` + `workspace` 创建；没有外部 owner，也不由父 turn 驱动。
- 所有 agent 都属于某个 Team（无 unbound member）；`main` 不例外。
- `parent_id` 是回复/投递父节点；`spawnedBy` 只进 `agent.spawned` 审计事件。

## 数据模型 v4

| 字段 | 含义 |
|---|---|
| `role` | `member` / `temporary` |
| `owner` | member = self，temporary = 雇佣者（缺省 `human`） |
| `parent_id` / `team_id` | 回复父节点 / Team；temporary 的 parent 默认 owner |
| `visibility` | private / team / tenant；member 强制 team |
| `bodies[]` | 全部 Body（含已退役）；唯一真相 |
| `primary_body_id` | 缺省投递目标（primary body 的 body_id） |
| `current_body` / `body_history` | 兼容视图：旧 primary 指针 / 已退役 primary（≤20）；只读、不回写 |
| `model` / `system_prompt` | 下一个 Body 生效 |

- `AGENT_SNAPSHOT_VERSION = 4`；v1 / v2 / v3 可读，不回写旧版本。
- v3 → v4：`current_body` 迁成唯一 live body + primary，旧 `body_history` 迁入 `bodies[]`；
  首次写 v4 前备份 `.v3.bak`（v1 / v2 各保留 `.v1.bak` / `.v2.bak`）。
- v2 → v3：`owner===id` → member；`owner` 缺省 → member；`owner≠id` → temporary；
  成员的 owner 补成 id。旧 `owner===undefined` / `owner===id` 判定全部改按 `role`。
- v3 及更早写出的 `role:'single'`（旧 `main`）在**读取时**降级为 `member`，并补绑
  default Team；写回时不再出现 `single`。
- 每 agent **恰好一具 live body**（`body_id ≡ session_id`）；唯一例外是 `rotation === 'rotating'`
  期间允许两具（新 + 待退役），窗口结束回到一具。
- `bodyHistory` 只追加，上限 `MAX_BODY_HISTORY = 20`。

## 创建

| 入口 | 结果 |
|---|---|
| `teams.create` | 只创建 Team |
| `agents.create kind:'peer'` | `member`，owner=self，team 必需（`main` 走这条） |
| `agents.create kind:'contractor'` | `temporary`，owner=雇佣者，team 可选 |
| `agents.create` 不传 kind / owner | `temporary`，owner 缺省 `human` |
| `agent` 工具 `create` | `member`（调用者必须有 Team） |
| `agent` 工具 `hire` | `temporary`（任意成员可 hire；有 Team 则继承） |
| `teams.members add` | temporary → member |
| Web 新会话 | 首条消息时 `agents.create{name}` → `runs.start{agent_id}`（不复用、不传固定名） |

- **创建第一个成员**：先建 Team，再 `agents.create { kind:'peer', team_id, name }`。
  空 Team 也可以创建 member。
- `role` 参数只做一致性校验：与 `kind` / `owner` 推导出的角色冲突即 `invalid_input`，
  不能用它覆盖 peer 推导。
- Agents 视图合并 Team roster 与 canonical `agents.list`。Team 页只显示 member + temporary。
- `new` 不是当前 action；`create` = peer/member，`hire` = contractor/temporary。

## 转换

`agents.update` 增加 `role` / `team_id`：

| 目标 | owner | parent | team | visibility |
|---|---|---|---|---|
| `member` | self | 无 | 必需 | team |
| `temporary` | 转换者 | = owner | 可选 | team / private |

- 权限：human / owner transport 可转任意可见成员；team-scoped token 只能转本队，不能换 Team。
- 转换只改记录 + roster + snapshot，**不要求新 Body**；已有 Body 继续运行。
- **上下文策略随角色热切换**：`temporary` 不主动压缩（到线只提示），`member` 恢复主动压缩。
  转换后同一具 live body 上开关立即翻转，下一次 run 即按新角色生效。压力提示的**文案**是
  spawn 期参数，转正后活体仍会说旧文案，因此转换时额外追加一条 `vessel:notice` 明确当前策略。
- 向成员上下文追加 `vessel:notice`（`identity changed: old → new; owner=...; team=...`），
  不启动 turn。Self Card 保持冻结，不改 system 前缀。
- 事件 `agent.role.changed`。
- Team 绑定决定 temporary ↔ member：加入 Team 且 `kind:'peer'` 变 member；
  temporary 绑定 Team 仍是 temporary。
- 回收：仅 `temporary` 且 `present` 可被空闲 TTL 回收（`membership='left'` + `state='closed'`，
  body 记录保留标 `retiredAt`）；`member`（含 `main`）永不回收。复活走 `reinstate`。

## Web 状态

- 使用 **Zustand** 域 store：`nodeStore` / `teamStore` / `agentStore` / `configStore`；
  `ConnectionProvider` 保留 WS/token/事件分发。
- 工具策略、config、capabilities 由 `configStore` 单一来源；保存后卡片/弹窗同步。
- `localStorage` 只放本地 UI 偏好（runtime context 可见性、orphan toast 已读）。

相关：[member-team](member-team.md)、[gateway-rpc](gateway-rpc.md)、[context](context.md)。
