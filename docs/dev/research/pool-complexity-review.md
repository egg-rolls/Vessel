# O4 pool 韧性复杂度评审（机制清单 + 判定）

> 状态：评审文档（纯文档，不改代码）。分支 fix/q-pool-design。
> 输入：engineering-quality-reflection.md O4 / ADR-106 / IDEAL-ARCHITECTURE A1。
> 证据基线：db69c381。代码真源：plugins/tools/engine-client/src/pool.ts（PoolTransport，1173 行）、
> src/gateway/pool-supervisor.ts（994 行）、src/tools-engine/entry.ts pool 模式（S19）、
> src/tools-engine/supervisor.ts（child 基线，234 行）。
> 注：任务书所指「src/tools-engine/pool.ts」实为 plugins/tools/engine-client/src/pool.ts。

## 一、机制清单（机制 | 防御故障 | 同机同用户池是否真实 | 判定）

| # | 机制（证据） | 防御的故障 | 同机同用户小池是否真实 | 判定 |
|---|---|---|---|---|
| 1 | 熔断器 closed/open/half-open，连续 3 次传输失败（pool.ts:53-54,113-121,291-314） | 反复向坏 engine 派发/dial | 部分真实：engine 死已由 routing 除名+失败即刷覆盖；熔断只补「进程活但传输持续坏」窗口（hang/codec 违约），与重连退避职责重叠 | simplify：与 #3 合并为单一「连接失败退避」，去掉独立三态机 |
| 2 | 冷却指数 5s→30s+jitter+opens 计数+half-open 单探测 gate（pool.ts:55-57,266-305,347-352） | 探测风暴/羊群 | 弱：N×M 为个位数，无分布式羊群；单探测 gate 防并发探测真实但 3 行可表达 | simplify：固定冷却 5s，删 opens 指数链 |
| 3 | 重连退避 1s→30s+jitter（pool.ts:65-67,377-387） | dial 风暴打死的端口 | 真实：respawn 需 ~1s+，退避防抖 | keep（~10 行，便宜） |
| 4 | routing epoch fencing：retiredEpochs 集（pool.ts:257-258,674-681；supervisor:832） | 旧 gateway 谱系写脏路由 | 低概率真实：instance-lock 保单 gateway，但 handoff 重叠窗口存在；成本 ~10 行 | keep（便宜，handoff 语义需要） |
| 5 | epoch 内 revision 单调（pool.ts:676；supervisor:457-459） | 三触发异步读乱序/旧快照 | 真实：watch/poll/失败即刷并发 readFile 可乱序 | keep（3 行） |
| 6 | adopt/external 永不杀 + 归属复核 pid+started_at+isBeforeBoot（supervisor:847-853,923-940） | pid 复用误杀；gateway restart 杀外部 engine | 真实：detached+adopt 是 ADR-106 决策 2/3 核心；Windows pid 复用真实 | keep（正确性，非韧性过度） |
| 7 | 重启预算 ≤3/10min 滑窗→disabled 不补位（supervisor:567-598；child supervisor.ts:115-135 同口径） | 毒调用无限重启循环 | 真实：代码级相关崩溃池化不消除（ADR-106 后果如实计价） | keep（与 child 共享常量，非 pool 专属税） |
| 8 | ping 超时→draining 不杀（Q6）+ inflight 进展观察（supervisor:506-538,816-822） | 过载误判僵死而杀（watchdog 事故教训） | 决策真实（busy≠故障）；但 observeProgress 只 log 无任何决策消费（v1 不 terminate） | keep 决策；simplify：删 observeProgress 无消费观察维（~18 行） |
| 9 | P2C 随机 2 选 node 本地在途少者（pool.ts:225-238,794-802） | 热点单 engine/依赖 gateway 全局负载 | 弱：M=2-4 时 P2C 对随机/轮询收益边际；但实现仅 ~14 行 | keep（便宜；复杂度不在 P2C 本身） |
| 10 | MCP 硬亲和绑定表 + configure 分裂合并（pool.ts:247-248,779-795,1015-1090） | 有状态 MCP 连接被自由迁移 | 真实且是正确性需求：连接物理持有=绑定权威，非韧性过度 | keep；configureSplitMerge ~75 行是复杂度热点但语义必需 |
| 11 | S17 重试安全白名单=证明未执行（pool.ts:760-879） | 副作用重复执行 | 真实：at-most-once 正确性需求；worker 派发后失联绝不重试是纪律 | keep（routeInvoke ~115 行是最大热点，但每分支对应真实故障语义） |
| 12 | busy 准入快拒 maxInflight=cpus×4 + rss 软阈（entry.ts:294-348,562-569；pool.ts:851-858） | 进程过载/OOM | 真实：物理资源保护；busy 不计熔断/不进模型 | keep |
| 13 | incarnation fencing：旧代际拒 4409/≥ 取代旧 scope（entry.ts:659-675） | 僵尸 node 重连污染新 scope | 真实：node rotate/重启是同机常态 | keep（~15 行） |
| 14 | 双 token 分权 control/data + auth 5s 超时（entry.ts:321-323,617-683） | data 连接误调 deactivate 杀全池；未鉴权占资源 | 正确性真实；安全上同用户可读 0600 即读 token（ADR-106 Q4 诚实定位：非沙箱） | keep 分权（正确性边界）；不追加 per-node token 硬化 |
| 15 | routing 唯一写者 + atomicWrite durable 0600 + publishChain 串行（supervisor:457-486） | 并发写撕裂/多写者冲突 | 真实：读面三触发需要一致快照 | keep |
| 16 | 路由三触发 fs.watch+5s poll+失败即刷（pool.ts:634-654,1167-1170） | watch 丢事件（rename 替换）/gateway 未起 | 部分真实：Windows watch 不可靠→poll 兜底必需；但 poll+失败即刷已闭环，watch 只是延迟优化 | simplify：可删 fs.watch（~20 行），5s poll 延迟可接受 |
| 17 | 心跳 15s ping 双角色（pool.ts:49-52,389-406） | TCP 半死连接不通知 | 真实；与 child.ts 同值同口径 | keep |
| 18 | last-known-good：读失败≠池空（pool.ts:662-664） | gateway 宕机数据面瘫 | 真实：ADR-106 核心收益「gateway 宕机数据面存活」 | keep（3 行） |
| 19 | fail-closed 不静默回退 in-process（pool.ts:798-799；supervisor.ts:6） | 静默语义漂移 | 真实：supervisor 纪律 | keep |
| 20 | N×M eager 直连 + 每 data 连接一个 NodeScope（pool.ts:742-746；entry.ts:462-615） | —（拓扑选择，非韧性） | 单 node N=1 时退化为 M 连接≈child over TCP（ADR-106 备选 (i) 已认 M=1 纯增税） | keep（已批拓扑）；opt-out 见 §二 |

