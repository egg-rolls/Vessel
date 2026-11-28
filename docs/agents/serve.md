---
title: Gateway / RPC / 远程约定
kind: advisory
triggers: [gateway, serve, rpc, remote, tls, origin, hub, attention, node, node_id, event stream, shutdown, permission, answer, interactions, only human, websocket, plugin http, 网关, 服务, 远程, 权限应答, 事件流, 关闭, 节点, 交互]
paths: [packages/serve/src/gateway.ts, packages/serve/src/rpc.ts, packages/serve/src/gateway/methods/sessions.ts, packages/serve/src/plugin-host/http.ts, packages/serve/src/plugin-host/ws-proxy.ts, packages/serve/src/plugin-host/manager.ts, packages/serve/src/interactions-registry.ts, packages/serve/src/shutdown-step.ts, src/rpc/types.ts, src/rpc/http-client.ts, src/session/context-usage.ts, src/gateway/stop-drain.ts, src/gateway/reload.ts, src/node/node-identity.ts]
applies_to: [N, M]
---

# Gateway / RPC / 远程约定

> 改 `packages/serve` / `src/rpc` 前读这一篇；远程与权限硬规则仍以 [AGENTS.md](../../AGENTS.md) 为准。指针：[gateway.md](../architecture/gateway.md) · [gateway-rpc.md](../architecture/gateway-rpc.md) · [REMOTE.md](../operations/REMOTE.md) · [CONFIG.md](../operations/CONFIG.md)。

## RPC

