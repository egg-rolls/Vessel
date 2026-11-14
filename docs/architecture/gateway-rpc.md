---
title: 统一 RPC 方法表
kind: current
triggers: [rpc, method, canonical, envelope, permission, agents.create, sessions.create, sessions.restart, sessions.activate, agents.dispatch, allow_auto_create, teams.spawnFrozen, manifest, 方法表, 信封, 权限, 契约, 生命周期契约, 附件, 冻结]
paths: [packages/serve/src/gateway/methods/**, packages/serve/src/protocol.ts]
---

# 统一 RPC 方法表
<a id="rpc-methods"></a>
- **0.49 入口**：本文方法表属 **Node API**，入口 `POST /v1/rpc`（node 端口，缺省 8644）。Platform Gateway 的 `POST /platform/rpc` 是独立的只读 allowlist（`platform.nodes.list|get|credentials`、`platform.whoami`、`platform.health.get`），**不复用**本表、不透传到 node dispatcher。G3：`platform.nodes.credentials({ node_id? })` 在注册多个节点时省略 `node_id` → HTTP 400 `invalid_params`；本地多 node 由 `vessel gateway nodes list|add|remove` 维护 `nodes.json`，`vessel node start --config <path>` 用独立配置启动。平台方法不进 canonical 表。
- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get|sources|set`；`sessions.list|get|search|delete|rename|compact|create|restart|activate`；`runs.list|get|start|cancel|resume`；`agents.list|get|tree` / `agents.create|update|close|send|dispatch`；`attachments.list`；`events.list|subscribe`；`tools.list`；`plugins.list|reload|catalog`；`metrics.get|reset`；`trace.prune`；`permission.respond` / `ask.respond` / `permissions.setToolPolicy`；`interactions.list`；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`；`gateway.reload`（admin-only，缺省 `not_supported`）；`teams.list|get|post|retract|members|budget` / `teams.create|update|archive|spawnFrozen`。permission 以表格为准。
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
| `agents.inbox` | read |
| `agents.recall` | write |
| `agents.claim` | write |
| `agents.dispatch` | write |
| `attachments.list` | read |
| `events.list` | read |
| `events.subscribe` | read |
| `tools.list` | read |
| `plugins.list` | read |
| `plugins.reload` | write |
| `plugins.catalog` | read |
| `metrics.get` | read |
| `metrics.reset` | write |
| `mcp.list` | read |
| `mcp.reconnect` | write |
| `trace.prune` | admin |
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
<!-- rpc-methods:end -->
当前方法计数与演进历史见 `docs/versions/0.24.0.md`–`0.26.2.md`；契约以本表为准。新增 canonical 方法必须发 addendum，并同时写 `result_schema`（ADR-066）。`plugins.catalog`（read）返回单视图（与 `plugins.list` 同源），`params: {}`、`result: { items: PluginCatalogItem[] }`；只读插件目录，不写 config、不访问网络、不触发 reload、不查 registry。`tools.list` 只有一份资源形状 `{ tools: [{ name, description, input_schema, has_permission_check }] }`：0.51 起不区分节点工具面与成员工具面（用户裁定），也没有 `surface` / `source` / `unavailable` 之类第二层字段。可选 `agent_id`（deprecated，仅诊断）只决定按哪具成员身体读同一份清单，响应形状不变；未知 `agent_id` → `not_found`（不返回空列表）；装配层没注入透传（老装配 / agent 关闭）→ 退化成节点口径，响应仍是同一个形状。判据只在执行内核（`MemberExecutionHost.toolSurface` + `selectTools`）一处，serve 只做形状透传。详见 [tools](tools.md)。
- **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS `run.submit|get|cancel`。**HTTP 语义**：信封合法时方法成功或方法级失败都返回 200（失败体 `ok:false`）；400 `invalid_params`（旧路径 `invalid_request`）；401 `unauthorized`；403 `forbidden`；413 体过大；未知方法 200 `not_found`（`details.method`）；500 `internal`。旧 REST 适配器保留既有路径、请求/响应体、状态码与错误码。
- **events**：`events.list` 支持 `run_id` / `since_seq` / `since_ts` / `types` / `type_prefix` / `limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）/ `since_ts` / `run_id` / `session_id` / `types` / `until_seq`（additive，分段回放上界）；`types` 条目以 `*` 结尾按前缀匹配，空数组等价于未提供。SSE `GET /v1/events` 同样接受 `?session_id=`、`?types=` 与 `?until_seq=`。RPC 回调为 `{ method: 'events.event', params: RunEvent }`；WS 旧 `{ kind: 'event', event }` 不变。
- **订阅 epoch 与有界回放**：每次成功的 WS `events.subscribe` 先发 `hello`（`from_seq` = 本次实际发送的第一条 seq），再发可选 `gap`、过滤后的有界回放窗口（≤ 1 MiB / 2000 条，从最新往回取），最后发 `res`。`gap.to_seq = max(环形缺口, 窗口 skippedTo)`；更早区间不在该 epoch 内。`until_seq`（一次性，只作用于下一次 subscribe epoch，不影响实时广播）把回放源裁成 `since < seq <= until_seq`，窗口仍受同一预算约束，所以客户端可以拿 `hello.from_seq - 1` 当下一页上界逐页回退（能力位 `events.replay-range`）；环形缓冲之外（更早）才是真的不可恢复，仍由 `gap` 表示。`session_id` 归属由 `data.session_id` 或 gateway 的 `run_id → session_id` 映射决定，映射不到不发（fail-closed）。能力位 `events.session-filter` 供客户端对旧 gateway 降级。
- **历史分页**：`sessions.get` 新增可选 `message_limit`（1..500）与 `before`（opaque base64url JSON 游标），返回 `messages_total`（恒返回）与 `next_before`（窗口起点 > 0 时）。缺省且无 `before` 仍是全量 messages（旧客户端行为不变）；缺省且有 `before` 时页大小 100。游标锚定绝对下标 + `messages[i-1]` 的 `timestamp` / `content.length` / `role`；锚点不一致 → `conflict` + `details.reason: "history_changed"`，格式错误 → `invalid_params`；游标不是授权凭据。`sessions.get` 结果另有**可选** `context_usage: { used, max?, at? }`（会话级上下文用量，从该会话事件日志**尾窗**派生；形状、`max` 来源与读取成本见 [serve.md](../agents/serve.md) 的 0.52 addendum），字段缺省 = 没有可用数据。`teams.get` 新增可选 `before`（稳定 `message_id`）与返回 `messages_has_more`；有 `before` 时从上一页首条向前按 8 MiB 分块回扫，最多 64 MiB，找不到 → `conflict` + `details.reason: "cursor_out_of_window"`（`not_found` 只表示 Team 不存在）；一页可因回扫预算少于 `limit`。
- **manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission }], tools, plugins }`；只含 canonical 方法。manifest 来自启动时的单 bundle，tools / plugins 取 `pluginHost()` / `plugins()`（单视图）。
- **`ask.respond` 与挂起的 ask**：命中 `status=pending` 且 `suspended` 的 ask（headless / 超时挂起）时，应答落定后 gateway 自己发起一次 resume（前置：durable 可读 + resume 已注入、checkpoint 仍是 `interrupted`、记录与 checkpoint 同 `session_id`、该 session 没有 queued/running 的 run；任一不成立只记录答案，RPC 仍是 `ok:true`）。返回体只对这类 ask 追加可选键 `resumed: boolean`；普通阻塞型 ask 的参数 / 返回 / 行为不变。答案进入被恢复 run 的口径见 ADR-082 Errata。
- **`ask.respond` 与 async ask**（0.52）：`mode: "async"` 的 ask 投的是「答案 → 新 run」，**不**续跑旧 run（那个 run 早在工具返回后正常收口了）。应答落定后 gateway 把答案作为一条 user 消息投给提问成员（`AgentService.admit`，注入的 `askAnswerDelivery`）并起一次新 run；返回体追加可选键 `delivered: boolean`（`false` = 只记录了答案，例如没有 live runtime / 成员已关闭）。投放的**唯一触发点**是交互注册表的 `pending → answered` 迁移：handler 只等 `awaitAsyncAskDelivery(requestId)` 的结果填 `delivered`，自己不投（否则同一次答案两个投放者 = 双投）；同进程多个 gateway 装配各注册一份监听，重复通知由 gateway 的进程级单飞拦下。`interactions.list` 的 ask 条目带 `mode`（缺省 = sync）；`answer.delivered_at` 是投放幂等标记（内存 + 投放前重读文件，跨进程 / 跨重启兜底），重复应答（`duplicate`）不会投第二次。async ask 的 `pending` 不随 run 终态转 `orphaned`，重启后仍可答。
- **`ask.respond` 的 `batch_id`（additive，0.52）**：可选字符串参数（1..200 字符），标识「这是待批页的哪一次提交」。同一次提交里的多个 `ask.respond` 带同一个 `batch_id`，装配层按 `(agent_id, session_id, batch_id)` 做 250ms 短窗口合并，把整批答案合成**一条** user 消息 + **一次** run（`interactions` 记录里写 `answer.batch_id`）；缺省 / 校验失败 = 一次一条（旧行为一字不改）。合并只在窗口内发生，窗口之后才到的应答退化成单独一条消息，不丢答案；`answers: []`（拒绝回答）永远单发。参数与返回体的其余部分不变，旧客户端不受影响。
- **客户端**：`RpcClient` 有 `request()` + `subscribe()`；`LocalRpcClient` / `HttpRpcClient`。CLI/TUI 不绕开方法表。本地 `subscribe()` 由装配层桥接到 `runtimeEvents`（只读旁路，不写回事件流）。`--connect <url>` / `VESSEL_CONNECT` 使用 `HttpRpcClient`、不取 data-dir 写锁、不写本地 store / trace；回环可明文，非回环必须 HTTPS + token。token 解析顺序 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> `connect.token`；CA 用 `--ca` / `connect.ca_file`。建连后 `health.get` 取远端 node 身份；principal 由 token 决定。connect 模式下 `permission.respond` / `ask.respond` 经 RPC 回远端；TUI / headless 同路径。
- **principal 与错误码**：token → principal（`serve.token`→admin、`serve.tokens` 按条目 role、回环无 token→admin）；一个 node 服务单公司。方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `data_locked` / `quota_exceeded` / `conflict` / `internal` / `not_supported`，增长类业务码还有 `team_full` / `team_frozen`，会话压缩另有 `session_not_found` / `compact_unavailable`；`sessions.create|restart|activate` 另有 `session_not_found`（活动 run 返回 `conflict`，message `run_in_progress`）。旧路径保留既有错误码映射。
- **`attachments.list`（0.52 addendum，节点侧只读目录浏览）**：`{ dir?, include_hidden?, limit? }` → `{ roots, dir?, parent?, entries: [{ name, path, kind: 'file'|'dir', bytes?, mtime_ms? }], truncated, reason? }`；permission `read`。`dir` 省略 = 只返回 `roots`（配置的 `allowed_roots`；未配时是 node 侧**安全默认根**：`agent.cwd`，再退回 home，绝不默认 `/`），相对路径按 basic-tools 的 `cwd` 解析，`limit` 缺省 200 / 上限 500，已在某个允许根上时不返回 `parent`。只列**单层**、只返回 `name` / 真实路径 / `bytes` / `mtime_ms`（无内容、无 mime、无 hash、不递归、不 watch、不支持远程 URL、不写）；deny 目录**及其条目不出现**（不是列出来再标红）、符号链接按 realpath 判（越界目标同样不出现）、越界 / 无权折成 `entries: []` + `reason`（`refs_invalid` / `refs_denied` / `refs_outside_roots`，与 `runs.start` 的 `refs` 拒绝**同一组**稳定码，不抛 500；`dir` 不存在 / 不是目录 / 读不了也是 `refs_invalid`）。返回的 `path` 必是 realpath，因为它要过 `runs.start` 的闸门。
- **为什么由节点侧列目录**：`refs[].path` 的语义是「将要消费它的那台机器上的绝对路径」（闸门按该 node 的 `allowed_roots` 判，`media` 工具也在 node 上读），谁消费谁产出 —— node 回来的字符串天然自洽（WSL 的 `/mnt/d/...` 与 `D:\...` 不再要人工映射，远程也不必猜路径），而网关侧弹原生对话框在 daemon / 远程 node / 容器里根本没有桌面会话。安全面与 `sessions.get`（已能读全部对话正文）同级：文件名 / 结构属于同一信任层级，新增面靠「限根 + 只读 + 无内容 + 单层 + `limit`」收口。
## canonical agent 生命周期契约
- `agents.create`：`{ agents: [{ kind?, name?, model?, system_prompt?, team_id?, workspace?, visibility?, from_session_id?, seed?, keep_messages? }] }`。`kind` 只取 `peer` / `contractor`；peer 必须有 `team_id`、不接受 `workspace`，`workspace` 只对合成 owner 传输开放；`from_session_id` 存在时从源 session 取种子（`seed` 缺省 `copy`，`compact` 必须显式；`keep_messages` 是 `sessions.get().messages` 下标），源 agent / session 零改动且仍可跑；`seed` / `keep_messages` 无来源时 `invalid_params`。成功条目带 `agent`（`owner` 可选）。无 `kind` 的旧形状语义不变。失败条目按 §1.4 映射：`not_found` / `not_visible` / `invalid_params`（含 reason `source_private`）/ `conflict`（reason `not_primary` / `run_in_progress` / `agent_closed` / `team_frozen` / `team_full`）/ `internal`（reason `create_failed`）。`agents.list` / `agents.get` / agent status 条目带 `role`：运行期注册表角色 `main` / `subagent`，或成员角色 `member` / `temporary`（`single` 已删除，存量快照读取时降级为 `member`）；`owner` 对外仍可选（v3 总是写入）。人类管理面 principal（`role:'admin'` 且无 `agent_id`）的 `agents.list` 在事件派生视图外合并无 Team 的 `member`；合成 owner 传输与其它 agent / team token 仍按 viewer 可见性判定，private member / temporary 不放开。
- `agents.update`：`{ agents: [{ agent_id, name?, model?, system_prompt?, role?, team_id? }] }`（每项至少一个字段；`role` 只取 `member` / `temporary`）。`role` / `team_id` 是显式角色转换：`member` 必须绑定 Team、`temporary` 归属转换者（`from`）；handler 传 `team_id → teamId` 与 `from = principal.agent_id ?? 'human'`。成功条目带 `agent` / `changed` / `applies_to: 'next_body'`（仅 model / system_prompt 实际变化时）。`agents.close`：`{ agents: [{ agent_id }] }`；成功条目 `{ ok: true, agent, agent_id, closed: true }`。
- `agents.inbox`（只读）：`{ agent_id?, session_id?, include_held?, message_ids? }` → `{ agent_id?, unread, pending, entries: [{ message_id, from, summary, status: 'unread'|'held', ts, session_id?, from_name?, text? }] }`。`agent_id` 与 `session_id` 二选一（后者由服务端 `resolve()` 反查 agent，缺两者 `invalid_params`）；`session_id` 做归属**等值过滤**，缺该字段的老条目永不命中。摘要来自 inbox 文件已存的 160 字 `summary`；**只有显式传 `message_ids`（≤10，越界 `invalid_params`）才返回 `text`**，且不改变任何状态（不消费、不 hold / unhold）。可见性与 `agents.list` 同一口径（不可见 → `not_found`）。`agents.recall`（write）：`{ agent_id, message_ids }`（≤20，越界 `invalid_params`）→ `{ deleted, skipped: [{ message_id, reason: 'not_found'|'consumed'|'active' }] }`；按 message id 取消它对应的 queued run 并从「将执行」集合拿走 —— **human 源 = 真删**（inbox discard，不留墓碑）/ **agent 源 = unhold 留档**（回可读 unread），正在执行的那条 `skipped: active`（撤回不是打断）。条目没有也不该有 run id，所以不给它加 `run_id` 字段。`agents.claim`（0.51，write）：`{ agent_id, message_ids }`（≤20，越界 `invalid_params`）→ `{ claimed, skipped: [{ message_id, reason: 'not_found'|'consumed' }] }`；把「已经看到正文」的待处理输入从队列里拿走：先撤掉该消息对应的 queued run 并从 body mailbox 出队，再标 `consumed` + 解 hold。与 `agents.recall` 的差别只在出口 —— recall 按 source 真删 / 留档，claim 一律**消费**：拿走的条目不再投递、不再出现在 `agents.inbox`，下一次 append 裁剪时清掉。**不可逆**（没有 unclaim）。没有 `active` 档：正在执行的那条开跑即 consumed，按 `consumed` 跳过。
- `agents.send`：`{ messages: [{ to, content, conversation_id?, interrupt?, notify?, message_id? }] }`。`interrupt` 与 `notify` 互斥（`invalid_params`，reason `conflicting_delivery`）；`message_id` 只配 `interrupt`；`notify` 必须自带 `content`；`important` 已删除，显式传入 → `invalid_params`。成功条目两种：work / urgent `{ ok: true, queued: true, message_id, state }`；notify `{ ok: true, notified: true, message_id, wake, resolution: 'live' | 'gone', resolved_to?, conversation_id? }`。strict send，不 resume。
- `agents.dispatch`：work-only，输入 `{ messages: [{ to, content, conversation_id?, allow_auto_create? }] }`；传 `interrupt` / `message_id` / `notify` / `important` → `invalid_params`；成功 `{ ok: true, status: 'queued', message_id, resolved_to, resolution, conversation_id? }`，`resolution` 取 `live` / `resumed` / `rotating` / `created`；业务拒绝逐条 `{ ok: false, code, error }`（`agent_left` / `resume_failed` / `auto_create_failed` / `auto_create_not_allowed` / `not_visible` / `budget_*` / `conversation_team_mismatch`）。
- 统一结果 `{ results: [...] }`，与输入同序；单条失败 `{ ok: false, code, error }`，不影响其它条目。上述生命周期方法 permission 都是 `write`；结构错误整体 `invalid_params`；team-scoped control token 不能 create / close（`forbidden`），update / send / dispatch 只能操作同 `team_id` 成员，否则逐条 `not_found`；update 的角色转换只能转 `member` / `temporary`（同 Team），不能换到其它 Team（`forbidden`）。`principal.agent_id` 只由合成 owner 传输填 root owner id；handler 以 `ctx.principal.agent_id ?? 'human'` 作为 `from` / `viewer`。owner 端点只做传输：用 `defineMethods([...createAgentMethods, ...createTeamMethods])` 组装与 gateway 同源的方法表，wire 名即 canonical；HTTP 状态映射 `invalid_params` 400、`forbidden` 403、`not_found` 404、`conflict` 409、`internal` 500。
## canonical session 创建 / 切换契约
- `sessions.create`：`{ agent_id?, from_session_id?, seed?, keep_messages?, startup_prompt?, title?, mode?, files? }` → `{ agent_id, session_id, source_session_id?, seed?, keep_messages?, keep_projected?, copied_messages?, title?, primary: true, files_restored?, files_skipped? } (additive param title: names the new session, stored as SessionState.title with title_source='manual' so automatic AI naming never overwrites it; 1-120 chars after trim, blank / overlong -> invalid_params, echoed back as title)`。同一 marker 的出口是 `sessions.list`：`SessionInfo` 带可选 `title_source`，取 `'manual'`（`sessions.create{title}` / `sessions.rename` 人工命名，自动 AI 命名不再覆盖）或 `'generated'`（AI 命名）；additive —— 无标记（旧数据 / 尚未命名 / 旧 gateway）时该 key 不出现，线上形状与旧版一致。归一化与唯一出口见 `packages/core/src/session/session-store.ts` 的 `withTitleSource`（file / sqlite 两个后端与 `toSessionInfo` 共用，非 `manual` / `generated` 的值一律当无标记丢弃、不抛错）。无来源 = 空 session（`agent_id` 必填，`seed` / `keep_messages` / `mode` / `files` → `invalid_params`）；有来源 = 源 primary 的 `[0, keep_messages)` 深拷贝 / 压缩（`agent_id` 可省或必须与源一致）。成功时新 session 成为唯一 primary，源 binding 退役进 `bindingHistory`，源必须 `sessions.activate` 才能再跑。`mode:'both'` 表示先做显式 git restore（`files` 必填），硬失败在切换前中止，未注入回滚端口 → `not_supported`；单路径失败计入 `files_skipped`。错误：`not_found` / `not_visible` / `session_not_found` / `invalid_params` / `conflict`（`not_primary` / `run_in_progress` / `agent_closed` / `team_frozen` / `team_full`）/ `quota_exceeded` / `internal`（`create_failed`）。
- `sessions.restart`：`{ session_id, startup_prompt? }` → `{ agent_id, session_id, from_epoch, epoch }`。同一 session 原地换 binding（epoch+1）；旧 binding 退役进 `bindingHistory`，旧 EU dispose / `releaseHeldFor`（只放这具 body 的持有 —— 多 live body 时不得误放别的 body 的在途队列），transcript / SessionState 不变。错误：`session_not_found`；非 primary → `conflict` + `not_primary`；current primary 有 active run → `conflict` + `run_in_progress`；agent closed / left → `conflict` + `agent_closed`；失败 → `internal`（`restart_failed` / `restart_rollback_failed`）。
- `sessions.activate`：`{ session_id, startup_prompt? }` → `{ agent_id, session_id, previous_session_id, epoch, noop }`。目标限 primary 或 `bindingHistory` 中的 session；目标已是当前 primary 时 `noop: true`；成功时 epoch = 当前 primary epoch+1，原 primary 退役。错误：`session_not_found`；不可见 → `not_found`（details `reason: not_visible`）；current primary 有 active run → `conflict` + `run_in_progress`；agent closed / left → `conflict` + `agent_closed`；失败 → `internal`（`activate_failed`）。三个方法 permission 都是 `write`；team-scoped control token 只加入 `sessions.create`（镜像已删的 `agents.rotate`），handler 校验 `agent_id` / 源 session 所属 agent 与 caller 同 `team_id`，否则 `not_found`。
- **0.39 删除面（已删除）**：`agents.fork` / `agents.rotate` / `agents.restart` / `agents.compactFork` / `sessions.rewind`；替代为 `agents.create{from_session_id}`（fork）、`sessions.create`（rotate / compactFork / rewind 的编辑重试）、`sessions.restart`（restart）。旧事件 `agent.forked` / `agent.compact_forked` / `session.forked` / `system_event:'fork'` 只读渲染。
## canonical runs 契约：附件引用（0.52）
- `runs.start` 新增**可选** `refs: [{ kind: 'file'|'image'|'document', path, name?, mime?, bytes? }]`（≤32 条，`path` 为宿主机绝对路径、≤4096 字符）。additive：不传 = 无引用，旧客户端行为不变。refs **只有路径与元信息**（不存正文 / base64 / 远程 URL），随这次投递写进 `user.message` 事件与 SessionState，`sessions.get` / `SessionDetail.messages[].refs` 原样透出。
- **只拦形状，不拦越界**：handler 只校验形状（绝对路径 / ≤4096 字符 / ≤32 条 / kind 合法），非法才 `invalid_params` + `details.reason: "refs_invalid"`（带被拒的 `details.path`）。路径边界（命中 deny 目录 / 越出 `allowed_roots`）**不在准入处判** —— 用户引用自带意图，提前拒等于把意图丢掉；权限校验发生在模型**读文件那一刻**（`read` / `media` 的 `evaluatePath`，与普通文件工具同一套：denylist 硬 `deny`、`allowed_roots` 越界 `ask`）。同一份 `messageRefSchema` 与同一份 `readRefsParam` 也被 `teams.post` 的可选 `refs` 复用（不传 = 无引用）：团队页的引用随 @ 投递写进成员 session 的 `Message.refs`（成员靠 `[refs]` 行用 `media` 工具按需读），**同时也写进 Team 日志**（`TeamLogEntry.refs`，只在非空时写）并由 `teamPostResultSchema` 回显 `refs`，`teams.get` 原样透出 → 团队时间线在气泡上方显引用 chip（乐观行直接用回执的 refs）；旧日志 / 无引用的消息没有该键，读侧不渲染。系统行（join / leave / retract / 预算 override）与成员 `send` 不带 refs。团队页引用与草稿同槽（按 `(node, team)` 键）、发送成功后随草稿清空，「再次发送」只复原正文与 @。
- **读侧拒绝的归属**：越界读取被 ask 拒绝 → 工具结果说明是「工具的权限判定要求确认」（`permission-policy` 的错误文案带 tool's own permission check）；命中 denylist → 工具自己返回「被路径策略拒绝，不是文件不存在」。两种都不复述完整路径（模型自己的入参里已有）。
- 模型侧**不注入正文**：refs 不进 `RunOptions.messages`；唯一注入的是 BeforeLlm 的一行环境信息（`[refs] N attachments: … (use media: action=…)`，见 [context](context.md#injection)），内容由多模态解析器插件的工具按需读。
- Web：Composer 的待发送引用与草稿同槽（按会话键、sessionStorage），`runs.start` 成功后清空；`addRef` 只拦形状（绝对路径 / 长度 / 条数，防手误），被拒时按 `details.reason` 出 i18n 文案。
## canonical team 冻结契约
- `teams.spawnFrozen`：`{ team_id, frozen }` → `TeamSummary`（含 `spawn_frozen?`，`false` 时字段缺省）；permission 为 `write`。team-scoped control token 只能操作自己的 team，其它 team 返回 `not_found`。冻结是 Team 元数据，`teams.update` 不修改该字段；冻结期间该 Team 的 create / hire / 人类 `agents.create`（含 `from_session_id`）/ reinstate 均返回 `team_frozen`，只有 `frozen: false` 解冻。CLI 为 `vessel team freeze|unfreeze <team_id>`。
- `teams.retract`：`{ team_id, message_id }` → `{ team_id, message_id, retracted_message_id }`（`message_id` 是新 tombstone，`retracted_message_id` 是目标）；permission `write`，team scope 校验同其它 `teams.*`。日志保持 append-only：只追加一条 `kind:'system'`、`system_event:'retract'`、`content:''` 的 tombstone，不删除 / 不改写原消息，也不级联删除后续回复。错误：Team 不存在 `not_found`；目标不在可读窗口（最近 1000 条）`not_found`（details `team_code: message_not_found`）；目标为 system 行 / tombstone `invalid_params`；目标已被撤回 `conflict`（`already_retracted`）；归档 Team 复用 `team_archived`。
