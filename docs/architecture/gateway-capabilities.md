---
title: Gateway 能力矩阵与职责归属
kind: current
triggers: [gateway capability, gateway lifecycle, tls termination, node ticket, origin allowlist, rate limit, audit, metrics, health probe, circuit breaker, adopt, version gate, node registry, routing, standby, 网关能力, 生命周期, 证书, 票据, 限流, 审计, 指标, 健康检查, 熔断, 路由]
paths: [packages/serve/src/platform/**, src/cli/commands/gateway/gateway-command.ts, src/gateway/**, docs/architecture/gateway-capabilities.md]
---

# Gateway 能力矩阵

定位与边界以 [ADR-103](../adr/ADR-103-gateway-responsibilities.md) 为准：8642 是基础设施进程，
不是大脑。它**不**持有 run 状态、**不**拥有会话数据、**不**做调度；node 数据面**默认由平台代理**
（透传 + 白名单，不解析会话内容，node token 不出网关；现态见 [topology](topology.md)）。本文只
登记「哪些能力归它、现在到什么程度、怎样算做完」。

现状三值：**有** = 已实现且有测试；**半** = 有实现但缺关键一侧或只管本机；**无** = 没代码。

## A 组 · 生命周期

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 进程列目录 | 半 | `node-supervisor.ts`、`gateway-command.ts:localNodeStatusViews` | `gateway status --json` 的 `nodes[]` 每项含 node_id/name/api_url/status（up/down/unknown）/auto_start（`LocalNodeStatusView`），缺一枚举失败 |
| 启停 node/hub | 有 | `gateway-command.ts:runGatewayCommand` | 同 `dataDir` 第二次 `start` 以 `instance_locked` 退出，且不 kill 已在跑的子进程 |
| 平台重启/handoff | 有 | `gateway-command.ts:runGatewayCommand`、`handoff.ts:HANDOFF_MARKER_TTL_MS` | restart 后 node/hub 的 pid 不变；marker 过期 120s 后新进程拒绝 adopt |
| 健康探测 | 半 | `node-supervisor.ts:probeNodeHealth`（`HEALTH_TIMEOUT_MS`） | 单次探测硬上限 1000ms；超时不得阻塞 `/platform/rpc` 超过 1.5s |
| 熔断 | 无 | — | 连续 3 次探测失败后 30s 内不再探测，`nodes.list` 返回 `down`+`probe_failed`，窗口内 RPC p95 <50ms |
| 孤儿收养 | 半 | `gateway-command.ts:adoptNodeTarget` | `kill -9` 平台后重启：不重复 spawn、端口不冲突、启动输出/日志出现 `(adopted)`（`status --json` **不**含该字段，契约面不加 adopted） |
| 版本闸门 | 无 | 仅外部插件有 `engines.vessel` 范围检查（`src/plugin/plugin-manifest.ts`） | 条目缺 `protocol` 或低于 MIN 时 `gateway start` 输出 `node_unsupported_version` 并给出理由、不 spawn 该 node |
| 单写者 | 有 | `gateway-command.ts:runGatewayCommand` | 同 `dataDir` 并发 `start` 只允许一个成功，另一个非零退出且不改动 `nodes.json` |
| 优雅停止（drain） | 有 | `gateway-command.ts:stopGateway`、`gateway/reload.ts:shutdownGateway`、`gateway/stop-drain.ts:waitForProcessExit`、`node-command.ts:runNodeCommand` | 停止先经 `gateway.shutdown` 请进程内 drain；**候 run 段缺省不限时**（每 5s 采样 live run 渲染进度），显式 `--timeout` 到点不自动强杀；quiesce 阳性证据（采样 0 live run 或专属连接拒绝，SD-4）持续满 30s 进程仍活 → force 兜底 + `stop.forced` 审计；drain 未成的强杀回退代打 `node.drain.skipped` / `platform.drain.skipped`。语义见 [gateway-lifecycle](gateway-lifecycle.md) / [GATEWAY](../operations/GATEWAY.md) |
| 舰队级停（`vessel stop`） | 有 | `src/cli/commands/fleet/stop-command.ts:stopFleetCommand` | 本地清点 + 确认后走 `stopGateway({keepNodes:false})`（缺省不限时 drain，`--force` 递归传播 = 非正常退出 + 审计）；远程只认显式 `--connect`，经 `/platform/rpc`，非回环须过三门控（`gateway.remote_shutdown` + 已配置密钥反代 + 平台 token），远程不强杀 |

## B 组 · 对外暴露

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 静态资源 | 有 | `platform/server.ts`（静态托管分支） | 未命中静态文件时落 `index.html`，且不返回 8642 之外的路径穿越 |
| 鉴权（平台 token） | 半 | `platform/auth.ts:resolvePlatformAuth` | 配置 token 后无 token 请求一律 401；未配置时仅回环放行 |
| WebUI 登录（`/auth/*`） | 有 | `platform/server.ts`（`authService.handle` 在鉴权闸之前）、`serve/src/auth/` | 配 `auth.backends` 后数据面请求须带会话，变更类须带 `X-Vessel-CSRF`（值取自 `GET /auth/status`）；未配置时退回 token / 回环形态 |
| node 数据面代理（`/nodes/*`） | 有 | `platform/proxy.ts:PlatformProxy`、`proxy-ws.ts`、`proxy-config.ts` | 默认 ON（`gateway.proxyNodes !== false`）；路径/方法/RPC 命名空间白名单 fail-closed，`/v1/local/**` 永远拒绝；浏览器拿不到 node token；WS 每次关闭恰一条 `gateway.ws.closed {via:'proxy'}`；server-initiated 关闭优先 `terminate()`（DR15-2，防 CLOSING 残留卡死 stop）。现态见 [topology](topology.md) |
| Origin 白名单 | 有 | `platform/server.ts`（Origin 判定分支） | 非白名单 Origin 的 `/platform/rpc` 返回 403 |
| TLS 终止 | 无 | `platform/types.ts` 无 tls 字段 | `tls.enabled=false` 且 bind 非回环时拒绝启动（fail-closed） |
| 短时节点票据 | 无 | — | 浏览器响应体不含 token 原文；票据 TTL ≤60s，重放第二次返回 401 |
| 限流 | 无 | — | 单 IP 1 分钟内第 61 次 `/platform/rpc` 返回 429，第 60 次仍 200 |
| 审计 | 无 | — | 每次 RPC 追加一行 jsonl（method/ok/来源/假名化 token），文件按日切 |

## C 组 · 连接与发现

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 注册表权威源 | 有 | `node-registry.ts:writeNodeRegistry`（原子写、0600） | `nodes.json` 损坏时启动失败并给出可修复提示，绝不重写为空表 |
| 平台 RPC 视图 | 有 | `platform/rpc.ts:PLATFORM_RPC_METHODS` | 6 个方法集合冻结（5 个只读 `platform.*` + `gateway.shutdown` 唯一非只读，additive）；新增方法需改 ADR 而不是加分支 |
| 注册表热重载 | 无 | `gateway reload` 只跑 config / plugins scope，不重载 registry | 改 `nodes.json` 后 `gateway reload` 生效，`requires_restart` 列表里不再出现 nodes |
| 多节点路由查询 | 无 | — | 查询无副作用（探测计数不变），返回候选 + 排因，不替调用方选 |
| hub 配对 | 有 | `src/cli/commands/hub-command.ts`（pairing TTL / pairing id） | 出站必须显式 opt-in；配对 id 过期即失效，未配置不发起连接 |

## D 组 · 运维

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 节点日志落盘 | 有 | `node-supervisor.ts:nodeLogPath` | 每个 node 独立 `<dataDir>/logs/node-<name>.log`（0600；名字里的路径分隔符归一为 `_`） |
| 日志聚合 | 无 | — | `gateway logs --follow` 同时输出平台 + 全部 node，带 `node=<name>` 标签，端到端延迟 <1s |
| 指标 | 有 | `platform/metrics.ts:createPlatformMetrics`、`platform/server.ts`（`/metrics` 分支） | `GET /metrics` 以 Prometheus text format 输出 `vessel_gateway_info` / `vessel_process_uptime_seconds` / rss / heap + `vessel_proxy_http_*` / `vessel_proxy_ws_*`（role=platform）；回环匿名可读，远端须平台 token（Bearer）；scrape 时求值，**无周期资源日志行**（日志/指标分离，原 `gateway.resources` 定时行已删） |
| 升级编排 | 无 | — | 版本闸门失败时中止升级且旧进程 pid 不变；成功路径停机 ≤2.5s |
| 备份巡检 | 无 | — | 每日巡检 `nodes.json` 与配对凭据 mtime，>7 天未变或文件缺失即告警 |

## 不做时的替代方案

| 不做 | 替代 | 代价 |
| --- | --- | --- |
| 关代理（`gateway.proxyNodes: false` 显式回退） | 前端取 credentials 直连 node（老路径） | node token 交回浏览器，node 须浏览器可达（同机或内网），跨网要自己解决 |
| 不做调度 | 客户端拿 `nodes.list` 自行选择 | 选择逻辑分散在 UI/TUI 两处，需共享同一份排序约定 |
| 不持有 run 状态 | 状态归属 node，重启靠 S1 marker + 客户端重连 | 断线重连语义由客户端保证，gateway 无法代为「续」 |
| 不做 standby 轮换 | `restart` 走 handoff，预算 ≤2.5s | 每次重启仍有 0.2–0.6s 结构性不可达 |
| 不在 8642 落持久态 | 一律重建式（`lastSeen` 可丢） | 累计指标只能从 node 侧汇总 |

职责边界决策见 [ADR-103](../adr/ADR-103-gateway-responsibilities.md)；engine 池见 [ADR-106](../adr/ADR-106-engine-pool.md)；生命周期职责见 [gateway-lifecycle](gateway-lifecycle.md)。