---
title: Gateway 协议与远程
kind: current
triggers: [gateway, websocket, sse, tls, origin, csp, cors, remote, protocol, endpoint, 网关, 重启, 协议, 远程, 跨域, 证书, 端点, 端口]
paths: [packages/serve/src/gateway.ts, packages/serve/src/protocol.ts, packages/serve/src/event-buffer.ts, packages/serve/src/replay-budget.ts, packages/serve/src/backpressure.ts, packages/serve/src/durable.ts, packages/serve/src/platform/server.ts, src/rpc/types.ts, src/rpc/http-client.ts, src/gateway/serve-auth.ts, src/cli/commands/fleet/stop-command.ts]
---

# Gateway 协议与远程
> 目标 / 迁移态见 [0.34-target.md](0.34-target.md)（target）与 [ADR-101](../adr/ADR-101-platform-gateway-and-node-api.md)；本文只写现态。分层决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)。
<a id="protocol"></a>

`packages/serve` 是 **EventStream 的消费者**（与 TUI 的 StreamRenderer 同构）：把 runtime 事件广播为 WS / SSE，并提供 `/v1` 控制端点；**不改 core、不经过 PluginHost**。gateway 只读取注入的单一事件面（单公司单流，无 tenant 过滤；ADR-089/100）。`apps/web` 是配套的浏览器控制台；数据面**默认经平台代理** `/nodes/:nodeId/**`（node token 不出网关），直连 node 只是 `gateway.proxyNodes: false` 的回退形态（现态与策略表见 [topology](topology.md)）。

**进程拓扑**：`vessel gateway start` **只跑平台进程** —— Platform Gateway（默认 `127.0.0.1:8642`；静态宿主 + `/health` + `/platform/rpc` allowlist：5 个只读 `platform.*` + `gateway.shutdown` 唯一非只读）+ **每节点子进程监督** + `/auth/*` 登录端点（`AuthService`，在鉴权闸**之前**处理；配了 `auth.backends` 才启用，见 `platform/server.ts`）；它**不进 bootstrap / serve 管线**，因此不加载 node runtime / tenant 锁 / plugin host / node 监听（`src/cli.ts` gateway 前台分支）。**Node API**（`node.port`，拆分缺省 8644；`/v1/*`、WS/SSE、插件 HTTP/静态）在**独立子进程**里：由 platform 托管并注册于 `<dataDir>/nodes.json`（`gateway nodes list|add|remove`，已删除最后一项则回隐式单节点）；`node start --config` 可单独启动（此时 gateway 只做 **adopt**，永不杀非自己 spawn 的 node）。「同一进程双监听」是 legacy 形态（`VESSEL_LEGACY_SERVE=1` / 旧 `vessel --serve`），不再是默认路径。平台路由表 / 认证链与 Node API 物理分离；平台 token 与 per-node token 互不通用，平台侧不 import node runtime，node 不 import platform（评审人工核对依赖方向）。`vessel node start/status/stop/reload` 只操作 Node API。legacy `vessel --serve` 仍是单监听 8642、node 宿主 UI。生命周期职责边界见 [gateway-lifecycle](gateway-lifecycle.md)；Hub 控制面不在 gateway 内：独立 `vessel hub start` 进程与节点出站拨号见 [federation-hub](federation-hub.md)。

### 协议 `vessel.gateway/1`

