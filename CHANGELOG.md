# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。

## [0.18.0] - 2026-10-21

> 0.18.0（基于 `release/0.18.0`，未发布）：会话事件日志成为唯一真相源；TUI 历史结构化并从事件日志恢复；Web 会话流扁平化、权限 / ask 内联到 Composer；新增 `vessel completion` 与只读 RPC `interactions.list`。未 tag、未 `npm publish`。

### Added

- **会话事件日志**：`sessions/<id>/events.ndjson` 作为唯一真相源；runtime 先 append + fsync 再 publish；checkpoint 只存 `messages: []` + `event_cursor`；resume 用 session 缓存 + `seq > derived_upto_seq` 增量；删除与损坏检测保持一致。reasoning 只持久化，不发布 / 不进 trace。
- **TUI 结构化历史**：`UiItem` / `ToolCallView` 取代纯文本历史；每种事件有独立样式；`/resume` 优先从 `EventLogReadPort` 读取，无日志或读失败回退 messages 并标「不完整」，超过 200 条截断提示；Markdown 表格 / 嵌套列表 / 去围栏；权限 / ask / agent / error / limit 内联；`/clear` 走 Ink `clear()`。
- **Web 扁平会话流**：删除 `RunCard` / `RunSection`，实时内容直接平铺进同一条会话流（`StreamItems`）；权限 / ask 用 Composer 槽位三态互斥（`Composer` / `Permission` / `Ask`），多 pending 串行，槽位高度自适应；停止按钮在 Composer；排队为流末尾 notice；失败 / 取消内联 `stream-notice`。
- **`vessel completion bash|zsh|fish|powershell`**：打印可直接 source / 加载的静态补全脚本；单一数据源 `src/completion-spec.ts`，registry 一致性由测试守护；不启动 runtime、不联网。
- **`interactions.list`**：tenant 作用域只读 RPC，参数 `{session_id?, run_id?, status?, limit?}`；返回 `pending` / `answered` / `orphaned` 权限与内存 pending ask（`kind: 'ask'` + `questions`）；canonical RPC 44 → **45**。
- **`TenantEventHub`**：`@vessel-agent/serve` 新增事件扇入面，各 tenant 用 `register(tenantId, stream)` 接入；hub 负责全局单调 `seq`、环形缓冲、`since` / `gap` 回放，并提供 raw 与脱敏后两条订阅。hub 不暴露 `publish`。

### Changed

- **BREAKING（嵌入方）**：删除共享事件流。`GatewayOptions.events` / `LocalRpcOptions.events` 改为 `hub: TenantEventHub`（可用 `createGatewayEventHub({ streams })` 构造）；`RunEngineOptions.events` 删除，`tenantEventsFor` 必填。`maxHistory` 移到 hub 选项。协议 / 帧 / `events.subscribe` / `events.list` / `seq` / 跨节点去重语义不变。
- **TUI**：用户输入使用暗金背景；渲染高度不变量；live 仍走内存 `EventStream`，历史走事件日志。
- **Web**：滚动容器不再压缩流内块（`.conversation-scroll > * { flex: 0 0 auto }`）；权限 / ask 不再使用全局遮罩；提问不再有过期字段，`AskUserRequest.requestedAt` 用于排序（与权限混排），`expiresAt` / `INTERACTION_TTL_MS` / 倒计时 / `now` prop 链删除。
- **CI / 测试**：Windows 进程探测 3s → 15s；headless stdin `await write/end` + 30s；workflow cancel 改为有界等待。
- **`ask_user` 默认无限等待**：取消 120s 自动超时（`createAskUserTool()` 不再传超时），等待绑定 run 的 `AbortSignal`，abort / cancel 返回明确的取消文案；显式 `timeout` 只保留给测试与调用方。Web / TUI 提问卡片去掉倒计时与过期提示。
- **交互 pending 只由状态收口**：`interactionTtlMs` / `RunEngine.sweep()` / gateway 30s 定时器删除；权限与 ask 的 pending 只由应答 / run 终态 / abort 清理。

### Fixed

- **交互应答投递**：`permission.respond` / `ask.respond` 之前只发布到 gateway 共享流，而 tenant 的 runtime / 工具等待的是各自的 runtime 事件流，导致用户点“允许”或提交回答后模型只收到超时结果。现在 gateway 通过 `TenantEventHub` 拿到归属 tenant 的运行时流，应答只发布到那里（流缺失返回 `run_ended`，不回退共享流）；Web 仍通过 hub 的广播看到事件。
- `health.get`、`/v1/health` 与 `hello` 的 `node` 字段按 tenant 隔离（0.17.1 线）。
- `SessionEventLog` LRU 淘汰竞态；derived 覆盖、read 排序、connect 关联；D2 跨模块内部 import。
- `serve` durable preview 优先使用 checkpoint `metadata.preview`。
- Web 长 run 滚动、权限槽位三态、连续 pending、停止按钮。

### Known limitations

- Track A P3 未做：win32 deleted 用例覆盖；`updateIndex` 会为空 session 重建目录；`read(limit)` 仍整文件读；`session.renamed` 未接事件；压缩摘要不可由事件重建。
- **Web hydration 待实现**：连接 / 刷新 / 选会话后尚未调用 `interactions.list` 合并进 Composer 槽位。
- Bun 1.3.9 下 `gateway.stop()` 在曾有 WS 连接的 gateway 上可能不 settle（测试沿用 `void gw.stop()`）。

## [0.17.0] - 2026-10-21

> 0.17.0（基于 `release/0.17.0`，未发布）：AgentService 成为唯一的成员能力层并独立成包（`packages/agent`）；模型工具面收敛到内置 `agent`（`new` / `send` / `close` / `list`，支持 batch），REPL 作为 owner 暴露 loopback 控制端点，CLI 新增 `vessel agent new|send|close|list`；删除 `team_*` / `delegate_task` 模型工具、`team` / `delegate-task` 插件与 `team.*` / `delegate.*` 配置。未 tag、未 `npm publish`、未合并 `main`。

### Added

- **`packages/agent`（AgentService）**：`new` / `send` / `close` / `list` 与 `subscribe`；`send` 入队即返回，同一成员同时只有一轮在跑，其余消息 FIFO 排队。成员与 session 1:1（`session_id === id`），注册表记录 `owner` / `visibility` / `state` / `current_tool` / `last_seen` / `usage`；状态机 `created` → `idle` ↔ `running` → `waiting_permission` / `completed` / `failed` / `cancelled` → `closed`，`stale` 表示进程 / owner 不可达。
- **快照与恢复**：状态变化经节流合并原子写入 `<dataDir>/agents/<tenant>.json`（`0600`，版本 1）；只存成员状态，不存消息队列。重启后非终态成员一律恢复为 `stale`，终态保持原值；未处理消息丢失。
- **owner 外部队列**：REPL 主 agent 通过 `attachOwner` 注册为 external owner，其消息队列只由父 turn 的 `BeforeLlm` 调 `takeMessages(ownerId)` 排空；`pump` 永不执行 owner 队列。注入消息固定 `role: 'user'`、`name: 'agent:<id>'`、`timestamp` 取原消息时间。
- **内置 `agent` 工具**：唯一模型 schema，动作 `new` / `send` / `close` / `list`；`new` / `close` 接受 `members`、`send` 接受 `messages` 批处理，条目并行、按输入顺序返回 `{results:[...]}`，单条失败不影响其它条目。工具调用者的 owner / parent 固定为 owner，模型不能伪造。**不提供** `wait` / `inbox` / `status` / `cancel` 模型工具。
- **REPL owner 控制端点**：交互 REPL 启动 AgentService 后监听 `127.0.0.1:0`，记录原子写入 `<dataDir>/agent-owner.json`（`0600`，`{pid,host,port,token,started_at,tenant_id}`）；只接受 loopback Host 与 Bearer token，方法 `agent.new` / `agent.send` / `agent.close` / `agent.list`。
- **`vessel agent` CLI**：`vessel agent new <name?> | send <member> <content> | close <member...> | list [--json]`，经 owner 记录 attach；无 owner 返回 `agent_owner_unavailable`，tenant 不一致返回 `agent_owner_tenant_mismatch`。
- **Web 兜底操作面**：Composer 上方显示当前会话内未匹配到 `RunCard` 的待处理权限 / ask；其他会话或无 `sessionId` 的请求进入顶部非模态面板，复用同一张 `PermissionCard` / `AskCard`，不恢复全局遮罩。面包屑显示 `agent` / `run` / `session` 短 id。
- **Web 流式占位**：`RunCard` 在运行中显示 `liveText` / `liveReasoning`，尚无内容时显示运行中空态占位，不再看起来像空卡片。
- **`vessel completion <bash|zsh|fish|powershell>`**：打印可直接 source / 加载的静态补全脚本，覆盖顶层命令、二级子命令与常用 flags；单一数据源 `src/completion-spec.ts`，`registry.ts` 一致性由测试守护。不启动 runtime、不联网；动态值（session / tenant / agent id）不写进脚本，留给 shell 默认文件补全。

### Changed

- **工具面**：默认 3（`bash` / `read` / `edit`）；`agent.enabled: true` 为 4（+`agent`）；交互 REPL / serve 默认 4（+`ask_user`）；交互 + `agent.enabled: true` 为 5。`delegate_task` 与 `team_*` 不再注册。
- **装配**：`agent.enabled` 是唯一开关（缺省 `false`），交互 / headless 一致；启用后注册内置 `agent` 工具、启动 AgentService 并尝试启动 owner 端点。同一 `dataDir` 已有 owner 时第二个 REPL 仍可用进程内工具，CLI attach 保持原 owner。
- **配置迁移**：成员 `permissionMode` / `readOnlyTools` / `limits` / `termination` 从 `delegate.*` 移入 `agent.*`；`agent.ownerId` 指定 root owner（默认 `main`）。
- **tui**：`/agents` 继续只读派生（`ctx.events.getHistory()`），成员事件来自 AgentService（`agent.spawned` / `agent.turn.*` / `agent.closed`）；有效限额改读 `config.agent.*`。
- **`/v1/team/*` 传输协议**：协议文件与 gateway 方法保留，但 0.17 没有生产装配，不再有模型工具入口；后续 Phase B 可复用。

### Removed

- 删除 `plugins/tools/team` 与 `plugins/tools/delegate-task` 及其测试；删除 `team_*`（spawn / send / inbox / status / cancel）与 `delegate_task` 模型工具。
- 删除 `TeamConfig` / `DelegateConfig`、`team.*` / `delegate.*` 配置键、team / delegate 装配与 `team-wiring` / 工厂插件路径；tenant overlay 不再接受 `team` / `delegate` 块。
- 删除 `agent-reply-injection`（旧 owner inbox 轮询路径）与 `team.legacyTools` 兼容开关。

### Fixed

- `health.get`、`/v1/health` 与 `hello` 的 `node` 字段按 tenant 过滤，不再泄漏其它 tenant 的 active run、session 与工具面。
- external owner 的消息不再被 `pump` 消费：成员回复只经父 turn 的 `BeforeLlm` 注入，避免 owner 队列被成员 runtime 抢走。
- bridge 权限请求补 `request_id` 别名，父窗口可按同一 `requestId` 应答 `permission.respond` / `ask.respond`。
- Web 权限 / ask 请求没有匹配 `RunCard` 时不再无处可操作；运行中的空 `RunCard` 不再显示为空白。

### Known limitations

- Phase B 未做：Gateway 作为 owner 或 attach 代理、Web 跨 owner 转发、durable outbox、跨节点写路径。
- CLI 依赖本机 REPL owner；没有 REPL 进程时 `vessel agent ...` 返回 `agent_owner_unavailable`，不会自动启动 gateway。
- 消息队列只在内存：进程重启后未处理消息丢失，非终态成员恢复为 `stale`，不能继续 `send`。
- `agent.followReplies` 仍只是配置 / 事件字段：回复在父会话下一次 `BeforeLlm` 时注入，不会自动开启新的父 turn。
- `close` 只支持本机成员；跨节点释放返回错误。
- `/v1/team/*` 协议保留但没有生产装配，不代表 team 控制面仍可用。
- canonical RPC 仍为 **44**，本版本不新增方法。

## [0.16.0] - 2026-10-21

> 0.16.0（基于 `release/0.16.0`，未发布）：统一 agent 工具 Phase A——模型工具面收敛到单个 `agent`（`spawn` / `send` / `close`），session 即成员，成员回复经 `BeforeLlm` 注入父 turn，权限请求桥接到父窗口；`team_*` 与 `delegate_task` 兼容保留一个版本。未 tag、未 `npm publish`、未合并 `main`。

### Added

