---
adr: 106
title: engine 池执行平面（gateway 控制面 + node 客户端 LB）
status: accepted
date: 2026-11-19
related: [26, 39, 55, 58, 66, 93, 99, 101, 105]
tags: [tools, engine, pool, gateway, control-plane, load-balance, affinity, crash-recovery, write-lock]
---

## ADR-106：engine 池执行平面（gateway 控制面 + node 客户端 LB）

> **状态：accepted**（2026-11-19 收编，engine-pool 阶段①切片；草案与论证记录在个人侧
> `docs/dev/plans/ADR-draft-engine-pool.md` / `docs/dev/research/engine-pool-architecture.md`）。
> 批准来源：个人侧 `docs/dev/plans/DECISION-engine-pool.md`（2026-11-19 用户「全照推荐」，
> Q1–Q13 + 待批实体全批）。实施蓝图 = 个人侧 `docs/dev/plans/CONTRACT-engine-pool.md`（冻结，S1–S20）；
> 实施状态与版本态只放个人侧 `docs/dev/**`，本文不写。基线：main @ `4473f7ae`。
> 独立 ADR，不并入 tools-engine ADR（Q8 裁决）；接受后取代个人侧 ADR-draft-tools-engine 决策 9
> 「P3 集群默认不建」部分（P2 契约 §0.3/§11 已同步修正案，2026-11-19）。
> 上游决策：用户裁决 C（个人侧 swarm-shared-workspace-collaboration.md §6.1，2026-11-19：
> engine 方向 = 蜂群统一工具池，IPC 税接受）+ 用户已定方向（池 / gateway 控制面不在数据热路径 /
> node 三步 LB + P2C / 准入快拒换家重试 / callback 按 node 精准路由 / 守 node 边界）。

## 上下文

1. **P2 已落地**：每 host 一个 engine child（B 形态），stdio NDJSON JSON-RPC（8 MiB），白名单
   read/edit/write/bash-sync 走 worker，MCP 连接迁 engine（孙进程），有状态工具 callback 关联-only
   回 host（fail-closed），权限门在 host 派发前，注册权威 PluginHost（C1–C3）。
   崩溃隔离 + 干净热替换边界 + 统一管理面已交付（ADR-099 备选 (d) 座位的另立契约）。
2. **P2 当时的 P3 保留**：「daemon/router/worker 池/轮换/全局路由：0 个已论证调用场景，默认不建」，
   但信封协议已按「同一 wire 日后可承接 daemon」设计（P2 契约 §11）。**本 ADR 即该预留的兑现**：
   裁决 C 给出真实需求（蜂群多 node 共享统一生产资料池），P3 触发条件满足。
3. **per-node child 的池化动机**（用户已定，不再讨论单共享 vs 池）：
   - 隔离更细：一 engine 崩只影响派给它的在途调用（现态 per-node child 崩 = 该 node 全工具面瘫）；
   - 可扩展：M 独立于 N 伸缩，统一生产资料池；
   - gateway 当控制面/注册中心（拉起/监督/发布路由），**不在数据热路径**，宕机时数据面存活；
   - node 客户端 LB（亲和→健康→P2C）+ engine 准入快拒，去中心化抗羊群，不依赖 gateway 精确全局负载。
4. **两个抗崩基石已在现态机制中兜底**：① 有状态 state 在 host（callback 模型，
   pending 表 = 「handler 是否已执行」的 host 权威 oracle）；② 写锁 stale 回收（data-lock 模式，
   engine 崩不死锁）。池化原样继承，不新增状态容器。
5. **写锁池proof**：Phase 1 第三重 = handler OS 文件锁 `<baseCwd>/.vessel/write.lock`
   （link/open wx + owner JSON + stale 回收 + .reclaim 守卫），锁权威 = 工作区文件，**拓扑无关**；
   被否的 engine dispatch per-path 互斥恰在池里失效（各 engine 各锁各的 mutex）。池化前提 =
   baseCwd realpath 归一（Q13 必修）。

## 决策

1. **池拓扑**：gateway 监督 M 个 **detached** engine 进程（loopback TCP listener）；node 经 N×M 条
   直连访问；**每 data 连接 = 一个 node 作用域**（ToolsEngine 按连接实例化，registry/inFlight/MCP
   全按 scope；连接 close/incarnation 取代 → scope dispose）。gateway 只发布成员+健康路由表，
   不转发工具调用、不持亲和绑定、不持写锁。三角色职责（PluginHost/engine/host）不变。
