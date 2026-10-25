---
adr: 95
title: 0.27 成员再派生：peer / contractor、冻结与 close 审批
status: accepted
date: 2026-10-25
related: [79, 88, 91, 92]
tags: [agent, spawn, peer, contractor, team, owner, freeze, permission, rpc, audit]
---

## ADR-095：0.27 成员再派生：peer / contractor、冻结与 close 审批

- **上下文**：ADR-091 的 Team 让成员共享 roster 与日志，但派生仍只由 owner 完成：成员不能在自己的 Team 里找同伴，owner 也不能把成员以「合同工」形式收进自己名下。0.26 已把生命周期收口为 canonical `agents.create`，但条目只有单一形状（隐式 owner = 调用者），close 没有成员发起时的审批语义，Team 也缺一个「停止增长」的运维闸门。本 ADR 只记录 0.27 S1–S5 已实现的部分；TTL、预算与跨 Team 派生不在其中。

- **决策**：
  1. **两条派生路径**：`peer`（同 Team 的平级成员）无 owner / parent，必须绑定 `team_id`，visibility 强制 `team`；`contractor`（合同工）由 owner 拥有，`owner` / `parent_id` 缺省填 owner（工具路径为调用者，service 缺省是 root owner），有 Team 时 visibility 缺省 `team`、unbound 时缺省 `private`。`kind` 缺省保持旧行为（绑定 Team 缺省 team、否则 private）。
  2. **owner 可选**：`CreateMemberInput.owner?: string | null`；`null` 表示显式无 owner（peer），缺省 `undefined` 由入口 / service 补齐为 owner（root owner 或调用者）。快照与 roster 条目仍以 `owner?` 表达归属。
  3. **每 Team present ≤ 20**：`TEAM_MEMBER_LIMIT = 20`，peer 与 contractor 都计入；`create` / `hire` / `fork` / `reinstate` 增长前检查，超限返回 `team_full`。同 Team 的幂等 reinstate 不增长，不被上限或冻结拦。冻结 / 上限 / 名字检查 / `registry.add` 之间不得有 await。
  4. **工具两套动作**：`agent` 工具 root owner 可见 `hire|send|close|list|rotate|post`（root 无 Team，不暴露 `create`）；成员 Body 可见 `create|hire|close|rotate|post|send|list`。`create` 只创建同 Team peer；`hire` 创建由调用者拥有的 contractor（root owner 下为 unbound）。
  5. **canonical `agents.create` 可带 `kind`**：条目增加 `kind?: 'peer' | 'contractor'`；`kind` 路径只通过 `team_id` 绑定 Team（不接受 `workspace`），peer 必须有 `team_id`，contractor 可省略（unbound）。结果 `agent` 的 `owner` 仍可选；旧形状（无 `kind`）语义不变。
  6. **close 审批**：`agent.close` 的权限在 `checkPermission` 完成。self-close、owner 关闭 contractor（同 owner 或同 Team）、root owner 调用直接 allow；成员关闭 peer 返回 `ask`，由权限 bridge 交给人类审批；root owner 记录不可被成员关闭、跨 Team contractor 关闭返回 `deny`；headless / 无 bridge 时 `ask` 按 fail-closed 变 `deny`。批量 close 只要含 peer 就整体 ask 一次。
  7. **级联关闭**：owner close 时按 registry 原始记录级联关闭其 `private` contractor（递归覆盖链式 private）；`team` 可见的 contractor 保持 present，队友仍可寻址。
  8. **Team 冻结**：canonical `teams.spawnFrozen`（`write`）`{team_id, frozen}` → `TeamSummary`；`TeamSummary.spawn_frozen?` 回显，`TeamRecord.spawn_frozen?` 持久化（false 删除字段）。冻结期间该 Team 的 `create` / `hire` / 人类 `agents.create` / `fork` / `reinstate` 全部返回 `team_frozen`；只有 `spawnFrozen: false` 解冻，`teams.update` 不改该字段。CLI 为 `vessel team freeze|unfreeze <team_id>`。
  9. **审计**：`agent.spawned` payload 带 `spawned_by`；Team join system 日志的 `from` 取 `spawned_by`（缺省仍是 `system`）。private 成员按既有规则不写 Team 日志。
  10. **`permission.neverAutoApprove`**（YAML `never_auto_approve`）：命中工具名或 `tool.action` 时，只把来自 `autoApprove` / 默认放行的 allow 降级为 ask；工具 `checkPermission` 的显式 allow / ask / deny 不受影响。未配置时装配层默认有效值为 `['agent.close']`；显式配置整体替换默认。headless 无审批通道时降级后的 ask 仍 fail closed。