- **`agent` 工具**：唯一模型 schema，动作 `spawn` / `send` / `close`。`spawn` 创建 session 并注册成员，返回成员状态；`send` 入队即返回 `{ queued: true, message_id }`，不阻塞、不等待；`close` 幂等释放成员（`{ state: 'closed' }`）。**不提供** `wait` / `inbox` / `status` / `cancel` 模型工具。消息上限 64 KiB（UTF-8）。
- **成员注册表**：`spawn` 的 session 与成员 1:1（`session_id === agent_id`），`to` / `member` 可用成员 id 或 session id。记录 `id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `permission_mode` / `state` / `current_tool?` / `last_seen?` / `usage?`；`visibility` 取 `private`（默认，仅 owner）/ `team` / `tenant`，跨 tenant 不可寻址。
- **成员生命周期**：状态 `created` / `idle` / `running` / `waiting_permission` / `completed` / `failed` / `cancelled` / `closed` / `stale`；与 `agents.tree` / `agents.list` 的 `state` 同名同义。`close` 后到达的 run 终态不覆盖 `closed`。
- **成员事件**（开放字符串）：`agent.spawned`、`agent.message.queued`、`agent.turn.started` / `completed` / `failed` / `cancelled`、`agent.permission.requested` / `responded`、`agent.closed`。
- **父 turn 注入**：core 新增 `HookContext.messages?: Message[]`（additive）；runtime 在 `BeforeLlm` 后把注入消息写入上下文一次，按 `name` / `timestamp` 稳定键或对象引用去重，每个 run 重置。装配层新增 owner inbox 注入器：回复映射为 `role: 'user'`、`name: 'agent:<id>'`、内容 `[agent <id>] <content>`，游标去重；发 `agent.reply.injected` / `agent.reply.inject_failed`。
- **权限 bridge**：成员 `permission_mode` 成为注册表一等属性（`bridge` / `allow` / `deny`，缺省交互 `bridge`、headless `allow`）。bridge 请求补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `delegate_path` / `state: 'waiting_permission'`，应答沿用 `permission.respond` / `ask.respond`；`deny` 只复制 `delegate.readOnlyTools`（默认 `['read']`）。
- **配置**：`agent.enabled` / `agent.defaultVisibility` / `agent.followReplies`、`team.legacyTools`；非法值与枚举值拒绝而不是静默回退。

### Changed

- **入口默认**：交互 REPL / serve 默认注册 `agent`；headless / `--run` 默认不注册，保留 `delegate_task`。显式 `agent.enabled` 在两个方向都生效。
- **单一 schema**：`agent` 可用时不再注册 `delegate_task`。`agent` 可用 = `agent.enabled` 生效 **或** `team.enabled: true`（team 插件构造时总会注册 `agent`）。旧配置名 `delegate_task` 在 `permission.autoApprove` 与 `delegate.disallowed` 中映射为 `agent`。`team_*` 5 个工具默认仍注册，`team.legacyTools: false` 时全部隐藏。
- **Self Card**：主 agent 的工具列表随入口与开关显示 `agent` 或 `delegate_task`，`team_*` 受 `team.legacyTools` 控制。
- **team 插件**：版本 0.2.0；成员宿主不再复制 `team_*` 与 `agent` 工具，Phase A 不支持嵌套成员。
- **工具数（实测）**：`--tools`（非 TTY）默认 4；`team.enabled: true` 或 `agent.enabled: true` 9（3 + `agent` + 5 个 `team_*`）；同条件 + `team.legacyTools: false` 4（3 + `agent`）。真交互 REPL（TTY）再 +`ask_user`，对应 5 / 10 / 5。
- canonical RPC 仍为 **44**，本版本不新增方法。

### Fixed

- **team 构造时不再注册 `delegate_task`**：`team.enabled: true` 此前会同时注册 `delegate_task` 与 `agent`，模型看到两个 schema；现在 `agent` 可用 = `agent.enabled` 生效或 `team.enabled: true`，可用时只保留 `agent`。
- inbox 排空失败不再被静默吞掉：发 `agent.reply.inject_failed`（`{ owner_id, error }`）并让父 turn 继续，模型不会永远等一个已经失败的回复。
- 父事件流与 Host 聚合流同源时不再重复转发权限请求与应答，避免父窗口出现两张权限卡。

### Known limitations

- legacy `team_spawn` 创建的成员不进入新注册表，`agent.send` 不能寻址它们。
- `agent.followReplies` 目前只是配置 / 事件字段：回复在父会话下一次 `BeforeLlm` 时注入，不会自动开启新的父 turn。
- `close` 只支持本机成员；跨节点释放返回错误。
- `stale` 状态已定义，Phase A 没有自动标记逻辑；进程重启后的成员状态恢复不在本版本范围。
- `allow` 模式对成员复制到的工具一律放行，不是按工具白名单逐项判定。

## [0.15.1] - 2026-10-21

> 0.15.1（基于 `release/0.15.1`，未发布）：Web 性能修复——移除全屏遮罩与应用栏的 `backdrop-filter` 模糊。

### Fixed

- **Web 模糊卡顿**：移除 `.modal-backdrop` 的 `backdrop-filter: blur(6px)` 与 `.appbar` 的 `blur(12px)`；遮罩改为更实的半透明底色（ink 55%），应用栏改为不透明 `--surface`。`backdrop-filter` 在 Edge / Chromium 上会为全屏或动画层强制额外合成与重采样，滚动、输入和流式文本时容易掉帧；去掉模糊后保留边框与层级阴影。

## [0.15.0] - 2026-10-21

> 0.15.0（基于 `release/0.15.0`，未发布）：透明化与多实例安全——压缩 / 限额预警 / 队列事件、agent 树与任务板、Self Card 注入、delegate 关联与孙 agent opt-in、tenant 双层锁与 session 写锁。以下均为已实现；未 tag、未 `npm publish`、未合并 `main`。

### Added

- **透明化事件**：`context.compacted`（`{run_id, session_id, removed, remaining, reason}`，`reason` 为 `auto|overflow|manual`，仅在 `removed > 0` 时发布）；`agent.limit.warning`（`{scope, key, current, max, source, threshold, hint}`，阈值固定 0.8，每 run 每 key 一次，达到硬上限后不再预警）；`agent.queue.entered/left`（`{agent_id, run_id, position, wait_reason, since}`，仅在 `SchedulerOptions.events` 注入时发布）。均为开放字符串事件名。
- **快照字段**：`AgentSnapshot` 增加 `nodeId?` / `sessionId` / `task?` / `waitReason?` / `contextUsed?` / `contextMax?` / `childrenCount?` / `lastSeen?`；`RunSnapshot` 与 `SchedulerSnapshot.queued[]` 增加 `waitReason?`（`capacity|per_agent_serial|paused|dependency|quota`）。
- **Self Card 注入**：`AgentRuntimeOptions.selfCard` 与 `AgentSpec.selfCard`（additive）；渲染 `role` / `parent_id?` / `depth` / `model` / `tools` / `limits` / `context` / `how_to_ask?`，追加到 systemPrompt，按 `estimateTokens` 截断到 400 tokens；每次 run（含 resume）生成一次，不写入持久化 session。主 agent 与 delegate child 各自构造。
- **delegate 关联字段**：`subagent.delegate.*` 与转发的 `subagent.*` / bridge 交互事件补 `tool_call_id` / `parent_session_id` / `parent_delegate_id` / `delegate_path`；`completed/failed` 补 `result_ref: {kind:'run', id}`。
- **孙 agent opt-in**：`delegate.allow_nested`（默认 `false`）与 `delegate.max_descendants`（默认 `16`）；开启后 child 获得独立 delegate 工具实例并新建 Host，`max_descendants` 按根树计数，根 delegate 不计入；`permissionMode: 'deny'` 或显式 `disallowed` 含 `delegate_task` 时不放开。
- **canonical RPC（40 → 44）**：`agents.tree`（AgentCard + `children_ids` / `children_count` + `as_of`）、`tasks.list` / `tasks.get`（只读派生，不持久化）、`config.set`（白名单键写回，仅 default tenant）。
- **可观测面**：`health.get` 增加 `runtime: {active_run_id?, scheduler:{as_of, queued, running, stats}}`；`runs.list` / `runs.get` 透出错误 envelope 字段与 `started_at`；`events.list` 读路径先脱敏再按 8 KiB 裁剪工具参数 / 结果。
- **TUI**：`/status` 展示队列、80% 预警与最近一次压缩；`/agents tree`；`/settings errorLevel|verbosity`；`/compact` 改走 `runtime.compactContext()`（`manual` 压缩事件）。
- **Web**：Diagnostics / Tasks / Display 页；`GatewayClient` 增加 `agents.tree` / `tasks.*` / `config.set`。
- **CLI / 运维**：全局 `--data-dir <path>` 与 `--exclusive`；`vessel doctor --deep`（只读查询本地 gateway 的 health / MCP）；`vessel logs tail [--json] [--lines N] [--instance <name>]`；`vessel gateway status --rpc`（health + runs 派生的队列计数）。

### Changed

- **tenant 双层锁**：`exclusive` 仍用 `tenants/<t>/.lock`（sqlite、`--exclusive`、migrate / tenant / trace prune）；file / memory 后端默认 `shared`，每进程写 `tenants/<t>/.members/<pid>-<nonce>.json`。两侧发布后互相复查；stale 规则统一（死 pid、不可解析 >5s、跨主机 >24h、回收守卫 >10s）。
- **session / run 写锁**：`tenants/<t>/.locks/sessions/<sha16>.lock` 与 `.locks/runs/<sha16>.lock`（`0600`）；`run()` 取 session 锁、`resume()` 取 run 锁，Host resume 在 bootstrap 直接取 run 锁；显式 session 的 REPL / headless 持进程级锁，`--serve` 空闲时不持长锁。冲突为 `conflict` + `session_locked` / `run_locked`。
- **interactions 按实例隔离**：default 仍是 `<dataDir>/interactions-<tenant>.json`；命名实例改为 `<dataDir>/instances/<instance>/interactions-<tenant>.json`。
- **`edit` 纳入路径边界**：与 `read` 共用 `evaluatePath`（内置 denylist 硬 `deny`、`allowed_roots` 越界 `ask`）；执行前再复查一次。
- **`deny_paths` 参与 bash 命令文本匹配**：内置 denylist 与自定义条目一起展开为 `~` / `$HOME` / `${HOME}` / 绝对路径 / 相对路径写法；仍是 best-effort 字符串匹配，不是沙箱。
- **端口占用**：gateway 启动捕获 `EADDRINUSE`，以 `port_in_use` 退出 1，且不写 PID 文件。

### Fixed

- **同 dataDir 多实例覆盖交互记录**：命名实例此前与 default 共用 `interactions-<tenant>.json`，会互相覆盖 pending / answered；现按实例分目录。
- **同 session 并发写**：多个进程可同时写同一 session / run；现由跨进程写锁拒绝第二写者，而不是静默覆盖。
- **`edit` 绕过敏感路径**：此前 `edit` 不受 `evaluatePath` 约束，可改内置 denylist 中的文件；现与 `read` 同边界。
- **自定义 `deny_paths` 不拦截命令文本**：此前只参与 realpath 边界，`bash` 命令文本里写出的自定义敏感路径不会被拒；现与内置 denylist 一并匹配。

### Security

- 同一 dataDir 的多实例不再互相覆盖 PID / interactions；session 级单写者由文件锁保证。
- 孙 agent 默认关闭；开启后 child 继承父级 resolved 权限与限额，不放大；嵌套实例使用独立 Host，避免占用父 run 的调度槽。
- `config.set` 仅 default tenant、仅白名单键；非 default tenant 返回 `forbidden`。
- `events.list` 与实时流共用 redactor 与 8 KiB 裁剪，避免回放路径泄漏未裁剪的工具参数 / 结果。

### Known limitations

- shared tenant 锁允许多进程共存，保证的是「每 session 单写者」，不是整个 tenant 单写者；需要 tenant 独占时用 `--exclusive` 或 sqlite 后端。
- `tasks.*` 与 agent 快照都是进程内派生：重启丢失，不是持久任务账本；`childrenCount` 依赖上层建立父子关系。
- `agent.limit.warning` 的 `max_runtime` 用 wall clock 估算；同一 key 只预警一次，阈值变化不会重发。
- Self Card 按 `estimateTokens` 近似截断，不保证 provider 精确 400 tokens；MCP 工具名在连接前不可知，不写入 Card。
- `port_in_use` 是 CLI 退出语义，不是 canonical RPC 错误码；`vessel logs tail` 只读本地日志，不跟随、不轮转。
- 0.15.0 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.14.4] - 2026-10-21

> 0.14.4（基于 `release/0.14.4`，未发布）：上下文压缩质量硬化——保留区改按 token 预算且同时受条数上限约束，保留边界不切断 tool 配对；摘要输入渲染工具调用、按 token 分块并逐块容错。以下均为已实现；未 tag、未 `npm publish`、未合并 `main`。

### Changed

- **压缩保留区改按 token 预算**：`MemoryContextManager.planCompaction` 不再按「最近 30% 消息条数」划分，而是从最新非 system 消息向前累计 `estimateMessageTokens`，上限为 `context.maxTokens × 0.3`；最新 2 条非 system 消息无论如何保留。非 system 少于 3 条时不压缩。
- **保留区同时受条数上限约束**：保留条数还须满足 `maxKept = max(2, messageCap - systemCount - 1)`，其中 `messageCap` 取显式 `context.maxMessages`，缺省为 `max(100, floor(maxTokens / 100))`。token 或条数任一超限都触发摘要；两者都未超时不压缩。自动压缩仍由 `tokenCount > maxTokens × 0.8` 或消息条数超过 `messageCap` 触发。
- **摘要 transcript 渲染工具调用**：摘要输入不再是 `<role> content` 的平铺，`assistant` 渲染为 `[assistant] <content>` 并逐条追加 `[tool_call:<name>] <arguments>`，`tool` 渲染为 `[tool:<id>] <content>`，其它角色为 `[<role>] <content>`；`reasoning_content` 不进入摘要。单条渲染超过 12,000 字符截断并追加 `[truncated]`。
- **摘要输入按 token 分块**：块预算为 `min(48_000, max(2_000, floor(context.maxTokens / 8)))`，按渲染后文本的估算 token 分组，单条超预算时独占一块。单块走一次摘要（输出 ≤ `max(128, min(context.maxTokens, 2048))`）；多块每块一次 partial（输出 ≤1024），再 reduce 一次（输出 ≤2048）。
- **摘要逐块容错**：某块 partial 失败写入 `[partial summary unavailable: chunk N]` 并继续；reduce 失败按序拼接 partial 并截断到输出预算；全部 partial 失败返回空串，由 core 回退占位摘要。摘要失败仍不中断 run。
- 无新增配置键；`context.maxMessages` 缺省推导规则不变。

### Fixed

- **保留边界可能切断 tool 配对**：保留区第一条是 `tool` 消息时，边界回退到持有对应 `tool_call_id` 的 `assistant(tool_calls)`，避免压缩后出现孤立 `tool` 被 provider 拒绝。配对完整性优先于条数上限，回退后保留数可能略超 `maxMessages`；找不到 owner 时保持原边界。
- **摘要丢失工具名 / 参数 / 结果**：此前摘要输入只含消息 `content`，`assistant` 的 `tool_calls` 与 `tool` 消息的调用标识全部丢失，摘要无法指认执行过什么。渲染 `[tool_call:<name>] <arguments>` 与 `[tool:<id>] <content>` 后，工具上下文进入摘要。
- **单次摘要输入超出预算**：此前整段 transcript 一次性发送，长会话的单次摘要请求可能过大且失败即丢整段摘要。分块后每块独立摘要，单块失败只影响该块。

### Known limitations

- **token 估算是字符近似**：保留预算、分块与截断都用 `estimateTokens`（ASCII 0.25 / CJK 0.5 token 每字符），不是 provider 精确计数；边界附近的保留量会有偏差。
- **配对回退可超条数上限**：为保证 `assistant(tool_calls)` / `tool` 配对，保留数可能略多于 `maxKept`；历史本身不完整（找不到 owner）时不强行前移。
- **摘要质量仍是 best-effort**：所有块失败时只留下 `[Auto Compact: N older messages summarized. Continuing...]` 占位，不重试、不延后到下一轮。
- 0.14.4 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.14.3] - 2026-10-21

> 0.14.3（基于 `release/0.14.3`，未发布）：限额命中（含终止策略）的可见性与结构化、默认预算调整、provider HTTP 错误与重试分类。以下均为已实现；未 tag、未 `npm publish`、未合并 `main`。

### Fixed

- **限额命中不可见**：限额命中（使用量上限或终止策略 `maxIterations` / `maxRuntimeSeconds`）时，runtime 发布一次 `limit.blocked` 事件（data 含 `error_code: 'limit_blocked'`、`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`、`run_id`、`session_id`），并抛 `LimitExceededError`。`run.failed` 保留原 `error` 文本（`Usage limits exceeded: ...` 或 `Termination policy triggered: ...`），同时附 `error_code: 'limit_blocked'` / `category: 'internal'` / `phase: 'run'` / `retryable: false` / `details: <LimitBlock>`。此前只抛 `Error('Usage limits exceeded')` / `Error('Termination policy triggered: ...')`，事件流与终端看不出命中了哪一项、当前值与上限。
- **默认输入 token 上限过低**：`limits.inputTokensLimit` 默认 100,000 → 1,000,000，与 `context.maxTokens` 的 1M 预算对齐；此前长上下文任务可能在压缩生效前被限额终止。
- **默认最大迭代次数过低**：`termination.maxIterations` 默认 20 → 50；`maxRuntimeSeconds` 仍 300。
- **Provider 非 2xx 丢失结构化信息**：OpenAI / Anthropic 的流式与非流式 4 处非 2xx 改抛 `ProviderHttpError`（`status` / `body` / `retryAfterMs`），message 仍为 `OpenAI API error: <status> - <body>` / `Anthropic API error: <status> - <body>`；错误 envelope 可从错误对象的 `status` 读取 `http_status`。
- **429 不读 Retry-After**：`provider-openai` / `provider-anthropic` 的 retry 在 429 时优先按错误上的 `retryAfterMs` / `retry_after_ms`（毫秒）、`retryAfter` / `retry_after`（秒）或 `retry-after` 头退避，受 `retry_max_delay_ms` 截断且不加抖动。
- **402 被重试**：额度耗尽（402）不再重试，避免再消耗一次配额；5xx 与网络错误行为不变（指数退避 + 抖动）。

### Changed

- **`LimitBlock` / `LimitExceededError` / `evaluateUsageLimits` / `evaluateTermination` 导出**（additive）：core 公开类型与纯函数，`MemoryLimitChecker.checkLimits` / `checkTermination` 复用同一判定；`limit.blocked` 仍是开放字符串事件名。`LimitBlock.key` 共七个（五个使用量 key + `max_iterations` / `max_runtime`），两类限额共用事件与 envelope 形状。
- **Provider 重试分类**：`withRetry` 只重试 429、5xx 与网络错误；其它 4xx（含 402）与 `AbortError` 不重试；流式已输出分片后不重试（不变）。
- 无新增 canonical RPC 方法（仍 40），无新增配置键；终止策略与使用量限额共用 `limit.blocked` 与 `run.failed` envelope，判定顺序仍是先终止、后使用量。

### Known limitations

- `max_runtime` 的 `current` 是已运行秒数（毫秒精度小数），未做整数归一。
- `retry-after` 只影响 429；402 与其它 4xx 直接失败。
- `ProviderHttpError.retryAfterMs` 只在 provider 适配层可用；`run.failed` envelope 只透出 `http_status`，不透出建议退避时间。
- 0.14.3 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.14.2] - 2026-10-21

> 0.14.2（基于 `release/0.14.2`，未发布）：两个缺陷修复——thinking 模型压缩后请求 400、bash 命令文本绕过内置凭据 denylist。以下均为已实现；未 tag、未 `npm publish`、未合并 `main`。

### Fixed

- **thinking 模型压缩后 400**：压缩摘要改为 `role: 'system'` + `compaction_summary: true`，插在基底 system 消息之后、其它消息之前。此前摘要写成 `role: 'assistant'` 且不带 `reasoning_content`，thinking 模式（如 DeepSeek）下压缩后的下一轮请求被拒。
- **旧摘要堆积**：应用新压缩时同时移除已有摘要，任意时刻最多一条。
- **摘要被当成基底 system**：请求组装只把非摘要的 system 视为基底 system；上下文缺 system 时的补回与 hook 改写 system 都不再替换摘要内容。
- **Anthropic 丢弃第二条 system**：`AnthropicProvider` 收集全部 system 消息并用空行合并后发送，流式与非流式共用；压缩摘要不再静默丢失，单条 system 与 OpenAI 兼容 provider 行为不变。
- **bash 命令文本绕过凭据 denylist**：`bash` 在 `checkPermission`（直接 `deny`）与执行前（返回 `path_denied`）检查命令文本，命中内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）即拒绝。覆盖 `~`、`$HOME`、`${HOME}` 与绝对路径写法，比较前归一大小写与 `/`、`\`。

### Changed

- **`Message.compaction_summary`**（additive）：core 内部用于识别压缩摘要，Provider 适配层忽略；不新增 RPC 方法（canonical 仍 40），不新增配置键。
- **bash 工具描述**：help 文本注明凭据路径会被拒绝，且该检查只匹配命令文本、不是沙箱。

### Security

- **命令文本检查不是沙箱**：只做归一化字符串匹配，不做 shell 解析。`cd` 后的相对路径、变量赋值 / 拼接、引号拆分、通配符、符号链接、`~root`、`%USERPROFILE%` 等仍可能绕过，不能把它当作隔离边界。自定义 `deny_paths` 不参与文本匹配（任意子串会误伤普通命令）。

### Known limitations

- **摘要标记不迁移**：旧版本写入的 `role: 'assistant'` 摘要不带 `compaction_summary`，不会被识别为摘要，只在下一次压缩时被替换。
- **Anthropic 合并无长度上限**：多条 system 合并后整体作为 `system` 字段发送，未按模型窗口单独截断。
- 0.14.2 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.14.1] - 2026-10-21

> 0.14.1（基于 `release/0.14.1`，未发布）：0.14.0 不单独 bump，本段合并记录 0.14.0 P0 与 0.14.1 / 0.15 折叠内容——可观察性与控制面、gateway 多实例 A、Host 对等与快照、ask_user 注册与 Web 聊天收口。以下均为已实现；未 tag、未 `npm publish`、未合并 `main`。

### Added

- **结构化错误 envelope**：`run.failed` / `tool.call.failed` 在保留原 `error` 文本的同时增加 `error_code` / `category` / `phase` / `retryable`，可从错误对象或消息识别时附 `http_status`，调用方可给非敏感 `details`；分类固定为 `provider|tool|permission|config|gateway|internal`。
- **可见性配置**：`ui.verbosity: minimal|normal|debug`（默认 `normal`）、`ui.showInternalEvents`（默认 `false`）、`ui.errorLevel: user|all`（默认 `user`）、`observability.showProcessErrors`（默认 `false`）；四个键都支持 `vessel config set`（YAML `verbosity` / `show_internal_events` / `error_level` / `show_process_errors`），非法值由 validator 拒绝。
- **只读控制面 CLI**：`vessel status [--json]`（本地配置、全部 gateway 实例、控制面 attach 状态）、`vessel agents [--json]`（canonical `agents.list`）、`vessel errors [--json] [--limit N]`（默认 20、上限 200，本地读 trace / `--connect` 走 `events.list`）。三者都不 bootstrap、不取 tenant 写锁、不输出密钥。
- **canonical `agents.list` / `agents.get`**：agent 注册表 RPC，canonical 方法总数 38 → 40；两者带 `result_schema`。
- **gateway 多实例 A**：PID / 日志 / 实例锁以 `(dataDir, instance)` 为键（default 为 `gateway.pid` / `gateway.log`，命名实例为 `gateway-<instance>.pid` / `gateway-<instance>.log`；实例锁 `gateway-<instance>.lock`）。新增 `vessel gateway list [--json]`；`start` 接受 `--instance` / `--port`，`stop` / `status` / `reload` / `restart` 额外接受 `--all`（与前者互斥；`restart --all` 必须带 `--daemon`）。实例名匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。
- **TUI 有效限制与 Self Card**：`/status` 增加 limits / budget / limit blocked 段（`as_of` 保留，idle 用量显示 `-`）；`/agents <id>` 增加 Self Card（as_of、tools（显式 > seen > unknown）、delegate 限制、剩余预算、最新 limit block）；`/errors` 对 `limit_blocked` 附 `[scope/key current/max · source · hint]`。
- **Host 对等**：`RunOptions.sessionId` 支持 per-run session；`AgentHandle.cancel` / `RuntimeHost.cancel` 接受 `RunInterruptReason`；`Host.resume(runId, opts?)` 经 Scheduler 排队（`ScheduledTask.runId` 保持 run id）；新增纯 JSON `HostSnapshot` / `AgentSnapshot` / `RunSnapshot` / `SchedulerSnapshot` 与 `snapshot()`；`pluginConfigs` / `logger` / `includeReasoning` 透传成员 runtime；合成 `agent.run.*` 事件带 `mirror_of_run_id`。
- **`ToolDefinition.display`**：可选 `{ label?, kind?: 'command'|'file'|'search'|'generic' }`，`listTools()` 原样透出；additive，不进入 LLM schema。
- **ask_user 注册扩展**：交互 REPL（TTY）与 `gateway start` / `--serve` 注册；`ui.ask_user`（`ui.askUser`）显式 `false` 按入口与 tenant 关闭；`vessel config set ui.askUser <true|false>` 可持久化。
- **Web 聊天渲染**：Codex 式工具卡（单行 header + 输入 / 输出 / 变更 / 错误分区、20 行 / 8KB 折叠、200KB 分段加载、复制、失败自动展开）；思考气泡（起止时间、12 行上限、流式展开 / 结束折叠、正文分离）；ask_user 内联到 `RunCard`，删除全局 `AskModal`；跨 session 顶部条同时汇总权限与提问；`ui.verbosity` 驱动 minimal / normal / debug 三级可见性。

### Changed

- **trace 流式过滤覆盖前缀**：`trace.includeStreamChunks=false`（默认）时，`llm.stream.chunk` 与 `<prefix>.llm.stream.chunk` 一律不落 trace；实时事件发布不变。
- **`--serve` 弃用**：从 `--help` 移除，保留为 default 实例的前台隐藏兼容别名，启动时向 stderr 打印弃用提示；新入口统一为 `vessel gateway start`。
- **errors 展示层级**：默认只含 run / tool / agent 级错误；`ui.errorLevel: all` 或 `observability.showProcessErrors: true` 时追加 process / shutdown / hook / plugin 级。
- **gateway 启动校验**：显式 `host.nodeId` 与其它运行实例重复时启动前拒绝（`duplicate_node_id`）；`gateway start --port 0` 必须同时给 `--instance`；无选择器且存在多个实例时返回 `multiple_instances`，不猜目标。
- **Web 流式性能**：`EventGroupCache` 按 run 增量并入并只重建受影响的 `RunGroup`；`RunCard` 使用 `memo` 与稳定回调；渲染组上限 200；滚动跟随节流 100ms。
- **TUI `/errors`**：有效级别 = 显式参数 > `ui.errorLevel` > `user`；`ui.showInternalEvents: true` 也会放开 internal 级。

### Fixed

- **Host 多 agent 复用默认 session**：`AgentHandle.run` 现在按 `RunOptions.sessionId` 为每个 run 选择 session，不再把成员默认 session 串到所有 run；单 agent 仍以显式 `sessionId` 参数为准。
- **resume 绕过并发 / 串行约束**：`Host.resume` 改经 Scheduler 排队，遵守 `maxConcurrency` / `perAgentSerial`；`resuming` 锁在 submit 失败、队列取消与 handle 结算时释放。
- **Host 丢失取消原因**：取消现在把 `RunInterruptReason` 透传到成员 runtime，`agent.run.cancelled` 可带 `reason`。
- **Host 未透传配置**：成员 runtime 现在继承 `pluginConfigs` / `logger` / `includeReasoning`。
- **带前缀流式事件绕过 trace 策略**：`subagent.llm.stream.chunk` 等转发事件按同一开关过滤。
- **Web 流式 token 触发整树重渲染**：增量 group cache + memo 后只更新受影响的 run 卡片。
- **多实例事件去重键冲突**：显式 `node_id` 跨运行实例重复时拒绝启动，避免 `(node, incarnation, run_id, seq)` 键碰撞。

### Security

- **实例锁文件**：`<dataDir>/gateway-<instance>.lock` 使用 `atomicWrite` + `0600`，目录 `0700`；实例名只接受安全字符集，非法名称拒绝。
- **跨实例 node_id 唯一**：显式 `host.nodeId` 不得与其它运行实例重复，拒绝信息只含实例名与 pid。
- **错误 envelope 不含敏感内容**：只携带分类 / 阶段 / 可重试性 / HTTP 状态与非敏感 `details`，不写 prompt、reasoning 或完整工具结果。
- **无客户端不注册 ask_user**：`--run` / headless / 管道不注册提问工具，避免无应答方时挂起；`ui.askUser: false` 可供嵌入方显式关闭。
- **默认不暴露内部事件**：`ui.showInternalEvents` / `observability.showProcessErrors` 默认关闭，`/errors` 与 `vessel errors` 默认只显示用户级错误。

### Known limitations

- **快照不持久化**：`HostSnapshot` 只反映当前进程内存，不能用于跨进程恢复或迁移；它不是 RPC 方法。
- **`display` 尚未全面消费**：`tools.list` 结果未包含 `display`，TUI / Web 仍保留按工具名的回退展示。
- **多实例只覆盖本地**：同机同 `dataDir` 的实例各自启动；不做跨实例调度、故障转移、负载均衡、日志轮转或每实例独立配置。
- **`--serve` 兼容期**：仍可用但不保证长期保留；脚本应迁移到 `vessel gateway start`。
- **提问仍按 120s 过期**：`ask_user` 使用事件时间 `event.ts + 120s`，未接入权限的持久化交互记录与无限等待语义。
- **验证范围**：定向测试覆盖 error envelope、trace 过滤、可见性配置、控制面命令、gateway 多实例、Host / Scheduler / durable resume、TUI limits 与 Web 渲染 / 缓存；全量门禁由 1 在收口时执行，本文档不声明具体通过数。
- 0.14.1 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.13.0] - 2026-10-20

> 0.13.0（基于 `release/0.13.0`，未发布）：TUI 双状态栏与权限生命周期重构；同时并入 0.12.1 的 TUI 小修（0.12.1 不单独发布）。权限等待默认不超时，pending / answered / orphaned 记录持久化到 `<dataDir>/interactions-<tenant>.json`；Web 权限改为 run 卡片内联应答。

### Added

- **TUI 运行态下栏 `BottomBar`**：与上栏同宽（`PanelFrame`），单行展示 `perm ask · N auto`（等待时改为 `waiting <tool>`）、`bash N`、`sub N`、`sess <短ID> · Ctrl+R`、tenant 与 queue。宽度分级：`<40` 列不渲染；`40–59` 显示 perm / bash / sub；`60–99` 增加 session；`>=100` 增加 tenant / queue。空间不足时按固定顺序从右到左丢弃 `tenant → queue → session → sub → auto`，`perm` / `bash` 保留。
- **状态栏显隐配置**：`ui.statusBars: top|bottom|both|none`（YAML `status_bars`），`vessel config set ui.statusBars <值>` 持久化到用户配置；`VESSEL_STATUS_BARS` 提供启动初始覆盖。下栏默认在 `rows >= 18` 时显示，手动切换结果写回 YAML，写回失败不回滚本次会话显示。
- **状态栏快捷键**：`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume` picker；快捷键在独占弹窗打开时仍可恢复栏位，并会覆盖 `ink-text-input` 插入的控制字符。
- **权限请求关联字段**：`tool.permission.request` 增加 `session_id` / `tool_call_id` / `deadline_at` / `source`（additive）；只有显式正数超时才写 `deadline_at`。
- **权限记录持久化**：`packages/serve/src/interactions-store.ts` 按 tenant 写 `<dataDir>/interactions-<tenant>.json`，状态为 `pending` / `answered` / `orphaned`，原子写且权限 `0600`。gateway 启动时加载；重启后仍为 `pending` 的记录转 `orphaned`。
- **Web 内联权限**：删除全局权限遮罩，`PermissionCard` 内联在 `RunCard` 中；跨 session 的待处理请求由顶部待处理条提示。其他端应答或过期时自动收起卡片。
- **RPC 错误码 `expired` / `run_ended`**：过期请求返回 `expired`；run 已结束或记录已 `orphaned` 时返回 `run_ended`，不再伪装成 `not_found`。canonical 方法总数仍为 38。

### Changed

- **上栏不再查询会话数**：删除 `N sess` 与每帧 `session.list()` 调用；路径在预算不足时中间省略（保留根与末两级目录），空闲且仍溢出时以 marquee 滚动（140ms / 格，首尾各停 1.2s），branch 固定在最右（超过 24 格尾部截断）。
- **下栏吸收 hint 行**：下栏显示时底部快捷键提示并入 `PanelFrame`，行预算净增 2 行；独占 overlay 打开时下栏让位，终端 `<40` 列按未渲染计入行预算。
- **权限等待默认不超时**：权限请求一直等待应答、取消或 abort；只有 core 显式配置正数 `RuntimePermissionConfig.timeoutMs` 才产生 `PermissionTimeoutError`。取消抛 `PermissionAbortedError`（`permission_cancelled`，`name: AbortError`），不再误报 `permission_timeout`。
- **serve 不再按 TTL sweep pending**：pending 的失效由 run 终态与进程重启决定，不做时间淘汰；run 结束时同 run 的 pending 全部清出并持久化为 `orphaned`。重复应答幂等返回首次结果；同一请求以不同决定重答返回 `conflict`。
- **Web 权限语义**：权限卡片不再按 120s TTL 丢弃；`ask_user` 弹窗仍按事件时间计算有效期。权限应答支持 `once` / `session` / `always`，`permission.respond` 的 `remember` 保留为 `always` 兼容写法。
- **CLI / TUI 品牌色统一**：TUI `theme.brand` 与 CLI `src/ui-style.ts` 主色统一为 `#c2a273`；CLI 标题与分组用同色 + `BOLD` 强调，不再使用 `#d08a3a` / `#e8a94c`。
- **斜杠提示宽度**：`computeDialogWidth = max(1, columns - 4)`，移除 72 列上限；`InlineAutocomplete` 订阅 `useWindowSize`，resize 后立即重排。
- **`/exit` 退出提示**：Ink unmount 并清理最后一帧后输出 `Goodbye!`；`Ctrl+C` 退出行为不变，简单模式不变。