- 服务端帧：`hello`（协议/节点信息 + `from_seq` / `latest_seq`；时间线 epoch 另带 `start_seq` / `end_seq` / `count` / `holes` 等段）、`event`（带 `seq`、可选 `job_id` 与 `node_id`）、`res`（方法应答）、`ping`、`timeline-epoch-end`（时间线 epoch 整趟发完的结束标记）。**没有 `gap` 帧**（已删除，见下）。
- `hello.from_seq` 是本次 epoch **实际会发送的第一条** seq：有回放窗口时为窗口首条；已追平为 `latest_seq + 1`；空缓冲为 `0`。`latest_seq` 是当前最新 seq（空缓冲为 `0`）。每次成功的 `events.subscribe` 都会先发一个新的 `hello`（订阅 epoch），再发有界回放，最后发 `res`；时间线 epoch 整趟发完时在 `res` 前补发 `timeline-epoch-end`（字段口径见 [gateway-rpc](gateway-rpc.md#rpc-methods)）；连接级 `hello` 只在首连 / 重连出现。
- 客户端帧：`auth`（首帧，`{ kind: 'auth', token, since? }`）、`req`（`id` + `method` + `params`）、`pong`、`timeline_gap`（缺口上报）。
- **首帧鉴权**：token 不进 WS URL / query；连接后 5s 内未收到合法 `auth` → 关闭码 4401。auth 不接受 `tenant_id`。
- `seq` 由 gateway 分配；环形缓冲默认保留 10000 条（只是抖动缓冲，不是历史）。客户端记录 `lastSeq`，重连用 `?since=` 或 `auth.since` 续订。
- **有界回放与缺口**：单次回放对**过滤后**的事件从最新往回取，≤ 1 MiB / 2000 条；更早区间可带 `until_seq`（能力位 `events.replay-range`）逐页回退，每页同样受上面的预算约束。**跳过的区间不编码成 `gap` 帧**：缺口只有两种解释——写者声明的 `holes`（时间线 epoch 的 `hello.count` / `holes`），或客户端自己按 seq 连续性算出来；对不上就发客户端帧 `{kind:'timeline_gap'}`，服务端记录为 `timeline.gap_reported`（不改事实源）。背压丢弃同样不上线成帧，进本连接 `backpressure_drops` 计数、断连时随 `gateway.ws.closed` 落账。
- **会话级订阅**：`events.subscribe` 支持 `session_id`，SSE 支持 `?session_id=`；事件满足 `data.session_id` 或 gateway 维护的 `run_id → session_id` 归属（内存 LRU 5000，回放期按 seq 顺序重建）才发送，归属不到则不发（fail-closed）。**唯一例外**：`agent.inbox.changed` 按「订阅会话的归属 agent」放行——归属在 subscribe 时经 `opts.agent.resolve` 服务端派生（不信客户端自报；解析失败降级为只收会话内帧），放行的只是 inbox 元数据变更信号，与 `agents.inbox` 的 RPC 可见性对齐；其余帧的会话等值口径不变。`types` 条目以 `*` 结尾按前缀匹配，空数组等价于未提供。空字符串 `session_id`（同空 `run_id`）按「过滤掉一切」处理，**不**等同于未提供。能力位 `events.session-filter` 用于新客户端对旧 gateway 降级。
- **since / pong / seq 回退**：客户端收到 `ping` 回 `pong`；`hello.latest_seq < lastSeq` 时从 `since=0` 重新对齐；时间线缺口按 `count` / `holes` 自检（见上）。重连指数退避 1s → 30s 加 jitter；10s 未收到 `hello` 视为失败并重连；`close()` 清理全部定时器。
- **跨节点事件**：`event.node_id` 优先于顶层 `node_id`；远端事件由 `(node_id, wire seq)` 去重后回灌。wire seq 按各节点 / 连接分配，**没有全局序**。
- `RunStatus.run_id` 是网关级 id；`core_run_id` 在 `run.started` 后可知；事件帧的 `job_id` 用于把 core run 与网关 run 对齐。

<a id="endpoints"></a>

### 端点

| 方法 / 路径 | 说明 |
|---|---|
| `GET /v1/health`（`/health` 兼容） | 开放探针；返回 clients / latest_seq / protocol / node |
| `GET /v1/local/token` | 本机 WebUI 自动连接；**仅回环 socket + 回环 Host + 同源（或无 Origin）**返回显式 legacy gateway token（`node.token` / `node.token_env` / `VESSEL_GATEWAY_TOKEN`）；`node.tokens`-only 与未配置均 404，不生成临时 token；无 CORS 头、`Cache-Control: no-store`、不写日志 |
| `GET /v1/events`（WS，`/ws` 兼容） | 事件流；query token 仅为兼容，客户端用首帧 `auth`，token 不进 URL |
| `GET /v1/events`（SSE，`/events` 兼容） | 只读事件流；`?token=` |
| `GET /v1/sessions`（`/sessions` 兼容） | 会话列表（`listRich`） |
| `GET /v1/tools` | 工具列表（不含 handler） |
| `GET /v1/runs?session_id=` | 当前进程运行列表 |
| `POST /v1/runs` | `{input, session_id?}` → 202 `{run_id, status, queue_position?}`；队列满 429 `busy` |
| `GET /v1/runs/:id` | 运行状态 |
| `POST /v1/runs/:id/cancel` | 取消（AbortController） |
| `POST /v1/permissions/:id` | `{decision:'allow'|'deny', remember?}` → 发布 `tool.permission.response` |
| `POST /v1/ask/:id` | `{answers:[]}` → 发布 `ask.user.answered`（空数组表示取消） |
| `GET /v1/durable/runs?status=&session_id=&limit=` | durable run 摘要列表；`status` 支持逗号分隔，缺省全部；默认 50、最大 200 |
| `POST /v1/durable/runs/:runId/resume` | 202 `{run_id, status:'queued'}`；未启用/不支持 resume → `durable_disabled` |
| `GET /v1/mcp/servers` | `{servers:[{name,status,tools,error?}]}`；未注入 → `mcp_disabled` |
| `GET /v1/metrics` | `{metrics: MetricsSnapshot}`；未注入 → `metrics_disabled` |
| `GET /v1/channels/feishu` | `{channel: FeishuStatus}`；未注入 → `channel_disabled` |
| `GET /v1/evals/latest?suite=` | `{report: EvalReport}`；无报告 → 404 `eval_not_found` |
| `POST /run` | 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 返回 `method_not_allowed`（legacy 草案保留在 `protocol.ts`）；跨节点 team 平面已删除。

稳定错误码（additive）：`run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled` / `metrics_disabled` / `channel_disabled` / `eval_not_found`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls` / `evals` / `feishu` / `metrics` / `config`。HTTP 映射：404 `*_not_found`；503 `*_disabled`；400 `invalid_request`。

<a id="static-hosting"></a>

### 静态托管与安全

- `staticDir` 存在时，GET/HEAD 的非 API 路径托管 `apps/web/dist`；无扩展名路径回落 `index.html`（SPA）；路径解析后校验 root 前缀，防穿越；API 路径永不托管。缓存：HTML 与**无内容哈希**资产（publicDir 直拷的 `/Vessel.svg`、`/favicon.ico`、`/apple-touch-icon.png` 等）`no-cache`（可再验证，升级即刷新）；仅文件名带内容哈希的 Vite 产物（`name-HASH.ext`）`public, max-age=31536000, immutable`。
- 默认绑定 `127.0.0.1`；Host 只接受 `127.0.0.1` / `localhost` / `[::1]` 或显式 `hostname`。
- **Origin allowlist**：`node.allowed_origins` / `--allowed-origin` 在启动时归一化为 `URL.origin`，拒绝 `*`、path、query；HTTP 与 WS upgrade 共用同一判定，无 Origin 放行（curl / peer），浏览器必须同源或在 allowlist。
- **反代共享密钥（opt-in）**：配 `node.proxy_secret_env` / `gateway.proxy_secret_env` 后，「回环 = 本机」不再自动成立——**无凭据**请求必须由反代注入 `x-vessel-proxy-secret` 头才放行；带 Bearer token 的请求行为不变。不配 = 旧行为。语义与部署见 [REVERSE-PROXY.md](../operations/REVERSE-PROXY.md)。
- **CORS**：预检命中 allowlist 返回 204，只回 `Access-Control-Allow-Origin` / `Methods` / `Headers` / `Max-Age`；永不使用 `*`，不使用 credentials。allowlist 非空时所有响应带 `Vary: Origin`。
- **CSP**：移除裸 `ws:` / `wss:`；`connect-src` 由 Host 与 allowlist 动态生成，其余策略保持 `script-src 'self'`。独立静态站点自行下发 CSP。
- token 来源优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。生成值 32B 随机 base64url，恒定时间比较；WS 5s 未鉴权关闭 4401。
- 事件流是长连接：`Bun.serve` 的 `idleTimeout` 默认 `0`（禁用，可用 `GatewayOptions.idleTimeout` 覆盖）；heartbeat 默认 15s，SSE 发 `: ping` 注释、WS 发 `ping` 帧，用于穿透代理与检测死客户端。
- 请求体上限 1 MiB（RPC / legacy REST / 跨节点消息端点一致）；**唯一例外** `attachments.stage` 放宽到 12 MiB（8 MiB 原始字节的 base64 膨胀），其余方法仍按 `maxBodyBytes`。慢客户端 `bufferedAmount > 4 MiB` 断开（1013）。
- **背压**：gateway `SeqEventBuffer` 缺省 10000，**永不无界**，与 core `observability.event_history` 的 `0 = unlimited` 语义独立、不被覆盖。WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；超过阈值先丢事件并计数（`backpressure_drops`，断连时进 `gateway.ws.closed`），4 MiB 硬断开作为最后手段。gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。

<a id="tls"></a>

### 远程监听与 TLS

- **默认不变**：`127.0.0.1:8642`（legacy 单监听；拆分 node 缺省 8644）、明文、token 来源优先级不变。
- **远程 opt-in**：`node.allow_remote: true` 或 `--allow-remote`；非回环 hostname 未显式允许时启动失败。
- **远程必须 token**：非回环必须有非空 gateway token（配置 / `VESSEL_GATEWAY_TOKEN` / 自动生成）；不得匿名。
- **远程必须 TLS**：非回环监听必须同时提供 `node.tls.cert_file` + `key_file`（或 `--tls-cert` / `--tls-key`），否则启动失败；不再允许明文远程。回环仍可在无 TLS 下运行，也可显式启 TLS。
- **无逃生口**：不提供 `--insecure` / `-k`；证书、token、Origin 任一不满足即 fail-closed，不静默降级。
- **独立前端 Origin**：`node.allowed_origins` 或重复 `--allowed-origin`；与 HTTP / WS 共用 allowlist，规则见 [静态托管与安全](#static-hosting)。
- **只做 HTTP/1.1**：不做 HTTP/2 / ALPN / mTLS / ACME；HTTPS 与 WSS 共用同一 server、token、Host/Origin 规则。
- `hello.features` 在启用 TLS 时增加 `tls`；不新增 `remote` feature。细节见 ADR-041 / ADR-051 / ADR-053。
- **已知行为**：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问需替换为实际 IP / 域名，且证书 SAN 必须匹配。这是显示层行为，不改变监听/鉴权。

<a id="remote"></a>

### 远程控制面
**远程客户端（CLI / TUI / headless）**

> 决策见 ADR-051 / ADR-052 / ADR-053。

- `--connect` / `VESSEL_CONNECT` 指向 gateway origin；非回环强制 HTTPS，token 缺失在发起网络请求前失败。
- WS 首帧 `auth` 带 token + `since`；解析 `hello` / `event` / `ping`（未知 kind 静默忽略），`ping` → `pong`，`hello.latest_seq < lastSeq` 从 0 重新对齐；退避 1s → 30s + jitter，10s hello 超时。
- `health.get` 返回远端 `node_id`；CLI 在 stderr（headless）或 TUI 状态行展示；TUI 不污染 stdout。
- connect 模式不获取本地 data-dir 写意图锁、不写本地 store / trace；交互回路由事件流转为 `permission.respond` / `ask.respond` RPC。
- **远程舰队停**：`vessel stop --connect <url>` 只认显式 `--connect`（绝不读 `VESSEL_CONNECT` env）——registry 级清点 → 确认 → `/platform/rpc gateway.shutdown` → 轮询 health 至不可达；**远程不强杀**（生命周期强杀恒本机；本地停止缺省不限时 drain，语义见 [gateway-lifecycle](gateway-lifecycle.md)）。非回环三门控（`gateway.remote_shutdown` opt-in + 已配置共享密钥的 TLS 反代 + 平台 token）见 [GATEWAY](../operations/GATEWAY.md)。

**安全收紧**：durable 端点校验 `write`，按单 node（非 tenant）返回；事件回灌丢弃本机来源帧。

- `transport.kind` 只接受 `in-process`；`loopback` / `remote` / `transport.nodes[]` 都是显式 validation error。
- 跨节点能力只有 federation 平面（`POST /v1/federation/messages` / `team-info` / `pair`，见 [ADR-094](../adr/ADR-094-federation-team-to-team.md) 与 [federation-hub](federation-hub.md#auto-join)）；`--connect` 客户端连远端 gateway 的能力不变。