- 拓扑：`vessel gateway start` 只跑平台进程（8642；`/platform/rpc` 只读 allowlist + 静态宿主）+ 每节点子进程监督；Node API（`node.port`，拆分缺省 8644；`/v1/rpc`、WS/SSE、插件）在独立子进程，注册于 `<dataDir>/nodes.json`。平台不得 import `gateway/methods/**` 或 node runtime，node 不得 import `platform/**`（评审人工核对依赖方向）。legacy `vessel --serve` / `VESSEL_LEGACY_SERVE=1` 保持单监听 8642。现态见 [gateway.md](../architecture/gateway.md)。
- 新 RPC 方法进 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开，不要把方法表回灌 `gateway.ts`；新增 canonical 方法必须发 addendum 并同时写 `result_schema`（ADR-059/066），清单与冻结项见 [gateway-rpc.md](../architecture/gateway-rpc.md#rpc-methods)。
- 错误码单源（gw-F2）：`src/rpc/types.ts` 的 `RPC_ERROR_CODE_LIST` 同时派生联合类型与 `isRpcResponse` 白名单，serve 侧 `rpc.ts` / `protocol.ts` 逐字同步；新增错误码只改清单，不手抄第二份码表。
- legacy 传输面：`transport.kind` 只剩 `in-process`；`loopback` / `remote` / `transport.nodes[]` 是显式 validation error；legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除，不得恢复。

## 插件 HTTP / WS 扩展面

- **归属**：插件 HTTP/WS 只注册在 Node API 监听器；平台不承载、不反代插件路由，`/plugins/*` 一律 404；插件 iframe 走 `nodeUrl`。`upgrade: "websocket"`（v1 唯一值）要求 `GET` 且非显式 `buffered`；`maxBodyBytes` / `maxResponseBytes` 对 WS 不适用。
- **限额**：`node.pluginHttp.maxFrameBytes` 缺省 1 MiB、`idleTimeoutMs` 30s；`maxConnections` 同时覆盖在途 HTTP 与 WS；每路由只能收紧；`timeoutMs` 只约束插件握手。校验在 `packages/config/src/validator.ts`，clamp 在 `plugin-host/http.ts`。
- **升级路径**：形态检查（400 `upgrade_required` / `upgrade_not_allowed`）→ auth/scope → `maxConnections` 预检（503 `busy`）→ `resolve()`（disabled 404 / unavailable 503）→ `srv.upgrade()`；Bun 1.3.9 允许 `await resolve()` 后再 upgrade，不走「先升级再 resolve」降级。
- **桥接 / 帧 / close**：宿主作为 WS 客户端连回环，只原样转发 text/binary（不做 JSON-RPC 转换、子协议或应用层 ping），剥离客户端 auth/cookie/`X-Vessel-*`/`X-Forwarded-*`/`Host` 握手头，只注入内部 token。超 `maxFrameBytes` → 1009，4 MiB 高水位 → 1013，idle → 1001；close code/reason 映射幂等，reason 截断 123B；插件 unreachable/握手失败 → 1011。
- **生命周期 / 审计**：`deactivate` / `disable` / `reload` / `stopAll` 先关该插件全部客户端 WS（1001 `plugin_unavailable`）再 terminate；插件崩溃 → 1011 不自动重连。`plugin.http.request` / `.disconnect` 只进结构化 logger（不含 header/body/token/query），WS 计数器只进日志聚合，不新增 RPC/事件常量。buffered / `stream`（含 SSE）语义不变，`stream` 仍只受 idle timeout 约束。
- **effective registry / 冲突**：路由表只收 enabled 插件；`builtin` 忽略 `expose`，外部插件只保留 `config.plugins[].expose.http` 列出的 route id，且只允许 `/plugins/<own-id>/<segment...>`（其它 `/plugins/` 子路径宿主保留）；manifest + serve 双重校验，catalog `effectiveSurface` 与路由表同源。单插件声明非法只排除该插件（`scope:"plugin"`）；跨插件 shape 冲突 → 路由表为空（`scope:"surface"`，`httpSurfaceDisabled()`）。CLI 对 `source !== 'repo'` 懒加载 config 只放行 `expose.cli`；`plugin.cli.invoke` 审计 plugin/command/outcome/durationMs。

## 远程安全

- 远程 opt-in / TLS / Origin 硬规则见 AGENTS；实现上 `node.allowed_origins` 归一化为 `URL.origin`，HTTP 与 WS upgrade 共用同一判定。token 不进 WS URL / query；首帧 `auth` 5s 内未合法即关闭 4401；auth 不接受 `tenant_id`。反代共享密钥（`node.proxy_secret_env` / `gateway.proxy_secret_env`）语义见 [REVERSE-PROXY.md](../operations/REVERSE-PROXY.md)。
- `/v1/local/token` 是本机便利端点，不是远程能力：只对回环 socket + 回环 Host + 同源（或无 Origin）返回**显式 legacy gateway token**（`node.token` / `node.token_env` / `VESSEL_GATEWAY_TOKEN`）；`node.tokens`-only 与未配置均 404，不带 CORS 头、不暴露自动生成的临时 token、不写日志。证书 / Origin / 客户端步骤见 [REMOTE.md](../operations/REMOTE.md)。

## Hub 控制面

- Hub 是独立进程 `vessel hub start`；`gateway start` 缺省自动拉起本地 hub 子进程（`hub.auto_start` 缺省 true；`direction: 'node'` 不启动；已有活实例 adopt；stop 只停本次 spawn 的 hub）。唯一方向 node → hub 出站拨号，只监听回环；hub → node 方向与 `auth.exchange|revoke|tokens`、`hub pair` / `hub node add` / `hub token *` / `hub data-token` 已删除。Hub 只存 node token 的 `sha256`，节点明文进 SecretStore。细节与硬规则见 [federation-hub.md](../architecture/federation-hub.md)。

## 事件与权限应答

- `respondPermission` / `respondAsk` 只能发布到本 node 的单一运行时事件流；流不存在返回 `run_ended`，不得回退共享流或两边都发。权限记录持久化到 `<dataDir>/interactions-<id>.json`（`0600` + `atomicWrite`，50ms trailing debounce 合并写；`<id>` 是内部持久单 id，不是 wire 字段）；pending 不 TTL 清扫、有界清理不淘汰 pending；重复应答幂等 / `conflict` / `orphaned`；`tool.permission.expired` 事件把 pending permission 收口 `orphaned`（ADR-079 Addendum）。
- **挂起 ask 自动续跑**：`suspended: true` 的 ask 被回答后 gateway 自发起一次 `resume`——触发点只有 `pending → answered` 这一次迁移，前置是 checkpoint 仍 `interrupted` + 同 session + 无 live run + durable 可读；任一不成立 fail-closed 成「只记录答案」，不报错不回滚（ADR-082 Errata）。
- **async ask 的答案是新 user 消息**：进提问成员 inbox（`askAnswerDelivery` = `AgentService.admit`）并起新 run，不续跑旧 run。唯一触发点 = 注册表 `pending → answered`（`onAsyncAskAnswered`）；`ask.respond` handler 只 `awaitAsyncAskDelivery` 填 `delivered`，不得自投。同进程多 gateway 装配共用一条 `runtimeEvents`，「同一 requestId 只投一次」钉在进程级单飞（`asyncAnswerDeliveries` 按流分表）；跨进程/重启由 `answer.delivered_at` 兜底（内存 + 投放前重读文件）。pending 的 async ask 不随 run 终态/重启转 `orphaned`。
- 事件面只有一条流（单公司；`TenantEventHub` 名称保留但不再按 tenant 分键）：不得重新引入 `sharedEvents`、tenant→shared 桥或多流；Hub 不暴露 `publish`、不代理/不持久化消息正文、不存 pending（ADR-089）。跨节点去重键含 `node` / `incarnation` / `run_id`（缺失写 `-`），消息键含 `from`；代际变化或 seq 回退只清该来源节点（ADR-067）。

## 会话级派生值（`context_usage` / `system_context`）

- `sessions.get` 可选 `context_usage: { used, max?, at?, source? }` 与 `system_context: { hash, system_prompt?, self_card?, model?, message_count?, tools_count?, estimated_tokens?, context_max?, at?, run_id? }`：从会话事件日志**尾窗**派生（`SessionEventLog.readTailMatches`，64 KiB 起按 64K→256K→1M→4M 扩窗，命中即停，miss 不回退全量扫盘），按 session + 尾水位（`大小:mtime`）缓存（`methods/sessions.ts`）；**整字段缺省 = 没有可用数据**，不是 `0`/`null`。`system_context` 取尾窗最近一条 `prompt.system_context`（装配 `src/session/system-context.ts`），是重启/回放淘汰后会话页「模型上下文」卡的唯一来源（[events.md](../architecture/events.md#事件回放)）。
- 取数口径（`src/session/context-usage.ts`）：类型→字段映射与 `agents-registry.ingestContext` 同一套；**同一 tier 内新→旧**，不做类型优先级跨新旧跳跃。tier 1 本地估算：`context.pressure.used` / `context.changed.token_count` / `llm.request.estimated_tokens` 三者同源请求视图估算（`correctedContextTokens`，锚点校正 + provider 地板）；pressure ≥50% 预警线每 run 一次 + 闸拒发，`context.changed` 不落盘。tier 2 provider `prompt_tokens` 只作兜底。`max` 三级：命中事件 `pressure.max` > `llm.request.data.context_max` > 装配注入 `config.context.maxTokens`（仅旧日志兼容）；都没有不给 `max`。Web 取值 live 优先（`agents.tree`）、落盘兜底，两者皆无不显示环。

## 关闭与 gateway 生命周期

- 关闭顺序固定：`await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`；后两步 `{ drain: false }`，不二次 drain。中断 active run 用 `interrupt('shutdown'|'timeout'|'user')`，不得只 abort signal 丢原因；headless 不得提前 `process.exit` 跳过清理（ADR-070）。退出链每步经 `shutdown-step.ts` 打 `node.shutdown.step`（start/done/timeout_bounded/failed；挂起时最后一条 start 即挂点）；退出路径等待一律有界（如 `server.stop` 5s race），到点 best-effort 推进，残余句柄随 `process.exit` 终止。
- **停止侧 graceful-first**：`node stop` / `gateway stop` 先经 Node API `gateway.shutdown`（admin）请进程自跑 `shutdownServeStack`。**候 run 段默认不限时**（用户裁定 #5）：每 5s 采样 live run 渲染进度；显式 `--timeout` 到点**不自动强杀**，如实报告阻塞者。quiesce **阳性证据**（SD-4）= 采样成功 0 live run，或专属连接拒绝（`isRpcConnectionRefused`；401/超时/其它失败不算）；证据持续满 30s（`POST_QUIESCE_EXIT_TIMEOUT_MS`）进程仍活 → force 兜底 + `stop.forced` 审计（此时已无 live run，`runs_cut` 恒 0）；drain 未成的强杀回退代打 `node.drain.skipped`。契约见 [gateway-rpc.md](../architecture/gateway-rpc.md#rpc-methods) 的 `gateway.shutdown` addendum。headless 退出不打 resume 标记；启动恢复清理「no_member + 已完成」僵尸标记（单写口）。
- 运行态以 `<dataDir>/gateway.pid` 为唯一来源；`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行。`gateway.reload` 热更新 plugins 扫描缓存、`node.allowed_origins`、permission / tools / mcp / log（注入 applier）、`provider.model`（节点缺省模型：新 body / 新 EU 立即用新值，live body 下一具才生效）与 federation / kanban / autoPrune 块（注入 applier）；其余配置域（含 `agent.model`）如实进 `requires_restart`（ADR-074/075）。

## 节点与 attention

- `node_id` 唯一来源是 `resolveNodeId()`（`src/node/node-identity.ts`）：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 `0600` 原子写；不得由 hostname / IP 派生；损坏抛 `node_identity_corrupt`（ADR-091）。
- 远程 attention：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，peer token 不能用于 attention；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生。`ask` 在 gateway / serve 入口注册（默认无限等待）；headless / `--run` / 管道也注册，但无人可问时挂起 run（`ask.user.timeout`，checkpoint `interrupted`，退出码 3）而不是永久等待（ADR-082 Errata）。