## 二、核心判定（摘要）

1. **两类机制要分开**：#6/10/11/12/13/14/15 是**正确性需求**（亲和/重试安全/归属/准入/代际/单写者），
   不是分布式韧性过度，删了会出正确性事故——keep。
2. **真正可简化的是韧性冗余层**：#1+#2 熔断三态机与 #3 重连退避职责重叠（同机小池无羊群），
   #8 observeProgress 无决策消费，#16 fs.watch 是 poll 之上的延迟优化。合计可删 ~80-100 行，
   但**收益有限**——它们不是复杂度大头。
3. **复杂度大头在拓扑与路由语义**，不在韧性常量：pool-supervisor 状态机 ~600 行（spawn/adopt/探测/stop）、
   routeInvoke 重试循环 ~115 行、configureSplitMerge ~75 行、N×M 连接+三张 node 本地软表。
   这些是 ADR-106 已批拓扑的固有成本，同机单 node 场景确实「分布式级配置干本地活」。
4. **opt-out 今天已存在**：双开关缺省关（tools_engine.mode=child + gateway.engine_pool.size=0，
   packages/config/src/types.ts:600,1173-1175；src/bootstrap.ts:1199,1246），child 路径逐字保留、本地模式恒 child。
   「不需要 pool 的人可不装」的**运行时**诉求已满足；A1 要解决的是**打包/装配**层面「不装=无 pool 代码」，
   属插件化重构，不是删韧性机制。
5. **结论**：不建议为同机场景砍正确性机制；建议 (a) 简化 #1/#2/#8/#16 冗余韧性层（小刀），
   (b) 把 pool 整体按 A1 做成可选 Platform 插件（大刀，ADR 级），让不需要者连代码都不加载。
   单 node 用户的最优解是缺省 child（现态已如此），而非把 pool 改薄。

## 三、opt-out / 插件化设计（对齐 IDEAL-ARCHITECTURE A1）

### 3.1 现态：运行时 opt-out 已闭环，打包 opt-out 未闭环
- 双开关缺省关：`tools_engine.mode: child|pool`（缺省 child，packages/config/src/types.ts:1173-1175）
  + `gateway.engine_pool.size`（缺省 0，types.ts:600）。本地模式（无 gateway）恒 child。
- 装配分叉：src/bootstrap.ts:1199 `mode==='pool'` → createPoolTransport；else → createEngineSupervisor
  （bootstrap.ts:1245-1279，child 路径逐字保留）。gateway 侧：gateway-command.ts:3021,3054 size>0 才建 supervisor。