### Fixed

- **0.12.1 TUI 小修并入**：窄 / 宽终端下斜杠提示不再被固定 72 列截断；弹窗跟随终端宽度；启动头 / wordmark / tagline 与 CLI 样式使用同一品牌色。
- **状态栏路径截断**：路径按显示列计算，CJK / emoji 不再被 `.slice` 截成半个字符；超长路径不再挤掉 branch。
- **状态栏会话计数陈旧**：删除上栏 `N sess` 后不再依赖可能过期的会话列表；session 入口改由下栏短 ID + `Ctrl+R` 提供。
- **权限卡片跨端残留**：其他端应答、请求过期或 run 结束后的旧卡片会被收起；迟到应答收到 `run_ended` 时提示「run 已结束」而不是静默失败。
- **权限取消被误报为超时**：abort 优先于超时判定，取消不再产生 `permission_timeout` 或留下“等待中”卡片。
- **Web 刷新后权限恢复**：应答/终态记录随事件重放恢复卡片状态；持久化记录用于跨重启的幂等与 `run_ended` 语义。

### Security

- **权限记录文件**：`<dataDir>/interactions-<tenant>.json` 走 `atomicWrite` 并显式 `0600`；tenant 名只接受 `[A-Za-z0-9._-]`，不安全名称不落盘。
- **持久化损坏不阻断启动**：交互记录文件不可读 / 损坏时向 stderr 报错并按空集处理，不删除原文件。
- **跨 tenant 应答拒绝**：`permission.respond` 校验请求产生时的 tenant，不匹配返回 `not_found`，不跨 tenant 泄漏请求状态。
- **记录上限不淘汰 pending**：有界记录清理只淘汰最旧的 `answered` / `orphaned`，pending 始终保留。

