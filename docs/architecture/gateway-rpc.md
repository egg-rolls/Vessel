---
title: 统一 RPC 方法表
kind: current
triggers: [rpc, method, canonical, envelope, permission, agents.create, sessions.create, sessions.restart, sessions.activate, agents.dispatch, allow_auto_create, teams.spawnFrozen, manifest]
paths: [packages/serve/src/gateway/methods/**, packages/serve/src/protocol.ts]
---

# 统一 RPC 方法表
<a id="rpc-methods"></a>

- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get|sources|set`；`sessions.list|get|search|delete|rename|compact|create|restart|activate`；`runs.list|get|start|cancel|resume`；`agents.list|get|tree` / `agents.create|update|close|send|dispatch`；`events.list|subscribe`；`tools.list`；`plugins.list`；`metrics.get|reset`；`trace.prune`；`tenants.list|get|create|update`；`permission.respond` / `ask.respond` / `permissions.setToolPolicy`；`interactions.list`；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`；`gateway.reload`（admin-only，缺省 `not_supported`）；`teams.list|get|post|retract|members|budget` / `teams.create|update|archive|spawnFrozen`；`auth.exchange|revoke|tokens`。permission 以表格为准。
<!-- rpc-methods:begin -->
| 方法 | permission |
|---|---|
| `health.get` | read |
| `capabilities.list` | read |
| `config.get` | read |
| `config.sources` | read |
| `config.set` | write |
| `sessions.list` | read |
| `sessions.get` | read |
| `sessions.search` | read |
| `sessions.delete` | write |
| `sessions.rename` | write |
| `sessions.compact` | write |
| `sessions.create` | write |
| `sessions.restart` | write |
| `sessions.activate` | write |
| `runs.list` | read |
| `runs.get` | read |
| `runs.start` | write |
| `runs.cancel` | write |
| `runs.resume` | write |
| `agents.list` | read |
| `agents.get` | read |
| `agents.tree` | read |
| `agents.create` | write |
| `agents.update` | write |
| `agents.close` | write |
| `agents.send` | write |
| `agents.dispatch` | write |
| `events.list` | read |
| `events.subscribe` | read |
| `tools.list` | read |
| `plugins.list` | read |
| `metrics.get` | read |
| `metrics.reset` | write |
| `mcp.list` | read |
| `mcp.reconnect` | write |
| `trace.prune` | admin |
| `tenants.list` | admin |
| `tenants.get` | read |
| `tenants.create` | admin |
| `tenants.update` | admin |
| `permission.respond` | write |
| `ask.respond` | write |
| `permissions.setToolPolicy` | write |
| `interactions.list` | read |
| `evals.latest` | read |
| `evals.run` | write |
| `feishu.status` | read |
| `gateway.reload` | admin |
| `teams.list` | read |
| `teams.get` | read |
| `teams.post` | write |
| `teams.retract` | write |
| `teams.members` | write |
| `teams.budget` | write |
| `teams.create` | write |
| `teams.update` | write |
| `teams.archive` | write |
| `teams.spawnFrozen` | write |
| `auth.exchange` | write |
| `auth.revoke` | admin |
| `auth.tokens` | admin |
<!-- rpc-methods:end -->

当前方法计数与演进历史见 `docs/versions/0.24.0.md`–`0.26.2.md`；契约以本表为准。新增 canonical 方法必须发 addendum，并同时写 `result_schema`（ADR-066）。

- **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS `run.submit|get|cancel`。**HTTP 语义**：信封合法时方法成功或方法级失败都返回 200（失败体 `ok:false`）；400 `invalid_params`（旧路径 `invalid_request`）；401 `unauthorized`；403 `forbidden`；413 体过大；未知方法 200 `not_found`（`details.method`）；500 `internal`。旧 REST 适配器保留既有路径、请求/响应体、状态码与错误码。
- **events**：`events.list` 支持 `run_id` / `since_seq` / `since_ts` / `types` / `type_prefix` / `limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）/ `since_ts` / `run_id` / `types` / `all_tenants`（仅 admin）。RPC 回调为 `{ method: 'events.event', params: RunEvent }`；WS 旧 `{ kind: 'event', event }` 不变。
- **manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission }], tools, plugins }`；只含 canonical 方法。manifest 按 `ctx.tenantId` 生成，tools / plugins 取 `pluginHostFor` / `pluginsFor`（缺省回退全局）。
- **客户端**：`RpcClient` 有 `request()` + `subscribe()`；`LocalRpcClient` / `HttpRpcClient`。CLI/TUI 不绕开方法表。本地 `subscribe()` 由装配层桥接到 `runtimeEvents`（只读旁路，不写回事件流）。`--connect <url>` / `VESSEL_CONNECT` 使用 `HttpRpcClient`、不取 tenant 写锁、不写本地 store / trace；回环可明文，非回环必须 HTTPS + token。token 解析顺序 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> `connect.token`；CA 用 `--ca` / `connect.ca_file`。建连后 `health.get` 取远端 tenant / node；显式 `--tenant` 才把 `tenant_id` 合并进请求（admin 覆盖），否则由 token principal 决定。connect 模式下 `permission.respond` / `ask.respond` 经 RPC 回远端；TUI / headless 同路径。
- **tenant 与错误码**：token → principal（`serve.token`→default/admin、`serve.tokens` 按条目、`serve.admin_token`→`*`/admin、回环无 token→default/admin）；非 admin 指定其它 tenant → `forbidden`；跨 tenant 读取 → `not_found`；一个 gateway 服务 N tenant（工厂缺省时非 default tenant `forbidden`）。durable REST 端点允许 admin 通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，两处同时出现且不一致 → 400。方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `tenant_locked` / `quota_exceeded` / `conflict` / `internal` / `not_supported`，增长类业务码还有 `team_full` / `team_frozen`，会话压缩另有 `session_not_found` / `compact_unavailable`；`sessions.create|restart|activate` 另有 `session_not_found`（活动 run 返回 `conflict`，message `run_in_progress`）。旧路径保留既有错误码映射。
## canonical agent 生命周期契约
- `agents.create`：`{ agents: [{ kind?, name?, model?, system_prompt?, team_id?, workspace?, visibility?, from_session_id?, seed?, keep_messages? }] }`。`kind` 只取 `peer` / `contractor`；peer 必须有 `team_id`、不接受 `workspace`，`workspace` 只对合成 owner 传输开放；`from_session_id` 存在时从源 session 取种子（`seed` 缺省 `copy`，`compact` 必须显式；`keep_messages` 是 `sessions.get().messages` 下标），源 agent / session 零改动且仍可跑；`seed` / `keep_messages` 无来源时 `invalid_params`。成功条目带 `agent`（`owner` 可选）。无 `kind` 的旧形状语义不变。失败条目按 §1.4 映射：`not_found` / `not_visible` / `invalid_params`（含 reason `source_private`）/ `conflict`（reason `not_primary` / `run_in_progress` / `agent_closed` / `team_frozen` / `team_full`）/ `internal`（reason `create_failed`）。`agents.list` / `agents.get` / agent status 条目带 `role`：运行期注册表角色 `main` / `subagent`，或成员角色 `member` / `temporary`（`single` 已删除，存量快照读取时降级为 `member`）；`owner` 对外仍可选（v3 总是写入）。人类管理面 principal（`role:'admin'` 且无 `agent_id`）的 `agents.list` 在事件派生视图外合并无 Team 的 `member`；合成 owner 传输与其它 agent / team token 仍按 viewer 可见性判定，private member / temporary 不放开。
- `agents.update`：`{ agents: [{ agent_id, name?, model?, system_prompt?, role?, team_id? }] }`（每项至少一个字段；`role` 只取 `member` / `temporary`）。`role` / `team_id` 是显式角色转换：`member` 必须绑定 Team、`temporary` 归属转换者（`from`）；handler 传 `team_id → teamId` 与 `from = principal.agent_id ?? 'human'`。成功条目带 `agent` / `changed` / `applies_to: 'next_body'`（仅 model / system_prompt 实际变化时）。`agents.close`：`{ agents: [{ agent_id }] }`；成功条目 `{ ok: true, agent, agent_id, closed: true }`。
- `agents.send`：`{ messages: [{ to, content, conversation_id?, interrupt?, notify?, message_id? }] }`。`interrupt` 与 `notify` 互斥（`invalid_params`，reason `conflicting_delivery`）；`message_id` 只配 `interrupt`；`notify` 必须自带 `content`；`important` 已删除，显式传入 → `invalid_params`。成功条目两种：work / urgent `{ ok: true, queued: true, message_id, state }`；notify `{ ok: true, notified: true, message_id, wake, resolution: 'live' | 'gone', resolved_to?, conversation_id? }`。strict send，不 resume。
- `agents.dispatch`：work-only，输入 `{ messages: [{ to, content, conversation_id?, allow_auto_create? }] }`；传 `interrupt` / `message_id` / `notify` / `important` → `invalid_params`；成功 `{ ok: true, status: 'queued', message_id, resolved_to, resolution, conversation_id? }`，`resolution` 取 `live` / `resumed` / `rotating` / `created`；业务拒绝逐条 `{ ok: false, code, error }`（`agent_left` / `resume_failed` / `auto_create_failed` / `auto_create_not_allowed` / `not_visible` / `budget_*` / `conversation_team_mismatch`）。
- 统一结果 `{ results: [...] }`，与输入同序；单条失败 `{ ok: false, code, error }`，不影响其它条目。上述生命周期方法 permission 都是 `write`；结构错误整体 `invalid_params`；team-scoped control token 不能 create / close（`forbidden`），update / send / dispatch 只能操作同 `team_id` 成员，否则逐条 `not_found`；update 的角色转换只能转 `member` / `temporary`（同 Team），不能换到其它 Team（`forbidden`）。`principal.agent_id` 只由合成 owner 传输填 root owner id；handler 以 `ctx.principal.agent_id ?? 'human'` 作为 `from` / `viewer`。owner 端点只做传输：用 `defineMethods([...createAgentMethods, ...createTeamMethods])` 组装与 gateway 同源的方法表，wire 名即 canonical；HTTP 状态映射 `invalid_params` 400、`forbidden` 403、`not_found` 404、`conflict` 409、`internal` 500。
## canonical session 创建 / 切换契约
- `sessions.create`：`{ agent_id?, from_session_id?, seed?, keep_messages?, startup_prompt?, mode?, files? }` → `{ agent_id, session_id, source_session_id?, seed?, keep_messages?, keep_projected?, copied_messages?, primary: true, files_restored?, files_skipped? }`。无来源 = 空 session（`agent_id` 必填，`seed` / `keep_messages` / `mode` / `files` → `invalid_params`）；有来源 = 源 primary 的 `[0, keep_messages)` 深拷贝 / 压缩（`agent_id` 可省或必须与源一致）。成功时新 session 成为唯一 primary，源 binding 退役进 `bindingHistory`，源必须 `sessions.activate` 才能再跑。`mode:'both'` 表示先做显式 git restore（`files` 必填），硬失败在切换前中止，未注入回滚端口 → `not_supported`；单路径失败计入 `files_skipped`。配额走 `tenants.checkQuota('sessions.create')`。错误：`not_found` / `not_visible` / `session_not_found` / `invalid_params` / `conflict`（`not_primary` / `run_in_progress` / `agent_closed` / `team_frozen` / `team_full`）/ `quota_exceeded` / `internal`（`create_failed`）。
- `sessions.restart`：`{ session_id, startup_prompt? }` → `{ agent_id, session_id, from_epoch, epoch }`。同一 session 原地换 binding（epoch+1）；旧 binding 退役进 `bindingHistory`，旧 EU dispose / `releaseHeld`，transcript / SessionState 不变。错误：`session_not_found`；非 primary → `conflict` + `not_primary`；current primary 有 active run → `conflict` + `run_in_progress`；agent closed / left → `conflict` + `agent_closed`；失败 → `internal`（`restart_failed` / `restart_rollback_failed`）。
- `sessions.activate`：`{ session_id, startup_prompt? }` → `{ agent_id, session_id, previous_session_id, epoch, noop }`。目标限 primary 或 `bindingHistory` 中的 session；目标已是当前 primary 时 `noop: true`；成功时 epoch = 当前 primary epoch+1，原 primary 退役。错误：`session_not_found`；不可见 → `not_found`（details `reason: not_visible`）；current primary 有 active run → `conflict` + `run_in_progress`；agent closed / left → `conflict` + `agent_closed`；失败 → `internal`（`activate_failed`）。
- 三个方法 permission 都是 `write`；team-scoped control token 只加入 `sessions.create`（镜像已删的 `agents.rotate`），handler 校验 `agent_id` / 源 session 所属 agent 与 caller 同 `team_id`，否则 `not_found`。
- **0.39 删除面（已删除）**：`agents.fork` / `agents.rotate` / `agents.restart` / `agents.compactFork` / `sessions.rewind`；替代为 `agents.create{from_session_id}`（fork）、`sessions.create`（rotate / compactFork / rewind 的编辑重试）、`sessions.restart`（restart）。旧事件 `agent.forked` / `agent.compact_forked` / `session.forked` / `system_event:'fork'` 只读渲染。
## canonical team 冻结契约
- `teams.spawnFrozen`：`{ team_id, frozen }` → `TeamSummary`（含 `spawn_frozen?`，`false` 时字段缺省）；permission 为 `write`。team-scoped control token 只能操作自己的 team，其它 team 返回 `not_found`。冻结是 Team 元数据，`teams.update` 不修改该字段；冻结期间该 Team 的 create / hire / 人类 `agents.create`（含 `from_session_id`）/ reinstate 均返回 `team_frozen`，只有 `frozen: false` 解冻。CLI 为 `vessel team freeze|unfreeze <team_id>`。
- `teams.retract`：`{ team_id, message_id }` → `{ team_id, message_id, retracted_message_id }`（`message_id` 是新 tombstone，`retracted_message_id` 是目标）；permission `write`，team scope 校验同其它 `teams.*`。日志保持 append-only：只追加一条 `kind:'system'`、`system_event:'retract'`、`content:''` 的 tombstone，不删除 / 不改写原消息，也不级联删除后续回复。错误：Team 不存在 `not_found`；目标不在可读窗口（最近 1000 条）`not_found`（details `team_code: message_not_found`）；目标为 system 行 / tombstone `invalid_params`；目标已被撤回 `conflict`（`already_retracted`）；归档 Team 复用 `team_archived`。
