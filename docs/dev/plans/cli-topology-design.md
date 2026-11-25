# CLI 命令拓扑梳理设计（cli-topology）

状态：设计稿（纯文档，零代码改动）。分支 design/q-cli-topology（基于 redblue-dev）。
任务来源：用户裁定五条（①–⑤）+ main 设计意见六条 + 用户追加语义裁定四条（⑥–⑨，含今晨金丝雀 stale 案例）。
行为验证归用户；本设计不引入测试/探针/临时进程。
姊妹文档：`docs/dev/plans/graceful-restart-design.md`（drain-to-quiesce / resume 语义的地基，本文不重复设计，只引用与接线）。

## 目录

- §0 摘要与决策速览
- §1 现状盘点（代码锚点）
- §2 目标命令矩阵（现状 → 目标）
- §3 舰队边界（dataDir 解析链与 env 继承教训）
- §4 `vessel start`：舰队级全量启动编排（幂等）
- §5 `vessel stop`：递归优雅停止（时序论证 + graceful/force 语义 + 升级阶梯）
- §6 组件级 stop 语义（gateway / node / hub）
- §7 `vessel restart`：stop + start 编排
- §8 兼容与弃用路径（--stop-nodes / docs / i18n / completion）
- §9 幂等与 stale lock 清理（含今晨金丝雀「锁记录与实际进程脱节」案例）
- §10 与 q-canary-topology 调研衔接（单 gateway 多 node 的命令面演进接口）
- §11 分期（P1 命令面 / P2 优雅递归 / P3 清理）
- §12 风险与开放问题

## 0. 摘要与决策速览

### 0.1 一句话

把 CLI 启动/停止命令面从「gateway 一词多义（平台进程 / 事实上的舰队编排）」梳理成两层：
**舰队层 `vessel start/stop/restart` = 薄编排**（检测 → 按依赖序调用各组件自己的 start/stop → 汇总），
**组件层 `vessel gateway|node|hub start/stop` = 只管自己的进程**（编排不代管组件生命周期，组件不越权停别人）。
优雅是常态（默认路径，不限时间但进度可见）；切断会话是显式 `--force` 才有的非正常退出，必须审计留痕。

### 0.2 用户裁定与 main 意见的落点

| 来源 | 主张 | 本文落点 |
|---|---|---|
| 用户① | `vessel start` = 舰队级全量启动编排（代替 gateway start 事实上的全量启动）；幂等 | §4 |
| 用户② | `gateway start/stop/restart` 只操控 gateway 进程，不碰 node/hub；移除 --stop-nodes | §6.1、§8 |
| 用户③ | `vessel stop` = 递归优雅停止：检测本舰队运行中组件 → 按依赖序调用各组件自己的 stop；默认优雅不限时间；--force 递归传播 | §5 |
| 用户④ | `vessel restart` = stop + start 编排（代替 gateway restart --stop-nodes） | §7 |
| 用户⑤ | node stop 等组件级 stop 默认优雅 + --force | §6.2、§6.3 |
| 用户⑥（追加） | 优雅 = 常态；会话被切断 = 非正常退出，仅 --force 显式触发，日志/审计标记「非正常退出，N 个 run 被切断」，不能静默 | §5.4 |
| 用户⑦（追加） | 升级阶梯：优雅等待（drain 进度可见）→ 外科手术式取消单个占用 run（复用现有 interrupt/cancel 机制）→ --force 全杀；force 不必全有全无 | §5.5 |
| 用户⑧（追加） | 非正常退出：被切断 session 标记 interrupted/crashed（非 completed），下次启动走既有恢复/续话机制；优雅停止全量干净落盘 | §5.4、§5.6 |
| 用户⑨（追加） | 优雅启动常态 = 幂等：检测 → adopt 或清理 stale → spawn → 健康确认 | §4.2、§9 |
| main-1 | 舰队边界：检测/操作严格限本舰队 dataDir；跨舰队必须显式 --user-config（env 继承教训） | §3 |
| main-2 | 停止顺序与依赖：给出方案并论证 | §5.2 |
| main-3 | 不限时间 ≠ 无反馈：drain 进度输出（哪些 run/session 还在跑），可另端 --force 升级 | §5.3、§5.5 |
| main-4 | 兼容：--stop-nodes 弃用路径（warning + 等价映射 vessel restart），docs/交接口径同步 | §8 |
| main-5 | 幂等 / stale lock 清理（金丝雀现 stale lock 实例） | §9 |
| main-6 | 与 q-canary-topology 衔接：单 gateway 多 node 若成立，命令面如何演进——留接口不预判结论 | §10 |