### Known limitations

- **`allow session` 尚未生效**：core 的 `PermissionPolicy` 只读取 `remember`（等价 `always`），`session` 范围目前等同 `once`；需后续在 core 增加 session 级批准集合。
- **无 `interactions.pending` RPC**：Web 刷新后的待处理恢复依赖事件重放缓冲（默认 10000 条），超出缓冲的旧请求可能无法恢复；未提供独立 pending 查询方法。
- **`ask_user` 仍是全局弹窗**：本版本只把权限请求改为 run 内联；提问仍走 `AskModal` 与事件时间 TTL。
- **状态栏写回失败不提示**：手动切换会写回 YAML，写入失败只保持本次会话显示，不向用户弹出错误。
- **`VESSEL_STATUS_BARS` 只是初始值**：环境变量不随手动切换改变，也不写入配置；两者同时存在时 env 优先于 `ui.statusBars`。
- **验证范围**：Windows 全量门禁 `3226 pass / 2 skip / 0 fail`（`VESSEL_VALIDATE_RESULTS=1`）；POSIX（oven/bun + 持久缓存）`3228 pass / 0 fail`，build 与 Web build 通过；typecheck / biome / check-deps / check-docs / check-rpc-methods 均为 0。
- 0.13.0 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.12.0] - 2026-10-20

> 0.12.0（基于 `release/0.12.0`，未发布）：Gateway 生命周期与热重载 + CLI 暗金样式与自更新；同时并入 0.11.1 的权限交互、思考流与默认工作目录修复（0.11.1 不单独发布）。gateway 常驻、服务注册与 `gateway.reload` 都需显式命令触发，不随启动自动改本机配置。

### Security

- **权限交互过期按事件时间计算**：Web 权限 / 提问弹窗的 `expiresAt = event.ts + 120s`，不再用浏览器收到事件的时间；重放 / 刷新后的旧请求直接丢弃，避免服务端已丢弃的请求被重新计时后误点。应答返回 `not_found` 时移除弹窗并提示已过期，不静默保留。
- **权限超时是致命错误**：core 的权限等待超时抛 `PermissionTimeoutError`（`code: 'permission_timeout'`），run 以失败结束，不把超时当成普通工具错误交给模型重试。
- **思考流默认不外泄**：`ui.showReasoning` 默认 `false`；只有显式开启时才把 provider 的 `reasoning_delta` 经 `llm.stream.chunk` 发布给 UI。`trace.includeStreamChunks` 仍默认 `false`，思考增量默认不落 trace。
- **PID 与服务定义权限**：`<dataDir>/gateway.pid` 以同目录临时文件 + rename 原子写入，权限 `0600`；daemon 日志目录 `0700`、日志文件 `0600`。PID 属主校验避免误删其它进程持有的文件。
- **热重载只承诺可验证的范围**：`gateway.reload` 为 admin-only；plugins 只刷新扫描缓存，config 只有 `serve.allowed_origins` 热更新，其余字段如实返回 `requires_restart`，不把未生效的改动报成成功。
- **服务注册需显式命令**：`install-service` / `uninstall-service` 只在用户主动执行时写入用户级定义并调用平台注册命令；不随 `gateway start` 或包安装自动修改本机服务。
- **自更新不碰工作区**：`vessel update` 只对 npm / bun 全局安装执行 `npm i -g vessel-agent@latest` / `bun add -g vessel-agent@latest`；源码 / 开发模式只打印 `git pull && bun install`，不改动工作区。

### Added

- **`vessel gateway` 生命周期命令**：`start [--daemon] [--port <n>] [--host <h>] [--log <path>]`、`stop [--timeout 10s]`、`status [--json]`、`restart [--daemon]`、`reload [--scope config,plugins]`、`install-service [--systemd|--launchd|--schtasks]`、`uninstall-service`。前台 `start` / `restart` 走原有 `--serve` 装配管线；`--serve` 保留为前台别名。
- **daemon 与 PID 状态**：`start --daemon` 用分离子进程常驻，stdio 追加到 `<dataDir>/logs/gateway.log`；PID 文件 `<dataDir>/gateway.pid` 记录 `{pid, started_at, host, port, version, node_id?}`。`status` 输出运行状态、地址、uptime、版本、服务注册状态；`--json` 为纯 JSON。死 PID、损坏文件或命令行不匹配按 stale 处理并可回收。
- **系统服务注册**：Linux 生成 systemd **user** unit，macOS 生成 LaunchAgent plist，Windows 生成登录时计划任务（`VesselGateway`）；运行命令固定为 `vessel gateway start`。只支持当前平台，指定其它平台或不支持的平台明确报错，不静默降级。
- **`gateway.reload` canonical RPC**：新增 admin-only 方法，`params { scopes?: string[] }` → `{ reloaded: string[], requires_restart: string[] }`；canonical 方法增至 38 个（37 个 domain 方法 + `events.subscribe`），带 `result_schema`。CLI 经本地 HTTP RPC 调用，token 来自配置、不放 URL。
- **`vessel update` 自更新**：按安装形态选择 `npm i -g vessel-agent@latest` / `bun add -g vessel-agent@latest`；默认交互确认，`--yes` 跳过（非 TTY 无 `--yes` 直接失败）；源码 / 开发模式只提示。`--check` 行为不变（只检查与提示）。
- **`ui.showReasoning`**：布尔配置，默认 `false`；`vessel config set ui.showReasoning <true|false>` 可写入用户配置。TUI / Web 在开启后折叠展示「思考过程」。
- **`agent.cwd`**：默认工作目录配置，支持 `~`；`bash` 未显式传 `cwd` 时使用它，`read` / `edit` 的相对路径按它解析。`vessel config set agent.cwd <path>` 可写入用户配置。
- **CLI 暗金样式**：`src/ui-style.ts` 提供标题、分隔线、状态前缀与 `label value` 对齐；覆盖全部一次性命令的人类可读输出。ANSI 只在 stdout 为 TTY、未设置 `NO_COLOR` 且 `TERM !== 'dumb'` 时输出；`--json` 与表格数据行保持纯文本。

### Changed

- **`--serve` 与 gateway 命令统一入口**：`vessel --serve` 与前台 `vessel gateway start` 走同一前台装配管线；常驻部署统一走 `vessel gateway start --daemon` 或服务管理器，不再需要自行拼接后台命令。
- **`restart` 语义**：先 `stop`（默认等待 10s）再按前台 / `--daemon` 方式启动；PID 指向自身时拒绝停止。
- **热重载范围**：`gateway reload` 缺省重载 `config,plugins`；`--scope` 只接受这两个值。`plugins` 清空插件目录扫描缓存，已安装插件与 active run 不受影响；`config` 重新读取配置，仅 `serve.allowed_origins` 经 `Gateway.reconfigure` 生效。
- **Web 权限弹窗**：显示剩余有效期；同一 `requestId` 只允许一次提交（双击 / 重复点击不发第二次 RPC）；过期项定时移除。
- **TUI / Web 思考展示**：`reasoning_delta` 合并成独立、可折叠的思考块，与正文文本分开；未开启 `ui.showReasoning` 时完全不发布。
- **`vessel update` 文案**：`--check` 仍只提示；不带 `--check` 时按安装形态执行或提示，成功后提示重启当前进程。

### Fixed

- **Web 流式内容必须刷新才可见**：`EventStore` 发布快照时复制 `entries` 数组；消费者用 `snapshot.entries` 派生的视图在流式增量到达时正确重算，不再需要手动刷新。
- **重放旧权限请求重新计时**：TTL 改由事件时间推导后，重连 / 刷新不会把历史请求当成新请求；`not_found` 不再表现为无响应的弹窗。
- **权限超时被当成可重试工具错误**：超时现在直接失败 run，不再让模型反复申请同一权限。
- **思考增量污染 trace**：只有显式 `ui.showReasoning: true` 才发布 `reasoning_delta`；trace 仍默认不落 stream chunk。
- **相对路径落在进程 cwd**：配置 `agent.cwd` 后，`bash` / `read` / `edit` 的默认目录与相对路径按配置解析；显式 `cwd` 仍优先，denylist 与 `allowed_roots` 继续生效。
- **gateway reload 假装成功**：配置读取失败、`reconfigure` 抛错或 scope 未知都返回 RPC 错误；不可热更新的字段只出现在 `requires_restart`。

### Known limitations

- **0.11.1 不单独发布**：其修复已并入本版本；不存在 `0.11.1` 的 tag、CHANGELOG 段落或 npm 版本。
- **热重载边界**：`gateway.reload` 只承诺 plugins 扫描缓存与 `serve.allowed_origins`。provider / model / agent / permission / TLS / token / port 等变更必须重启；已安装插件与 active run 不会被替换。
- **服务注册只覆盖当前平台**：Linux 只写 systemd user unit，macOS 只写 LaunchAgent，Windows 只建登录计划任务；不支持 root 级系统服务，也不做跨平台交叉注册。平台注册命令失败时 `install-service` 返回非 0。
- **daemon 不自带崩溃重启**：`gateway start --daemon` 只是分离进程；需要常驻与自动拉起时用 `install-service` 交给 systemd / launchd / 计划任务。PID 存活判定依赖读取命令行，读不到时按 stale 处理。
- **自更新只覆盖 npm / bun 全局安装**：源码 / 开发模式与未知安装形态只提示；不提供独立二进制或二进制自替换（ADR-006 继续有效）。非 TTY 环境必须显式 `--yes`。
- **CLI 样式不是语义输出**：ANSI 仅在 TTY 且未禁用颜色时输出；`--json`、路径与数据行不加颜色。重定向到文件时本来就不会有 ANSI。
- **思考流是 UI 行为**：`ui.showReasoning` 只控制是否向 UI 发布增量，不改变模型请求参数；provider 是否返回 reasoning 取决于模型与端点。
- **验证范围**：本版本 Windows 全量门禁为 `3126 pass / 2 skip / 0 fail`（`VESSEL_VALIDATE_RESULTS=1`）；POSIX CI 实跑仍待完成，文档不宣称已通过。
- 0.12.0 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入。

## [0.11.0] - 2026-10-20

> 0.11.0（基于 `release/0.11.0`，未发布）：UI 设置与终端观感 + npm scope 归属。TUI 新增 `/settings language`，Web 壳层接入 zh-CN / en，终端面板改为全宽并统一边框；18 个可发布子包从 `@vessel/*` 迁到 `@vessel-agent/*`（根包仍是 `vessel-agent`）。

### Added

- **TUI `/settings language <zh-CN|en>`**：经装配层注入的 `ctx.settings.setLanguage` 把语言持久化到用户配置 `ui.language`，成功后立即 `setLocale` 重渲染；未注入 `ctx.settings` 时只读；写入失败显示 `error.command.settings`。`VESSEL_LANG` 仍是最高优先级，显式设置环境变量时命令不会改变当前显示。
- **`ui.clearOnStart?: boolean`**（默认 `true`）：TTY 进入 REPL 前清可视区并归位光标（`\x1b[2J\x1b[H`）；显式 `false` 或非 TTY 不清屏。
- **`vessel config set ui.language <zh-CN|en> [--json]`**：原子写 `~/.vessel/config.yaml`（`0600`，保留其它键），本地 REPL 与 `--connect` 两处 `ReplContext` 都注入 `settings`。
- **Web 壳层 i18n**：`apps/web/src/i18n/` 提供 zh-CN / en catalog，覆盖导航、面包屑、Settings 六个 tab、Appearance 与通用按钮；locale 取 `localStorage['vessel.ui.language']` > `navigator.language`；Settings → Appearance 提供语言选择并立即重渲染。
- **npm scope `@vessel-agent`**：18 个可发布子包从 `@vessel/*` 改为 `@vessel-agent/*`；根包仍为 `vessel-agent`（bin 仍是 `vessel`）。源码 import、manifest、`scripts/{version,release-dry-run,check-deps,smoke-subpaths,smoke-install}.ts` 与当前维护文档同步更新。

