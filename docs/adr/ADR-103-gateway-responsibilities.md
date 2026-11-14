---
adr: 103
title: Gateway 的职责边界（四组能力 / 明确不做 / 单点预算）
status: proposed
date: 2026-11-14
related: [100, 101, 102]
tags: [gateway, platform, node, hub, auth, ticket, tls, operations, single-point]
---

## ADR-103：Gateway 的职责边界

- **状态**：proposed。§上下文 的前五条是 owner 已拍的既定前提，本 ADR 的任务只是把它们
  写成**可引用的边界**（避免每个版本重新讨论一次）。§决策 2 的「不做」清单、§决策 3 的
  「单点预算」、§决策 5 的「重评估触发条件」是本次新增，待 owner 确认后转 accepted。
  本 ADR 不推翻 ADR-100 / ADR-101，只补上它们没写的**能力归属**。

- **上下文**：
  - 四层拓扑见 [topology.md](../architecture/topology.md)：Platform Gateway 8642（UI 宿主 +
    `platform.*` 只读 RPC）、Node 8644（公司 runtime 与数据）、Hub 8643（仅 node→hub 出站）、
    Supervisor（平台进程 spawn node/hub 子进程）。**Gateway 不反代 Node**——UI 直连 8644。
  - 8642 今天的全部职责只有三件事：静态资源、`GET /health`、`POST /platform/rpc`
    （`packages/serve/src/platform/server.ts:4`、`:25`、`:113`、`:148`）；对外只读方法只有 5 个，
    契约已冻结（`packages/serve/src/platform/rpc.ts:15-28`）。
  - 8642 的平台层**内存态只有 `registry.lastSeen`** 一个 Map
    （`packages/serve/src/platform/registry.ts:80`、`:84`）；健康探测是按需的，单次上限
    1000ms（`registry.ts:13`），没有后台巡询、没有缓存、没有熔断。
  - handoff 已落地：`gateway restart` 保留 node/hub 交由新进程 adopt
    （`src/gateway/handoff.ts:1-18`、`src/gateway-command.ts:2323-2348`）；**监听必须晚于
    spawn 子进程**，否则 socket 被子进程继承（`src/gateway-command.ts:2181-2186`，
    真实事故，`f539f7a6`）。
  - 8642 的可抛弃性是**量过**的：结构性不可达窗口 0.2–0.6s，目标预算 ≤2.5s
    （`docs/dev/research/zero-downtime-c-and-worker-split.md:31`、`:159`）。
  - per-node token 等于「公司钥匙」，撤销只能换 token；但**今天浏览器拿到的是 token 原文**：
    `platform.nodes.credentials` 对回环浏览器直接返回明文（客户端取用见
    `apps/web/src/gateway/bootstrap.ts:106-112`），平台侧鉴权在未配置 token 时「仅回环放行」
    （`packages/serve/src/platform/auth.ts:53-62`）。这条路径与既定原则直接冲突——原则要求
    钥匙不出服务端，现状是钥匙交给浏览器进程。