### 0.3 关键决策速览（细节见各节）

- **D1（两层命令面）**：舰队层 `vessel start/stop/restart` 是薄编排，只读清点 + 按依赖序调用各组件自己的 start/stop 接缝，汇总退出码；组件层命令只操控自己的进程。
  编排不代管组件生命周期（用户③的解耦要求），组件也不越权停别人（gateway stop 不再杀 node/hub）。
- **D2（启动职责上移）**：今天 `gateway start` 前台管线里的「spawn auto_start 节点 + 拉起 hub」
  职责上移到 `vessel start` 编排层；`gateway start` 退化为纯平台进程启动（bind + 守卫 + 写 platform.pid）。
  adopt 保留为平台的**只读检测/登记**能力（代理需要知道 node），不再是生命周期动作。
- **D3（停止顺序）**：node 先 drain（各自 fence 拒新 + 优雅落盘）→ gateway 停 → hub 停。
  论证见 §5.2：把最长的等待放在观测面（平台代理/WebUI）还活着的时候，fence 权威在 node 准入层，
  hub 是 node 出站事件的依赖所以最后停。
- **D4（graceful 默认不限时 + 进度可见）**：组件级 stop 默认走进程内 drain（引用 graceful-restart-design
  的 drain-to-quiesce），等待无硬 deadline；停止方每 5s 打印 drain 进度（哪些 run/session 还在跑）。
  现有 10s 强杀回退（`DEFAULT_STOP_TIMEOUT_MS` / `GRACEFUL_SHUTDOWN_TIMEOUT_MS`）从默认路径移除，
  只保留为显式 `--timeout` 的可选上限。
- **D5（force = 非正常退出，审计留痕）**：`--force` 跳过优雅等待直接终止（POSIX SIGKILL / Windows
  process.kill + taskkill /T /F），终止前快照在跑 run，结构化审计行「非正常退出，N 个 run 被切断」
  （组件、pid、run/session 清单）；被切断 session 走既有 interrupted/crashed 恢复路径，不标 completed。
- **D6（升级阶梯）**：优雅等待 → 外科手术式取消单个阻塞 run（复用 `runs.cancel` RPC / agent send interrupt）
  → `--force` 全杀。force 不必全有全无：先试精准取消占用者让优雅完成（§5.5）。
- **D7（node stop 解除 managed 拒绝）**：新拓扑下平台不再代管 node 生命周期，`node stop` 对托管节点
  不再拒绝（改提示行），成为 node 停止的唯一正规路径；supervisor/watchdog 对「有意停止」不 respawn（§6.2）。
- **D8（hub stop 新增）**：hub 今天没有 stop 命令（只能被 `gateway stop --stop-nodes` 顺带杀）。
  新增 `vessel hub stop`（graceful + --force），hub 无 run 面，优雅 = 停受理 + flush + 退出。
- **D9（stale-adopt 对账）**：stale 清理前先探记录端口的 health——若端口上有活的 vessel 进程
  （pid 与记录不符）→ 对账/adopt 重写记录，而不是宣布「未运行」再 spawn 撞端口。
  覆盖今晨金丝雀案例（记录 pid 132924 已死、实际 pid 46932 在 8652 健康服务）。
  需要 platform health 载荷 additive 增加 pid/started_at（§9.3）。
- **D10（舰队边界）**：清点/操作严格限解析出的本舰队 dataDir；`--all` = 本 dataDir 内全部实例，
  绝不跨 dataDir 枚举；跨舰队只能显式 `--user-config` / `--data-dir`。env 继承教训的防线见 §3。