### Changed

- **面板全宽**：移除 `VIEW_MAX_WIDTH = 160`，视图宽度改为 `cols - 2`（`VIEW_HORIZONTAL_MARGIN`），宽终端不再人为留白。
- **统一边框与行数预算**：状态栏、启动头 + 会话摘要、队列预览改用单线 `PanelFrame`；`STATUS_BAR_ROWS = 3`，minimal 数据行封顶 `MINIMAL_ROW_CAP = 3`，14 / 15 行终端切换时容量不回落。
- **locale 可在运行中切换**：TUI 不再要求改配置后重启；Web 语言选择即时生效。
- **安装与发布引用**：`release-dry-run`、`smoke-install`、`check-deps`、`smoke-subpaths` 全部按 `@vessel-agent/*` 解析；历史 ADR 与 CHANGELOG 的既往版本段落保留旧包名，不改写。

### Known limitations

- Web 只有壳层 i18n（导航 / 面包屑 / Settings / Appearance / 通用按钮）；功能页未收录的 key 回退中文，不能宣称 Web 已全量本地化。
- TUI `/settings` 依赖 asm 注入 `ctx.settings`；未注入的宿主只能只读查看语言，不能切换。
- `ui.clearOnStart` 只影响 TTY 的 REPL 启动；非 TTY / headless 不清屏。
- `VESSEL_LANG` 优先于 `config.ui.language`；环境变量显式设置时，`/settings` 与 `config set` 会写入配置但当前显示不变。
- 0.11.0 仍未 tag、未 `npm publish`、未合并 `main`；manifest 版本由 1 在收口时统一写入，本周期文档不维护版本副本。

## [0.10.0] - 2026-10-20

> 0.10.0（基于 `release/0.10.0`，未发布）：发版硬化——首启与配置、上下文 / 运行时、日志与可观测、打包与分发、CLI 语言。新增能力都保留兼容路径；根包与 18 个可发布子包已 bump 到 `0.10.0`，发布名改为 `vessel-agent`。

### Security

- **trace 文件权限**：trace 文件以 `0600` 创建；`trace.includeStreamChunks` 默认 `false`，`llm.stream.chunk` 不再默认落盘（需要时显式开启）。
- **配置来源脱敏**：`config show --sources` 中 `serve.tokens.<token>.*` 的 token 段与值替换为 `<set>` / `<set#N>`，`*.apiKey` / `*.token` 的来源值统一 `<set>`；不再输出解析后的密钥。
- **`transport.token` 不再当 gateway admin**：远程 transport 的 token 只用于节点间认证，不能提升为 gateway 管理权限。
- **诊断不写 stdout**：`VESSEL_DEBUG` 不再把 prompt 正文打印到 stdout；诊断日志统一走 stderr（stderr JSON），并默认经 trace redactor 脱敏。
- **异常兜底不泄露原文**：`unhandledRejection` / `uncaughtException` 的 `process.error` 事件只带 `kind` 与脱敏后的 message，不带 stack / 原始对象；shutdown 失败同样只记录脱敏字段。
- **hook-logging 默认 stderr**：hook 日志不再混入命令结果 / JSON 输出。

### Added

- **统一 API Key 解析**：`resolveEffectiveApiKey()` 统一处理 provider 级 key、`*_env` 与顶层 `apiKey`，各入口不再各读一套。
- **首启诊断**：`config init` 生成的模板可直接启动，输出下一步提示；`--json` 下错误为结构化对象；CLI 统一错误 formatter。
- **`Logger` 端口**（core）：`Logger` / `LogLevel` / `LoggerOptions` 类型 + `createStderrLogger()`（stderr JSON、级别阈值、redact）与 `noopLogger`；CLI / serve 通过 `createCliLogger()` 读取 `VESSEL_LOG_LEVEL`（`VESSEL_DEBUG` 非空等价 debug）。
- **interrupt 原因**：`AgentRuntime.interrupt(reason?: 'shutdown' | 'timeout' | 'user')`，与 `RunOptions.signal` 合并为同一取消信号；`shutdown` / `timeout` 落 `interrupted` checkpoint，可 `--resume-run`。
- **provider 超时与重试观测**：provider 插件默认 120s 请求超时（`timeout_ms`，`<=0` 关闭），超时抛 `ProviderTimeoutError`（`provider_timeout`）；重试通过 `onRetry` 回调输出结构化事件。
- **MCP 告警结构化**：MCP server 连接 / 工具冲突告警写 stderr 并发布 `mcp.warning` 事件。
- **CLI i18n**：`src/i18n/` 提供 zh-CN / en 两份 catalog（各 85 个 key）与 `t(key, params?)`；`--help`、一次性命令错误、默认空状态与 demo banner 走同一 locale 解析。
- **安装解析 smoke**：`scripts/smoke-install.ts` 对 18 个子包 + 根 tarball 执行 `npm pack`，用本地 `file:` `overrides` 安装后运行 `vessel --version` / `VESSEL_MOCK=1 vessel --tools`，并断言根 tarball 含 `apps/web/dist/index.html`；CI 新增 `install-smoke` job，`release.yml` 的 `verify` 与 `publish-npm` 都先构建 Web 控制台再打包 / 发布。
- **包元数据**：18 个子包补充 `files: ["src"]`、`license`、`repository`、`engines`；根包 `files` 排除 `**/node_modules/**` 并加入 `apps/web/dist`。

### Changed

- **配置优先级收窄**：legacy `default_provider` / `providers` 与新版 `provider:` 并存时新版优先，并对 legacy 键发 deprecation warning；legacy 仅作只读兼容。
- **未知 provider 必须显式端点**：未注册 provider 且无 `provider.base_url` 时抛 `ProviderConfigError`（`provider_invalid`）；有 `base_url` 时按 OpenAI 兼容端点构造，并只向 stderr 打一次 info。
- **YAML 错误不再静默**：YAML 解析错误 / 重复键转为带文件路径（与行号）的 validation error，不再回落默认配置。
- **`context.maxMessages` 默认移除**：缺省时 core 按 `context.maxTokens` 推导安全条数上限；显式配置仍优先。
- **上下文不再硬截断**：去掉 100 条硬截断；token 估算统一覆盖 `tool_calls` / `reasoning` / system 消息；超限先摘要，system 消息永不丢弃。
- **400 context-overflow**：provider 返回 400 且命中 overflow 模式时，强制压缩一次并重试一次；压缩失败不覆盖原始错误。
- **网关关闭**：`gateway.stop()` 幂等；先 `interrupt('shutdown')`，最多 drain active run 5s，再关连接 / HTTP；关闭顺序固定为 `stop → 取消订阅 / 关闭 transport → beforeClose → closeAll → shutdown`，serve 路径不再二次 drain。
- **根包发布名**：根 `package.json` 为 `vessel-agent`，bin 仍是 `vessel`；`release.yml` 先发布 18 个子包（core → permission → config → serve → tui → plugins），最后发布根包。
- **CLI 本地化范围**：默认 zh-CN，`VESSEL_LANG` 优先；TUI 与 CLI 共用同一优先级；命令的数据输出（会话 / trace / metrics / 成本等）保持英文。

### Fixed

- **未知 provider 静默回退**：不再猜测厂商默认端点；缺 model 的已知 provider 也 fail-fast，不全局回退 `gpt-4`。
- **重复键被吞**：YAML 重复键与解析失败不再被当作空配置。
- **上下文 100 条上限**：长对话不再因条数上限被截断。
- **400 overflow 直接失败**：先压缩再重试一次。
- **调试输出污染 stdout**：`VESSEL_DEBUG` 的 prompt 正文与日志移到 stderr，stdout 只留命令结果 / JSON。
- **重复 drain**：serve 关闭时 gateway 与 bundle 不再各等一次 active run。
- **provider 请求无超时**：默认 120s，避免挂死。
- **`config show --sources` 泄露**：token / apiKey 来源值统一脱敏。

### Known limitations

- host 模式（直接使用 `PluginHost` 装配）不经过 `AgentRuntime.interrupt()`；durable run 与 workflow 的 drain 语义未在 host 模式覆盖。
- 跨节点去重集合仍不持久化，只保证单 gateway 进程生命周期内 at-most-once；文档不宣称跨重启 exactly-once。
- RPC 结果校验默认关闭，只有 `VESSEL_VALIDATE_RESULTS=1` 时生效；CI 的 Test step 固定开启。
- provider 插件没有事件总线，重试观测只能通过 `onRetry` 回调或 stderr 日志，不会发布 core 事件。
- 安装解析 smoke 只在 POSIX / Node 22 运行；Windows 的 npm `.cmd` bin shim 与 `file:` override 未验证，默认跳过。
- CLI 本地化覆盖 `--help` / 错误 / 空状态 / demo banner；命令数据输出仍为英文，Web 前端未本地化。`--help` 在配置加载前短路，只能看到环境变量层。
- `context.maxMessages` 缺省值由 core 按 token 预算推导；依赖旧默认条数的调用方需显式配置。
- 0.10.0 仍未 tag、未 `npm publish`、未合并 `main`；根包与子包版本已 bump，lock 由 ext 在集成线刷新。

## [0.9.0] - 2026-10-20

> 0.9.0（基于 `release/0.9.0`，未发布）：Wave 2B2B 收口——插件生命周期 v2、canonical RPC 方法的结果 schema、跨节点去重键（含进程代际 `incarnation`）。新增能力都保留默认兼容路径；版本号由 1 在集成线统一写入。

### Added

- **插件生命周期 v2**（core）：`Plugin.init?(ctx: { host })` 在所有插件安装完成后按安装顺序调用，单个 `init` 抛错发 `plugin.init.failed` 并继续；`Plugin.dispose?()` 按逆安装顺序 best-effort 调用，抛错只发 `plugin.dispose.failed`，`AgentRuntime.dispose()` 幂等（Promise 缓存）并在最后关闭 session。`PluginHost.beginPluginInstall?()` 返回 `{ commit, rollback }` 安装作用域；安装失败先回滚该插件本次的 tool / provider / guardrail / hook 注册，再发 `plugin.failed` 并重抛（fail-fast 语义不变）。新增 `plugin.loaded` 事件（`name` / 可选 `version`）。
- **RPC 结果 schema**（serve / web）：37 个 canonical 方法全部声明 `result_schema`（36 个 domain 方法 + `events.subscribe`），复用片段集中在 `packages/serve/src/gateway/methods/schemas.ts`。
- **结果校验开关**：`VESSEL_VALIDATE_RESULTS=1` 时按 `result_schema` 校验结果；违反返回 `internal`（details 仅 `method` / `path`）并发 `rpc.result_invalid`。默认关闭。
- **协议版本单源**：`PROTOCOL_VERSION` 是唯一版本常量，`RPC_VERSION` 保留为兼容别名；HTTP / WS / `hello` / team / transport 中硬编码的 `1` 已替换。
- **去重键含 `incarnation`**：事件键 `${node}:${incarnation}:${run_id ?? '-'}:${seq}`；代际变化或 seq 回退只清空该节点的键。消息键 transport 为 `${from}:${id}`、网关为 `${tenant}:${from}:${id}`，spawn 为 `${tenant}:${request_id}`。网关 `hello` / `peers` 透出 `incarnation`，缺失按 `-` 处理以兼容旧对端。

### Changed

- 关闭链全部 `await`：bootstrap / CLI / serve 的 shutdown 路径等待 runtime 释放完成；工厂式插件（MCP client、workflow engine）由装配层显式 close，并各自实现幂等 `dispose()`；其余 11 个仓库插件没有需要释放的资源。
- `withPluginConfig` 保留 `init` / `dispose`，包装后不再丢失生命周期钩子。
- `sessions.list` 的 `branch` / `tenant_id` / `ended_at` / `end_reason` 在真实 session 中可能为 `null` 或缺失，校验器不支持 nullable / union，因此这四个字段不声明类型（任意值通过）；`required` 与其余字段仍受约束。
- CI：`quality` 与 `cross-platform` 的 Test step 以 `VESSEL_VALIDATE_RESULTS=1` 运行，保持结果 schema 与实现同步。

### Known limitations

- 去重集合不持久化：承诺只覆盖单 gateway 进程生命周期内的 at-most-once；重启后同一 `id` 可能再次投递。
- host 模式（直接使用 `PluginHost` 装配）绕过生命周期 v2，不保证 `init` / `dispose` 被调用。
- 工厂式插件（MCP client、workflow engine）不走 `Plugin.dispose` 的自动路径，必须由装配层显式关闭。
- `runs.get` 的 `result_schema` 是 `RunStatus` 与 durable checkpoint 的宽松超集，不是精确校验。
- 结果校验默认关闭；运行时默认不校验，只有设置 `VESSEL_VALIDATE_RESULTS=1` 才生效。

## [0.8.7] - 2026-10-20

> 0.8.7（基于 `release/0.8.7`，未发布）：上下文默认预算提升到 1,000,000 token，并补齐 CI 与发布脚本的前置条件。`provider.maxTokens`（单次输出上限）与 `context.maxTokens`（上下文预算）仍是两个独立配置。

### Changed

- `context.maxTokens` 默认值 4096 → **1,000,000**：core `context-manager.ts` 的三处 fallback（构造、summarizer 预算、`shouldCompact`）与 config `defaults.ts` 的 `context` 默认值同步调整；provider 请求的 `max_tokens` **仍为 4096**，不随上下文预算变化。
- 自动压缩阈值仍为 `compactThreshold: 0.8`，默认约 **800,000** 估算 token 才触发摘要。
- CI：`quality` 与 `cross-platform`（ubuntu / windows / macos）在 `bun test` 前执行 Node 22 + `apps/web` 的 `npm ci`；根 `workspaces` 不含 `apps/web`，此前 `apps/web/tests` 会因缺少 `react` 计为 error。
- Build：`scripts/version.ts` 写模式在 bump 版本时同步各 manifest 的 `@vessel/*` 依赖为精确目标版本（含 `workspace:*`），修复 `release-dry-run` 的 `internal_dependency_version`。

### Known limitations

- 1,000,000 默认预算可能超过小上下文模型（如 8k 窗口）的实际容量；使用这类模型必须显式配置 `context.maxTokens`。
- 默认自动压缩在约 800k 估算 token 才触发，小窗口模型在显式调低预算前不会得到保护。
- token 计数是估算值，不等于 provider 的精确窗口 / 计费统计。

## [0.8.6] - 2026-10-20

