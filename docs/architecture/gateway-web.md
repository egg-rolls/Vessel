---
title: 权限桥与会话切换
kind: current
triggers: [web, apps/web, permission bridge, ask, session switch, frontend]
paths: [apps/web/**, packages/serve/src/gateway/**]
---

# 权限桥与会话切换（Web）

<a id="permission-bridge"></a>

### 权限与 ask 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 弹窗支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。

<a id="session-switch"></a>

### 会话切换

`GatewayOptions.context` 存在且目标 session 与当前不同时：先 `context.setSessionId(target)` 再 `context.clear()`，随后 `runtime.run` 从 `SessionStore` 重载目标会话历史。没有 `context` 时无法保证隔离（需装配层传入）。

<a id="web"></a>

### Web 控制台（`apps/web`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`since`）、gap 提示。
- token 只存 `sessionStorage`；`#token=` 是**平台 token** 的种子。平台 token 与 node token 分槽；不写 `localStorage`、不进 URL query。
- **0.49 连接顺序**：平台 token 连 Gateway → `platform.whoami` → `platform.nodes.list` → `platform.nodes.credentials` → 用生效 node 凭据直连 Node API（`api_url` 的 `/v1/rpc`、`/v1/events`）。回环匿名时 `whoami` 返回 `anonymous`、credentials 返回 `{token:null,mode:'none'}`，node 按现有匿名语义连接。Web 不再调用 `/v1/local/token`。
- **legacy 回退**：页面由 legacy `--serve` 托管、`/platform/rpc` 不存在时，回退到同源 node 连接与旧 `vessel.token` 槽；401 鉴权错误不静默回退。
- **平台 URL**：`localStorage['vessel.gateway-url']` 语义 = 平台 origin；空串 = 页面同源。仅接受 `http(s)://host[:port]` origin；非回环必须 https。node URL 来自 registry，不由用户输入拼装。
- **独立前端**：可把 `apps/web/dist` 部署到任意静态站点；服务端配置 `serve.allowed_origins` 允许该 Origin（CORS + WS upgrade），浏览器需信任 gateway 证书。同源部署仍由 gateway 托管 `dist`。
- 功能：运行提交/取消、时间线、会话列表、工具端点、权限弹窗、ask 表单。
- 按 `hello.features` 显示 **MCP server 面板**（`mcp-status`）与 **interrupted run 面板**（`durable-resume`），可触发 durable resume；未启用的 feature 不显示面板。面板 10s 刷新。
- 按 `hello.features` 显示 **metrics 快照**与 **飞书状态**（`metrics` / `feishu`）；evals 只做 `GET /v1/evals/latest`，不做面板。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/platform` 到平台 `127.0.0.1:8642`、`/v1` 与 `/health` 到 node `127.0.0.1:8644`，`changeOrigin:false` 保持同源）；生产：Platform Gateway 托管 `dist`，node 不再宿主 UI。
- 插件页面由 Node API 托管（`/plugins/<id>/...`）；Platform Gateway 的 `/plugins/*` 一律 404，插件 iframe 走 `nodeUrl`，catalog / settings 为单份视图。
- 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠（见 `docs/versions/0.6.1.md`）。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