- 回退 = 翻配置 + node 重启（ADR-106 决策 10）。**「不需要 pool 的人可不启用」已满足。**
- 未满足的是「不装 = 无 pool 代码」：bootstrap.ts:19 静态 import createPoolTransport，
  engine-client index.ts:14 静态导出 pool.ts → child 模式下 1173 行 pool 代码仍被加载求值。
  A1 的增量价值在**打包/装配层**，不在运行时开关。

### 3.2 A1 目标形态：执行提供者插件
- 端口已存在：`EngineTransport`（protocol.ts）就是执行提供者 seam——forward/registry/client
  消费面零改动（pool.ts:4-5 已证）。补 start/stop 生命周期即成 ExecutionProvider 端口，零新 wire。
- 三实现：in-process（直调 handler，无 IPC，A1 新增）/ child（现 supervisor.ts，装配层基础设施）
  / pool（PoolTransport + gateway pool-supervisor，可选 Platform 插件）。
- basic-tools 只注册工具定义；wireTool 路由到提供者（wiring.ts:43-65 白名单接线点已是该形状）。
- 归属：pool-supervisor 归 platform 侧（src/gateway/，ADR-101/103）；PoolTransport 归 node 侧
  能力插件（engine-client 已是插件，ADR-039 同形）。不装 = 无 pool。

### 3.3 配置面（零新键，宪法 10）
- 保留现有两键作提供者选择面；未来 in-process 只是 mode 新枚举值，不加键。
- 语义变化：`mode=pool` 从「静态 import 建 PoolTransport」→「解析已安装执行提供者插件；
  未安装 → fail-closed 稳定错误（engine_unavailable + 诊断），**不静默回退 child**」。
- `gateway.engine_pool.size>0` 而 pool 插件未装 → gateway logger.error 不 spawn（不静默忽略）。
- config validator 增静态检查：mode=pool ⇒ pool 插件已安装（启动前报错优于运行期工具瘫）。

### 3.4 无 pool 缺省 child 路径
- 缺省 child 逐字不变；child supervisor 留装配层（非插件），保证无 pool 时零回归。
- 第一步（小刀）：bootstrap pool 分支改动态 `await import(...)` → child 模式不求值 pool.ts。
- 终态（A1 大刀）：pool 独立插件包，不装 = node_modules 无此包；engine-client 核心只留
  EngineTransport 端口 + child transport；pool.ts 随插件走。

### 3.5 迁移步骤（增量，每步独立可回退）
1. **M1 seam 冻结**：ExecutionProvider = EngineTransport + start/stop，立契约（零新 wire/零新 RPC）。
2. **M2 动态 import**：bootstrap pool 分支异步化；child 路径逐字不动；门禁 + 用户行为验证
   （child 回归 / pool 灰度各一轮）。此步独立交付「child 模式不加载 pool 代码」。
3. **M3 插件打包**：pool-supervisor 走 platform 插件贡献面（ADR-099/103）；PoolTransport 作
   engine-client 可选导出；catalog 声明 provides: execution-provider。
4. **M4 提供者解析**：mode → 插件解析 + 未装 fail-closed + validator 静态检查。
5. **M5（可选，A4 hybrid）**：RoutingTransport 按类别+工具名混搭 child+pool；
   前置 = 阶段③ pool 验证 + pool 三修复（IDEAL-ARCHITECTURE A4 已留档 DECISION/CONTRACT）。

### 3.6 风险
- **R1 装配时序**：现 pool transport 构造同步（bootstrap.ts:1210），动态 import 异步化需调装配序；
  缓解 = getTransport 晚绑定形状不变（bootstrap.ts:1195），await 完成前转发 fail-closed。
- **R2 生命周期不对称**：pool-supervisor 是 detached+adopt，gateway restart 不杀池（ADR-106 决策 2）；
  插件化**不得**把 supervisor 塞进随 stdin EOF 死的 child 插件进程——platform 插件宿主须保 adopt 语义。
- **R3 fail-closed 漂移**：未装/解析失败必须稳定报错，绝不静默回退 child/in-process（pool.ts:17 纪律）。
- **R4 升级兼容**：现 mode=pool 用户升级后若插件缺省不装 → 工具瘫。缓解 = pool 插件**缺省安装、
  缺省不启用**（opt-out = 卸载，而非缺省 absent）；双开关语义不变。
- **R5 回归面扩大**：child / pool(装+启) / pool(未装 fail-closed) 三组合行为验证矩阵，
  不能只测 happy path（复盘 S 系列教训）。
- **R6 排序**：A1 是 ADR 级最大重构，IDEAL-ARCHITECTURE 排序最后（第 5）；前置 = 可用性修通 +
  阶段③ pool 验证。本评审不建议立即启动 M3-M5；M2 动态 import 可先行（小刀，独立收益）。