> 0.8.6（基于 `release/0.8.6`，未发布）：确定性 mock 场景与 `vessel demo`。默认 mock 行为（`echo`）与 0.8.5 逐字一致；core 不引入场景概念。版本号由 1 在集成线统一写入。

### Added

- `src/mock/scenarios.ts`：`resolveMockScenario()` / `createScenarioProvider()`；场景名 `echo`（默认）/ `tools` / `permissions` / `error` / `multi-turn` 为冻结契约。`echo` 的文本、usage 与流式分片与 core `MemoryLLMProvider` 逐字一致。
- `tools` / `permissions`：首轮返回一次 `bash echo vessel-demo-ok` 的 tool_call，收到 tool 结果后以固定文本收尾；`error` 抛固定错误；`multi-turn` 返回 `Turn N: <输入>`。
- `VESSEL_MOCK_SCENARIO`：只在 `src/cli.ts` 读取一次，经 bootstrap / tenant runtime factory 透传到 provider factory；未设置时仍用 `MemoryLLMProvider`；未知值回退 `echo` 并打印一行 stderr 警告。
- `vessel demo`：CLI 模式（复用现有 bootstrap / REPL，不进一次性命令注册表），固定 mock + `tools` 场景，数据目录隔离到 `<dataDir>/demo`，不读用户已有 session；`--help` 可见。非 TTY 时打印提示并 exit 1。
- 测试 `src/__tests__/mock-scenarios.test.ts`：5 个 CLI spawn 用例，含未知场景回退与 `error` 场景的反向验证。

### Changed

- README 快速开始步骤① 改为 `vessel demo`；`VESSEL_MOCK=1` 保留为调试 / CI 用法。
- `vessel demo` 忽略 `VESSEL_MOCK_SCENARIO`，固定 `tools`；`VESSEL_MOCK` 的语义不变。

### Known limitations

- `vessel demo` 需要交互式 TTY；非 TTY 直接失败（CI 用 `VESSEL_MOCK=1 ... --run`）。
- evals 与 workflow 未接入场景 provider，仍使用各自固定的 mock 行为。
- `vessel demo` 的引导文案与 CLI 输出未本地化（0.8.5 的本地化范围限制继续有效）。

## [0.8.5] - 2026-10-20

> 0.8.5（基于 `release/0.8.5`，未发布）：TUI 本地化（zh-CN / en）。用户可见文案收敛到 catalog 并经 `t()` 查表；新增 `ui.language` 配置与 `VESSEL_LANG` 环境变量。默认 zh-CN 文案与 0.8.4 逐字一致。版本号由 1 在集成线统一写入。

### Added

- `packages/tui/src/i18n/`：`index.ts`（`resolveLocale` / `setLocale` / `getLocale` / `t`）、`messages/zh-CN.ts`、`messages/en.ts`；两份 catalog 各 271 个 key，集合一致。
- `packages/config`：`VesselConfig.ui.language`（`UiConfig`），validator 的已知键包含 `ui` / `ui.language`；配置含该字段时不再被当作未知键拒绝。
- locale 优先级：`VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`；`zh` / `zh-*` / `zh_*`（可带 `.UTF-8`）归一为 `zh-CN`，`en` / `en-*` 归一为 `en`，非法值跳过该层。
- 新增 ADR-062。

### Changed

- TUI 启动头 / 摘要、状态栏、确认与提问弹窗、队列预览、命令描述与错误文案改走 `t(key, params?)`；会话选择器、setup wizard、流式与工具显示同步。
- `t()` 缺失 key 回退 zh-CN，再回退 key 本身；缺失参数保留 `{name}` 原文，不抛错、不打印。
- locale 在 REPL 启动时解析一次并进程内固定；wizard 没有 `ReplContext`，只按环境变量解析。

### Build

- 根 `package.json` 的 `files` 排除 `__tests__` 与 `*.test.ts` / `*.test.tsx`：`npm pack --dry-run` 由 packed **1,035,163 B** 降到 **642,679 B**、unpacked **4,349,088 B** 降到 **2,549,095 B**、文件数 **660** 降到 **374**；包内测试文件为 0。
- 根 `dependencies` 显式声明 `@vessel/{config,core,permission,serve,tui}` 为 `^0.8.5`。**发布前提：先发布这些子包**，否则 tarball 安装时依赖无法解析。

### Known limitations

- CLI 一次性命令（`--run` / `--tools` 等）与 Web 前端未本地化。
- 运行时切换语言需重启 REPL / wizard 进程。
- wizard 只读环境变量，不读 `config.ui.language`。
- 命令的数据输出（会话 / trace / metrics / 成本等）仍为英文；`t()` 只覆盖 UI chrome 与交互文案。
- 新增 key 必须在 `zh-CN` 与 `en` 两份 catalog 同步；en 缺失时静默回退 zh-CN，不会报错。

## [0.8.4] - 2026-10-20

> 0.8.4（基于 `release/0.8.4`，未发布）：TUI 可见问题修复——重复 key、ANSI 控制序列、Markdown 归档与 resize。全部改动在展示层，core / 工具的原始返回值不变。版本号由 1 在集成线统一写入。

### Added

- `packages/tui/src/utils/sanitize-terminal-text.ts`：纯函数 `sanitizeTerminalText()`（CSI / OSC / ESC / C0 / DEL / C1 清洗，`\r\n` 与 `\r` 归一为 `\n`）。
- `packages/tui/src/utils/text-layout.ts`：纯函数 `lineKey(index)`。
- `packages/tui/src/repl/use-repl-state.ts`：`HistoryItem`（`{ text, markdown? }`）。
- 新增 ADR-061。

### Fixed

- **React duplicate key**：`TextViewer` / `QuickHelp` / `QueuePreview` / `ToolTrail` 的列表 key 从“累计字符偏移”改为按行下标（`lineKey(index)`）；连续空行或重复文本不再产生相同 key。
- **ANSI 控制序列破坏布局**：新增纯函数 `sanitizeTerminalText()`，去除 CSI / OSC / 其它 ESC / C0 / DEL / C1，保留 `\n` / `\t`，并把 `\r\n` 与 `\r` 归一为 `\n`；`TextViewer`、`ToolTrail`、`StreamOutput` 与命令输出归档在渲染前清洗。
- **Markdown 归档回退成源码**：流式完成后历史项带 `markdown: true`，`<Static>` 继续用 `<MarkdownText>` 渲染；命令输出与用户输入仍按纯文本渲染。
- **resize 不生效**：`ink-repl.tsx` 改用 Ink `useWindowSize()` 订阅 `columns` / `rows`（`useStdout()` 不订阅 resize）；弹窗 / 面板宽度与 live 行数随窗口即时变化，矮终端（`<15` 行）隐藏 live 并只提示一次。

### Changed

- TUI 历史从 `string[]` 改为 `HistoryItem[]`（`{ text, markdown? }`）；`appendHistory` / `appendHistoryLines` 支持 `markdown` 标志。
- `VIEW_MAX_WIDTH` 从 110 提到 160；live 行数上限随终端高度增长（`MINIMAL_ROW_CAP = 5`）。
- 根布局不设固定 `height`：固定高度会让 Ink 每帧 `clearTerminal`，在 Windows / PowerShell 下造成历史、流式输出与底栏互相覆盖。
- 新增纯函数测试（`sanitize-terminal-text` / `text-layout` / `repl-state` / `layout`），全部在 `packages/tui` 内独立运行，不依赖 `mock.module` 的进程级状态。

### Known limitations

- ANSI 清洗只在展示层：gateway / headless / web / 插件仍拿到工具的原始文本（含控制序列）。
- TUI 不再显示原始 ANSI 颜色；`sanitizeTerminalText()` 只做清洗，不做宽度重排。
- Markdown 历史项比纯文本更占内存与渲染成本；`<Static>` 一旦写入不会重绘，窗口变宽后已归档内容按原宽度换行。
- Windows 真终端的 resize 行为仍需人工验证；`<15` 行的终端不显示流式 live 区。
- i18n 只在设计文档中，未实现。

## [0.8.3] - 2026-10-20

> 0.8 Wave 2B2A（基于 `release/0.8.3`，未发布）：Gateway 方法表按域拆分、CLI 一次性命令改为有序注册表。纯结构重构，无协议、无行为变化。版本号由 1 在集成线统一写入。

### Added

- **Gateway 方法模块**：新增 `packages/serve/src/gateway/errors.ts`（`MethodError`）与 `packages/serve/src/gateway/methods/`：`common.ts`（`tenantParamSchema` / `stringParam` / `checkpointBelongsToTenant`）、`config.ts`（`createConfigMethods` / `createToolMethods` / `createPluginsMethods`）、`evals.ts`、`feishu.ts`、`interactions.ts`、`mcp.ts`、`observability.ts`（`createEventsMethods` / `createMetricsMethods` / `createTraceMethods`）、`runs.ts`、`sessions.ts`、`tenants.ts`、`workflow.ts`（`createWorkflowMethods` / `parseWorkflowInputs`）。
- **CLI 命令注册表**：新增 `src/commands/registry.ts`，导出 `CliCommand`（`name` / `match(args)` / `run(args, ctx)`）、有序数组 `cliCommands` 与 `matchCommand(args)`；覆盖 `tools` / `update` / `resume-run-list` / `workflow` / `eval` / `config` / `tenant` / `migrate` / `trace` / `plugin` / `doctor` 11 条命令。
- 新增 ADR-059 / ADR-060。

### Changed

- `packages/serve/src/gateway.ts` 从约 4000 行降到 3002 行，只保留选项校验、缓冲 / 连接状态、HTTP / WS 路由与鉴权顺序；方法表用 `...createXxxMethods(deps)` 组装后交给 `defineMethods`。
- `events.subscribe` 仍留在 `gateway.ts`（依赖连接类型与事件缓冲游标），其余方法全部移入 domain 模块。
- `src/cli.ts` 删除约 153 行顶层 `if` 链，只解析全局参数 → `matchCommand` → 执行 → 统一 `exitCode`；REPL / serve / headless 路径不变。
- `MethodError` 独立成文件，保证拆分后 handler 与 legacy 错误处理仍命中同一个 `instanceof`。

### Fixed

- 无用户可见修复。本节只记录本次消除的结构性问题：方法定义与路由 / 连接状态混在单文件、新增 RPC 方法需在巨型数组中插入；一次性命令的命中顺序与退出码处理散落在 `if` 链各分支、单个命令无法独立测试。

### Known limitations

- 拆分只改变文件组织：方法名、`params_schema`、返回形状、协议错误码与鉴权顺序完全不变。
- 方法表不再能在一个屏幕内读完；domain 间共享逻辑必须显式放进 `common.ts`，否则会重复。
- CLI 注册表的顺序即语义：宽泛的 `match` 放在前面会遮蔽后面的命令；`--help` / `--version` 仍在入口处先行处理，不进入注册表。
- 注册表只覆盖一次性命令；REPL / serve / headless 的入口选择未抽象。

## [0.8.2] - 2026-10-19

> 0.8 Wave 2B1（基于 `release/0.8.2`，未发布）：统一工具执行管道，关闭 workflow / delegate 的权限与检查旁路。版本号由 1 在集成线统一写入。

### Added

- **core `ToolPipeline`**：新增 `packages/core/src/runtime/tool-pipeline.ts`，导出 `createToolPipeline` / `createToolPipelineFor` / `ToolPipeline` / `ToolPipelineOptions` / `ToolPipelineStages` / `ToolPipelineResult`（根入口与 `@vessel/core/runtime`）。阶段顺序：getTool → ToolCall guardrail → BeforeTool hook → permission（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。
- **workflow 注入点**：`WorkflowEngineOptions.toolPipeline?`；`type: tool` 走管道并发布 `tool.call.started|completed|failed`（payload 含 `workflow_run_id` / `tool_call_id` / `tool_name`）。
- **delegate 权限继承**：`DelegateTaskOptions.permission?`；子 runtime 使用父级 resolved 权限（`default` + `autoApprove`）。
- **装配纯函数**：`resolveRuntimePermission(config, headless)` 与 `buildDelegateTaskOptions()`；runtime / delegate / workflow 共用同一份 permission。

### Changed

- `AgentRuntime.runToolCall` 改用 `ToolPipeline`；关闭外层已处理的 ToolCall guardrail / BeforeTool / AfterTool，只复用 permission、handler 超时与 ToolResult guardrail；删除私有 `invokeTool`。
- 权限判定统一在 guardrail / hook 改写之后执行，针对最终工具与参数；改写导致参数 JSON 非法时直接失败。
- workflow `type: tool` 从“直接调 handler”改为走统一管道；未注入 `toolPipeline` 的旧嵌入路径保留但标记 deprecated。
- delegate 子 agent 不再固定 `{ default: 'allow' }`；显式 `permissionMode: 'allow'` 仍覆盖，`deny` 仍过滤工具。
- 交互默认 `ask` / headless 默认 `allow` 的口径由同一 resolved 权限提供给 runtime / delegate / workflow。

### Fixed

- workflow `type: tool` 绕过 runtime 的 guardrail / hook / 超时，以及与 runtime 权限语义不一致。
- delegate 子 agent 静默放行未声明 `checkPermission` 的工具（现继承父级 `ask` / `autoApprove`）。
- 三条执行路径的权限判定时机不一致；统一管道后一律针对 guardrail / hook 改写后的最终工具与参数判定。
- `ToolDefinition.timeout` 在 workflow 直接 handler 路径不生效；统一管道后生效。

### Security

- 关闭 workflow / delegate 的工具执行旁路：两处与 runtime 使用同一 guardrail / hook / permission / timeout 顺序。
- delegate 默认权限不再无条件 allow；交互模式继承父级 `ask`。
- workflow 的权限 `ask` 走 `tool.permission.request`，120s 无应答按失败处理，不静默放行。
- 管道阶段可由嵌入方显式关闭（`ToolPipelineStages`），关闭即由调用方承担检查责任；asm 默认全开。

### Known limitations

- 直接构造 workflow 引擎且不注入 `toolPipeline` 的第三方嵌入方仍走旧直接 handler 路径。
- 管道统一执行语义，不改变 `ToolDefinition` / `PermissionPolicy` / guardrail / hook 的接口。
- 测试禁止使用 `mock.module`（Bun 进程级污染），接线测试改用依赖注入与纯函数。

## [0.8.1] - 2026-10-19

> 0.8 Wave 2A 加固（基于 `release/0.8.1`，未发布）：持久化耐久性与损坏检测、配置单一 resolver、Gateway 拆分第一阶段。版本号由 1 在集成线统一写入。

### Fixed

