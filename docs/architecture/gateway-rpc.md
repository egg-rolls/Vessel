---
title: 统一 RPC 方法表
kind: current
triggers: [rpc, method, canonical, envelope, permission, agents.create, agents.rotate, teams.spawnFrozen, manifest]
paths: [packages/serve/src/gateway/methods/**, packages/serve/src/protocol.ts]
---

# 统一 RPC 方法表

<a id="rpc-methods"></a>

- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get|sources|set`；`sessions.list|get|search|delete|rename`；`runs.list|get|start|cancel|resume`；`agents.list|get|tree` / `agents.create|update|close|send|dispatch|rotate`；`events.list|subscribe`；`tools.list`；`plugins.list`；`metrics.get|reset`；`trace.prune`；`tenants.list|get|create|update`；`permission.respond` / `ask.respond` / `permissions.setToolPolicy`；`interactions.list`；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`；`gateway.reload`（admin-only，缺省 `not_supported`）；`teams.list|get|post|members|budget` / `teams.create|update|archive|spawnFrozen`；`auth.exchange|revoke|tokens`。permission 以表格为准。

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
| `agents.rotate` | write |
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
- **tenant 与错误码**：token → principal（`serve.token`→default/admin、`serve.tokens` 按条目、`serve.admin_token`→`*`/admin、回环无 token→default/admin）；非 admin 指定其它 tenant → `forbidden`；跨 tenant 读取 → `not_found`；一个 gateway 服务 N tenant（工厂缺省时非 default tenant `forbidden`）。durable REST 端点允许 admin 通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，两处同时出现且不一致 → 400。方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `tenant_locked` / `quota_exceeded` / `conflict` / `internal` / `not_supported`，增长类业务码还有 `team_full` / `team_frozen`。旧路径保留既有错误码映射。

## canonical agent 生命周期契约

<a id="agent-lifecycle"></a>

- `agents.create`：`{ agents: [{ kind?, name?, model?, system_prompt?, team_id?, workspace?, visibility? }] }`。`kind` 只取 `peer` / `contractor`；peer 必须有 `team_id`、不接受 `workspace`，`workspace` 只对合成 owner 传输开放；成功条目带 `agent`（`owner` 可选）。无 `kind` 的旧形状语义不变。`agents.list` / `agents.get` / agent status 条目带 `role`：运行期注册表角色 `main` / `subagent`，或成员角色 `single` / `member` / `temporary`；`owner` 对外仍可选（v3 总是写入）。人类管理面 principal（`role:'admin'` 且无 `agent_id`）的 `agents.list` 在事件派生视图外合并无 Team 的 `single`（含 private single）；合成 owner 传输与其它 agent / team token 仍按 viewer 可见性判定，private member / temporary 不放开。
- `agents.update`：`{ agents: [{ agent_id, name?, model?, system_prompt?, role?, team_id? }] }`（每项至少一个字段；`role` 只取 `single` / `member` / `temporary`）。`role` / `team_id` 是显式角色转换：`member` 必须绑定 Team、`temporary` 归属转换者（`from`）、`single` 清空 Team；handler 传 `team_id → teamId` 与 `from = principal.agent_id ?? 'human'`。成功条目带 `agent` / `changed` / `applies_to: 'next_body'`（仅 model / system_prompt 实际变化时）。`agents.close`：`{ agents: [{ agent_id }] }`；成功条目 `{ ok: true, agent, agent_id, closed: true }`。
- `agents.send`：`{ messages: [{ to, content, conversation_id? }] }` → 成功 `{ ok: true, queued: true, message_id, state }`（strict send，不 resume）。`agents.dispatch`：`{ messages: [{ to, content, conversation_id?, allow_fork? }] }` → 成功 `{ ok: true, status: 'queued', message_id, resolved_to, resolution, conversation_id? }`；业务拒绝逐条 `{ ok: false, code, error }`（`agent_left` / `resume_failed` / `not_visible` / `budget_*` / `conversation_team_mismatch`）。`agents.rotate`：`{ agents: [{ to, startup_prompt, from_session_id? }] }` → 成功 `{ ok: true, status: 'rotated', agent_id, from_session_id, to_session_id, epoch }`。
- 统一结果 `{ results: [...] }`，与输入同序；单条失败 `{ ok: false, code, error }`，不影响其它条目。三者 permission 都是 `write`；结构错误整体 `invalid_params`；team-scoped control token 不能 create / close（`forbidden`），update / send / dispatch / rotate 只能操作同 `team_id` 成员，否则逐条 `not_found`；update 的角色转换只能转 `member` / `temporary`（同 Team），不能转 `single` 或换到其它 Team（`forbidden`）。`principal.agent_id` 只由合成 owner 传输填 root owner id；handler 以 `ctx.principal.agent_id ?? 'human'` 作为 `from` / `viewer`。owner 端点只做传输：用 `defineMethods([...createAgentMethods, ...createTeamMethods])` 组装与 gateway 同源的方法表，wire 名即 canonical；HTTP 状态映射 `invalid_params` 400、`forbidden` 403、`not_found` 404、`conflict` 409、`internal` 500。

## canonical team 冻结契约

<a id="team-spawn-frozen"></a>

- `teams.spawnFrozen`：`{ team_id, frozen }` → `TeamSummary`（含 `spawn_frozen?`，`false` 时字段缺省）；permission 为 `write`。team-scoped control token 只能操作自己的 team，其它 team 返回 `not_found`。冻结是 Team 元数据，`teams.update` 不修改该字段；冻结期间该 Team 的 create / hire / 人类 `agents.create` / fork / reinstate 均返回 `team_frozen`，只有 `frozen: false` 解冻。CLI 为 `vessel team freeze|unfreeze <team_id>`。