- **Frozen contract**：
  - `CreateMemberInput`：`kind?` / `owner?: string | null` / `teamId?` / `spawnedBy?`；`kind` 不持久化，只决定 owner / parent / visibility / 校验。
  - `TeamRecord.spawn_frozen?` / `TeamSummary.spawn_frozen?`：布尔，缺省无字段；写路径只有 `teams.spawnFrozen`。
  - `agents.create` 条目：`kind?`、`team_id?`、`name?`、`model?`、`system_prompt?`、`visibility?`（owner 传输额外允许 `workspace?`，peer / contractor 不接受）。
  - 错误码：`team_full`、`team_frozen`（稳定业务码，逐条返回）。
  - 工具动作：root `hire|send|close|list|rotate|post`；成员 `create|hire|close|rotate|post|send|list`。

- **Delete / Downgrade**：
  - 工具动作 `new` 降级为 `create`（peer）与 `hire`（contractor）；不保留 `new` 别名。
  - `CreateMemberInput.owner` 从必填降级为可选，并用 `null` 表达显式无 owner；无兼容别名。
  - close 的成员发起审批下沉到 `checkPermission`，不新增 RPC；`agents.close` 仍是人类路径。
  - 不新增持久化派生表：owner / parent / team 仍是 Agent 记录字段。

- **非目标**：
  - 不做 TTL / 自动回收、spawn 预算或速率限制。
  - 不允许跨 Team 的 peer / contractor；不自动总结或继承父 Agent 的历史。
  - 不新增 Web 页面；不做 fork 语义扩展。
  - 不引入 `agent.new` / `agent.close` 旧 wire 别名。

- **已知限制**：
  - 20 是硬编码上限，尚不可按 Team 配置。
  - 冻结只拦增长，不暂停已有成员的运行 / 投递 / close。
  - 级联只覆盖 `private` contractor；`team` 可见 contractor 在 owner 关闭后仍 present。
  - close 审批依赖权限 bridge；headless 无 bridge 时成员无法关闭 peer（fail closed）。
  - private 成员不写 Team 日志，因此 join 审计只覆盖 team / tenant 可见成员。

- **验证**：
  - peer 无 owner / parent、必须同 Team、visibility 强制 team；contractor 缺省 owner / parent 为 owner（工具路径是调用者）。
  - 第 21 个 present 成员（含 contractor）返回 `team_full`；fork / reinstate 同样受限；幂等 reinstate 不受影响。
  - 冻结后 create / hire / 人类 `agents.create` / fork / reinstate 均 `team_frozen`；`spawnFrozen false` 解冻。
  - 成员 close peer 经 bridge ask；owner 关闭 private contractor 级联，team 可见 contractor 保留。
  - `agent.spawned.spawned_by` 与 Team join `from` 一致；`neverAutoApprove` 只降级 auto allow。

- **关联**：[ADR-079](ADR-079-permission-lifecycle-persistence.md)（权限生命周期）、[ADR-088](ADR-088-agent-service-package.md)（AgentService 分层）、[ADR-091](ADR-091-agent-body-and-presence.md)（Agent / Body / Team）、[ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)（rotate / epoch fencing）。