- `FileSessionBackend.load()` 不再把“文件存在但不可读 / JSON 损坏”静默当成“无会话”，避免下一次 save 覆盖唯一副本；非 ENOENT 读取错误与解析失败抛 `SessionCorruptError`（`session_corrupt`）。
- 主路径存在（包括属于其它 tenant）时不再回退 legacy 路径；只有主路径 `ENOENT` 才尝试 legacy。
- `FileSessionBackend.delete()` / tenant 模式 `FileRunStore.delete()` 不再删除损坏文件：先 `load()` 校验，损坏时抛错、缺失或 foreign 时 no-op。
- `deleteSessionData` 的冲突检查从“只看第一页 200 条”改为 `limit: 200` + `offset` 全量分页；超过一页的 `running` / `interrupted` run 不再漏判后被删除。
- `atomicWrite` 在 rename 前对 temp 文件 fsync、rename 后尽力 fsync 目录，降低掉电后目标文件内容未落盘的风险。
- `VESSEL_CONNECT_TOKEN` / `VESSEL_CONNECT_CA` 进入 config env 层；connect token / CA 不再由 `bootstrapConnect` 各自读 argv / `process.env`，消除与 `VESSEL_GATEWAY_TOKEN`、`serve.token` 的优先级漂移。

### Changed

- `atomicWrite` 新增 `AtomicWriteOptions.durable`（默认 `true`）；`durable: false` 恢复 0.5 的旧行为。文件 fsync 失败抛 `AtomicWriteError` 且不 rename，目录 fsync 失败忽略。
- 新增并导出 `SessionCorruptError`；`FileSessionBackend.listRich()` 对损坏文件逐项降级跳过，直接 `load()` 仍抛错。
- `RunStore.list` 新增可选 `offset`（过滤、排序后切片）；`MemoryRunStore` / `FileRunStore` 同步实现，既有调用方不受影响。
- `ConfigLoadOptions` 新增 `cliOverrides`，`defaults` 标记 deprecated（先应用，`cliOverrides` 后应用）；层序仍为 `CLI > env > tenant overlay > project > user > default`。
- 新增 `src/cli-overrides.ts` 的 `buildCliConfigOverrides()`；`resolveServeOptions(config)` 不再接收 argv，`serve` / `connect` 统一从合并后的 config 读取。
- connect token 解析：`VESSEL_CONNECT_TOKEN` 优先，缺失时回退 `VESSEL_GATEWAY_TOKEN`；CA 来自 `VESSEL_CONNECT_CA` 或 `connect.ca_file`。
- Gateway 拆分第一阶段：新增 `packages/serve/src/gateway/{auth,frames,sse,static}.ts`；`gateway.ts` 从 4172 行降到 3886 行。公开导出、协议帧与 wire 行为不变。
- 新增 ADR-056 / ADR-057，并同步 ARCHITECTURE / AGENTS / SECURITY。

### Security

- 损坏的 session / tenant run 不再被静默覆盖或删除；损坏可能仍含敏感会话内容，排查时不应粘贴到日志或 issue。
- 持久化默认 fsync，降低掉电导致 checkpoint / 会话内容丢失的风险；这不等同于备份或磁盘损坏防护。
- connect token / CA 只经配置层合并，`config show --sources` 只显示来源与 set/unset，不输出明文。

### Known limitations

- 每次 session / checkpoint 写入多一次 fsync；Windows 上目录 fsync 通常被跳过。
- 损坏文件只报错或跳过，不自动修复、不备份、不重试 fsync。
- 非 tenant 的 `FileRunStore` 仍把损坏当 `null`（0.3 兼容语义）。
- `deleteSessionData` 的冲突检查成本随 run 数增长（上限 10,000 页）。
- Gateway 只完成第一阶段拆分；路由与连接状态机仍在 `gateway.ts`。
- 新增 CLI flag 必须同时加入 `buildCliConfigOverrides()`，否则不会进入配置层。

## [0.8.0] - 2026-10-19

> 0.8 Wave 1 结构收口（基于 `release/0.8`，未发布）：只做真实行为缺陷、core 失败隔离与工具安全边界，不做 Gateway 拆分等大重构。版本号由 1 在集成线统一写入。

### Added

- **RunExecution（core）**：新增 `RunExecution` 类型，run 级状态（run id / session / branch / 计时 / usage / context）从 `AgentRuntime` 实例字段收敛到每次执行；`run()` 与 `resume()` 共用。
- **单 run 守卫**：新增 `RunAlreadyRunningError`（`code: 'run_already_running'`，继承 `RunResumeError`，从根入口与 `@vessel/core/session` 导出）；同一 runtime 已有 active run 时，新的 `run()` / `resume()` 立即失败。
- **统一终态**：`finalizeRun()` 成为 `run()` / `resume()` 唯一终态路径；新增 `run.finalize.failed` 事件（终态持久化失败时保留原始错误）。
- **失败隔离**：新增 `hook.error` 与 `guardrail.error` 事件；单个 hook 抛错发事件后继续执行，guardrail 抛错按 fail-closed 返回 `guardrail_error`。
- **本地 RPC subscribe**：装配层把 `LocalRpcClient.subscribe()` 桥接到 `runtimeEvents`（只读 `events.event` 转发）。
- **basic-tools 路径边界**：内置敏感路径 denylist；插件配置 `allowed_roots`（越界 `ask`）与 `deny_paths`（追加）；`read` / `bash cwd` 按 realpath 判定。
- **Web seq 回退重放**：`hello.latest_seq < currentSeq` 时以 `since=0` 重连并从头重放；新增 `GatewayClient.restart` 与纯函数 `planHelloSeq`。
- **durable REST 显式 tenant**：admin 可用 query `tenant_id` 或 `X-Vessel-Tenant` 指定 tenant；两者不一致返回 400。
- **文档**：新增 [ADR-054](docs/adr/ADR-054-run-execution-and-failure-isolation.md) / [ADR-055](docs/adr/ADR-055-tool-path-boundaries.md)，同步 ARCHITECTURE / AGENTS / SECURITY。

### Changed

- `resume()` 的用户取消改为 checkpoint `cancelled` + `run.cancelled`，与 `run()` 一致；不再发 `run.failed`。
- `OnError` hook 变为 best-effort：hook 自身抛错不替换原始错误，也不跳过 session / checkpoint 写入。
- `VESSEL_MODEL` / `VESSEL_BASE_URL` / `VESSEL_PROVIDER_API_KEY` 只合并对应字段；只有显式 `VESSEL_PROVIDER` 才覆盖 `provider.name`（修复项目 `provider.name: anthropic` 被改成 `openai`）。
- headless 不再提前 `process.exit`：先统一执行 gateway / tenant / transport / shutdown 清理，再设置退出码。
- `--resume-run` 读取 `<data_dir>/tenants/<id>/runs`，与执行面一致。
- `createRunStore` 透传 `tenantId`；`FileRunStore.delete()` 在 tenant 模式下先校验归属，foreign / 缺失 no-op。
- durable REST 的 tenant 解析与 RPC `runs.resume` 的 `ctx.tenantId` 对齐（admin 显式指定，其余按 principal）。

### Fixed

- 本地 REPL 的 `/runs resume`、`/workflows run|resume` 因缺少事件订阅而挂起。
- `--serve --run` 退出时跳过清理，残留 tenant `.lock`。
- 同一 runtime 并发 `run()` 互相污染 usage / session / branch。
- Web 在 gateway 重启（seq 回退）后丢失重放事件。
- durable REST 忽略 admin 的显式 tenant。
- `coreToJob` 随 run 数量无界增长（终态与 `trimRuns` 时清理）。
- `--resume-run` 在默认 tenant 布局下列不出 run。

### Security

- `read` / `bash cwd` 内置 denylist 硬拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`，用于降低提示注入诱导的凭据读取；命中 `deny` 而非 `ask`。
- `allowed_roots` / `deny_paths` 为 opt-in；路径比较基于 realpath（含最近已存在祖先），`..` 与符号链接不能绕过。
- **明确边界**：这不是沙箱。`bash` 只校验 `cwd`，命令本身仍可访问其它路径；`edit` 未纳入路径边界。真正的隔离仍需沙箱类插件与受限运行环境。

### Known limitations

- 单 run 守卫是进程内、每 runtime 的；跨进程并发仍依赖 tenant 写锁与 durable 唯一写者约定。
- `finalizeRun` 持久化失败只发 `run.finalize.failed`，不重试、不补偿。
- 内置 denylist 不能通过配置移除，只能追加。
- Web seq 回退会清空本地事件存储并全量重放，成本随事件数增长。
- 0.8 Wave 1 不包含 Gateway 拆分、统一工具执行管道、插件生命周期 v2、协议 schema、fsync/损坏恢复、CLI 命令注册表与配置单一 resolver（留在 Wave 2）。

## [0.7.1] - 2026-10-19

> 0.7 的 P0 加固补丁线（基于 `release/0.7`）。与 0.5 / 0.6 / 0.7 一样只做发布干跑，不 tag、不 publish、不合并 `main`。

### Security

- **P0-1 legacy WS 租户作用域**：`run.submit` / `run.get` / `run.cancel` / `permission.respond` / `ask.respond` 等 legacy WS 方法不再绕过 principal/tenant，统一经 dispatcher 按调用方 tenant 执行；跨 tenant 读取 / 取消 / 应答返回 `forbidden/not_found`，`team.*` legacy 帧保持 `method_not_allowed`。
- **P0-2 tenant 锁回收**：锁内容改为原子发布，不可解析锁增加 mtime 宽限，stale 回收改为带互斥守卫的 compare-and-delete；同主机存活 pid 不再被 24h 年龄判为 stale，跨主机仍按年龄兜底。消除空文件窗口与双重回收导致的单写者失效。
- **P0-3 外部插件信任边界（缓解 / MITIGATED）**：默认仍加载 repo / project / user / node_modules 插件，但启动时向 stderr 打印外部插件告警；新增 `VESSEL_NO_EXTERNAL_PLUGINS=1` 显式 opt-out；显式 `plugins:` 始终可加载指定外部插件。**该风险只是缓解，未完全关闭**——外部插件仍以完整进程权限在启动时执行。

### Changed

- 插件来源优先级修正为 `repo → project → user → node_modules`，同名插件先出现者胜出（项目覆盖用户）。

### Upgrade notes

- 在不可信仓库中运行请设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`。默认行为不变（外部插件仍会加载），但启动会看到告警。
- 若依赖外部插件，可继续使用默认集；只想信任指定插件时，使用显式 `plugins:` 列表。

### Known limitations

- P0-3 记录为 **MITIGATED**（残余风险经用户接受）：没有插件 manifest / 签名 / 沙箱，也没有 `install()` 超时与故障隔离。
- 0.7.1 不包含 Gateway 拆分、统一工具执行管道、RunExecution、协议 schema 与 fsync（留在 0.8）。

## [0.5.0] - 2026-10-18

> 0.5 代码就绪，发布决定在 1；0.5 仍只做发布干跑，不 tag、不 publish、不合并 `main`。

### Added

- **F1 文件优先存储**：默认 `session.backend: file`；tenant 目录布局（`sessions/` / `runs/` / `events/` / `tenant.json` / `.lock`）；原子写；单写者锁；`vessel migrate`（sqlite / file-v1 → file-v2，默认 dry-run、源只读、幂等）。
- **F2 trace**：`TraceRecorder` / `FileTraceRecorder`、`RunEvent.seq` / `tenant_id`、`readTraceEvents`、`pruneTrace`、`rebuildMetrics`、`TraceRedactor`；默认 `full`，30 天 / 1000 runs / 1 GiB。
- **F3 统一入口**：RPC 信封 v1、方法表 v1.1、capability manifest、`RpcClient`（local / http）、`--connect`；旧 REST 端点保留为兼容别名。
- **F4 多租户**：`TenantContext`、tenant 解析、token → principal、存储 / 配置 / 工具 / 权限 / quota / trace / RPC 隔离；`serve.tokens` / `serve.admin_token`；`vessel tenant list|get|create|update`。
- **F6 配置与密钥**：YAML 主配置、`config path|init|show [--sources]`、`_env` 间接引用、来源标注、密钥脱敏输出。
- **A-6 内置多租户执行**：`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`；`--serve` 为每个 active tenant 构建独立执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl）与独立 EventStream、per-tenant writer lock；启动失败回滚、shutdown 释放。
- **ADR 多文件**：`docs/adr/ADR-001..050`，`docs/adr/README.md` 索引与编写约定，`docs/ADR.md` 保留为兼容 stub。
- **门禁**：`check-docs` ADR 树校验；`check-rpc-methods`；`check-config-sources`；`check-trace`。

### Changed

- `session.backend` 默认 sqlite → file；`durable.path` 默认统一到 `<data_dir>/tenants/<tenant_id>/runs`。
- 显式用户取消只发 `run.cancelled`（不再同时发 `run.failed`），`metrics.runs.cancelled` 首次可能非 0；0.4 的 cancel→failed 是历史行为。
- trace 的 `seq` 由 recorder 落盘分配并持久化；内存事件可无 seq，消费方按 `(seq ?? ts)`。
- `.env` 从推荐主配置降为部署覆盖；CLI/TUI 走 RPC 客户端。
- ADR 从单文件迁移到 `docs/adr/`；`docs/ADR.md` 只作兼容入口。

### Upgrade notes

- 旧 sqlite / file-v1 数据不会自动迁移：检测到后只提示执行 `vessel migrate`。先 dry-run，再 `--apply`。
- 显式 `session.storage_path` / `durable.path` 可以逃出 tenant，但启动时会 warn。
- 旧 `.vessel/sessions.db`、`~/.vessel/runs` 不自动删除；验证新数据后再手工处理。
- 配置优先级固定为 `CLI > env > tenant overlay > project > user > default`；项目 `vessel.yaml` 禁止密钥。

### Known limitations

- 不承诺多进程并发写同一 tenant；单写者锁是唯一保障。
- `sessions.list` / `runs.list` 为 O(N)；0.5 上限单 tenant 5,000 sessions / 20,000 runs。
- redactor 只降低泄漏面，不是合规保证；0.5 不脱敏 run checkpoint / eval 报告 / 飞书回复。
- trace 队列溢出会写 `trace.overflow`，该 trace 标记为不完整。
- `pruneTrace` 不删除 `running` / `interrupted` run；tenant 删除默认 disabled，0.5 无 `--purge`。
- `--connect` 只连本机回环 gateway；**F5 跨机器远程在 0.6**。
- 多租户执行已实现（ext 插件、web 接口、asm per-tenant 执行面）；**gateway 的 workflow / 飞书控制面仍只走 default tenant**（A-6 §13.3 方法表未包含 per-tenant 变体）。
- Windows 上 programmatic SIGINT 不触发 Bun 信号处理器，shutdown 释放 tenant 锁（A6-17/A6-21c）未自动验证；代码路径存在（`tenantFactory?.closeAll()`），需 POSIX CI 补验。
- **微信（公众号 / 企业微信）不做**；0.5 不发布。

## [0.4.0] - 2026-10-18

> 0.4 代码就绪，发布决定在 1；**0.4 只做发布干跑，不 tag、不 publish、不合并 `main`**。
> 0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布。

### Added

