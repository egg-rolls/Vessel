---
title: Gateway / RPC / 远程约定
kind: advisory
triggers: [gateway, serve, rpc, remote, tls, origin, hub, attention, node, node_id, event stream, shutdown, permission, answer, interactions, only human, websocket, plugin http]
paths: [packages/serve/**, src/rpc/**]
applies_to: [N, M]
---

# Gateway / RPC / 远程约定

> 改 `packages/serve/**` / `src/rpc/**` 前读这一篇；远程与权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## RPC

- 0.49 G1/G3：`vessel gateway start` 同进程双监听——Platform Gateway（8642；`/platform/rpc` 只读 allowlist + 静态宿主）与 Node API（`serve.port`，缺省 8644；`/v1/rpc`、WS/SSE、插件）。平台侧不得 import `gateway/methods/**` 或 node runtime；node 不得 import `platform/**`；由 `check-deps` D7–D9 守。G3 起 platform 以独立子进程托管本地多 Node，`<dataDir>/nodes.json` 为注册表（`gateway nodes list|add|remove`），`node start --config` 可单独启动；`vessel node` 只操作 Node API，legacy `--serve` 保持单监听 8642。
- 新 RPC 方法进 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开，不要把方法表回灌 `gateway.ts`；新增 canonical 方法必须发 addendum 并同时写 `result_schema`，清单与冻结项见 [gateway-rpc.md](../architecture/gateway-rpc.md#rpc-methods)（ADR-059/066）。

<a id="legacy-transport"></a>

## 插件 HTTP / WS 扩展面（0.48 M1/M3/M4）

- **归属 / manifest**：插件 HTTP/WS 只注册在 **Node API 监听器**（`serve.port`；拆分模式缺省 8644，legacy `--serve` 仍 8642）。Platform Gateway 不承载、不反代插件路由，平台 `/plugins/*` 一律 404；插件 iframe 走 `nodeUrl`。`contributes.http[]` 的 `upgrade: "websocket"`（v1 唯一值）要求 `GET` 且非显式 `buffered`；`maxBodyBytes` / `maxResponseBytes` 对 WS 不适用。
- **限额**：`serve.pluginHttp.maxFrameBytes` 默认 1 MiB、`idleTimeoutMs` 30s；`maxConnections` 同时覆盖在途 HTTP 与 WS。每路由只能收紧；`timeoutMs` 只约束插件握手。校验在 `packages/config/src/validator.ts`，clamp 在 `plugin-host/http.ts`。
- **升级路径**：形态检查（400 `upgrade_required` / `upgrade_not_allowed`）→ auth / scope → `maxConnections` 预检（503 `busy`）→ `resolve()`（disabled 404 / unavailable 503）→ `srv.upgrade()`。Bun 1.3.9 实测允许 `await resolve()` 后再 upgrade（R6），不走「先升级再 resolve」降级。
- **桥接 / 帧 / close**：宿主作为 WS 客户端连回环 `ws://127.0.0.1:<port><path>`，只原样转发 text/binary（不做 JSON-RPC 转换、子协议或应用层 ping），剥离客户端 auth/cookie/`X-Vessel-*`/`X-Forwarded-*`/`Host` 握手头，只注入内部 token。超 `maxFrameBytes` → 1009，4 MiB 高水位（R7）→ 1013，idle → 1001；close code/reason 映射且幂等，reason 截断 123B；插件 unreachable/握手失败 → 客户端 1011。
- **生命周期 / 审计**：manager 登记 `pluginId → WS connections`；`deactivate` / `disable` / `reload` / `stopAll` 先关该插件全部客户端 WS（1001 `plugin_unavailable`）再 terminate，插件崩溃 → 1011 不自动重连。`plugin.http.request` / `.disconnect` 只进结构化 logger（不含 header/body/token/query），WS 计数器只进日志聚合，不新增 RPC / 事件常量。
- **回归**：M1 的 buffered / `stream`（含 SSE）语义不变；`responseMode: "stream"` 仍只受 idle timeout 约束。
- **effective registry / namespace（0.48 M4）**：路由表只收 enabled 插件；`builtin` 忽略 `expose`，外部插件只保留 `config.plugins[].expose.http` 列出的 route id。外部插件只允许 `/plugins/<own-id>/<segment...>`，其它 `/plugins/` 子路径仍是宿主保留；manifest + serve 双重校验。`match()` / `resolve()` 窄接口不变，catalog 的 `effectiveSurface` 与真实路由表同源。
- **冲突 / CLI**：单插件声明非法（path / 限额 / auth / 同插件重复）只排除该插件（`conflicts()` 中 `scope:"plugin"`）；effective 跨插件 shape 冲突 → 路由表为空（`scope:"surface"`，`httpSurfaceDisabled() === true`），未授权声明不参与。CLI 对 `source !== 'repo'` 的插件懒加载 config，只放行 `expose.cli` 中的 `path.join('.')`；未授权 / config 失败按未命中回落，`plugin.cli.invoke` 审计字段为 plugin / command / outcome / durationMs。

## legacy 传输面

- `transport.kind` 只剩 `in-process`；`loopback` / `remote` / `transport.nodes[]` 是显式 validation error；legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除，不得恢复。

## 远程安全

- 远程 opt-in / TLS / Origin 的规则见 AGENTS 硬安全规则；实现上 `serve.allowed_origins` 归一化为 `URL.origin`，HTTP 与 WS upgrade 共用同一判定。token 不进 WS URL / query；首帧 `auth` 5s 内未合法即关闭 4401；auth 不接受 `tenant_id`。
- `/v1/local/token` 是本机便利端点，不是远程能力：只对回环 socket + 回环 Host + 同源（或无 Origin）返回**显式 legacy gateway token**（`serve.token` / `token_env` / `VESSEL_GATEWAY_TOKEN`）；`serve.tokens`-only 与未配置均 404，不带 CORS 头、不暴露自动生成的临时 token、不写日志。证书 / Origin / 客户端步骤见 [REMOTE.md](../operations/REMOTE.md)，契约见 [gateway.md](../architecture/gateway.md#protocol)。

## Hub 控制面（独立服务）

- Hub 是独立前台进程 `vessel hub start`（`src/hub/**`）；gateway 不启动本地 hub。唯一方向 node → hub：节点出站拨号 `${hub.url}/v1/hub/node-control`，只监听回环；节点侧无 `/v1/hub/control` / `/v1/hub/pair`。保留 `vessel hub join-code` / `vessel hub join`、`POST /v1/hub/join`、`/v1/hub/directory`、`/v1/hub/events`；Hub 只存 node token 的 `sha256`，节点明文进 SecretStore（`hub.allow_file_secrets` 属节点侧）。
- `auth.exchange|revoke|tokens`、`hub pair` / `hub node add` / `hub token *` / `hub data-token`、`hub.autoStart` 与 `hub.direction: 'hub'` 已删除（只保留 `hub.direction: 'node'`）；ADR-093 的 hub → node 方向已移除，见 [ADR-093 0.49 Errata](../adr/ADR-093-hub-control-plane.md)。细节见 [federation-hub.md](../architecture/federation-hub.md)。

## 事件与权限应答

- `respondPermission` / `respondAsk` 只能发布到本 node 的单一运行时事件流；流不存在返回 `run_ended`，不得回退共享流或两边都发。权限记录持久化到 `<dataDir>/interactions-<id>.json`（`0600` + `atomicWrite`；`<id>` 是内部持久单 id，缺省 `default`，不是 wire 字段），pending 不 TTL 清扫、有界清理也不淘汰 pending；重复应答幂等 / `conflict` / `orphaned`（ADR-079 Addendum）。
- **挂起 ask 的自动续跑**：`suspended: true` 的 ask（headless / 超时挂起）被回答后，gateway 在该次应答落定后自己发起一次 `resume`——触发点只有 `pending → answered` 这一次迁移（重复应答 / 答案冲突不触发），前置是 checkpoint 仍 `interrupted` + 同 session + 无 live run + durable 可读。任何一条不成立都 fail-closed 成「只记录答案」，不报错、不回滚；答案仍由既有 `startResume` 以 `source=ask_resume` 的 user 消息注入（ADR-082 Errata 2026-11-11）。
- **async ask 的答案投放与它不共用那条路**：`mode: 'async'` 的 ask 没有可续跑的 checkpoint（提问的 run 早已正常收口），答案是**一条新 user 消息**：gateway 把注入的 `askAnswerDelivery`（装配层的 `AgentService.admit`）当作「人发了这句话」，进成员 inbox（`delivery: input`）并起一次新 run。投放**只有一个触发点**：交互注册表的 `pending → answered` 迁移（`onAsyncAskAnswered`）；`ask.respond` 的 handler 只 `awaitAsyncAskDelivery` 读结果填 `delivered`，**不得**自己再投一次。注册表那句「两条应答路径共用一个出口」要靠 `settleAnswer` 自己判「此刻是否仍 pending」才成立——RPC 应答 publish 到流上的回声是**同步**的，那一次才是真迁移。注意同一进程里可以并存两个 gateway 装配（bootstrap 的本地 dispatcher + `--serve` 的 gateway），两者共用一条 `runtimeEvents`、各注册一份监听，所以「同一 requestId 只投一次」钉在 gateway 的进程级单飞（`asyncAnswerDeliveries`，按流分表）；跨进程 / 跨重启则由 `answer.delivered_at` 兜底（内存一份，投放前再从文件重读一份）。`pending` 的 async ask 不随 run 终态 / 进程重启转 `orphaned`（否则人类再没有回答入口）。
- 事件面只有一条流（单公司；`TenantEventHub` 名称保留但不再按 tenant 分键）：不得重新引入 `sharedEvents`、tenant→shared 桥或多流；Hub（独立进程）不暴露 `publish`、不代理 / 不持久化消息正文、不存 pending（ADR-089）。跨节点去重键含 `node` / `incarnation` / `run_id`（缺失写 `-`），消息键含 `from`；代际变化或 seq 回退只清该来源节点（ADR-067）。

## 会话级上下文用量（0.52 addendum）

- **字段**：`sessions.get` 结果新增**可选** `context_usage: { used: number, max?: number, at?: number, source?: 'pressure'|'changed'|'estimated'|'prompt' }`（`result_schema` 里是非 required 的 `contextUsageSchema`）。`used` = 该会话最近一次真实用量；`max` = 上下文窗口（缺省=未知）；`at` = 那条事件的 `ts`；`source` = 这个数字取自哪条事件的哪个字段（自查用，UI 不消费）。**整字段缺省 = 没有可用数据**（新会话还没跑过），不是 `0`、不是 `null`。取值走新增的只读 `SessionEventLog.readTailMatches`：从文件尾首窗 64 KiB、按 64K→256K→1M→4M 扩窗回扫，命中最近一条带用量数字的事件即停；日志只追加，命中即最新；一次 miss（尾部 4 MiB 内确实没有用量事件）累计最多读 ≈5.3 MiB 后返回「不知道」，**不回退全量扫盘**。`sessions.get` 侧按 **session + 事件日志尾水位（`大小:mtime`）** 缓存（`packages/serve/src/gateway/methods/sessions.ts`）：水位不变 = 0 字节读盘（只一次 `stat`），水位变了才重读一次尾窗。
- **取哪条事件的哪个字段**：类型 → 字段映射与 live 注册表 `agents-registry.ingestContext` 同一套（`context.pressure.used` / `context.changed.token_count` / `llm.request.estimated_tokens` / `llm.response.usage.prompt_tokens`）。**同一 tier 内按新 → 旧选**，不做「类型优先级」跨新旧跳跃：`context.pressure` 只在 ≥90% 水位发、压缩后不重发，一条更老的 pressure（900K）会比它之后的 `estimated_tokens`（压缩后的 200K）大得多，按类型硬挑会把过期高水位当现值。tier 1 = 本地估算口径（pressure / changed / `llm.request.estimated_tokens`，后者在写盘副本里**就是** `workingContext.tokenCount`，与 `context.changed.token_count` 同一个数）；tier 2 = provider 报的 `prompt_tokens`（含 system / tools / 缓存，比估算略大几个 %，只作最后兜底）。 **为什么来源不是 `context.changed`、也不是内存值**：`context.changed` **不落盘**（`run-journal.ts` 的 `NON_PERSISTED_EVENT_TYPES`，ADR-098 C1），`context.pressure` 只在 ≥90% 水位才发 —— 真实事件日志里稳定存在的只有 `llm.request` / `llm.response` 两条（否则本字段对历史会话永远是空的）。而 `agents.tree` 的内存用量是**身体级**：进程重启 / rotate / 换 body 之后就空，历史会话永远没有环 —— 用量是**会话属性**，事件日志才是权威；Web 侧取值顺序是 **live 优先（`agents.tree`）、落盘兜底（本字段）**，两者都没有则不显示环（`apps/web/src/domains/chat/useChatTranscript.ts`）。
- **`max` 的来源与已知边界**：事实链是 `config.context.maxTokens`（缺省 `DEFAULT_CONFIG.context.maxTokens`）→ `workingContext.maxTokens`（runtime 算百分比的分母）→ `context.pressure.max`（同一份值的 live 镜像）。所以 `max` 优先取 `context.pressure.max`（事件里的真值），否则用装配层注入的同一个 `config.context.maxTokens`（**不是另编一个上限，也不是花钱预算**），都没有就不给 `max`（不画比例）。边界：provider 侧拿不到每个模型的真实上下文窗口，runtime 用配置值当分母，且配置是**全局一个值** —— 将来若按 agent / 模型配置不同窗口，历史会话的 `max` 可能落到全局值。

## 关闭与 gateway 生命周期

- 关闭顺序固定：`await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`；后两步 `{ drain: false }`，不二次 drain。中断 active run 用 `interrupt('shutdown'|'timeout'|'user')`，不得只 abort signal 丢原因；headless 不得提前 `process.exit` 跳过清理（ADR-070）。
- 运行态以 `<dataDir>/gateway.pid` 为唯一来源；`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行。`gateway.reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`，其余如实进 `requires_restart`（ADR-074/075）。

## 节点与 attention

- `node_id` 唯一来源是 `resolveNodeId()`：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 `0600` 原子写；不得由 hostname / IP 派生；损坏抛 `node_identity_corrupt`（ADR-091）。
- 远程 attention：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，peer token 不能用于 attention；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生。`ask_user` 在 gateway / serve 入口注册（默认无限等待）；headless / `--run` / 管道也注册，但无人可问时挂起 run（`ask.user.timeout`，checkpoint `interrupted`，退出码 3）而不是永久等待（ADR-082 Errata）。

## 指针

- [gateway.md](../architecture/gateway.md) · [gateway-rpc.md](../architecture/gateway-rpc.md) · [REMOTE.md](../operations/REMOTE.md) · [CONFIG.md](../operations/CONFIG.md)。
