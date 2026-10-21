---
adr: 87
title: 0.16.0 统一 agent 工具（Phase A）
status: accepted
date: 2026-10-21
related: [37, 81, 86]
tags: [agent, tools, session, registry, permission, events, config, compatibility]
---

## ADR-087：0.16.0 统一 agent 工具（Phase A）

- **上下文**：0.15 之前模型侧同时存在两套成员能力：`delegate_task`（一次性子任务，内联返回结果）与 `team_*`（spawn / send / inbox / status / cancel）。前者把"等待结果"写进一次工具调用，后者把收件箱轮询暴露给模型；两者都不符合"消息自然到达、等待就是结束这一轮"的交互模型。权限方面，delegate 有 bridge，team 成员没有统一的 `permissionMode`；成员状态只存在于各工具自己的返回里，`agents.tree` 与成员身份没有一一对应。Phase A 的目标是把模型工具面收敛到一个 `agent` schema，并让 session、成员注册表、成员事件与权限桥成为同一条链路。

- **决策**：
  1. **唯一 `agent` schema**：动作固定 `spawn` / `send` / `close`。`spawn` 创建 session 并注册成员，返回成员状态；`send` 入队后立即返回 `{queued: true, message_id}`，不阻塞、不等待结果；`close` 幂等释放成员。模型工具面**不提供** `wait` / `inbox` / `status` / `cancel`；这些是 UI / CLI / 控制面能力（`agents.tree` / `agents.list` 与既有取消路径）。
  2. **session 即成员**：`spawn` 创建的 session 与成员 1:1（`session_id === agent_id`），`to` / `member` 既可传成员 id 也可传 session id。注册表记录 `id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `permission_mode` / `state` / `current_tool?` / `last_seen?` / `usage?`；只有注册成员可被 `send` 寻址，未注册 session 仍是普通本地会话。
  3. **可见性**：`visibility` 取 `private`（默认，仅 owner）/ `team` / `tenant`；跨 tenant 不可寻址。Phase A 中 `team` 与 `tenant` 在本机同一 tenant 内等价，跨节点授权沿用 team transport 的显式配置。
  4. **成员状态机**：`created` → `idle` → `running` →（`completed` / `failed` / `cancelled`）→ `closed`；权限等待插入 `waiting_permission`；`stale` 为定义位，表示进程 / owner 不可达。状态与 `agents.tree` / `agents.list` 的 `state` 同名同义。
  5. **父 turn 注入**：core 的 `HookContext.messages?: Message[]`（additive）作为 `BeforeLlm` 注入位；runtime 在组装请求前把消息按返回顺序写入上下文一次，按 `name` / `timestamp` 稳定键或对象引用去重，每个 run 重置。装配层用 owner inbox 排空实现成员回复注入：回复映射为 `role: 'user'`、`name: 'agent:<id>'`、内容 `[agent <id>] <content>`，`timestamp` 取原消息时间；游标由注入器持有，同一回复跨轮不重复注入。
  6. **权限 bridge**：成员 `permissionMode` 取 `bridge` / `allow` / `deny`，成为注册表的一等属性，缺省交互 `bridge`、headless `allow`。成员的权限请求补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `delegate_path` / `state: 'waiting_permission'`（`tool` / `input` / `source` 沿用原请求字段）后转发到父事件流；应答沿用 `permission.respond` / `ask.respond`，回灌后成员回到 `running`。`deny` 模式只向成员复制 `readOnlyTools`（默认 `read`）。
  7. **兼容一个版本**：`team.legacyTools` 默认 `true`，`team_*` 5 个工具仍在，但 `agent` 可用时不再注册 `delegate_task`；**`agent` 可用 = `agent.enabled` 生效或 `team.enabled: true`**（team 插件构造时总会注册 `agent`）。旧配置名 `delegate_task` 在 `permission.autoApprove` / `delegate.disallowed` 中映射为 `agent`。`team_*` 与 `delegate_task` 代码不删除，模型工具面按开关收敛。
  8. **入口默认**：交互 REPL / serve 默认注册 `agent`（`agent.enabled` 缺省 true）；headless / `--run` 默认不注册（缺省 false），保留 `delegate_task`。显式 `agent.enabled` 在两个方向都生效；`team.enabled: true` 同样使 `agent` 可用，不再同时注册 `delegate_task`。
  9. **配置**：`agent.enabled` / `agent.defaultVisibility` / `agent.followReplies`、`team.legacyTools`；`followReplies` 目前只参与装配与 `agent.reply.injected` 事件，不自动续跑父 turn。

- **冻结契约**：
  - `agent` 输入：`{ action: 'spawn' | 'send' | 'close', name?, model?, system_prompt?, visibility?, to?, content?, member? }`；`action` 必填，动作外的字段被忽略。
  - `spawn` 结果：成员状态（`id` / `session_id` / `name?` / `parent_id?` / `visibility` / `state` / `current_tool?` / `last_seen?` / `usage?`）。`send` 结果：`{ queued: true, message_id }`。`close` 结果：`{ state: 'closed' }`。
  - 消息内容上限 64 KiB（UTF-8）；空 `to` / 空 `content` / 未知成员 / 已关闭成员 / 不可见成员均返回错误文本，不静默丢弃。
  - 成员事件（开放字符串）：`agent.spawned`、`agent.message.queued`、`agent.turn.started` / `completed` / `failed` / `cancelled`、`agent.permission.requested` / `responded`、`agent.closed`。`send` 后先发 `agent.message.queued`（`{ agent_id, message_id, from, to, kind }`），成员 turn 开始时发 `agent.turn.started`（`{ agent_id, run_id, session_id }`）。
  - 回复注入事件：`agent.reply.injected`（`{ owner_id, count, message_ids, follow_replies }`）；inbox 读取失败发 `agent.reply.inject_failed`（`{ owner_id, error }`），父 turn 继续。
  - `BeforeLlm.messages` 只增不改；未写 `messages` 时请求形状不变；同一批消息重复返回只写入一次。
  - 权限请求附加字段为 additive：不覆盖 core 已有的 `requestId` / `tool` / `input` / `source`；只有显式超时策略才写 `deadline_at`。
  - canonical RPC 仍为 **44**，本版本不新增方法；`agents.tree` / `agents.list` 的 `state` 与成员状态机同名同义。

- **非目标**：
  - 不做 owner 选举、durable outbox、跨节点写路径、持久任务账本、pause / broadcast / reassign。
  - 不提供 `wait` / `inbox` / `status` / `cancel` 模型工具，也不把成员收件箱做成模型可轮询的资源。
  - 不删除 `delegate_task` / `team_*` 代码；只按配置隐藏模型工具面。
  - 不改 headless 默认行为：headless 默认仍走 `delegate_task`，team / agent 需显式开启。
  - 不做成员自动续跑：`followReplies` 只作为配置与事件字段存在。

- **验证**：
  - `agent` spawn → send → 成员回复在父 turn 的 `BeforeLlm` 注入 → close；两个成员的消息互不串线；重复排空同一回复只注入一次。
  - 成员 `bridge` 权限请求出现在父事件流，应答回灌后成员回到 `running`；headless 成员默认 `allow`，不会等待无人应答的桥接请求。
  - `agent` 可用时工具表只出现一个 `agent` schema，不再出现 `delegate_task`；`delegate_task` 旧配置名在 `autoApprove` / `disallowed` 中映射到 `agent`。
  - `team.legacyTools: false` 时模型看不到任何 `team_*`。
  - 实测工具数（`--tools`，非 TTY）：默认 **4**（`bash` / `read` / `edit` / `delegate_task`，team 未构造）；`team.enabled: true` 或 `agent.enabled: true` **9**（3 + `agent` + 5 个 `team_*`）；同条件 + `team.legacyTools: false` **4**（3 + `agent`）。真交互 REPL（TTY）再 +`ask_user`，对应 **5 / 10 / 5**。

- **已知限制**：
  - legacy `team_spawn` 创建的成员不进入新的成员注册表，`agent.send` 不能寻址它们；Phase A 只统一新 `agent.spawn` 路径。
  - `followReplies` 不触发新的父 turn：回复只在父会话下一次 `BeforeLlm` 时注入；没有父 turn 就没有自动消费。
  - `close` 只支持本机成员；跨节点释放返回错误。
  - `stale` 状态已定义，但 Phase A 没有自动标记逻辑；进程重启后的成员状态恢复不在本版本范围。
  - `allow` 模式对成员复制到的工具一律放行（`checkPermission: 'allow'`），不是按工具白名单逐项判定；需要收窄时用 `deny` + `readOnlyTools`。

- **关联**：[ADR-037](ADR-037-modular-agent-runtime.md)（Host / runtime 边界）、[ADR-081](ADR-081-host-parity-and-serializable-snapshot.md)（Host 对等与快照）、[ADR-086](ADR-086-transparency-and-multi-instance-safety.md)（Self Card、delegate 关联字段、`agents.tree`）。