2. **传输 = TCP loopback + 既有 NDJSON JSON-RPC**：与 stdio 字节流同构（codec 抽单实现），
   **wire 8 方法一字不改**；首帧 auth（双 token 分权：control=gateway / data=node）；8 MiB/心跳 15s/
   pending 关联沿用。**远程 engine 仍禁止**（同机同 FS 硬约束，loopback bind 物理表达）。
   否决 stdio 控制通道：gateway restart adopt 语义（topology.md）不允许整池随平台重启而死
   （stdin EOF → 全池 exit）；detached + 状态文件自写 + adopt 对齐 node-supervisor 既有词汇。
3. **控制面 = 文件路由 v1**：engine 自写状态文件（pid/port/tokens，gateway.pid 先例）；gateway
   探测（控制 ping + pid 复核）+ 预算内 one-for-one respawn（≤3/10min）+ adopt/external 永不杀；
   routing.json gateway 唯一写者（epoch/revision fencing，atomicWrite）；node fs.watch + 5s poll +
   失败即刷。**零新 canonical RPC、零 gateway 新端口、零 push 通道**（WS push 演进）。
   **gateway 宕机数据面存活**（detached + 路由持久 + node 本地健康）；僵死判定保守（Q6：exit 才重启，
   ping 超时标 draining 不杀，watchdog 事故教训：过载≠僵死）。
4. **node 客户端 LB = PoolTransport 实现既有 EngineTransport 端口**（forward/pending/registry/client
   消费面零改动）：① 亲和过滤（mcp:<server> → 绑定 engine）→ ② 健康过滤（本地熔断，busy 不计入）
   → ③ P2C（随机 2 选 **node 本地在途**少者）。路由/绑定/熔断三张 node 本地软表；不依赖 gateway
   全局负载。**重试安全 = 「证明未执行」**（不是「无状态」）：busy/connect 失败/错 engine 可换家；
   worker 派发后失联折稳定错误不自动重试；**callback pendingState='pending' → 透明续上**
   （重派替代 engine，pending 记录原样，at-most-once 由状态机收口）。
5. **亲和 = MCP 硬亲和，绑定表 node 本地软状态**（per-(node,server)，Q2）：绑定权威 = 物理持有
   （engine 持连接）；configure = 绑定建立点（分裂合并 per-scope 全量 diff）；连接断 = scope dispose =
   绑定自然失效（无孤儿无迁移协议）；崩溃 rebind 走既有 reconcile（换连接不换定义，tools[] 快照不变）；
   rebind 只由死亡/熔断触发，不由瞬时 busy 触发。worker/callback 零亲和自由 LB（信封自包含 +
   关联-only callback 协议保证）。gateway 不持绑定（薄控制面；全局绑定表演进）。
6. **callback 精准路由 = 连接即身份**：auth 帧 {node_id, incarnation, dirs}（hub 先例）；
   tool.callback 原路回请求方连接 → 该 node fail-closed pending 表；**信封零新字段**。
   node 边界 = 正确性边界（合作节点互不串线），**不是同用户安全沙箱**（与 stdio 亲子鉴权同信任等级；
   Q4：v1 不做 per-(node,engine) token 硬化，留演进）。
7. **准入 = 进程级 in-flight 上限 + engine_busy 传输层快拒**：ΣinFlight ≥ maxInflight（缺省 cpus×4，
   物理资源保护非 run 累计限制）或 rss 软阈 → JSON-RPC error（ENGINE_BUSY_CODE），LB 拦截换家重试，
   **不进模型**；全池 busy 折稳定文本 retryable:false（Q5，零模型面语义变更）。busy ≠ 故障
   （不触发熔断/重启）。**不建有界/durable 队列**（快拒+换家已闭环，宪法 10）。
