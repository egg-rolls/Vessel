---
title: 权限桥与会话切换
kind: current
triggers: [web, apps/web, permission bridge, ask, session switch, frontend, 网页, 前端, 权限桥, 会话切换, 浏览器]
paths: [apps/web/src/gateway/**, apps/web/src/state/**, apps/web/src/auth/auth-client.ts, apps/web/src/domains/chat/PermissionCard.tsx, apps/web/src/domains/chat/pending-permissions.ts, apps/web/src/domains/chat/AskCard.tsx, apps/web/src/domains/chat/ask-answer.ts, apps/web/src/domains/chat/tool-catalog.tsx, apps/web/src/domains/integrations/McpPanel.tsx, apps/web/src/domains/integrations/ChannelsPanel.tsx, apps/web/src/domains/integrations/ToolsPanel.tsx, apps/web/src/domains/observe/MetricsPanel.tsx, apps/web/src/domains/runs/useRunsPage.ts, apps/web/vite.config.ts, packages/serve/src/gateway.ts, packages/core/src/runtime/runtime.ts, packages/core/src/runtime/execution-unit.ts, src/cli.ts, src/web-dist.ts]
---

# 权限桥与会话切换（Web）

<a id="permission-bridge"></a>

### 权限与 ask 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 弹窗支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。

<a id="session-switch"></a>

### 会话切换

会话切换**不经 gateway 共享 context**：`GatewayOptions.context`（`packages/serve/src/gateway.ts`）是残留选项，serve 已不消费它（全域零 `setSessionId` 调用点）。现态是 **per-session ExecutionUnit 隔离**：`Runtime.getOrCreateExecutionUnit` 按 `(tenantId, sessionId)` 取或建 EU（单飞创建；已有 EU 而 `agentId` 不一致时拒绝复用，不静默串台），带目标 `session_id` 的运行路由到该会话自己的 EU。每个 Run 新建 `WorkingContext`（`contextFactory`；缺省 `defaultContextFactory` 按 session 新建 `MemoryWorkingContext` 并 `setSessionId`），run 起点由 `seedWorkingContext` 用目标会话的历史投影播种——先 `setSessionId(target)` 再 `clear()`，然后逐条追加历史（`packages/core/src/runtime/runtime.ts` 的 `defaultContextFactory`、`execution-unit.ts` 的 `seedWorkingContext`）。切会话 = 换 EU + 从历史播种的新窗口，不存在需要 gateway 清空的共享上下文。

<a id="web"></a>

### Web 控制台（`apps/web`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`since`）、gap 提示。
- token 只存 `sessionStorage`（连接设置里手动填）；0.56 P2 起 `#token=` / `#bootstrap=` 只是**一次性引导码**（提交给 `POST /auth/bootstrap`，单次 + 10 分钟 TTL），不再是平台 token 的种子。平台 token 与 node token 分槽；不写 `localStorage`、不进 URL query。
- **0.49 连接顺序**：平台 token 连 Gateway → `platform.whoami` → `platform.nodes.list` → `platform.nodes.credentials` → 用生效 node 凭据直连 Node API（`api_url` 的 `/v1/rpc`、`/v1/events`）。回环匿名时 `whoami` 返回 `anonymous`、credentials 返回 `{token:null,mode:'none'}`，node 按现有匿名语义连接。Web 不再调用 `/v1/local/token`。
- **legacy 回退**：页面由 legacy `--serve` 托管、`/platform/rpc` 不存在时，回退到同源 node 连接与旧 `vessel.token` 槽；401 鉴权错误不静默回退。
- **平台 URL**：`localStorage['vessel.gateway-url']` 语义 = 平台 origin；空串 = 页面同源。仅接受 `http(s)://host[:port]` origin；非回环必须 https。node URL 来自 registry，不由用户输入拼装。
- **独立前端**：可把 `apps/web/dist` 部署到任意静态站点；服务端配置 `serve.allowed_origins` 允许该 Origin（CORS + WS upgrade），浏览器需信任 gateway 证书。同源部署仍由 gateway 托管 `dist`。
- 功能：运行提交/取消、时间线、会话列表、工具端点、权限弹窗、ask 表单。
- **工具面板只有一份清单（0.51）**：`tools.list` 不传参数，把节点那一份工具平铺列出来 —— 插件工具与其它工具不分组、不徽标，也不再有成员选择器 / `surface` / `source` / 「被规则挡住」清单（用户裁定：成员用的就是节点有的那一份，不要区分）。可选 `agent_id` 只在诊断时按某具成员身体读同一份清单，响应形状不变；`inbox` 仍是成员运行期注入、暂时不在清单里，待 inbox 插件化后自然归位。
- **工具卡的描述目录**：`ToolCatalogProvider` 在知道当前会话的成员 id 时（chat 的 `activeAgent`）带 `agent_id` 拉一次，`inbox` 这类卡片的描述不再显示「描述不可用」；拿不到 id 时保持原行为（拉节点插件面）。
- 按 `hello.features` 显示 **MCP server 面板**（`mcp-status`）与 **interrupted run 面板**（`durable-resume`），可触发 durable resume；未启用的 feature 不显示面板。面板 10s 刷新。
- 按 `hello.features` 显示 **metrics 快照**与 **飞书状态**（`metrics` / `feishu`）；evals 只做 `GET /v1/evals/latest`，不做面板。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/platform` 到平台 `127.0.0.1:8642`、`/v1` 与 `/health` 到 node `127.0.0.1:8644`，`changeOrigin:false` 保持同源）；生产：Platform Gateway 托管 `dist`，node 不再宿主 UI。
- 插件页面由 Node API 托管（`/plugins/<id>/...`）；Platform Gateway 的 `/plugins/*` 一律 404，插件 iframe 走 `nodeUrl`，catalog / settings 为单份视图。
- 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠（见 `docs/versions/0.6.1.md`）。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

