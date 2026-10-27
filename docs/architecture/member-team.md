---
title: AgentService、Body 与 Team
kind: current
triggers: [agent, member, team, body, session, dispatch, send, rotate, fork, spawn, peer, contractor, owner, freeze, presence, membership, visibility, roster, budget, conversation]
paths: [packages/agent/**, src/agent-service-wiring.ts, src/team-command.ts]
---

# AgentService、Body 与 Team

> 成员能力层的当前事实。RPC 方法形状见 [gateway-rpc.md](gateway-rpc.md#agent-lifecycle)；改动前的硬约定见 [docs/agents/agent.md](../agents/agent.md)。core 不知道 member / owner / visibility（ADR-088 / ADR-097）。

<a id="layering"></a>

## 分层与唯一实现

- `packages/agent` 是唯一成员能力实现：注册表、body registry、准入、状态机、可见性、权限 bridge 与快照都在包内；入口（REPL / CLI / Gateway / Web）只解析输入、调用 `AgentService`、渲染事件。装配在 `src/agent-service-wiring.ts`，执行经每 tenant 一个 `InProcessScheduler`。所有 agent（含 `main`）走同一条 `admit`，不得在入口或插件里复制第二套成员生命周期或第二套队列。

<a id="identity-body"></a>

## Agent 身份与 Body

- **Agent 是持久身份，Body 是活执行单元**：`body_id ≡ session_id`，一个 agent 可同时有多个 live body（每 agent ≤ 20，可配置）；每个 body 有独立 `AgentRuntime`、独立 context、独立 session 历史、独立事件流、独立 runStore 与独立 body lease。
- `PersistedAgentRecord` 持久化 `membership` / `model` / `system_prompt` / `bodies[]` / `primary_body_id` / `forked_from`；`presence` / `rotation` 不落盘。`bodies[]` 是唯一真相（已退役条目保留 ≤50），`primary_body_id` 是缺省投递目标；`current_body` / `body_history` 降级为旧数据的兼容视图（只读、不回写，`body_history` ≤20 条已退役 primary）。快照写 `version: 4`，读取兼容 v1 / v2 / v3；v3 → v4 把 `current_body` 迁成唯一 live body + primary、旧 `body_history` 迁入 `bodies[]`，首次写 v4 前备份 `.v3.bak`（v1 / v2 各保留自己的 `.bak`），失败则放弃本次写。
- `role` 语义不变：`single`（owner=self、无 Team）、`member`（owner=self、Team 必需）、`temporary`（owner=雇佣者、Team 可选）。`main` 是普通 `single`，走普通 create 路径，没有外部 owner。

<a id="state"></a>

## 三层状态

| 层 | 取值 | 是否持久化 |
|---|---|---|
| `membership` | `present` / `left` | 是 |
| `presence` | `live` / `gone` | 否（进程内） |
| member `state` | `created` / `idle` / `running` / `waiting_permission` / `completed` / `failed` / `cancelled` / `closed` | 快照派生 |
| body `state` | `idle` / `running` / `waiting_permission` / `closed` | 快照派生 |

- 派生不存储：`canAccept = present && live && stable`；`needsResume = present && gone`；`rotating = present && rotation === 'rotating'`。重启加载：`closed` 或 `membership === 'left'` → `left + gone + closed`；其它 → `present + gone + idle`，body 运行时惰性重建。不得再写 `stale`；`stale` 只作旧快照 / 旧 wire 只读兼容。
- `dispose` 按 body session 幂等回收（移除 entry、退订 bridge、清 pending、dispose runtime、释放 body lease）；它不写 `membership` / `presence`，也不落快照。清空 primary 后下一次 `admit` 新建 primary（ADR-091 Errata）。

<a id="dispatch"></a>

## 准入与投递：admit / dispatch / strict send

- `AgentService.admit({ agent_id?, session_id?, content, from, channel })` 是唯一准入：resolve agent → membership / presence / visibility → 复用或创建 body → 预算 → 入该 body mailbox → 满足条件时 `scheduler.submit`。`session_id` 已绑定则以绑定为准，显式传了不同 `agent_id` 返回 `invalid_input`；未绑定归 `agent_id ?? 'main'` 并在首次发言时建 body；未传 `session_id` 用该 agent 的 primary body。
- `dispatch`（缺省）与 strict `send` 复用同一条 admit，`to` 按 id → session_id → 唯一 name 解析。差别只有 presence：dispatch 允许确保 body / 恢复成员 presence，strict 不自动恢复（`gone` → `member_stale`）。稳定失败码：`agent_left` / `not_visible` / `resume_failed` / `body_limit`（新建 body 超上限）/ `team_full` / `team_frozen`。
- fork 只有一个触发点：`dispatch` 在 `presence === 'gone'` 且 resume 失败后，按 `teams[].policy.allowFork` / 显式 `allow_fork` 尝试；不新增工具动作或 RPC。失败零写入，源记录保持不变。

<a id="rotate"></a>

## rotate 与 epoch fencing

- rotate 只退休 **primary body** 并新建 primary（新 session id）；同一 Agent 已有进行中的 rotate 返回 `rotating`。其它 live body 的历史、checkpoint、epoch 与在途 run 完全不受影响。模型侧 `agent` 工具只能 rotate 自己，靠 `from_session_id` 等于当前 primary body 做最终闸门。
- 切换顺序固定：spawn 新 body → 提交 primary（`primary_body_id`）→ 快照落盘 → 旧 primary 退休进 `body_history` → 启动嘱托入队 → `rotation = stable`。spawn 或快照失败时恢复旧 primary、dispose 新 body、返回 `rotate_failed`，不自动重试。
- 旧 body 的轮按**该 body 自身** epoch / 退役标志 fencing：发带 `stale: true` 的配对终态与 `agent.reply.stale`，不写 state / usage、不投父队列。
- 事件：`agent.rotating` / `agent.rotated` / `agent.rotate.failed` / `agent.retired` / `agent.reply.stale`；payload 不带启动嘱托正文。

<a id="spawn"></a>

## 派生：peer / contractor 与冻结

- `AgentService.create` 接受 `CreateMemberInput`：`kind?: 'peer' | 'contractor'` / `owner?: string | null` / `teamId?` / `spawnedBy?`。输入 `kind` 映射持久化 `role`：peer → member，contractor → temporary；无 kind 的旧请求按 temporary。
- **member**：owner=self、无 parent、必须绑定 Team、visibility 强制 `team`。**temporary**：owner/parent 缺省为雇佣者（工具路径填调用者，service 缺省是 single）；有 Team 时 visibility 缺省 `team`，unbound 缺省 `private`。
- **`agent` 工具 `hire` 对任意成员开放**（含 temporary，是否有 Team 均可）：owner / parent 固定为调用者；调用者有 Team 时绑定该 `team_id`（计入上限 / 冻结），否则 unbound 且不计 Team 上限。`create`（member）仍要求调用者有 Team，single 只能 `hire`；`new` 不是当前 action。转换用 `agents.update { role, team_id? }`，不要求新 Body，只追加 `vessel:notice`。
- 每 Team present 成员 ≤ 20（peer + contractor 都计入）；`create` / `hire` / `fork` / `reinstate` 增长前检查，超限 `team_full`。同 Team 的幂等 reinstate 不增长，不被冻结 / 上限拦。
- **冻结**：`TeamRecord.spawn_frozen?` 持久化，`TeamSummary.spawn_frozen?` 回显；canonical `teams.spawnFrozen` 是唯一写路径，`teams.update` 不改。冻结期间 `create` / `hire` / 人类 `agents.create` / `fork` / `reinstate` 全部 `team_frozen`；只有 `frozen: false` 解冻。CLI 为 `vessel team freeze|unfreeze <team_id>`，team-scoped token 只能操作自己的 team。
- **close 审批与级联**：self、owner 关闭 contractor（同 owner 或同 Team）、root owner 调用直接 allow；成员关闭 peer 经权限 bridge 交人类审批；root owner 记录与跨 Team contractor 拒绝；无 bridge 时 ask fail closed。owner close 按 registry 原始记录级联关闭自己的 private contractor，team 可见 contractor 保持 present。**审计**：`agent.spawned` payload 带 `spawned_by`；Team join system 日志的 `from` 取 `spawned_by`；private 成员按既有规则不写 Team 日志。

<a id="team"></a>

## Team、可见性与预算

- roster 是派生视图：`team_id + membership = present`，不单独持久化。Team 记录与日志在 `<dataDir>/teams/<tenant>/<team_id>/`；`TeamService` 是日志唯一写入点。`TeamMemberSummary.role` 区分 member/temporary，`owner` 仍指向归属（member 为 self，temporary 为雇佣者）。
- **Team 日志不是队列**：无 `@` 的 post / reply / system 记录只追加，不 dispatch、不产生 run；`@` 必须先写日志再逐条 admit。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；Team 成员强制权限 bridge，只有 human / policy 能应答。
- conversation 预算挂 `teams[].policy.budget`，状态写 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人抬高或清除。human 直接对话免 conversation budget；Team / agent→agent 仍走预算，被 block 的消息留在该 body mailbox，override / release 后重新准入。

<a id="team-vs-sessions"></a>

## Team 与 body 会话：一条消息一个 run

- Team `@` 路径：`TeamService.post` 先写 Team 日志（`kind: 'mention'`），再按结构化 `mentions` 逐条 `admit({ channel: 'team', origin_team_id, conversation_id })`。消息进入目标 body 的 mailbox，由该 body 的 `AgentRuntime` 执行；assistant 文本随 `saveSession` 写入该 body session。不存在“Team 会话”与“私聊会话”两套存储，同一 body 上的所有投递共用一份历史。
- `run.*` 是唯一执行生命周期（payload 带 `agent_id` + `session_id`）。成功轮 team 可见成员由 `TeamService` 从 `run.completed.output` 写一条 `kind: 'reply'` 的 Team 日志；失败 / 取消轮从 `run.failed` / `run.cancelled` 写 `kind: 'system'` 条目 `turn failed: <reason>` / `turn cancelled: <reason>`，不写 reply。private 成员与被 fence 的旧 body 不写 Team 日志。同一段文本分别落在 session（上下文消息）与 Team 日志（事件记录），不是双写同一存储。
- `conversation_id` 只是预算 / 分组键，不是 session 身份：一次 Team `@` 的所有 mention 共用同一个 `conversation_id`；未显式携带的直聊会新生成一个。不同 conversation 的消息仍累积在同一 body session 的历史里。

<a id="message-source"></a>

## 来源标注与 Team 归属

- 每轮把来源渲染成**单行方括号**，且**渲染成描述而不是地址**：`[from agent:3ae686c0]` / `[from human]` / `[from system]`，作为一条 `role: 'user'` / `name: 'vessel:source'` 消息，通过 `RunOptions.messages` 在用户输入之前注入。它持久化进 `ContextManager` / session 历史，后续轮次只在尾部追加，不改写 system 前缀。**本机来源不带 node 段，也不写 `@<team>`**：写成 `agent:<uuid>@<team>` 会看起来像可回复的地址，但它缺 node 段，按 `resolveAddress` 解析必失败 —— 格式暗示了一个它不支持的操作。模型回信靠 `to: <uuid>` 或成员名，不抄这一行。短 id 只用于展示，完整 uuid 仍在 `AgentMessage.from` 里。federation 入站的 `from` 已内嵌远端 `<principal>@<node>:<team>`，直接渲染该地址、不再拼本地 node/team；正文里的 `[federation] from ...` 回信抬头保留。渲染不用 C 风格块注释语法：`sanitizeSource()` 不处理块注释结束标记，名字里带它会提前闭合且不报错。
- `source` / `channel` 由 `admit` 按 registry 与调用方标注：已登记的 id 与 `federation:*` 入站记为 agent，其余 principal（human / 未登记 id）记为 human；带 `origin_team_id` 的投递渠道记为 team，其余为 direct。二者是内存队列元数据，不落 snapshot，**也不渲染进提示词**（`channel` 只进 trace / 日志）。**只用于模型理解来源，不参与权限判定**；权限仍只由权限 bridge 的 human / policy 主体决定，注入文本不能作为授权依据。`from` 清洗为单行并限长。
- Self Card 对绑定 Team 的成员带 `team_id`，unbound 成员不伪造该字段。core 的 `formatSelfCard` 直接渲染 `team: <id>` 行。

## 约束

- canonical `agents.*` / `teams.*` 是唯一契约。消息队列只在内存（每 body 一个 mailbox），重启丢失未处理消息；不新增持久化消息队列。成员会话会出现在 tenant `sessions.list` 中；不得把 `packages/core` 变成 member-aware。
- body 上限与空闲 TTL 是唯一背压：闲置超过 TTL 的 body 自动退休；primary 被 retire 时提升最近活跃的 live body，没有 live body 则清空 primary。

## 指针

- [gateway-rpc.md](gateway-rpc.md#agent-lifecycle) · [assembly.md](assembly.md#assembly) · [config.md](config.md#config-model) · [docs/agents/agent.md](../agents/agent.md) · 决策：[ADR-088](../adr/ADR-088-agent-service-package.md) · [ADR-091](../adr/ADR-091-agent-body-and-presence.md) · [ADR-092](../adr/ADR-092-agent-rotate-and-epoch-fencing.md) · [ADR-095](../adr/ADR-095-agent-spawn-and-contractors.md) · [ADR-097](../adr/ADR-097-unified-agent-body-model.md)