8. **池化正确性硬前提（Q9/Q13 必修，实施顺序最先）**：
   - **Q9 env 作用域化**：auth dirs（host 权威）→ NodeScope → BasicToolsCallScope 扩展
     {toolOutputDir, dataDir} + **core toolOutputRoot() 先查 ALS 再落 env**（内部机制 additive，
     零模型面）+ spawnBash env 按 scope 注入。无 scope → env fallback 逐字不变（零回归）。
   - **Q13 baseCwd 归一**：write-lock.ts writeLockPath 内 realpathSync.native 单实现归一
     （acquire + 表面记录同源；fail-closed）；不改信封 cwd 值语义（方案 A）；跨 node/跨 engine/in-process
     天然一致。Tier 2 工作区锚点局限诚实标注（Q12 演进另批）；Windows 强制锁仍 deferred（原子性降级待裁）。
9. **写锁与三重保险零变化**：OS 文件锁池proof（锁权威 = baseCwd 文件，OS 内核裁决，与派发无关）；
   崩溃持锁 → stale 回收（ESRCH + 30s hung + 10s 争用折错），池不卡死；订阅感知/匹配兜底 host 侧不变；
   engine dispatch per-path 互斥维持备选记录（启用需 charter 修正案），池化不默认启用。
10. **迁移 = 双开关 opt-in，缺省关零回归**：`gateway.engine_pool.size`（缺省 0）+
    `tools_engine.mode: child|pool`（缺省 child）；本地模式（无 gateway）恒 child；阶段 ① 硬前提 →
    阶段 ② 组件 → 阶段 ③ 单 node 灰度 → 舰队；回退 = 翻配置 + node 重启；child 模式路径逐字保留
    （不删除、不静默回退 in-process）。
11. **模型面零变化 / 实体最小**：零新工具/字段/事件类型/canonical RPC/prompt surface；
    新增仅 2 config 键 + 连接层 auth 帧 + engine_busy 码 + health 进程字段 additive + 路由/状态文件协议
    + 2 新组件（pool-supervisor/PoolTransport）+ core output scope ALS 内部机制（DECISION 全批）。
    不加：per-tool 幂等标记 / engine_id 事件字段（Q10）/ 孤儿清扫实体（Q11 先观察）/ 工作区根锚点（Q12）/
    per-node token（Q4）/ 队列 / 全局精确负载发布。

## 备选（均不取）

- (a) **stdio 控制通道**（supervisor 原样复用）：最大复用，但 gateway restart → stdin EOF → 整池死，
  违反 gateway restart adopt 语义（平台重启不打断在跑 run）。否。
- (b) **gateway 维护亲和绑定表**：全局可观测，但控制面变厚 + 三方一致性协议 + 绑定与物理持有脱节需 fencing。
  node 本地软表 + 连接生命周期 = 作用域生命周期已闭环（无孤儿）。演进（真实全局调度需求再议）。
- (c) **HTTP 数据面**：无反向请求通道（callback 需第二通道），本地模式 node 无监听。否。
- (d) **WS 数据面**：分帧内建/先例最近，但 NDJSON 泵重写 + masking 税，数据面无浏览器/代理需求。
  备选（未来经平台代理再议）；named pipe 硬化需先验证 Bun Windows 支持。
- (e) **engine dispatch per-path 互斥**（原 C 共享池落点）：池里失效（各锁各的 mutex）；OS 文件锁
  拓扑无关 + 零 charter 改动。维持备选记录（swarm 裁决）。
- (f) **engine 自报绑定 / engine 自解析 baseCwd**：违反「校验权 host / 不信 engine 自报 / engine 不自决」
  纪律（P2 C1 / boundary 单权威同构）。否。
- (g) **per-(node,engine) token v1 硬化**：同信任域内收益有限（能读 0600 的同用户进程本就能读各 node config），
  N×M token + allowlist 实体成本；hub 先例同信任等级。留演进（多租户/不信任 node 场景）。
- (h) **有界/durable 队列**：快拒 + 换家重试已闭环；队列等「快拒不可接受」真实调用点（宪法 10 §7）。
- (i) **单共享 engine（M=1）**：用户已定池方向；M=1 池 = child over TCP 纯增税，单 node 恒 child。
- (j) **并入 tools-engine ADR P3 章节**：池是独立架构决策（控制面/LB/亲和/恢复），独立 ADR（Q8）。

## 后果

- **收益**：blast radius 细化（per-engine 在途 vs per-node 全工具面）；M 独立伸缩；统一生产资料池；
  gateway 宕机数据面存活；有状态调用透明续上（callback oracle，比无状态更抗崩）；写协调拓扑无关
  （池proof）；执行平面与 node 生命周期解耦。
