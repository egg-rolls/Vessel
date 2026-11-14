# Gateway 分阶段计划（P0–P3）

> 决策依据：[ADR-103](../../adr/ADR-103-gateway-responsibilities.md) ｜ 能力清单：
> [gateway-capabilities.md](../../architecture/gateway-capabilities.md) ｜ 调研：
> [graceful-restart.md](./graceful-restart.md)、
> [zero-downtime-c-and-worker-split.md](./zero-downtime-c-and-worker-split.md)
>
> 本文是**决策材料**：人日是可执行区间，判据是可判定的（能写成测试或脚本），风险带检出手段。

## 0. 三句话结论

1. 8642 今天只做三件事（静态资源、`/health`、5 个只读 `platform.*` RPC，
   `packages/serve/src/platform/server.ts:4`、`rpc.ts:15-28`），**A 组生命周期是成本，B/C/D
   三组才是 8642 存在的理由**——因此后续投入应压在 B（票据）与 C/D（可观测），而不是继续加
   生命周期功能。
2. 迁移到公网服务器**之前必须补两件事**：浏览器拿票据而不是 per-node token（今天回环浏览器
   拿到的是 token 原文），以及 gateway 在反代后的来源识别（未配置平台 token 时鉴权等价于
   「仅回环放行」，`packages/serve/src/platform/auth.ts:53-62`）。
3. C 档 standby 维持 no-go，但已给出四条可判定触发条件；在它们全部不成立前，**不要**把
   8642 从「可抛弃」改成「不可停机」。

## 1. 基线（用于判定"没变坏"）

| 指标 | 现值 | 出处 |
| --- | --- | --- |
| 8642 路由数 | 3（静态 / `/health` / `/platform/rpc`） | `platform/server.ts:113`、`:25`、`:148` |
| `platform.*` 方法数 | 5（冻结） | `platform/rpc.ts:15-28` |
| 平台内存态 | 1 个 `lastSeen` Map | `platform/registry.ts:80` |
| 单次健康探测上限 | 1000ms | `platform/registry.ts:13` |
| 8642 结构性不可达 | 0.2–0.6s | `zero-downtime-c-and-worker-split.md:159` |
| 停机预算 | ≤2.5s | 同上 `:31` |
| 平台 stop 上限 / node readiness / node stop | 10s / 20s / 5s | `gateway-command.ts:2038`、`node-supervisor.ts` |
| handoff marker TTL | 120s | `src/gateway/handoff.ts:24` |

## 2. 阶段总表

| 阶段 | 时间窗 | 人日 | 一句话 |
| --- | --- | --- | --- |
| P0 | 0.52 内 | 2.5–4 | 把「权威与归属」的坑填平，不加新职责 |
| P1 | 服务器迁移前，必须 | 6–9 | 票据 + 反代信任 + 熔断 + 指标 |
| P2 | 1.0 前 | 9.5–14 | 限流/审计/热重载/日志/路由查询/升级编排 |
| P3 | 1.0 后 | 12–18 | 流式透明反代（仅当 ADR-103 决策 5 条件 (a) 成立）+ 备份巡检 + 票据撤销 |

合计 **30–45 人日**；P0+P1（迁移必需）= **8.5–13 人日**。若只做 P0+P1 的下限（8.5 人日），
迁移风险可接受；跳过 P1 直接上公网属于**已知不可接受**。

## 3. P0 · 0.52 收尾（必须，2.5–4 人日）

**做什么**

| 项 | 人日 | 说明 |
| --- | --- | --- |
| adopt 归属判据收紧 | 0.5–1 | 现为 `gateway.pid` 三元组（`gateway-command.ts:387-412`）；补 `started_at` + role + port 四元组比对，歧义时默认不 adopt，需 `--force` |
| listen 顺序回归测试 | 0.5 | 已修（`gateway-command.ts:2181-2186`）；补一条测试：spawn 后 200ms 内 8642 未 listen 也不算失败，子进程未继承监听 |
| 版本闸门 | 1–1.5 | `nodes.json` 条目缺 `protocol` 或 < MIN → 拒绝启用 + 原因；插件侧已有 `engines.vessel` 范围检查可复用（`plugin-manifest.ts:1450-1456`） |
| 残 pid / 孤儿巡检 | 0.5–1 | id 与进程不匹配时给 `stale_pid` 提示，不静默清理 |

