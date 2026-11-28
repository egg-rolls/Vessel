---
title: Web 网关客户端、state 与权限桥
kind: current
triggers: [web, apps/web, gateway client, permission bridge, ask, session switch, state, visibility, messageVisibility, 可见性, settings, frontend, 网页, 前端, 权限桥, 会话切换, 浏览器, attachments, images.blob, token, bootstrap, plugin.changed]
paths: [apps/web/src/gateway/**, apps/web/src/state/**, apps/web/src/auth/auth-client.ts, apps/web/src/domains/chat/PermissionCard.tsx, apps/web/src/domains/chat/pending-permissions.ts, apps/web/src/domains/chat/AskCard.tsx, apps/web/src/domains/chat/ask-answer.ts, apps/web/src/domains/chat/tool-catalog.tsx, apps/web/src/domains/integrations/McpPanel.tsx, apps/web/src/domains/integrations/ChannelsPanel.tsx, apps/web/src/domains/integrations/ToolsPanel.tsx, apps/web/src/domains/observe/MetricsPanel.tsx, apps/web/src/domains/runs/useRunsPage.ts, apps/web/vite.config.ts, packages/serve/src/gateway.ts, packages/core/src/runtime/runtime.ts, packages/core/src/runtime/execution-unit.ts, src/cli.ts, src/gateway/web-dist.ts]
---

# Web 网关客户端与 state（`apps/web`）

> 事实家：网关客户端（`gateway/**`）+ 客户端 state（`state/**`）+ 权限 / ask 桥 + 会话切换的 Web 侧面。既有家只链接：渲染链 [web-chat-render.md](web-chat-render.md)、块协议 [blocks.md](blocks.md)、stores [web-stores.md](web-stores.md)、UI 约定 [agents/web.md](../agents/web.md) / [WEB-UI.md](../WEB-UI.md)、回放协议 [session-replay.md](session-replay.md)、事件三档 [event-visibility.md](event-visibility.md)、SWR [data-refresh-swr.md](data-refresh-swr.md)、设置弹窗 [WEB-UI.md §设置](../WEB-UI.md)。

<a id="permission-bridge"></a>

## 权限与 ask 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 卡片支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`；已过期 / 已随 run 取消的请求返回 `expired`（`gateway/interactions.ts`）。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。
- 客户端 pending 集合唯一来源是 `stores/interactionStore`（ConnectionProvider 唯一写者；`interactions.list` hydration + 纯合并规则 `gateway/interaction-hydration.ts:interactionReducer`）；卡片槽位与收起约定见 [agents/web.md](../agents/web.md)。

<a id="session-switch"></a>

## 会话切换

- **不经 gateway 共享 context**：`GatewayOptions.context`（`packages/serve/src/gateway.ts`）是残留选项，serve 已不消费它。现态是 **per-session ExecutionUnit 隔离**：`Runtime.getOrCreateExecutionUnit` 按 `(tenantId, sessionId)` 取或建 EU（单飞创建；已有 EU 而 `agentId` 不一致时拒绝复用，不静默串台），带目标 `session_id` 的运行路由到该会话自己的 EU。
- 每个 Run 经 `contextFactory` 新建 `WorkingContext`（缺省 `defaultContextFactory` 按 session 新建 `MemoryWorkingContext`）；run 起点由 `seedWorkingContext` 用目标会话的历史投影播种——先 `setSessionId(target)` 再 `clear()`，然后逐条追加历史（缺基底 system 时补回）。历史 = 事件日志整份投影 + 会话壳缓存按内容对账；同 session、日志尾未前进且窗口非空时走复用路径（只抑制 `context.changed` 事件，不跳过播种）。机制细节见 [runtime-lifecycle.md](runtime-lifecycle.md) / [context.md](context.md)。
- 切会话 = 换 EU + 从历史播种的新窗口，不存在需要 gateway 清空的共享上下文。

<a id="client"></a>

## 网关客户端（`gateway/**`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`since`）、gap 提示（回放硬校验见 [session-replay.md](session-replay.md)）。
- 平台客户端固定 `gateway/platform/**`、node 客户端固定 `gateway/node/**`，互不 import；`client.ts` 只是兼容 barrel。
- token 只存 `sessionStorage`（平台 / node 分槽，连接设置里手动填）；`#token=` / `#bootstrap=` 是**一次性引导码**（`auth/auth-client.ts` 提交 `POST /auth/bootstrap`，单次 + 10 分钟 TTL，换到会话后即废），不是平台 token 的种子。不写 localStorage、不进 URL query、不落日志。
- 连接顺序：平台 token → `/platform/rpc`（`whoami` → `nodes.list` → `credentials`）→ 用生效 node 凭据直连 Node API（`api_url` 的 `/v1/rpc`、`/v1/events`）。回环匿名时 `whoami` 返回 `anonymous`、credentials 返回 `{token:null,mode:'none'}`，node 按匿名语义连接。不再调用 `/v1/local/token`。
- **legacy 回退**：页面由 legacy `--serve` 托管、`/platform/rpc` 不存在时，回退同源 node 连接与旧 `vessel.token` 槽；401 鉴权错误不静默回退。
- **平台 URL**：`localStorage['vessel.gateway-url']` 语义 = 平台 origin；空串 = 页面同源；仅接受 `http(s)://host[:port]`，非回环必须 https。node URL 来自 registry，不由用户输入拼装。
- node 域方法：`attachments.list` / `attachments.stage`（暂存上传，逐文件失败逐条报，`gateway/node/attachments.ts:stageFiles`）/ `attachments.preview`（缩略图 + 过期探针）；`images.blob` 按 sha256 + `session_id` 读内容寻址 blob（会话归属闸 fail-closed，无路径入参；旧 gateway `not_found` → 退回元数据 chip）。客户端缓存与图片卡见 [web-chat-render.md](web-chat-render.md)。
- 会话订阅顺带解析归属 agent（subscribe 时经 `opts.agent.resolve`，不信客户端自报），只用于放行 `agent.inbox.changed`；解析失败降级为只收会话内帧，其余事件族的会话边界不变。
- 任何插件生效态变化（`plugins.reload` / `plugins.config.set` / config 热应用链）必有一次 `plugin.changed` 广播（`Gateway.notifyPluginChanged`），web 对账随即拿到活数据。

<a id="state"></a>

## state 层（`state/**`）

- **消息显示唯一解析口** `state/message-visibility.ts:resolveMessageVisibility`：`ui.messageVisibility` 五 toggle（reasoning / tools / environment / source 默认 true，system 默认 false）；system 未配置回退旧键 `ui.showInternalEvents`（snake_case 也接受，显式新键优先）；`verbosity: debug` 的「或」语义由消费方叠加（`visibility.ts` / `runtime-visibility.ts`），不在解析口。用户消息 / AI 正文恒显不给开关。
- runtime 上下文消息（role user、name `vessel:*`）**拆两半**：`runtime-kinds.ts` 是纯函数半（零 import：kind 词表 source / notice / subscription / limit / compaction / other + `runtimeVisibilityFor` 查表——notice / source 跟 environment / source toggle，其余跟 system；`subscription` 是无生产者的历史 kind）；`runtime-visibility.ts` 只留 React 绑定 `useRuntimeVisibility`（读 configStore 快照，设置保存后无需刷新即生效）。渲染侧消费见 [web-chat-render.md](web-chat-render.md)。
- 原始事件行三档（content / internal / observe）与登记义务 → [event-visibility.md](event-visibility.md)（`state/event-visibility.ts` / `error-visibility.ts`）。
- **设置注册表**：`state/settings-registry.ts`（`CORE_SETTINGS` 服务端键表 + `LOCAL_SETTINGS` 本地偏好 + `VIEW_SETTINGS` view 项 + `pluginSettingsToDefs` 插件域）+ `settings-search.ts`（`@modified` / `@plugin:<id>` / scope token + 空格分词 AND）+ `display-settings.ts` 派生兼容层——事实家是 [WEB-UI.md §设置](../WEB-UI.md)（单一事实源 / 写路径 / 分类），此处不复制。
- 实时事件状态（`event-store.ts` / `events.ts` / `live-items.ts`）→ [session-replay.md](session-replay.md)；`useResource.ts` 资源契约 → [data-refresh-swr.md](data-refresh-swr.md)；其余（sessions / runs / run-detail / agents / teams / palette / theme 等）是各域读侧投影，store 层见 [web-stores.md](web-stores.md)。

<a id="web"></a>

## Web 控制台

- 功能：运行提交 / 取消、时间线、会话列表、工具端点、权限弹窗、ask 表单；Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠。
- **工具面板只有一份清单**：`tools.list` 不传参数，把节点那一份工具平铺列出来——通用成员级工具（`inbox` 等）经 `agent.commonToolSurface` 已纳入节点口径清单（按 name 去重、宿主优先），不分组、不徽标、无成员选择器。可选 `agent_id` 只在诊断时按某具成员身体读同一份清单（未知 id → `not_found`，老装配退化为节点口径）。工具卡描述目录：`ToolCatalogProvider`（`domains/chat/tool-catalog.tsx`）在知道当前会话成员 id 时带 `agent_id` 拉一次，拿不到 id 保持节点面。
- 按 `hello.features` 显示面板：**MCP server**（`mcp-status`）、**interrupted run**（`durable-resume`，可触发 durable resume）、**metrics 快照**、**飞书状态**；未启用的 feature 不显示，面板 10s 刷新。evals 只做 `GET /v1/evals/latest`，不做面板。
- **独立前端**：`apps/web/dist` 可部署到任意静态站点，服务端 `serve.allowed_origins` 允许该 Origin（CORS + WS upgrade），浏览器需信任 gateway 证书；同源部署仍由 gateway 托管。静态目录解析链：`gateway.web_dist` config > `VESSEL_STATIC_DIR` env > 仓库内 `apps/web/dist`（`src/gateway/web-dist.ts:resolveWebDistDir`；空串视为未设置，`~` 展开、相对按 cwd）；自动构建自愈只在仓库内默认目录生效（显式目录不碰），失败只告警不改退出码。CLI 装配 wiring 见 [cli-wiring.md](cli-wiring.md)。
- 插件页面由 Node API 托管（`/plugins/<id>/...`）；Platform Gateway 的 `/plugins/*` 一律 404，插件 iframe 走 node origin（平台模式取选中节点 `api_url`），catalog / settings 为单份视图。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/platform` → 平台 `127.0.0.1:8642`、`/v1` 与 `/health` → node `127.0.0.1:8644`，`changeOrigin:false` 保持同源）；两个零 import 叶模块经 alias 按源码消费（`@vessel-agent/agent/address-display`、`@vessel-agent/config/env-injection`，包根不进 web bundle）。
- 已知边界：per-body 串行 + FIFO 队列（默认上限 100，见 [host.md](host.md)）；live 环形缓冲在内存（受裁剪），落盘历史走 timeline（[session-replay.md](session-replay.md)）；无自动化浏览器测试。