- **代价（如实计价）**：N×M 连接管理 + 三张 node 本地软表 + gateway 控制面新组件 + env 作用域化改造
  （core 内部机制 additive）+ TCP loopback IPC 税（pipe 0.15ms 基线，TCP 同量级，未实测）；
  代码级相关崩溃风险池化不消除（所有 engine 同一份源码，毒调用可缩池至零 → fail-closed）；
  MCP 崩溃孤儿孙进程（Windows 无自动树杀，Q11 先观察）；同信任域身份声称（正确性边界协议强制，
  安全边界诚实定位）。
- **模型面零变化**：engine 对模型不可见不变；tools[] 快照/前缀缓存/append-only/WAL 语义不变；
  权限门/注册权威/PII 信任边界不变（loopback + token 与 stdio 亲子同信任等级）。
- **验收**（宪法第三/四条）：静态门禁由实施切片 N 跑；行为验证由用户本人做——阶段 ① 锁归一争用/
  输出落盘归属；阶段 ② child 通道回归/崩溃隔离/callback 续上/MCP rebind/准入快拒/路由 fencing/adopt；
  不起服务/探针。

## 关联

- **ADR-099**：备选 (d)「能力插件迁出进程另立契约」座位的延伸；决策 1（PluginHost 唯一注册入口）/
  3（执行位置≠扩展机制）/4（不是沙箱）/7（生命周期对称）全保留。不 supersede。
- **tools-engine ADR（个人侧草案，proposed）**：本 ADR 取代其决策 9「P3 集群默认不建」部分；
  P2 契约 §0.3/§11 已同步修正案（2026-11-19）。决策 1–8（三角色/C1–C3/callback/鉴权留 host/信封/
  桥/MCP/不是沙箱）全部保留，池复用同一 wire。
- **ADR-101**（platform gateway / node API 拆分）：控制面/数据面物理分离口径延续；pool-supervisor
  归 platform 侧（src/gateway/，node-supervisor 同层），不 import node runtime；engine entry 经 argv spawn。
- **ADR-058**：authorize 先于派发 / 事件由调用方发布不变（engine 不发布 tool.call.*）。
- **ADR-026 / 055 / 083**：工具自描述/自判、路径边界单权威+单实现+两执行点、「bash 不是沙箱」不变；
  baseCwd 归一与 boundary realpath 语义同构。
- **ADR-039**：MCP 默认 ask / autoApprove 精确匹配不变；engine-client 能力插件同形（pool.ts 新模块）。
- **ADR-066**：零新 canonical RPC 方法（平台 RPC allowlist 不动；路由经文件，非 RPC）。
- **ADR-093**（hub 控制面）：auth/hello/incarnation/revision 词汇借鉴（连接即身份 + 快照 fencing）；
  hub 协议本身不改。
- **ADR-105**（session timeline 单一事实源）：WAL/事件落盘路径不变；崩溃恢复不另造 journal。
- **ADR-056 / 086**（data-lock）：write-lock 已复制其 stale 协议（第二调用点）；池proof + 不死锁
  论证骑在该已验证模式上。
- **message-invariants / tools-body-snapshot（P0）**：可见性对等 / append-only / tools[] 快照不受影响
  （执行位置对模型不可见）。
- **宪法 10 / 13**：实体最小（DECISION 全批清单）；机制在核心（output scope ALS）、实现在插件/装配层。

## 冻结清单指针（不是本 ADR 的决策）

> 冻结形状 = 个人侧 `docs/dev/plans/CONTRACT-engine-pool.md`（S1–S20：config 键 / auth 帧 / engine_busy /
> health additive / 路由与状态文件 / pool-supervisor / PoolTransport / pending state 查询 / NDJSON codec /
> core ALS / basic-tools scope + spawnBash env / executeWorker dirs / write-lock 归一 / MCP 分裂合并 /
> 广播合并 / 重试安全 / 准入 / entry pool 模式 / 装配开关；单元所有权 + 实施顺序硬约束 + 门禁纪律）。
> 开放问题裁决记录 = 个人侧 `docs/dev/plans/DECISION-engine-pool.md`（Q1–Q13 全照推荐）。
> 论证/风险/恢复时序 = 个人侧 `docs/dev/research/engine-pool-architecture.md`（r2）。