**不做什么**：不引入票据、不加 TLS/限流/审计（那是 P1/P2）；不改 `nodes.json` schema 语义
（只允许加可选字段）。

**验收判据**：`gateway list` 在同 `dataDir` 里出现两个不同 `instance` 时仍能区分；版本不匹配
的 node 在 `start` 时输出 `node_unsupported_version` 且不 spawn（进程表证明无新进程）；
`restart` 后 node pid 不变（handoff 仍成立）。

**风险**：四元组收紧后可能把「合法 adopt」判成歧义，导致每次重启都拉起新 node（回退方案：
`--force` 保留；检出：restart 后 pid 变化率）。

## 4. P1 · 服务器迁移前（必须，6–9 人日）

**做什么**

| 项 | 人日 | 说明 |
| --- | --- | --- |
| B1 短时票据 | 2.5–3.5 | 8642 签发（**Ed25519 非对称 + kid 多代**，TTL 60s，aud=node_id，单次使用 + 60s 重放缓存，绑定 Origin），8644 只持公钥校验；nodes.credentials 改返回票据。（口径见 auth-decision-memo.md 的 D2，原 HMAC 记号作废） |
| B2 反代信任 + Origin 收口 | 1–2 | 显式 `proxy.trusted: true` 才认 `X-Forwarded-For`；否则 bind 非回环时拒绝启动（fail-closed） |
| C1 健康缓存 + 熔断 | 1.5–2 | 500ms 缓存；连续 3 次失败熔断 30s，半开探测 1 次成功后恢复 |
| D1 平台指标 | 1 | `GET /platform/metrics`：uptime、nodes_total/up、ticket_issued_total、probe_failures_total |
| 迁移检查单 | 0.5 | 写进 `docs/operations/REMOTE.md`：TLS 前置、Origin、token 轮换、票据开关 |

**不做什么**：不做 gateway 内部 TLS 终止（走前置反代，见待拍板）；不做多节点自动选优；
不做 standby。

**验收判据**：浏览器侧响应体不含 ≥32 字节 base64 形态的 token（抓包/断言均可）；票据重放第二
次返回 401；把 8642 放到 nginx 后、`proxy.trusted=false` 时启动即失败并说明原因；节点挂掉后
`nodes.list` 30s 内不再探测（探测计数可证）。

**风险**：票据引入「两处密码学」易错（签名/校验分别实现）；缓解：固定向量测试 + 票据里带
`kid` 便于轮换。另：node 侧校验属于 8644 契约变更，需与 8644 的 5 个平台方法同步发版。

## 5. P2 · 1.0 前（9.5–14 人日）

- **做**：限流（`/platform/rpc` 60 req/min/IP，票据 10 req/min/IP，1 人日）· 审计 jsonl（1.5–2）·
  注册表热重载（`gateway reload` 覆盖 registry，1–1.5）· 日志聚合（`gateway logs --follow`，
  1–1.5）· 多节点路由查询（只读、无副作用，2–3）· 升级编排（版本闸门 + drain 联动，3–4）。
- **不做**：不做调度决策、不做会话数据代理。
- **验收判据**：第 61 次 RPC 返回 429 而第 60 次 200；改 `nodes.json` 后 `reload` 生效且
  `requires_restart` 不再列 nodes；`logs --follow` 端到端延迟 <1s；升级失败时旧进程 pid 不变。
- **风险**：升级编排会把「drain（30s 上限）」和「版本闸门」耦合，任一侧超时都会让升级半途
  而废（检出：升级后残留 run 计数）。

## 6. P3 · 1.0 后（12–18 人日）

- **做**：**仅在 ADR-103 决策 5 条件 (a) 成立时**做流式透明反代（SSE 原样透传，8–12）·
  备份巡检（2–3）· 票据撤销与多租户票据（2–3）。
- **不做**：不做「先收全再转发」，不做把 SSE 降级为轮询。判据见 ADR-103 决策 2。
- **验收判据**：反代路径下 SSE 事件序号零丢失、端到端 p95 增量 <20ms；巡检发现 >7 天未变即告警。
- **风险**：反代一旦成为默认路径，8642 就从「可抛弃」变成数据面必经点（见 §8 风险 1）。

