---
title: Gateway 能力矩阵与职责归属
kind: current
triggers: [gateway capability, gateway lifecycle, tls termination, node ticket, origin allowlist, rate limit, audit, metrics, health probe, circuit breaker, adopt, version gate, node registry, routing, standby]
paths: [packages/serve/src/platform/**, src/gateway-command.ts, src/gateway/**, docs/architecture/gateway-capabilities.md]
---

# Gateway 能力矩阵

定位与边界以 [ADR-103](../adr/ADR-103-gateway-responsibilities.md) 为准：8642 是基础设施进程，
不是大脑。它**不**持有 run 状态、**不**拥有会话数据、**不**做调度、**不**反代会话数据。本文只
登记「哪些能力归它、现在到什么程度、怎样算做完」。

现状三值：**有** = 已实现且有测试；**半** = 有实现但缺关键一侧或只管本机；**无** = 没代码。

## A 组 · 生命周期

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 进程列目录 | 半 | `node-supervisor.ts`、`gateway-command.ts:519-605` | `gateway status --json` 的 `nodes[]` 每项含 state/pid/url/version（`gateway-command.ts:1098`、`:309-311`），缺一枚举失败 |
| 启停 node/hub | 有 | `gateway-command.ts:519-605` | 同 `dataDir` 第二次 `start` 以 `instance_locked` 退出，且不 kill 已在跑的子进程 |
| 平台重启/handoff | 有 | `gateway-command.ts:2323-2348`、`handoff.ts:1-18` | restart 后 node/hub 的 pid 不变；marker 过期 120s 后新进程拒绝 adopt（`handoff.ts:24`） |
| 健康探测 | 半 | `registry.ts:13`、`:80` | 单次探测硬上限 1000ms；超时不得阻塞 `/platform/rpc` 超过 1.5s |
| 熔断 | 无 | — | 连续 3 次探测失败后 30s 内不再探测，`nodes.list` 返回 `down`+`probe_failed`，窗口内 RPC p95 <50ms |
| 孤儿收养 | 半 | `gateway-command.ts:387-412` | `kill -9` 平台后重启：不重复 spawn、端口不冲突、启动输出/日志出现 `(adopted)`（`status --json` **不**含该字段，`gateway-command.ts:309-311`） |
| 版本闸门 | 无 | 仅插件有 `engines.vessel` 范围检查（`plugin-manifest.ts:1450-1456`） | 条目缺 `protocol` 或低于 MIN 时 `gateway start` 输出 `node_unsupported_version` 并给出理由、不 spawn 该 node |
| 单写者 | 有 | `gateway-command.ts:519-605` | 同 `dataDir` 并发 `start` 只允许一个成功，另一个非零退出且不改动 `nodes.json` |

## B 组 · 对外暴露

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 静态资源 | 有 | `platform/server.ts:148` | 未命中静态文件时落 `index.html`，且不返回 8642 之外的路径穿越 |
| 鉴权（平台 token） | 半 | `platform/auth.ts:53-62` | 配置 token 后无 token 请求一律 401；未配置时仅回环放行 |
| Origin 白名单 | 有 | `platform/server.ts:101-107` | 非白名单 Origin 的 `/platform/rpc` 返回 403 |
| TLS 终止 | 无 | `platform/types.ts:41-66` 无 tls 字段 | `tls.enabled=false` 且 bind 非回环时拒绝启动（fail-closed） |
| 短时节点票据 | 无 | — | 浏览器响应体不含 token 原文；票据 TTL ≤60s，重放第二次返回 401 |
| 限流 | 无 | — | 单 IP 1 分钟内第 61 次 `/platform/rpc` 返回 429，第 60 次仍 200 |
| 审计 | 无 | — | 每次 RPC 追加一行 jsonl（method/ok/来源/假名化 token），文件按日切 |

## C 组 · 连接与发现

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 注册表权威源 | 有 | `node-registry.ts:4`（原子写、0600） | `nodes.json` 损坏时启动失败并给出可修复提示，绝不重写为空表 |
| 只读视图 | 有 | `platform/rpc.ts:15-28` | 5 个方法集合冻结；新增方法需改 ADR 而不是加分支 |
| 注册表热重载 | 无 | `gateway reload` 不重载 registry（`docs/versions/CURRENT.md:172`） | 改 `nodes.json` 后 `gateway reload` 生效，`requires_restart` 列表里不再出现 nodes |
| 多节点路由查询 | 无 | — | 查询无副作用（探测计数不变），返回候选 + 排因，不替调用方选 |
| hub 配对 | 有 | `src/hub-command.ts:524`（pairing TTL）、`:791`（pairing id） | 出站必须显式 opt-in；配对 id 过期即失效，未配置不发起连接 |

## D 组 · 运维

| 能力 | 现状 | 代码位置 | 验收判据（可判定） |
| --- | --- | --- | --- |
| 节点日志落盘 | 有 | `node-supervisor.ts:128` | 每个 node 独立 `<dataDir>/gateway/node-<name>.log` |
| 日志聚合 | 无 | — | `gateway logs --follow` 同时输出平台 + 全部 node，带 `node=<name>` 标签，端到端延迟 <1s |
| 指标 | 无 | 8642 只有 `/health`；node 侧有 `/v1/metrics` | `GET /platform/metrics` 输出含 `gateway_uptime_ms`、`nodes_total`、`nodes_up`、`ticket_issued_total` |
| 升级编排 | 无 | — | 版本闸门失败时中止升级且旧进程 pid 不变；成功路径停机 ≤2.5s |
| 备份巡检 | 无 | — | 每日巡检 `nodes.json` 与配对凭据 mtime，>7 天未变或文件缺失即告警 |

## 不做时的替代方案

| 不做 | 替代 | 代价 |
| --- | --- | --- |
| 不反代会话数据 | UI 直连 8644 + 短时票据 | 浏览器到 node 需可达（同机或内网），跨网要自己解决 |
| 不做调度 | 客户端拿 `nodes.list` 自行选择 | 选择逻辑分散在 UI/TUI 两处，需共享同一份排序约定 |
| 不持有 run 状态 | 状态归属 node，重启靠 S1 marker + 客户端重连 | 断线重连语义由客户端保证，gateway 无法代为「续」 |
| 不做 standby 轮换 | `restart` 走 handoff，预算 ≤2.5s | 每次重启仍有 0.2–0.6s 结构性不可达 |
| 不在 8642 落持久态 | 一律重建式（`lastSeen` 可丢） | 累计指标只能从 node 侧汇总 |

落地顺序、人日与风险见 [gateway-plan.md](../dev/research/gateway-plan.md)。