- **D11（restart 失败策略）**：`vessel restart` = stop + start；stop 未全成 → 不 start（防双跑），
  如实报告并提示 --force 升级。`gateway restart` 保留为平台-only 热替换（handoff/adopt 语义不变）。
- **D12（分期）**：P1 命令面（注册 vessel start/restart、hub stop、弃用映射、--force 参数面）；
  P2 优雅递归（不限时 drain + 进度 + 升级阶梯 + 审计）；P3 清理（移除弃用 flag、stale 对账、残留治理）。

## 1. 现状盘点（代码锚点）

> 锚点基于 redblue-dev（4fc0fe8c）；已核对 src/cli 与生产 main（38ee0aec）无差异。

### 1.1 命令注册面

- 顶层分发：`src/cli/args.ts:767-817` —— `gateway` / `node` / `hub` / `status` / `stop` 等首词分发。
  **没有顶层 `start` / `restart`**（落入未知参数路径）。
- 一次性命令注册表：`src/cli/registry.ts:294-345` —— `gateway`（非前台子命令）、`node`（非前台）、
  `hub`、`stop`（→ `stopFleetCommand`）。
- 前台管线：`src/cli.ts:398-506` —— `gateway start/restart`（daemon=false）与 `node start`（daemon=false）
  接进 serve 管线；`gateway restart` 先经 `resolveRestartDaemonMode`（gateway-command.ts:721）按旧记录
  daemon 标记分流前台/后台。
- `vessel stop` 已存在：`src/cli/commands/fleet/stop-command.ts`（CONTRACT-stop-semantics S1–S7），
  本地 = 只读清点 → 确认 → `stopGateway({ keepNodes:false })` 共享接缝 → 池残留提示 → 汇总；
  远程 = 显式 `--connect` → registry 级清点 → `gateway.shutdown` 经 `/platform/rpc` → 轮询 health 至不可达。
- `vessel status` 已存在：`src/cli/commands/fleet/status-command.ts`（只读，DECISION-025 §1.5）。

### 1.2 gateway start = 事实上的全量启动

`runPlatformGatewayForeground`（gateway-command.ts:2760，模块注释 2756-2758）：
**平台 bind → spawn auto_start 节点 → 等每个节点 gateway.pid + /health → 写 platform.pid**；
本地 hub 默认随 gateway 自动拉起（2941-2944，`hub.auto_start:false` 关闭）；
任一节点失败 → 停已 spawn 子进程并停平台（回滚）。
`--daemon` 路径 `startDaemonCommand`（2189）spawn 分离子进程走同一前台管线，父进程等 platform.pid（waitMs 60s）。
节点来源：`nodes.json` registry（`loadNodeRegistry`）；无 registry = 隐式单节点（与平台共用 dataDir）。
子进程 env 显式注入 `VESSEL_DATA_DIR=<node dataDir>` + `VESSEL_NODE_TOKEN`（node-supervisor.ts:1336-1344）；
hub 子进程**不**设 VESSEL_DATA_DIR（node-supervisor.ts:1170，必须用 hub.dataDir）。

### 1.3 gateway stop / restart 与 --stop-nodes

- `stopGateway`（gateway-command.ts:892）：缺省 `keepNodes=true`（0.55.2）= **只停平台层**，
  node/hub 保活待下一次 start adopt（handoff marker，`src/gateway/handoff.ts`，TTL 120s）；
  `--stop-nodes`（= `--no-keep-nodes` 别名）= 连本机 spawn/接管且归属可复核的 node/hub 一起停。
- 子进程停止：`stopSpawnedChildren`（node-supervisor.ts:578）——只终止 manifest
  （`platform-children[-<instance>].json`）内条目，逐条复核归属（recordOwnsPid）；
  node 先试优雅（`tryGracefulNodeShutdown`:448，`gateway.shutdown` RPC + 等死 ≤10s），
  失败回退强杀（`terminateChild`:484，POSIX SIGTERM / Windows process.kill + taskkill /T /F 兜底）；
  hub 无 run 面不试优雅。未确认停止 → manifest 条目保留供重试。
