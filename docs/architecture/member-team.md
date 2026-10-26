---
title: AgentService、Body 与 Team
kind: current
triggers: [agent, member, team, body, session, dispatch, send, rotate, fork, spawn, peer, contractor, owner, freeze, presence, membership, visibility, roster, budget, conversation]
paths: [packages/agent/**, src/agent-service-wiring.ts, src/team-command.ts]
---

# AgentService、Body 与 Team

> 成员能力层的当前事实。RPC 方法形状见 [gateway-rpc.md](gateway-rpc.md#agent-lifecycle)；改动前的硬约定见 [docs/agents/agent.md](../agents/agent.md)。core 不知道 member / owner / visibility（ADR-088）。

<a id="layering"></a>

## 分层与唯一实现

- `packages/agent` 是唯一成员能力实现：注册表、状态机、消息队列、可见性、回复投递、权限 bridge 与快照都在包内；入口（REPL / CLI / Gateway / Web）只解析输入、调用 `AgentService`、渲染事件。装配在 `src/agent-service-wiring.ts`；owner 队列经父 turn 的 `BeforeLlm` 注入。不得在入口或插件里复制第二套成员生命周期。

<a id="identity-body"></a>

## Agent 身份与 Body

- **Agent 是持久身份，Body 是 session + engine**：`body_id ≡ session_id`，`current_body` 是唯一持久指针，`epoch` 存在 `current_body` 内。首具 Body 的 `session_id` 与 agent id 相同。
- `PersistedAgentRecord` 持久化 `membership` / `model` / `system_prompt` / `current_body` / `forked_from` / `body_history?`；`presence` / `rotation` 不落盘。`body_history` 只记录已退役 Body，最多 20 条，当前 Body 不在其中。快照写 `version: 3`；读取兼容 v1/v2。v3 持久化 `role: single|member|temporary`：v2 的 `owner===id` → single、`owner` 缺省 → member、`owner≠id` → temporary；single/member 的 owner 补成 id。首次写 v3 前备份 `.v2.bak`（v1 保留 `.v1.bak`），失败则放弃本次写。

<a id="state"></a>

## 三层状态

| 层 | 取值 | 是否持久化 |
|---|---|---|
| `membership` | `present` / `left` | 是 |
| `presence` | `live` / `gone` | 否（进程内） |
| engine state | `created` / `idle` / `running` / `waiting_permission` / `completed` / `failed` / `cancelled` / `closed` | 快照派生 |

- 派生不存储：`canAccept = present && live && stable`；`needsResume = present && gone`；`rotating = present && rotation === 'rotating'`。重启加载：`closed` 或 `membership === 'left'` → `left + gone + closed`；其它 → `present + gone + idle`。不得再写 `stale`；`stale` 只作旧快照 / 旧 wire 只读兼容，转移仅 `stale → closed`。
- `attachOwner` 是 root owner 的显式 `left → present` 例外；Team roster `add` 的 `reinstate` 是第二条人力路径，engine 不得复活成员。
- `dispose` 是按 Body session 幂等的 engine 回收（移除 entry、退订 bridge、清 pending、dispose engine）；它不写 `membership` / `presence` / state，也不落快照。状态由调用方写（close 写 `left + gone + closed`，rotate 只切换 Body），失败只记 `agent.dispose.failed`。不要把 dispose 当成 close / left 或 Agent 结束（ADR-091 Errata）。

<a id="dispatch"></a>

## 投递：dispatch 与 strict send

- `AgentService.dispatch({to, content, from?})` 是统一投递入口；`to` 按 id → session_id → 唯一 name 解析。
- 顺序：`left` / `closed` / closing → `agent_left`；`rotating` → 入队；`live` → 入队；`gone` → single-flight `ensureResumed()` 后入队（失败 `resume_failed`）；不可见 → `not_visible`。resume 与入队之间要复查 `membership` / `presence`，close 竞态不得投进已关闭成员。
- strict `send` 不 resume：`left` / `closed` 返回 `member_closed`，`gone` 返回 `member_stale`。两个入口都复用唯一 `enqueueMessage()`，不写第二套队列。
- fork 只有一个触发点：`dispatch` 在 `presence === 'gone'` 且 resume 失败后，按 `teams[].policy.allowFork` / owner 显式 `allow_fork` 尝试；不新增工具动作或 RPC。失败零写入，源记录保持不变。

<a id="rotate"></a>

## rotate 与 epoch fencing

- 只有活 Body 可 rotate：`presence !== 'live'` 返回 `body_not_live`；同一 Agent 已有进行中的 rotate 返回 `rotating`。模型侧 `agent` 工具只能 rotate 自己，靠 `from_session_id` 等于当前 Body 做最终闸门。切换顺序固定：spawn 新 Body → 旧指针写入 `body_history` → `setCurrentBody` → 快照落盘 → 启动嘱托入队 → `rotation = stable`。spawn 或快照失败时恢复旧指针、dispose 新 engine、返回 `rotate_failed`，不自动重试。
- 旧轮按 epoch fencing：当前 Body 已变化时，发带 `stale: true` 的配对终态与 `agent.reply.stale`，不写 state / usage、不 `deliverToParent`。
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
- **Team 日志不是队列**：无 `@` 的 post / reply / system 记录只追加，不 dispatch、不产生 run；`@` 必须先写日志再逐条 dispatch。
- 可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；Team 成员强制权限 bridge，只有 human / policy 能应答。
- conversation 预算挂 `teams[].policy.budget`，状态写 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人抬高或清除。

<a id="team-vs-sessions"></a>

## Team 与成员会话：同一条 Body 会话

- 成员只有一条活 Body（`body_id ≡ session_id`）。Team `@`、owner 直聊、成员间 `send` 都经 `dispatch` / `enqueueMessage` 进入同一内存队列，并在同一个 Body session 上执行；不存在“Team 会话”与“私聊会话”两套存储。
- Team `@` 路径：`TeamService.post` 先写 Team 日志（`kind: 'mention'`），再按结构化 `mentions` 逐条 `AgentService.dispatch({ from, content, conversation_id, origin_team_id })`。消息入 `AgentMessage` 队列后，`runTurn` 把 `content` 作为 user 消息交给成员 `AgentRuntime.run(..., member.session_id)`；最终 assistant 文本随 `saveSession` 写入该成员 session。若成员 team 可见且本轮 completed，`AgentService` 另发 `agent.reply.posted`，由 `TeamService` 追加 `kind: 'reply'` 的 Team 日志。同一段文本分别落在 session（上下文消息）与 Team 日志（事件记录），不是双写同一存储。
- `conversation_id` 只是预算 / 分组键，不是 session 身份：一次 Team `@` 的所有 mention 共用同一个 `conversation_id`；未显式携带的直聊会新生成一个。不同 conversation 的消息仍累积在同一 Body session 的历史里。
- 成功轮：session 有 user + assistant；team 可见成员的 Team 日志有 `reply`。失败 / 取消轮：core 仍保存已进入上下文的 user 消息（有 partial 文本也保留），Team 日志写一条 `system` 条目 `turn failed: <reason>` / `turn cancelled: <reason>`，不写 `reply`。旧 Body 的 `stale` 终态与 private 成员不写 Team 日志。因此“Team 里有回复、会话侧似乎没有”通常不是存储分叉：同一段文本分别落在 session 与 Team 日志；失败轮沉默是 `TeamService` 曾不处理 `agent.turn.failed` / `agent.turn.cancelled`，现已补 system 条目。

<a id="message-source"></a>

## 来源标注与 Team 归属

- 每轮把 `[Message source]`（`from: human@<node>:<team>` / `from: agent:<id>@<node>:<team>` / `from: system@<node>:<team>`，`channel: team | direct`）作为一条 `role: 'user'` / `name: 'vessel:source'` 消息，通过 `RunOptions.messages` 在用户输入之前注入。它持久化进 `ContextManager` / session 历史，后续轮次只在尾部追加，不改写 system 前缀。federation 入站的 `from` 已经内嵌远端 `<principal>@<node>:<team>`，直接渲染该地址、不再拼本地 node/team；正文里的 `[federation] from ...` 回信抬头保留。
- `source` / `channel` 由 `AgentService.enqueueMessage` 按 registry 标注：已登记且非 external owner 的 id 记为 agent，`federation:*` 入站也记为 agent（远端 agent，不是本地人类），其余 principal（root owner / 未登记 id）记为 human；Team `@` 的 dispatch 带 `origin_team_id` 时渠道记为 team，其余为 direct。二者是内存队列元数据，不落 snapshot。**只用于模型理解来源，不参与权限判定**；权限仍只由权限 bridge 的 human / policy 主体决定，注入文本不能作为授权依据。owner 队列注入（`src/agent-owner-injection.ts`）同样在 content 前加 `[Message source]` / `from: agent:<id>` / `channel: direct` 来源块，并保留 `name: agent:<id>`：provider 会丢弃 `name`，模型只能从正文看到发送者；`from` 清洗为单行并限长。
- Self Card 对绑定 Team 的成员带 `team_id`，unbound 成员不伪造该字段。core 的 `formatSelfCard` 直接渲染 `team: <id>` 行；不再由成员的 `BeforeLlm` hook 追加 Team 行。

## 约束

- canonical `agents.*` / `teams.*` 是唯一契约，owner 端点只做传输；不要恢复 `agent.*` / `team.*` legacy wire 名（ADR-091 0.26 Addendum）。消息队列只在内存，重启丢失未处理消息；不新增持久化消息队列。
- 成员会话会出现在 tenant `sessions.list` 中；不得把 `packages/core` 变成 member-aware。

## 指针

- [gateway-rpc.md](gateway-rpc.md#agent-lifecycle) · [assembly.md](assembly.md#assembly) · [config.md](config.md#config-model) · [docs/agents/agent.md](../agents/agent.md) · 决策：[ADR-088](../adr/ADR-088-agent-service-package.md) · [ADR-091](../adr/ADR-091-agent-body-and-presence.md) · [ADR-092](../adr/ADR-092-agent-rotate-and-epoch-fencing.md) · [ADR-095](../adr/ADR-095-agent-spawn-and-contractors.md) · [ADR-087](../adr/ADR-087-unified-agent-tool-phase-a.md)