- **决策**：

  **1. 四组能力，逐条归属（其余一切不属于 gateway）**

  | 组 | 能力 | 归属说明 |
  | --- | --- | --- |
  | A 生命周期 | 枚举/启停/重启 node·hub·平台自身、健康探测、熔断、孤儿收养、版本闸门、单写者 | 已在 `src/gateway-command.ts`、`src/gateway/node-supervisor.ts`：adopt 三判据（`gateway.pid` 三元组）、readiness 20s、node stop 5s（`node-supervisor.ts:34-35`）、平台 stop 上限 10s（`gateway-command.ts:2038`）、实例锁（`gateway-command.ts:519-605`）。**熔断与版本闸门尚无** |
  | B 对外暴露 | TLS 终止、鉴权、**给浏览器签短时节点票据**、Origin 白名单、限流、审计 | 今天只有 Origin 白名单与两种鉴权模式（`platform/auth.ts:53-62`、`platform/server.ts:101-107`）；TLS/限流/审计/票据**全缺**（`PlatformGatewayOptions` 无 tls 字段，`platform/types.ts:41-66`） |
  | C 连接与发现 | 节点注册表权威源、多节点路由查询、hub 配对、重连契约归客户端 | 权威源是 `<dataDir>/nodes.json`（原子写、0600，`src/gateway/node-registry.ts:4`）；8642 只是只读视图，且 **`gateway reload` 不重载 registry**（`docs/versions/CURRENT.md:172`）；重连/退避**由客户端库负责**，不进 gateway |
  | D 运维 | 日志聚合、指标、升级编排、备份巡检 | 节点日志已按 `<dataDir>/gateway/node-<name>.log` 落盘（`node-supervisor.ts:128`）；聚合、指标、编排、巡检**全缺**，8642 连 `/platform/metrics` 都没有（`server.ts` 只有 `/health` 与 `/platform/rpc`） |

  **2. 明确不做（写死，不再逐版讨论）**
  - **不持有 agent 运行态**：run/session/turn 的状态只在 node 进程里。gateway 重启不得影响
    任何正在跑的 run——这正是 handoff 存在的原因。
  - **不拥有会话数据**：8642 不落会话、不落消息、不做数据迁移与校验和。
  - **不做调度**：不做节点选择、负载均衡、亲和性、失败重试路由等「选谁跑」的算法；C 组只提供
    **查询**（谁 up、版本多少、`last_seen` 何时），选择留给调用方。
  - **不反代会话数据**。若将来必须反代（P3 之后才谈），必须**流式透明**：SSE 原样透传，
    禁止把事件流降级成轮询、禁止在 gateway 落缓冲区。任何「先收全再转发」的实现一律否决。

  **3. 边界原则：可以抛弃、可以做单点，但单点必须可重启且预算 ≤2.5s**
  - 「可抛弃」= 任意时刻 SIGKILL 8642，恢复后不得丢数据、不得让 UI 进入不可恢复状态。
    当前成立，因为平台层内存态只有 `registry.lastSeen`（`registry.ts:80`），丢了只让
    `last_seen` 从 null 重新长回来。
  - 「可以做单点」= 允许 8642 成为 UI 唯一入口，**前提**是重启停机窗口 ≤2.5s，且能被
    `gateway restart` 一条命令完成。这条预算是**门限**不是愿望：超过 2.5s 就必须先补
    drain/预热，再谈把更多职责压上去。
  - 推论：**任何把「不可重建状态」写进 8642 的改动都自动违反本 ADR**，review 时明确否决，
    或新开 ADR 重定预算。

  **4. 浏览器拿到的必须是票据，不是 token**
  - 新能力项：8642 签发**短时节点票据**（TTL 60s、`aud=node_id`、单次使用、绑定 Origin），
    浏览器凭票据访问 8644，由 node 校验票据而不是 per-node token。
  - 签发点必须在 gateway（唯一知道「谁登录、能看哪些 node」的地方），校验点必须在 node
    （不要绕成 gateway 代校验再透传，那会变成数据面依赖）。
  - 撤销模型不变：票据天然短命，token 泄漏仍只有换 token 一条路——与 topology.md 一致。
  - 迁移约束：票据上线后 `platform.nodes.credentials` 必须**停止返回 token 原文**（改返回
    票据，或在不支持时返回 `ticket_not_supported`）；新旧两条路并存等于没修。

  **5. C 档（gateway standby 轮换）的重评估触发条件**
  - 现状：C 档 no-go（`docs/dev/research/zero-downtime-c-and-worker-split.md:19`），收益只是
    8642 的 0.2–0.6s 不可达，成本 3–4 人日 + 两实例写者仲裁（同级文档 `:169`）。
  - **触发条件（全部可判定，满足任一即重开）**：
    - (a) B 组落地后 8642 成为**唯一**对外入口（UI/TUI/API 都不再直连 8644），即「8642 挂了
      = 产品不可用」；
    - (b) 单次 `gateway restart` 实测 p95 停机 >2.5s（重启前后各 100 次 `GET /health` 采样）；
    - (c) 8642 上出现**不可重建状态**（违背决策 3 推论：会话缓存、票据私钥热态、长连接注册表等）；
    - (d) 对外承诺 SLA ≥99.9%（每月 ≤43min，部署频次 × 0.6s 已不可忽略）。
  - 未满足以上任一条件时，**禁止**把 standby/Hot 交接当「架构升级」推进——那是净亏。

- **后果**：
  - 正面：能力归属一次写清，后续版本只在矩阵里挪状态，不再重开「gateway 要不要管运行态」；
    票据把「钥匙下发浏览器」这条真实冲突关掉；单点预算给出可验证门限（2.5s），让「继续加
    职责」变成有代价的决策。
  - 负面：票据需要 node 侧新增校验路径（跨仓库改动，协调成本高）；「不做调度/不反代」会
    明确拒绝若干便利需求（多节点自动选优、统一 SSE 入口）；2.5s 预算需要长期回归基线，
    目前**还没有这条 benchmark**。
  - 遗留：本 ADR 不改代码。能力矩阵与落地顺序见
    [gateway-capabilities.md](../architecture/gateway-capabilities.md) 与
    [gateway-plan.md](../dev/research/gateway-plan.md)。

- **替代方案**：
  - **A. 保持「gateway 什么都管」**（守护 + 反代 + 调度 + 数据代理）：把 run 状态与会话数据
    拉回 8642 会让它从「可抛弃」变成「不可重启」，handoff 立即失效，S1 那条 drain 路线也
    失去意义。否决。
  - **B. 干脆去掉 8642**（UI 直连 8644，浏览器存 token）：省一个进程，但 (1) 每家公司各一个
    token 进浏览器，撤销只能挨个换；(2) 跨公司视图没有落点；(3) 平台升级要逐节点升级。
    否决——但它说明 8642 的价值只在 B/C/D 三组，A 组是成本不是卖点。
  - **C. 现在就做 C 档 standby**：收益 0.6s，成本 3–4 人日 + 双写者仲裁风险，而 UI 侧真正的
    断点是 node 上的 run（那是 S1 的事）。否决，并给出触发条件（决策 5）以便将来翻案。
  - **D. 票据改成「gateway 代校验后透传」**：gateway 会变成数据面必经点，直接违反决策 2 的
    「不反代会话数据」，并把 8642 变成 run 的 KPI 依赖。否决。

