---
adr: 88
title: 0.17.0 AgentService 独立成包与执行内核分层
status: accepted
date: 2026-10-21
related: [37, 81, 86, 87]
tags: [agent, service, package, lifecycle, queue, snapshot, owner, permission, cli]
---

## ADR-088：0.17.0 AgentService 独立成包与执行内核分层

- **上下文**：0.16 的成员能力仍寄居在 `team` 插件里：`agent` 工具、注册表、生命周期和 team transport 混在同一个包，`delegate` 与 `team` 各有一套装配和配置；模型工具面同时保留 `agent`、`delegate_task` 与 `team_*`，靠 `team.legacyTools` 与入口默认值收敛。这样做有两个结构性代价：一是成员生命周期没有独立边界，入口（REPL / CLI / Gateway）无法共用同一个实现；二是删除旧工具时必须留下兼容开关，配置面继续同时存在 `team.*` 与 `delegate.*`。0.17 的目标是把“成员能力层”从插件里抽出，按“能力层 / 执行内核 / 入口”三层重新划界，并删除重复工具。

- **决策**：
  1. **AgentService 独立成包**：新增 `packages/agent`，唯一实现 `new` / `send` / `close` / `list` 并暴露 `subscribe`、`reply`、`takeMessages`、`requestPermission`、`flushSnapshot`。registry、状态机、消息队列、可见性、回复投递、权限 bridge 与快照全部在这个包内；不得在入口或插件里复制第二套成员生命周期。
  2. **分层固定为“入口 → 能力层 → 执行内核”**：`packages/core` 仍是领域无关的执行内核（单 agent loop / Host / Scheduler / Context / ToolPipeline / Permission / 事件），不知道 member / owner / visibility；`packages/agent` 只做成员能力层，通过 `MemberRuntimePort` 调执行内核；`packages/tui`、`src/`、`packages/serve`、`apps/web` 是入口，只解析输入、调用 AgentService、渲染事件。扩展层（`plugins/**`）依赖 core 与 agent，不依赖入口。
  3. **session 即成员**：`new` 创建成员时 `session_id === id`，`send.to` 与 `close.member` 都可用成员 id 或 session id。注册表只存身份与状态，不持有 runtime 对象；未注册 session 不是成员，不能经 AgentService 寻址。
  4. **内置 `agent` 工具**：动作固定 `new` / `send` / `close` / `list`；`new` / `close` 接受 `members`、`send` 接受 `messages` 批处理，条目并行、按输入顺序返回 `{results:[...]}`，单条失败不影响其它条目。工具调用者的 owner / parent 固定为 owner，模型不能伪造。**不提供** `wait` / `inbox` / `status` / `cancel` 模型工具：等待的语义是结束这一轮，回复作为新 turn 到达；roster 读取用 `list`，取消属于控制面。
  5. **状态机与可见性**：状态取 `created|idle|running|waiting_permission|completed|failed|cancelled|closed|stale`；`close` 后的迟到终态不得覆盖 `closed`。`visibility` 取 `private`（默认，仅 owner）/ `team` / `tenant`；跨 tenant 不可寻址。
  6. **持久化选内存队列 + snapshot**：registry 在 owner 内存；状态变化经节流合并原子写入 `<dataDir>/agents/<tenant>.json`（`0600`，`version: 1`）。快照只含成员状态，不含消息队列；重启后非终态成员恢复为 `stale`，未处理消息丢失。durable outbox 留到 Phase B。
  7. **owner 与传输分离**：REPL 是天然 owner，启动 AgentService 并监听 `127.0.0.1:0` 的最小 HTTP 控制端点；记录原子写入 `<dataDir>/agent-owner.json`（`0600`，`{pid,host,port,token,started_at,tenant_id}`），只接受 loopback Host 与 Bearer token。端点只是传输，`agent.new/send/close/list` 全部委托同一 AgentService；CLI 经 owner 记录 attach，不复制 registry。同一 `dataDir` 已有 owner 时第二个 REPL 仍可用进程内工具，CLI 保持原 owner。
  8. **owner 外部队列**：REPL 主 agent 通过 `attachOwner` 注册为 external owner；它的队列只由父 turn 的 `BeforeLlm` 调 `takeMessages(ownerId)` 排空，`pump` 永不执行 owner 队列，成员 runtime 也不得消费。注入消息固定 `role: 'user'`、`name: 'agent:<id>'`、`timestamp` 取原消息时间。
  9. **权限 bridge**：成员 `permissionMode` 取 `bridge` / `allow` / `deny`，缺省交互 `bridge`、headless `allow`；bridge 把成员的 `tool.permission.request` / `ask.user.requested` 补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `delegate_path` 后转发到父事件流，应答沿用 `permission.respond` / `ask.respond` 回灌。无父流时按 deny，不死等。
  10. **删除清单**：删除 `plugins/tools/team`、`plugins/tools/delegate-task`、`TeamConfig` / `DelegateConfig`、`team.*` / `delegate.*` 配置键、team / delegate 装配与旧 owner inbox 轮询路径；`team.legacyTools` 不再保留。`/v1/team/*` 传输协议文件保留，但没有生产装配，Phase B 可复用。
  11. **入口适配**：交互 REPL / serve 的 `ask_user` 与 `agent` 工具按配置注册；Web 为没有匹配 `RunCard` 的权限 / ask 提供 Composer 上方兜底与非模态面板；tui `/agents` 只读消费事件历史，有效限额读 `config.agent.*`。

