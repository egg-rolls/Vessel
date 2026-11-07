---
title: Gateway / RPC / 远程约定
kind: advisory
triggers: [gateway, serve, rpc, remote, tls, origin, hub, tenant, attention, node_id, shutdown, permission, answer, interactions, tenant stream, only human, websocket, plugin http]
paths: [packages/serve/**, src/rpc/**]
applies_to: [N, M]
---

# Gateway / RPC / 远程约定

> 改 `packages/serve/**` / `src/rpc/**` 前读这一篇；远程与权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## RPC

- 0.49 G1：`vessel gateway start` 同进程双监听——Platform Gateway（8642；`/platform/rpc` 只读 allowlist + 静态宿主）与 Node API（`serve.port`，缺省 8644；`/v1/rpc`、WS/SSE、插件）。平台侧不得 import `gateway/methods/**` 或 node runtime；node 不得 import `platform/**`；由 `check-deps` D7–D9 守。`vessel node` 只操作 Node API；legacy `--serve` 保持单监听 8642。
- 新 RPC 方法进 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开，不要把方法表回灌 `gateway.ts`；新增 canonical 方法必须发 addendum 并同时写 `result_schema`，清单与冻结项见 [gateway-rpc.md](../architecture/gateway-rpc.md#rpc-methods)（ADR-059/066）。

<a id="legacy-transport"></a>

## 插件 HTTP / WS 扩展面（0.48 M1/M3/M4）

- **归属 / manifest**：插件 HTTP/WS 只注册在 **Node API 监听器**（`serve.port`；拆分模式缺省 8644，legacy `--serve` 仍 8642）。Platform Gateway 不承载、不反代插件路由，平台 `/plugins/*` 一律 404；插件 iframe 走 `nodeUrl`。`contributes.http[]` 的 `upgrade: "websocket"`（v1 唯一值）要求 `GET` 且非显式 `buffered`；`maxBodyBytes` / `maxResponseBytes` 对 WS 不适用。
- **限额**：`serve.pluginHttp.maxFrameBytes` 默认 1 MiB、`idleTimeoutMs` 30s；`maxConnections` 同时覆盖在途 HTTP 与 WS。每路由只能收紧；`timeoutMs` 只约束插件握手。校验在 `packages/config/src/validator.ts`，clamp 在 `plugin-host/http.ts`。
- **升级路径**：形态检查（400 `upgrade_required` / `upgrade_not_allowed`）→ auth / tenant / scope → `maxConnections` 预检（503 `busy`）→ `resolve()`（disabled 404 / unavailable 503）→ `srv.upgrade()`。Bun 1.3.9 实测允许 `await resolve()` 后再 upgrade（R6），不走「先升级再 resolve」降级。
- **桥接 / 帧 / close**：宿主作为 WS 客户端连回环 `ws://127.0.0.1:<port><path>`，只原样转发 text/binary（不做 JSON-RPC 转换、子协议或应用层 ping），剥离客户端 auth/cookie/`X-Vessel-*`/`X-Forwarded-*`/`Host` 握手头，只注入内部 token + tenant。超 `maxFrameBytes` → 1009，4 MiB 高水位（R7）→ 1013，idle → 1001；close code/reason 映射且幂等，reason 截断 123B；插件 unreachable/握手失败 → 客户端 1011。
- **生命周期 / 审计**：manager 登记 `pluginId → WS connections`；`deactivate` / `disable` / `reload` / `stopAll` 先关该插件全部客户端 WS（1001 `plugin_unavailable`）再 terminate，插件崩溃 → 1011 不自动重连。`plugin.http.request` / `.disconnect` 只进结构化 logger（不含 header/body/token/query），WS 计数器只进日志聚合，不新增 RPC / 事件常量。
- **回归**：M1 的 buffered / `stream`（含 SSE）语义不变；`responseMode: "stream"` 仍只受 idle timeout 约束。
- **effective registry / namespace（0.48 M4）**：路由表只收 enabled 插件；`builtin` 忽略 `expose`，外部插件只保留 `config.plugins[].expose.http` 列出的 route id。外部插件只允许 `/plugins/<own-id>/<segment...>`，其它 `/plugins/` 子路径仍是宿主保留；manifest + serve 双重校验。`match()` / `resolve()` 窄接口不变，catalog 的 `effectiveSurface` 与真实路由表同源。
- **冲突 / CLI**：单插件声明非法（path / 限额 / auth / 同插件重复）只排除该插件（`conflicts()` 中 `scope:"plugin"`）；effective 跨插件 shape 冲突 → 路由表为空（`scope:"surface"`，`httpSurfaceDisabled() === true`），未授权声明不参与。CLI 对 `source !== 'repo'` 的插件懒加载 config，只放行 `expose.cli` 中的 `path.join('.')`；未授权 / config 失败按未命中回落，`plugin.cli.invoke` 审计字段为 plugin / command / outcome / durationMs / tenant。

## legacy 传输面

- `transport.kind` 只剩 `in-process`；`loopback` / `remote` / `transport.nodes[]` 是显式 validation error；legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除，不得恢复。

## 远程安全

- 远程 opt-in / TLS / Origin 的规则见 AGENTS 硬安全规则；实现上 `serve.allowed_origins` 归一化为 `URL.origin`，HTTP 与 WS upgrade 共用同一判定。token 不进 WS URL / query；首帧 `auth` 5s 内未合法即关闭 4401；非 admin 指定其它 tenant → 4403。
- `/v1/local/token` 是本机便利端点，不是远程能力：只对回环 socket + 回环 Host + 同源（或无 Origin）返回**显式 legacy gateway token**（`serve.token` / `token_env` / `VESSEL_GATEWAY_TOKEN`）；`serve.tokens`-only 与未配置均 404，不带 CORS 头、不暴露自动生成的临时 token、不写日志。证书 / Origin / 客户端步骤见 [REMOTE.md](../operations/REMOTE.md)，契约见 [gateway.md](../architecture/gateway.md#protocol)。

## Hub 控制面（独立服务）

- Hub 是独立前台进程 `vessel hub start`（`src/hub/**`）；gateway 不启动本地 hub。唯一方向 node → hub：节点出站拨号 `${hub.url}/v1/hub/node-control`，只监听回环；节点侧无 `/v1/hub/control` / `/v1/hub/pair`。保留 `vessel hub join-code` / `vessel hub join`、`POST /v1/hub/join`、`/v1/hub/directory`、`/v1/hub/events`；Hub 只存 node token 的 `sha256`，节点明文进 SecretStore（`hub.allow_file_secrets` 属节点侧）。
- `auth.exchange|revoke|tokens`、`hub pair` / `hub node add` / `hub token *` / `hub data-token`、`hub.autoStart` 与 `hub.direction: 'hub'` 已删除（只保留 `hub.direction: 'node'`）；ADR-093 的 hub → node 方向已移除，errata 由 gov 后续。细节见 [federation-hub.md](../architecture/federation-hub.md)。

## tenant 事件与权限应答

- `respondPermission` / `respondAsk` 只能发布到该 tenant 的运行时事件流；流不存在返回 `run_ended`，不得回退共享流或两边都发。权限记录持久化到 `interactions-<tenant>.json`（`0600` + `atomicWrite`），pending 不 TTL 清扫、有界清理也不淘汰 pending；重复应答幂等 / `conflict` / `orphaned`（ADR-079 Addendum）。
- `TenantEventHub` 是唯一事件面：不得重新引入 `sharedEvents`、tenant→shared 桥或单流 `GatewayOptions.events`；Hub（独立进程）不暴露 `publish`、不代理 / 不持久化消息正文、不存 pending（ADR-089）。跨节点去重键含 `node` / `incarnation` / `run_id`（缺失写 `-`），消息键含 `from` + gateway `tenant`；代际变化或 seq 回退只清该来源节点（ADR-067）。

## 关闭与 gateway 生命周期

- 关闭顺序固定：`await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`；后两步 `{ drain: false }`，不二次 drain。中断 active run 用 `interrupt('shutdown'|'timeout'|'user')`，不得只 abort signal 丢原因；headless 不得提前 `process.exit` 跳过清理（ADR-070）。
- 运行态以 `<dataDir>/gateway.pid` 为唯一来源；`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行。`gateway.reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`，其余如实进 `requires_restart`（ADR-074/075）。

## 节点与 attention

- `node_id` 唯一来源是 `resolveNodeId()`：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 `0600` 原子写；不得由 hostname / IP 派生；损坏抛 `node_identity_corrupt`（ADR-091）。
- 远程 attention：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，peer token 不能用于 attention；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生。`ask_user` 在 gateway / serve 入口注册（`--run` / headless / 管道不注册）。

## T1 单公司兼容期（tenant 行为收敛）

- 数据面忽略 `tenant_id`：`resolveTenantScope` 一律返回 `<单 id>`；缺失或 legacy id 不返回 `forbidden`（不等于单 id 时写一次 warning），格式非法仍 `invalid_params`，`all_tenants` 接受但无效果。
- token / principal 继续接受旧 `tenantId` 与 wildcard admin；principal 统一 `<单 id>`、role 不变，per-tenant 回调只可能收到 `<单 id>`（非单 id 分支保留但不可达）。
- 事件面只注册 `<单 id>` 一条流、读取不按 `tenant_id` 过滤；事件 DTO 与持久化记录仍保留 `tenant_id`（T5 才删）。管理面 `tenants.*` 收敛单 id，`create` 返回 `forbidden`。
- 0.49 T2：serve 仍不持有/透传 tenantPaths（`packages/serve/src` 0 引用）；单 id 根布局由 asm 注入，`interactions-<id>.json` 仍 root-keyed（defer-T4）。

## 指针

- [gateway.md](../architecture/gateway.md) · [gateway-rpc.md](../architecture/gateway-rpc.md) · [REMOTE.md](../operations/REMOTE.md) · [CONFIG.md](../operations/CONFIG.md)。