## 7. 与既有工作的衔接

| 既有工作 | 关系 | 落地位置 |
| --- | --- | --- |
| **S1（node marker + resume）** | P0/P1 的**前置**：gateway 侧任何 drain/升级编排都必须先有 marker；S1 本身 2–3 天（`graceful-restart.md:94`） | node 侧，不占本计划人日 |
| **S1a–c 拆分** | 仓库文档里没有 `S1a/S1b/S1c` 字样（grep 0 命中），按 main 口径沿用，细节**未核实** | — |
| **S2（`restart` 工具）** | 排在最后，需要 sentinel + 强制审批；与 P2「升级编排」共用 drain 判定 | P2 之后 |
| **服务器迁移（腾讯云）** | P1 是硬前置；`docs/operations/REMOTE.md` 已有 TLS/Origin/token 策略与 `non_root_layout` 检查可复用；`MIGRATION.md` 覆盖数据布局迁移 | P1 |
| `docs/operations/CONFIG.md` | 新增配置键（`tls.*`、`ticket.*`、`rate_limit.*`）必须登记，否则等于隐形配置 | P1/P2 |

## 8. 风险表

| # | 风险 | 概率 | 影响 | 检出 | 缓解 |
| --- | --- | --- | --- | --- | --- |
| 1 | gateway 单点化（B 组全上后 8642 成唯一入口） | 中 | 产品不可用 | `/health` 采样 p95 | 2.5s 预算门限；触发条件 (b) 一到就重评 C 档 |
| 2 | 票据签发的攻击面（伪造=拿到公司钥匙） | 高 | 数据泄露 | 401 计数、`kid` 分布 | HMAC + 60s TTL + 单次使用 + Origin 绑定 + 固定向量测试 |
| 3 | adopt 归属歧义（误杀他人 node） | 中 | 他人会话中断 | adopt 日志的判据分支 | 四元组 + 默认不 adopt + `--force` |
| 4 | 双节点同 `dataDir` 的写者冲突 | 中 | `nodes.json` 损坏/串号 | `instance_locked`、`duplicate_node_id` | 实例锁（`instance-lock.ts:143`，启动路径 `gateway-command.ts:519-605`）+ node_id 去重（`gateway-command.ts:585` 与 `:1514`）+ dataDir 绑定校验 |
| 5 | 升级编排与 drain 耦合 | 高 | 升级时 run 被杀 | 升级后残留 run 数 | drain deadline 30s + S1 marker/resume + 强制审批 |
| 6 | 反代后回环误判（nginx→127.0.0.1 被当本地） | 高 | 未鉴权访问 | 审计里 `remote=127.0.0.1` 占比异常 | 显式 `proxy.trusted`，默认关；bind 非回环且未信任时拒绝启动（依据 `platform/server.ts:108-110`、`platform/auth.ts:53-62`） |

## 9. 待 owner 拍板

1. **TLS 归属**：(a) 8642 内置 TLS（+1.5–2 人日，配置统一）；(b) 强制前置反代 + 检查单
   （0.5 人日，运维多一步）。建议 (b)，与「8642 可抛弃」一致。
2. **票据密钥**：(a) 8642 与 node 共享 HMAC 密钥（简单，泄漏面大）；(b) 非对称，8642 持私钥
   签、node 只持公钥验（+1 人日，撤销/轮换更清晰）。建议 (b)。
3. **版本闸门严格度**：(a) lockstep（协议版本必须相等）；(b) N-1 兼容（跨一个小版本可跑）。
   建议 (a)，代价是升级要连 node 一起。
4. **P1 是否含日志聚合**（+1–1.5 人日）：迁移后第一个事故通常靠日志定位，缺失会显著拉长 MTTR。

## 10. 未核实

- `S1a–c` 的具体拆分与当前进度（仓库文档无该字样）。
- 腾讯云形态（单机 / 多机、是否已有 WAF/CDN）未知，直接影响 B2 与限流策略。
- 8642 冷启 0.2–0.6s 是在何种机器上测的（Windows/WSL vs Linux 云主机），预算 2.5s 在目标
  机器上未复测。
- `vessel gateway restart` 的停机 p95 **从未测过**（触发条件 (b) 目前无基线）。
- node 侧票据校验是否需要新增 8644 契约版本号（未设计）。

