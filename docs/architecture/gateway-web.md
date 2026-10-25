---
title: 权限桥与会话切换
kind: current
triggers: [web, apps/web, permission bridge, ask_user, session switch, frontend]
paths: [apps/web/**, packages/serve/src/gateway/**]
---

# 权限桥与会话切换（Web）

<a id="permission-bridge"></a>

### 权限与 ask_user 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 弹窗支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。

<a id="session-switch"></a>

### 会话切换

`GatewayOptions.context` 存在且目标 session 与当前不同时：先 `context.setSessionId(target)` 再 `context.clear()`，随后 `runtime.run` 从 `SessionBackend` 重载目标会话历史。没有 `context` 时无法保证隔离（需装配层传入）。

<a id="web"></a>

### Web 控制台（`apps/web`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`since`）、gap 提示。
- token 存 URL fragment，再转 `sessionStorage`；不写 `localStorage`、不进 URL query。
- **运行时 gateway URL**：优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 `http(s)://host[:port]` origin，拒绝 path / query / hash / userinfo / wildcard；非回环必须 https，HTTPS 页面拒绝 http/ws（mixed content）。换 URL 时重建 client 并重置 seq / 时间线 / 选中会话。
- **独立前端**：可把 `apps/web/dist` 部署到任意静态站点；服务端配置 `serve.allowed_origins` 允许该 Origin（CORS + WS upgrade），浏览器需信任 gateway 证书。同源部署仍由 gateway 托管 `dist`。
- 功能：运行提交/取消、时间线、会话列表、工具端点、权限弹窗、ask_user 表单。
- 按 `hello.features` 显示 **MCP server 面板**（`mcp-status`）与 **interrupted run 面板**（`durable-resume`），可触发 durable resume；未启用的 feature 不显示面板。面板 10s 刷新。
- 按 `hello.features` 显示 **metrics 快照**与 **飞书状态**（`metrics` / `feishu`）；evals 只做 `GET /v1/evals/latest`，不做面板。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/v1` 与 `/health` 到 `127.0.0.1:8642`，`changeOrigin:false` 保持同源）；生产：gateway 托管 `dist`。
- 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠（见 `docs/versions/0.6.1.md`）。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

