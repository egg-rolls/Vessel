---
title: Gateway 协议与远程
kind: current
triggers: [gateway, websocket, sse, tls, origin, csp, cors, remote, protocol, endpoint]
paths: [packages/serve/src/**, packages/serve/src/gateway/**, src/serve-auth.ts, src/rpc/**]
---

# Gateway 协议与远程

<a id="protocol"></a>

`packages/serve` 是 **EventStream 的消费者**（与 TUI 的 StreamRenderer 同构）：把 runtime 事件广播为 WS / SSE，并提供 `/v1` 控制端点；**不改 core、不经过 PluginHost**。gateway 只读取注入的 `TenantEventHub`，由 hub 对各 tenant 的运行时流 fan-in（ADR-089）。`apps/web` 是配套的浏览器控制台。

### 协议 `vessel.gateway/1`

- 服务端帧：`hello`（协议/节点信息 + `from_seq` / `latest_seq`）、`event`（带 `seq`、可选 `job_id` 与 `node_id`）、`gap`（历史被截断）、`res`（方法应答）、`ping`。
- `hello.from_seq` 是本次回放的**第一条** seq：空缓冲为 `0`；已追平时为 `since + 1`（下一条期望序号）。`latest_seq` 是当前最新 seq（空缓冲为 `0`）。
- 客户端帧：`auth`（首帧，`{ kind: 'auth', token, since?, tenant_id? }`）、`req`（`id` + `method` + `params`）、`pong`。
- **首帧鉴权**：token 不进 WS URL / query；连接后 5s 内未收到合法 `auth` → 关闭码 4401。admin 可在 `auth` 指定 `tenant_id`；非 admin 指定其它 tenant → 4403。
- `seq` 由 gateway 分配；环形缓冲默认保留 10000 条。客户端记录 `lastSeq`，重连用 `?since=` 或 `auth.since` 续订；超出缓冲发 `gap`。
- **since / pong / seq 回退**：客户端收到 `ping` 回 `pong`；收到 `gap` 用 `to_seq` 触发带 `since` 的重连；`hello.latest_seq < lastSeq` 时从 `since=0` 重新对齐。重连指数退避 1s → 30s 加 jitter；10s 未收到 `hello` 视为失败并重连；`close()` 清理全部定时器。
- **跨节点事件**：`event.node_id` 优先于顶层 `node_id`；远端事件由 `(node_id, wire seq)` 去重后回灌。wire seq 按各节点 / 连接分配，**没有全局序**。
- `RunStatus.run_id` 是网关级 id；`core_run_id` 在 `run.started` 后可知；事件帧的 `job_id` 用于把 core run 与网关 run 对齐。

<a id="endpoints"></a>

### 端点

| 方法 / 路径 | 说明 |
|---|---|
| `GET /v1/health`（`/health` 兼容） | 开放探针；返回 clients / latest_seq / protocol / node |
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
| `GET /v1/durable/runs?status=&session_id=&limit=` | durable run 摘要列表；`status` 支持逗号分隔，缺省全部；默认 50、最大 200（0.3） |
| `POST /v1/durable/runs/:runId/resume` | 202 `{run_id, status:'queued'}`；未启用/不支持 resume → `durable_disabled`（0.3） |
| `GET /v1/mcp/servers` | `{servers:[{name,status,tools,error?}]}`；未注入 → `mcp_disabled`（0.3） |
| `GET /v1/metrics` | `{metrics: MetricsSnapshot}`；未注入 → `metrics_disabled`（0.4） |
| `GET /v1/channels/feishu` | `{channel: FeishuStatus}`；未注入 → `channel_disabled`（0.4） |
| `GET /v1/evals/latest?suite=` | `{report: EvalReport}`；无报告 → 404 `eval_not_found`（0.4） |
| `POST /run` | 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 返回 `method_not_allowed`（legacy 草案保留在 `protocol.ts`）；跨节点 team 平面已删除。

稳定错误码（additive）：`run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled` / `metrics_disabled` / `channel_disabled` / `eval_not_found`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls` / `evals` / `feishu` / `metrics`。HTTP 映射：404 `*_not_found`；503 `*_disabled`；400 `invalid_request`。

<a id="static-hosting"></a>

### 静态托管与安全

- `staticDir` 存在时，GET/HEAD 的非 API 路径托管 `apps/web/dist`；无扩展名路径回落 `index.html`（SPA）；路径解析后校验 root 前缀，防穿越；API 路径永不托管。
- 默认绑定 `127.0.0.1`；Host 只接受 `127.0.0.1` / `localhost` / `[::1]` 或显式 `hostname`。
- **Origin allowlist**：`serve.allowed_origins` / `--allowed-origin` 在启动时归一化为 `URL.origin`，拒绝 `*`、path、query；HTTP 与 WS upgrade 共用同一判定，无 Origin 放行（curl / peer），浏览器必须同源或在 allowlist。
- **CORS**：预检命中 allowlist 返回 204，只回 `Access-Control-Allow-Origin` / `Methods` / `Headers` / `Max-Age`；永不使用 `*`，不使用 credentials。allowlist 非空时所有响应带 `Vary: Origin`。
- **CSP**：移除裸 `ws:` / `wss:`；`connect-src` 由 Host 与 allowlist 动态生成，其余策略保持 `script-src 'self'`。独立静态站点自行下发 CSP。
- token 来源优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。生成值 32B 随机 base64url，恒定时间比较；WS 5s 未鉴权关闭 4401。
- 事件流是长连接：`Bun.serve` 的 `idleTimeout` 默认 `0`（禁用，可用 `GatewayOptions.idleTimeout` 覆盖）；heartbeat 默认 15s，SSE 发 `: ping` 注释、WS 发 `ping` 帧，用于穿透代理与检测死客户端。
- 请求体上限 1 MiB（RPC / legacy REST / 跨节点消息端点一致）；慢客户端 `bufferedAmount > 4 MiB` 断开（1013）。
- **背压**：gateway `SeqEventBuffer` 缺省 10000，**永不无界**，与 core `observability.event_history` 的 `0 = unlimited` 语义独立、不被覆盖。WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；超过阈值先丢事件并标记 `gap`，4 MiB 硬断开作为最后手段。gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。

<a id="tls"></a>

### 远程监听与 TLS

- **默认不变**：`127.0.0.1:8642`、明文、token 来源优先级不变。
- **远程 opt-in**：`serve.allow_remote: true` 或 `--allow-remote`；非回环 hostname 未显式允许时启动失败。
- **远程必须 token**：非回环必须有非空 gateway token（配置 / `VESSEL_GATEWAY_TOKEN` / 自动生成）；不得匿名。
- **远程必须 TLS**：非回环监听必须同时提供 `serve.tls.cert_file` + `key_file`（或 `--tls-cert` / `--tls-key`），否则启动失败；不再允许明文远程。回环仍可在无 TLS 下运行，也可显式启 TLS。
- **无逃生口**：不提供 `--insecure` / `-k`；证书、token、Origin 任一不满足即 fail-closed，不静默降级。
- **独立前端 Origin**：`serve.allowed_origins` 或重复 `--allowed-origin`；与 HTTP / WS 共用 allowlist，规则见 [静态托管与安全](#static-hosting)。
- **只做 HTTP/1.1**：不做 HTTP/2 / ALPN / mTLS / ACME；HTTPS 与 WSS 共用同一 server、token、Host/Origin 规则。
- `hello.features` 在启用 TLS 时增加 `tls`；不新增 `remote` feature。细节见 ADR-041 / ADR-051 / ADR-053。
- **已知行为**：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问需替换为实际 IP / 域名，且证书 SAN 必须匹配。这是显示层行为，不改变监听/鉴权。

<a id="remote"></a>

### 远程控制面

**远程客户端（CLI / TUI / headless）**

> 决策见 ADR-051 / ADR-052 / ADR-053。

- `--connect` / `VESSEL_CONNECT` 指向 gateway origin；非回环强制 HTTPS，token 缺失在发起网络请求前失败。
- WS 首帧 `auth` 带 token + `since`；解析 `hello` / `event` / `gap` / `ping`，`ping` → `pong`，`gap.to_seq` 触发 `since` 重连，`hello.latest_seq < lastSeq` 从 0 重新对齐；退避 1s → 30s + jitter，10s hello 超时。
- `health.get` 返回远端 `tenant_id` / `node_id`；CLI 在 stderr（headless）或 TUI 状态行展示；TUI 不污染 stdout。
- connect 模式不获取本地 tenant 写锁、不写本地 store / trace；交互回路由事件流转为 `permission.respond` / `ask.respond` RPC。

**安全收紧**：durable 端点按 principal 的 tenant 过滤并校验 `write`；事件回灌丢弃本机来源帧。见 `docs/versions/0.6.1.md`。

- `transport.kind` 只接受 `in-process`；`loopback` / `remote` / `transport.nodes[]` 都是显式 validation error。
- 跨节点能力只有 federation 平面（`POST /v1/federation/messages`，见 `docs/versions/0.20.0.md` 与 [ADR-094](../adr/ADR-094-federation-team-to-team.md)）；`--connect` 客户端连远端 gateway 的能力不变。