- **冻结契约**：
  - `MemberStatus`：`id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `state` / `current_tool?` / `last_seen?` / `usage?`（snake_case）。
  - `AgentService`：`new(NewMemberInput | {members})`、`send(SendInput | {messages})`、`close(CloseInput | {members})`、`list(ListFilter)`；`send` 返回 `{queued: true, message_id, state}`，不等待一轮结束。
  - 消息内容上限 64 KiB（UTF-8）；空 `to` / 空 `content` / 未知成员 / 已关闭 / `stale` / 不可见成员返回错误文本或错误码，不静默丢弃。
  - `agent` 工具输入：`{action, name?, model?, system_prompt?, visibility?, members?, to?, content?, messages?, member?, state?, parent_id?}`；单条字段与 batch 字段互斥。
  - 快照形状：`{version, tenant_id, updated_at, members: MemberStatus[]}`；版本不匹配按空 registry 启动。
  - owner 记录形状：`{pid, host, port, token, started_at, tenant_id}`；方法名固定 `agent.new` / `agent.send` / `agent.close` / `agent.list`。
  - 成员事件（开放字符串）：`agent.spawned`、`agent.stale`、`agent.message.queued`、`agent.turn.started` / `completed` / `failed` / `cancelled`、`agent.permission.requested` / `responded`、`agent.closed`。事件 `agent_id` 为成员 id。
  - canonical RPC 仍为 **44**；owner 端点是本地控制传输，不进入 RPC 方法表。

- **非目标**：
  - 不做 Gateway 作为 owner 或 attach 代理、Web 跨 owner 转发、durable outbox、跨节点写路径（Phase B）。
  - 不做 owner 选举、pause / broadcast / reassign、成员自动续跑。
  - 不恢复 `wait` / `inbox` / `status` / `cancel` 模型工具，也不把成员收件箱做成模型可轮询的资源。
  - 不迁移旧会话 / 旧成员数据；没有 snapshot 时从空 registry 开始。
  - 不把 AgentService 的能力下推进 core：core 仍不知道 member / owner / visibility。

- **验证**：
  - `new` → `send` → 成员回复进入 owner 队列 → 父 turn `BeforeLlm` 注入 → `close`；两个成员的消息互不串线；owner 队列不会被 `pump` 或成员 runtime 消费。
  - `agent.enabled: true` 时交互 REPL 暴露 `bash` / `read` / `edit` / `ask_user` / `agent`（5）；无 agent 的交互为 4；headless 默认 3、`agent.enabled: true` 为 4。
  - owner 端点可被 CLI attach：`agent new/list/send/close` 与进程内工具结果一致；无 owner 返回 `agent_owner_unavailable`，tenant 不一致被拒绝。
  - 重启后 snapshot 中的非终态成员标 `stale`，`send` 返回 `member_stale`；损坏 / 版本不匹配的快照不阻塞启动。
  - 成员 `bridge` 权限请求出现在父事件流，应答后成员回到 `running`；headless 成员默认 `allow`，不等待无人应答的请求。
  - 仓库内不再存在 `team_*` / `delegate_task` 注册与 `team` / `delegate` 配置键；`/v1/team/*` 文件保留但无生产装配。
  - `bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`（44）、biome 通过。

- **已知限制**：
  - Phase B 未做：Gateway attach / Web 代理 / durable 队列 / 跨节点。
  - CLI 依赖本机 REPL owner；没有 REPL 进程时不会自动启动 gateway。
  - 消息队列只在内存，重启丢失未处理消息；`stale` 成员不能继续 `send`。
  - `agent.followReplies` 只作为配置 / 事件字段：回复在下一次 `BeforeLlm` 注入，不自动开启新的父 turn。
  - `close` 只支持本机成员。
  - `/v1/team/*` 协议保留不等于 team 控制面可用。

- **关联**：[ADR-037](ADR-037-modular-agent-runtime.md)（Host / runtime 边界）、[ADR-081](ADR-081-host-parity-and-serializable-snapshot.md)（Host 对等与快照）、[ADR-086](ADR-086-transparency-and-multi-instance-safety.md)（Self Card、`agents.tree`）、[ADR-087](ADR-087-unified-agent-tool-phase-a.md)（0.16 统一工具 Phase A）。