- `@vessel/workflow`：声明式 workflow 插件——YAML/JSON DAG、`agent` / `tool` 步骤、模板插值、重试 / `on_error` / `when`、并行上限、run 持久化与 resume、`WorkflowControls` 控制面；工厂式插件，不进 core，不注册模型工具。
- `@vessel/evals`：默认离线的 eval harness——suite / case、脚本化 mock provider、断言白名单（`output_contains` / `output_matches` / `no_error` / `tool_called` / `tool_not_called` / `max_duration_ms` / `max_iterations` / `usage_under`）、JSON 报告、`report.ts` 写盘与 latest 查找。
- `@vessel/feishu`：飞书渠道插件——官方 SDK WebSocket 长连接、`FeishuTransport` 抽象、专用 `InProcessRuntimeHost`、per-chat session（`feishu:<chat_id>`）、文本消息、队列上限、凭据掩码；`--feishu` 附加开关。
- `@vessel/core`：`MetricsCollector` / `MetricsSnapshot`（进程内事件聚合）；`MemoryEventStreamOptions.maxHistory`（缺省 1000、显式 0 = 不限制、>0 环形缓冲）；`pruneRuns` helper（`status` / `older_than_ms` / `keep_latest`）。
- `@vessel/config`：`workflow` / `evals` / `feishu` / `observability` 四个配置块与严格校验；`feishu.agent_id` 已删除，按未知键拒绝。
- CLI：`vessel workflow run|list|show|resume|cancel`、`vessel eval <suite>`、`--feishu`（TTY → REPL + 渠道；非 TTY → 仅渠道前台；`--serve` → gateway + 渠道）。
- `@vessel/tui`：`/workflows`、`/metrics`、`/feishu`、启动横幅（interrupted workflow / 飞书已连接）。
- `@vessel/serve`：`GET /v1/metrics`、`/v1/workflows*`、`/v1/channels/feishu`、`GET /v1/evals/latest`；新错误码与 `hello.features`；慢客户端丢事件并标记 `gap`。
- `apps/web`：workflow / metrics / 飞书面板。
- 发布干跑：`scripts/release-dry-run.ts` + `Release Dry Run` CI job（PR + `release/**`；不 tag / 不 publish / 不上传）；Offline Integration 扩展 workflow / evals / feishu / core。

### Changed

- `@vessel/core` 的 `./observability` subpath 在 0.3 已存在；0.4 **改指**到新的 `src/observability/index.ts` barrel，并继续 re-export 原 events 符号（不是新增 subpath）。
- 四个新配置块全缺省时行为与 0.3 一致；`observability` 块缺省时不注入 metrics；事件历史缺省仍为 1000。
- 发布流程不变：1.0 前不发布；0.4 只干跑，tag / publish / 合并 `main` 仍由 1 决定。

### Fixed

- `@vessel/core`：长会话 context compact 后消息/事件不重复、不丢最后一条用户消息。
- `@vessel/core`：`InProcessRuntimeHost` 在 run 结束时释放 `AbortSignal` 监听器，避免泄漏；关闭路径清理成员、排队 run 与交互请求。
- `@vessel/core`：`Scheduler` 队列满 / 并发取消 / 同成员串行的并发不变量由测试固定。
- 发布干跑：`entry_file_missing`（`main` / `types` / `exports` 目标不在 tarball 中）由 warning 提升为 **error**。
- 0.3 基线已包含 PeerRegistry stop race 修复（`ec25cfc`），0.4 不回归。

### Known limitations

- workflow `type: tool` 直接调用 handler，**绕过 runtime 的 guardrail / hook**；需要 guardrail 的步骤用 `type: agent`。
- workflow resume 不保证 step 幂等；重跑可能重复副作用。
- workflow agent step 使用 Host 中已存在的成员，**共享其 session**；workflow 级会话隔离不在 0.4 承诺。
- workflow `cancel` 只支持同进程；跨进程 run 返回 `workflow_not_found`。
- `MetricsCollector` 的 `runs.cancelled` 保持 0，取消的 run 计入 `runs.failed`；resume 不计 `runs.started`，因此 `completed` 可能大于 `started`。
- `pruneRuns` 的 `kept` 受 `RunStore.list` 200 窗口限制，`keep_latest > 200` 不保证精确；prune 不自动调度。
- 事件历史上限只作用于 `MemoryEventStream`；`FileEventStore` 不自动轮转。
- 飞书只支持文本、单 chat 单 session；真实 WebSocket 连接未在离线 CI 验证（CI 使用 mock transport）；达到 `max_members` 时新 chat 回 `busy`，不逐出已有成员；不做富媒体 / 卡片 / thread / 多机器人 / OAuth。
- eval 使用 mock provider 时 usage 可能为 0；`usage_under` 的判定以实际报告为准；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。
- 发布干跑通过不代表 npm 凭据、2FA、provenance 的线上配置已完成；0.4 不生成 `latest.json`。

## [0.3.0] - 2026-10-17

> 0.1.0 与 0.2 均未单独发布；0.2 的变更并入本版本。0.3.0 代码就绪，发布决定在 1。

### Added

- 0.2：`@vessel/core` Kernel——`RuntimeHost` / `AgentHandle` / `RunHandle` / `Scheduler` / `EventBus` / `Cancellation` / `Limits`，以及 `createRuntime()`。
- 0.2：`@vessel/core` subpath exports——`context` / `observability` / `kernel` / `policy` / `provider` / `session` / `transport` / `types`；根入口保持兼容。
- 0.2：in-process `Transport`；gateway loopback transport 与 `team.*` 协议。
- 0.2：`team` / `delegate_task` 共用 Host；team 仍默认 off、显式 opt-in。
- `@vessel/core`：durable run——`RunStore` port、`RunCheckpoint`、`MemoryRunStore` / `FileRunStore`；checkpoint 在 run 开始、每轮 tool-call 后、run 结束写入；`AgentRuntime.resume(runId, opts?)`、`RunnableAgent.resume?`、`RuntimeHost.resume(runId)`（不经 Scheduler）；开放事件 `run.checkpoint` / `run.resumed`。
- `@vessel/core`：resume 稳定错误 `RunResumeError`（`run_not_found` / `run_not_resumable` / `run_already_running` / `run_store_required` / `agent_not_found`）；同一 run 并发恢复首个成功，后续 `run_already_running`。
- `@vessel/mcp-client`：MCP client 插件——stdio 与 HTTP（Streamable HTTP，POST JSON-RPC + JSON/SSE 响应）两种传输；工具经 `PluginHost` 注册；`mcp__<server>__<tool>` 前缀（超 64 字符截断并加 hash）；权限默认 `ask`，`auto_approve_tools` 按原始工具名精确放行；单 server 失败隔离；控制面 `listServers()` / `getServer()` / `reconnect()` / `close()`；事件 `mcp.server.*` / `mcp.tool.*`。
- `@vessel/config`：`mcp_servers`（stdio/http、超时、tool_prefix、auto_approve_tools 等）、`durable`（enabled / backend / path / checkpoint_every）、`serve`（hostname / port / allow_remote / tls）配置块与校验。
- `@vessel/serve`：`GET /v1/durable/runs`、`POST /v1/durable/runs/<runId>/resume`、`GET /v1/mcp/servers`；新错误码 `run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls`。
- `@vessel/serve`：显式 opt-in 的远程监听与 TLS——`serve.allow_remote` / `--allow-remote`、`serve.tls.cert_file` + `key_file` / `--tls-cert` + `--tls-key`；非回环必须 token；默认仍绑 `127.0.0.1` 且明文。
- `@vessel/tui`：`/mcp`（状态 / `reconnect <name>`）、`/runs`（running + interrupted，`resume <runId>`）、启动横幅提示（有 MCP server 或未完成 run 时）。
- CLI：`--resume-run [runId]`（无参列出 interrupted，有参恢复；与 `--run` / `--serve` / `--tools` / 位置式输入互斥）、`--serve-host`、`--allow-remote`、`--tls-cert`、`--tls-key`。
- `apps/web`：按 `hello.features` 显示 MCP server 面板与 interrupted run 面板；可触发 durable resume。
- examples：`examples/embedded-mcp.ts`、`examples/mcp-echo-server.ts`。

### Changed

- 0.2：定位调整为「可嵌入的多 agent 平台 runtime + 参考 harness 外壳」（ADR-037）。
- 0.2：`AgentRuntime` 仍是单 agent loop；Host 包在它外面，不重写 loop。
- durable 默认关闭（`durable.enabled: false`）：关闭时不创建 `RunStore`，行为与 0.2 一致。
- serve 默认行为不变（回环 + 明文）；REST 仍为 HTTP/1.1。
- MCP 工具默认逐次询问；`auto_approve_tools` 只接受 server 返回的原始工具名（大小写敏感）。

### Removed

- `@vessel/team` 中 0.2 的 deprecated 进程内 Host 兼容路径（`InProcessRuntimeHost` / `LegacyHostAdapter`）；team 统一注入 core `RuntimeHost`。
- 配置键 `delegate.viaHost` 与 `team.maxMembers`；旧配置按未知键报错。

### Fixed

- 无 0.3 专属修复；0.2 的 loop / SSE / 启动竞态修复已包含在基线中。

### Known limitations

- durable 只支持本机 `file` / `memory` 后端；不做跨机器恢复、分布式锁或跨进程并发写协调。
- `FileRunStore` 的原子写是 best-effort（Windows 下 rename 失败重试后整文件直写）；无保留/清理策略，`list` 可能增长。
- resume 并发守卫是 per-Host / per-store-instance；多 Host 共享同一 `FileRunStore` 或跨进程同时恢复同一 run 属部署错误，不在 0.3 协调范围。
- MCP HTTP 不做 GET 长连接、session 恢复、OAuth；MCP 工具默认需要用户确认。
- 远程/TLS：只做 HTTP/1.1；证书由用户提供，不支持 ACME / mTLS / HTTP/2。
- workflow / evals / 多租户 / 跨机器调度 / 单二进制 / npm CLI 仍未实现。
- 0.1.0 / 0.2 / 0.3.0 均未发布。

## [0.1.0] - 2026-10-17

### Added

- `@vessel/core`：AgentRuntime 与通用 tool-calling loop（流式、中断、事件、限流、session 恢复）。
- `@vessel/core`：9 个接口（Provider / Context / EventStream / Tool / Session / Limits / Guardrail / Hook / Plugin），唯一扩展机制 `Plugin` + `PluginHost`。
- `@vessel/core`：`FileEventStore` + `replayRun` 事件回放；File / SQLite / Memory 三种 session 后端。
- `@vessel/config`：YAML 配置加载、校验（未知键报错）、snake_case → camelCase 映射。
- `@vessel/tui`：Ink REPL、流式渲染、slash 命令、权限确认、`@路径` 文件引用。
- `@vessel/serve`：常驻 gateway（`--serve`），实现 `vessel.gateway/1`：WS/SSE 事件流（`seq` 续订 / `gap`）、异步运行提交与取消、会话/工具/权限/ask_user 端点、可选同源静态托管。
- `apps/web`：浏览器控制台 v1（时间线、运行取消、权限弹窗、ask_user、断线重连）。
- `@vessel/permission`：共享权限原语（工具经事件流等用户授权）。
- 能力工具 3 个：`bash` / `read` / `edit`；接缝工具 2 个：`ask_user`（仅交互）/ `delegate_task`。
- 插件包：`provider-openai` / `provider-anthropic` / `guardrail-pii` / `redact-secrets` / `tool-policy` / `hook-logging`。
- headless 入口 `--run`：文本、`@file`（`.json` 多轮 seeding）、stdin 管道。
- `VESSEL_MOCK=1` 模拟模式：无 API Key 跑通整条链路。
- CLI：`--version`（根 `package.json`）、`--tools`（headless 口径，不需要 Key）、`update [--check] [--channel latest|beta] [--json] [--force]`（check-only）；非交互且无 Key 时快速失败，不进首启向导。
- 配置块：`provider.timeout_ms`、`session.backend`（sqlite / file / memory）、`update.*`、`delegate.*`（含 `permission_mode` / `read_only_tools`）、`team.*`；顶层未知键升为 error（带拼写建议）。
- 插件包 9 个：新增 `@vessel/team`（进程内原型，`team.enabled` 显式 opt-in，注册 5 个 `team_*` 工具）。
- provider timeout 装饰器（openai / anthropic 插件）；`delegate_task` 权限 bridge / allow / deny。
- thinking 模型：OpenAI 兼容 provider 支持 `reasoning_content`（非流式解析、流式累积、下一轮请求回传、会话持久化；事件流与 TUI 不暴露思维链，ADR-038）。
- CI：质量门禁、跨平台矩阵、web 构建、examples 类型检查、mock 冒烟。
- 发布：tag `v*` 驱动，npm 发布 `@vessel/*` 与插件包（provenance、latest/beta dist-tag），生成 `latest.json`。
- 版本工具：`scripts/version.ts`（统一版本 + 一致性校验）、`scripts/latest-json.ts`。

### Fixed

- core loop 正确性修复（ADR-035）：非法 tool arguments JSON 不终止 run；失败 run 保存真实上下文；请求消息归一化（补 system、丢弃孤儿 `role:tool`、降级不完整 `tool_calls`）；`updateRealTokens` 使用本次请求 token；guardrail `replacement` 四阶段生效；Anthropic 非流式 `max_tokens` 映射为 `length`；会话标题取首轮最后一条 user；`FileEventStore` 自动创建父目录。
- SSE 长连接：`Bun.serve` `idleTimeout` 默认禁用（0），保留 15s heartbeat；`hello.from_seq` 空缓冲为 `0`、已追平为 `since + 1`。

### Changed

- 极简化重构（ADR-034）：工具集收敛为 `bash` / `read` / `edit`；插件发现只保留运行时目录扫描；skills 改为普通文件经 `RunOptions.messages` 注入。
- 事件名统一为开放字符串（ADR-030）；hook / guardrail 按 priority 排序。
- `AgentRuntime` 改为异步静态工厂 `AgentRuntime.create()`（ADR-023）。
- 工具口径：默认 4（`bash` / `read` / `edit` + `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 5）；`team.enabled` 后 9。
- `--serve` 接线完成：传入 `context` / `pluginHost` / `staticDir`，G2 会话切换与 Web 静态托管生效。

### Removed

- `file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / memory 插件。
- `ToolRegistry` 与 `ToolDefinition` 的死字段（`default` / `interactive` / `render` / `isEnabled` / `shouldDefer`）。
- `vessel.yaml` 的 `tools:` 声明段。
- 旧的 `docs/specs/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`docs/role/`、`processes/`、`legacy/` 文档树。

### Known limitations

- MCP 未实现；接外部系统先用 `bash`（`curl` / CLI）。
- workflow / durable execution / evals 未实现；agent team 只有进程内原型（`team.enabled` 显式开启），gateway 的 `team.*` 为 0.2 草案。
- Gateway 0.1.0 单节点单 runtime：并发固定 1（队列上限 100），运行与事件历史在内存。
- 0.1.0 **不发布二进制**（ADR-006 继续有效）。
- 根 CLI `vessel` 尚未发布到 npm，`npx vessel` 暂不可用。
- `vessel update` 只做版本检查与提示（check-only），不下载、不自替换。
- `provider.timeout_ms` 只对插件式 provider 生效；未知 provider 的降级路径没有超时装饰器。
- 顶层未知配置键现在是 error（不是 warning）：旧配置里的拼写错误会让启动失败。

---

## 版本命名规则

- `x.y.z` = 语义化版本（Semantic Versioning）。
- pre-1.0 阶段：`0.x.y`，Minor（中间位）= 不兼容变更。
- 发布时打 tag：`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`。