- 平台进程停止：graceful-first（gateway-command.ts:1094-1176）——legacy node 走 node 链 token，
  platform 走平台链 token（`effectivePlatformToken`）经 `/platform/rpc` 的 `gateway.shutdown`；
  等死预算 = 停止方 timeoutMs（缺省 10s，`DEFAULT_STOP_TIMEOUT_MS` args.ts:1778）；
  超时/失败 → `terminateProcess` 强杀 + 代打 `node.drain.skipped` / `platform.drain.skipped`。
- `gateway restart`：daemon 路径 `restartDaemonCommand`（2356）= stopGateway（停前快照保留 instance/port/host）
  → startDaemonCommand；前台路径（2794-2839）同口径。**stopCode ≠ 0 → 直接返回不 start**
  ——昨日金丝雀「停了旧没起新」的直接机制（停止超时/失败即中止，无后续启动）。
- `gateway.shutdown` RPC：node 侧 `packages/serve/src/gateway/methods/admin.ts:105-124`
  （params 空对象，只受理 defer 一拍）；平台侧 `packages/serve/src/platform/rpc.ts:264+`
  （allowlist 唯一非只读项；远程需 `gateway.remote_shutdown` opt-in + 已配置密钥反代，fail-closed）。
  **两侧都不接受 force/timeout 参数**——等待预算恒在停止方（K5）。

### 1.4 node stop / hub 命令面

- `node stop`（node-command.ts:269）：两道 managed 判定（health role=platform / children manifest 含该 node）
  命中 → **稳定非 0 拒绝**并提示 `gateway stop`；独立 node → graceful RPC（等死 ≤10s）→ 强杀回退。
  无 --force 参数；10s 是硬编码。
- `node start --daemon`（node-command.ts:116）：独立 node 分离子进程；与 gateway 共享同一实例
  pid/lock（同 dataDir 只允许一个写者）。
- `hub` 子命令（args.ts:398-410 HubCommand）：start / directory / watch / join-code / join /
  node-list / node-remove —— **没有 stop**。standalone hub 今天只能被 `gateway stop --stop-nodes`
  顺带停（在 manifest 里时）；手工/外部 hub 走 adopt 不记 manifest，`gateway stop` 不杀它
  （fleet/stop-command.ts:212 注释「hub stop 不在本轮」）。

### 1.5 状态/锁模型与 drain 现状

- 状态文件：`<dataDir>/gateway[-<instance>].pid`（node 族）/ `platform[-<instance>].pid`（platform 族）
  + 实例锁 `gateway-<instance>.lock`（`src/gateway/instance-lock.ts`，pid + started_at + host）
  + owner 文件；`collectGatewayState`（src/gateway/pid.ts）单读入口，
  状态机 running / degraded / stale / starting / unknown / foreign-host（classifyGatewayRecord:347）。
- stale 清理：`cleanupGatewayStateEntry` 条件删除（文件被别人改过则不动）；
  `prepareForegroundGatewayStart`（gateway-command.ts:824-827）与 stopGateway（1008-1024）都会回收确认 stale。
- 进程内 drain：`src/gateway/shutdown-sequence.ts` —— beginDrain（fence 准入 + 写 resume 标记 +
  interrupt('shutdown') + ≤2s settle + flush）必须先于 gateway.stop()；
  `src/node-drain.ts` NODE_DRAIN_SETTLE_MS=2000（不 await 长工具/长模型流）。
  **今天的「优雅」是 2s settle 的打断式 drain，不是等 run 跑完**；drain-to-quiesce（不限时等待安全边界）
  是 graceful-restart-design.md 的设计面，本文 §5 的「默认优雅不限时」以该文档为地基接线，不另造语义。
- 停止方超时现状汇总：stopGateway 等死 10s；stopSpawnedChildren 优雅等死 10s（GRACEFUL_SHUTDOWN_TIMEOUT_MS）
  + 强杀等死 timeoutMs；node stop 优雅 10s + 强杀 10s；fleet stop 缺省 DEFAULT_STOP_TIMEOUT_MS=10s。
  昨日金丝雀 restart 坑根源 = 这些 10s 预算在长 drain 面前必然超时 → stopCode=1 → restart 中止不 start。