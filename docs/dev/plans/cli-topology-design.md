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
  昨日金丝雀 restart 坑根源 = 这些 10s 预算在长 drain 面前必然超时 → stopCode=1 → restart 中止不 start。## 2. 目标命令矩阵（现状 → 目标）

> 原则：**舰队层薄编排，组件层只管自己**。每个组件的 start/stop 都是独立可用的正规命令；
> 舰队命令 = 检测 + 按依赖序调用这些命令的共享接缝 + 汇总。表中「优雅」均指默认路径：
> 进程内 drain、不限时间、进度可见（§5.3）；`--force` 均为显式非正常退出（§5.4）。

### 2.1 舰队层

| 命令 | 现状 | 目标 |
|---|---|---|
| `vessel start` | **不存在**（未知参数） | 舰队级全量启动编排：检测本舰队组件 → 幂等（已运行跳过 / stale 对账清理 / adopt）→ 按依赖序 spawn（hub → gateway → nodes）→ 逐个健康确认 → 汇总。缺省后台化（组件各自 daemon），编排进程确认完即退出 |
| `vessel stop` | 已存在（薄编排 → `stopGateway({keepNodes:false})`，子进程先停再停平台，缺省 10s 超时） | 递归优雅停止：检测本舰队运行中组件（gateway/node/hub）→ 按依赖序调用**各组件自己的 stop**（node drain → gateway → hub）；默认优雅不限时间 + drain 进度；`--force` 递归传播；`--yes`/`--connect` 保留 |
| `vessel restart` | **不存在** | stop + start 编排（代替 `gateway restart --stop-nodes`）；stop 未全成 → 不 start；`--force` 传播到 stop 段 |
| `vessel status` | 已存在（只读清点） | 保留；输出补「组件级」视图（gateway/node/hub 各自状态行），与 stop 清点同口径（§5.1） |

### 2.2 组件层

| 命令 | 现状 | 目标 |
|---|---|---|
| `vessel gateway start [--daemon]` | 平台 bind + spawn auto_start nodes + 拉起 hub（事实全量启动） | **只启动平台进程**：守卫 → bind → 写 platform.pid。不 spawn node/hub；adopt 仅为只读检测/登记（代理需要）。前台/daemon 双模式保留 |
| `vessel gateway stop` | 缺省只停平台（keepNodes handoff）；`--stop-nodes` 连 node/hub 一起停 | **只停平台进程**，永不碰 node/hub（keepNodes 概念消失——本来就不碰）。graceful-first 保留（`gateway.shutdown` RPC → 等死），默认不限时 + 进度；`--force` 强杀 + 审计。`--stop-nodes`/`--keep-nodes`/`--no-keep-nodes` 弃用（§8） |
| `vessel gateway restart` | stop + start；缺省 keep nodes 待 adopt；`--stop-nodes` 冷重启全舰队 | **平台-only 热替换**（stop 平台 → start 平台；node/hub 天然保活，新平台 adopt 登记）。`--stop-nodes` 弃用 → warning + 等价映射 `vessel restart` |
| `vessel gateway reload/status/list/nodes …` | 已存在 | 不变（reload 是热加载不是重启；nodes 是 registry 管理面） |
| `vessel node start [--daemon] [--config]` | 独立 node；托管场景由平台 spawn | 不变；成为编排层 spawn node 的正规接缝（§4.3）。多 node 寻址接口预留 `--node <name>`（§10） |
| `vessel node stop` | managed → 拒绝（exit 1）；独立 → 优雅 10s → 强杀 | **默认优雅不限时 + 进度；`--force` 强杀 + 审计**。解除 managed 拒绝（改提示行「由平台实例 X 托管；只停本 node」）；supervisor/watchdog 对有意停止不 respawn（§6.2） |
| `vessel node status/reload/token` | 已存在 | 不变 |
| `vessel hub start …` | 已存在（start/directory/watch/join/…） | 不变 |
| `vessel hub stop` | **不存在** | 新增：默认优雅（停受理 + flush + 退出，hub 无 run 面）+ `--force`；寻址 = `config.hub.dataDir` 或 `<dataDir>/hub` 的 hub.lock（§6.3） |

### 2.3 选择器与参数口径

- 实例选择器 `--instance / --port / --all` 语义不变（args.ts GatewaySelector）；
  **`--all` 恒 = 本舰队 dataDir 内全部实例**，绝不跨 dataDir（§3）。
- 舰队层缺省 = 本舰队全量（stop 已有先例：空选择器归一 `{all:true}`，args.ts:2862-2871）；
  start/restart 同口径。
- `--timeout <dur>`：从「缺省 10s 硬预算」改为**可选显式上限**（缺省 = 不限时）。
  显式给了 --timeout 而超时 → 不自动强杀，如实报告阻塞者并提示升级阶梯（§5.5）；
  这与 graceful-restart-design D5「超时中止不硬杀」同哲学。
- `--force`：舰队层递归传播到每个组件 stop 的 force；组件层只作用于自己。
- `--yes`：跳过确认（stop/restart 保留现有 S3 规则：非交互无 --yes 拒绝）。
- `--connect`（远程 stop）：P1 不动（远程不强杀、生命周期强杀恒本机的既有边界保留）。

## 3. 舰队边界（dataDir 解析链与 env 继承教训）

### 3.1 解析链与边界定义

舰队 = **一次命令解析出的 dataDir 所圈定的状态文件集合**：
`resolveDataDir(config, env)`（src/data/data-paths.ts:41）= `config.dataDir` > `VESSEL_DATA_DIR` env 兜底 > 缺省根。
config 来自 `--user-config <path>` 指定的文件（缺省 `~/.vessel/config.yaml`）；`--data-dir` 是显式覆盖。

边界规则（设计约束，实现必须遵守）：

1. **清点/操作严格限本舰队**：`collectGatewayState(dataDir)`、registry（`<dataDir>/nodes.json`）、
   manifest（`<dataDir>/platform-children*.json`）、hub lock（`config.hub.dataDir` 或 `<dataDir>/hub`）
   ——全部以解析出的 dataDir 为根。**绝不枚举兄弟舰队目录**（不 readdir 上级、不扫 `~/.vessel` 全根）。
2. **`--all` 不越界**：allInstances 扫描（stopSpawnedChildren:587-597）只 readdir 本 dataDir 的
   manifest 文件，现状已合规；新编排沿用同一口径。
3. **跨舰队必须显式**：要操作另一舰队，只能显式 `--user-config <该舰队配置>` 或 `--data-dir <该舰队根>`。
   不提供隐式「发现所有舰队」的命令（未来若需要，是另一个显式 `vessel fleets list` 提案，不在本轮）。
4. **registry 节点的 dataDir 可以不同于舰队根**（显式 registry 节点各有自己的 data_dir，
   node-command.ts:241 先例）——舰队成员资格由**本舰队 registry/manifest 的登记**决定，
   不是路径包含关系。停 node 时寻址用该节点自己的 data_dir（manifest/registry 已记录），
   但**枚举入口**恒为本舰队文件。
5. **清点抬头必须打印解析出的 dataDir**（stop.inventory.title 已有先例），让用户在确认前
   看见「我要动的是哪个舰队」。start/restart 同口径。

### 3.2 env 继承教训的防线

昨日事故：interop 进程继承宿主 `VESSEL_DATA_DIR=生产`，导致跨舰队误操作。防线分三层：

- **解析层**：`VESSEL_DATA_DIR` 只是兜底（config.dataDir 优先）。舰队命令在清点抬头打印
  生效 dataDir 与**来源**（config / --data-dir / env 兜底）；来源 = env 兜底时加一行 warning
  「dataDir 来自继承环境变量 VESSEL_DATA_DIR，跨舰队操作请显式 --user-config」。
- **spawn 层**：编排 spawn 子进程时**显式注入**目标组件的 dataDir（node 已有先例
  node-supervisor.ts:1338 `VESSEL_DATA_DIR: spec.dataDir`；hub 刻意不设、用 hub.dataDir，:1170）。
  新编排层沿用：子进程 env 里的 VESSEL_DATA_DIR 恒为**该组件自己的** dataDir，
  绝不透传编排进程继承来的值。daemon spawn（src/gateway/daemon.ts）同口径核对。
- **确认层**：破坏性命令（stop/restart）的 S3 确认保留；确认提示里带 dataDir，
  非交互无 --yes 拒绝（既有规则不动）。

### 3.3 与远程分支的关系

`vessel stop --connect` 的远程边界不变：只认显式 flag（不认 VESSEL_CONNECT env，S1 先例）、
registry 级清点、远程不强杀。舰队边界规则同样适用：远程目标 = 显式 URL，不做发现式扫描。## 4. `vessel start`：舰队级全量启动编排（幂等）

### 4.1 职责与形态

`vessel start` = 舰队级薄编排（新注册：args.ts 顶层分发 + registry.ts 一次性命令）：

```
vessel start [--instance N | --port N | --all] [--yes] [--user-config <path>] [--data-dir <path>]
```

- 缺省后台化：编排进程依次把组件以 daemon 形态拉起（复用各组件既有 daemon 接缝），
  逐个健康确认后退出；输出逐组件一行（started / skipped(running) / adopted / failed+原因）。
- 前台需求留给组件层（`gateway start` 前台管线保留，供开发调试）；
  `vessel start --foreground` 不在本轮（开放问题 §12）。
- 编排**不**新造进程管理实体：不写自己的 pid/lock，不新增状态文件；
  全部状态仍是各组件既有的 pid/lock/manifest/registry（单一真相源）。

### 4.2 幂等序列（用户⑨：检测 → adopt 或清理 stale → spawn → 健康确认）

对每个组件（按 §4.3 顺序）执行同一四拍：

1. **检测**：读该组件状态文件 + 探活（collectGatewayState / hub.lock + isProcessAlive / health 探测）。
2. **分流**：
   - `running`（身份已确认）→ **跳过**，输出 `skipped (already running, pid N)`——幂等核心；
   - `stale` → 先走 **stale-adopt 对账**（§9.3：端口上有活的 vessel 进程 → 对账重写记录并视为 running 跳过；
     确认无活进程 → 条件清理 pid/lock/owner）再 spawn；
   - `starting` → 有界等待（沿用 daemon 等待预算）后重检；仍未就绪 → 报告失败，不重复 spawn；
   - `unknown` / `foreign-host` → **拒绝且不动文件**（既有 fail-closed 口径），汇总 exit 1；
   - 无记录 → spawn。
3. **spawn**：调用组件自己的 daemon start 接缝（不绕过其守卫：端口校验、duplicate_node_id、
   implicit_node_conflict、platformListenError 全部保留在组件层）。
4. **健康确认**：等该组件的 pid 文件 + health（node readiness 既有上限 20s；平台 waitMs 60s 先例），
   确认后才进入下一个组件；失败 → 记录并继续下一组件（§4.4 失败策略）。

### 4.3 启动顺序与依赖论证

**hub → gateway（平台）→ nodes（registry auto_start / 隐式单节点）**。

- hub 先：node 的出站事件（`hub.direction: node`，cli.ts:1804-1825）拨号 hub；
  事件 sink 先就绪，node 起来即可注册/上报，避免启动窗口内的出站失败重试噪音。
  hub 无 run 面、启动快，先启后停都便宜。
- gateway 次：平台 bind 是 fail-fast 守卫最重的一步（端口/token/origin/implicit_node_conflict）；
  先过守卫再拉 node，避免「node 起来了平台 bind 失败」的半舰队。
  平台不再等 node 就绪才写 platform.pid（职责上移后平台只对自己负责）——
  **这是与现状的关键差异**：现状平台写 PID 以 node 就绪为前提（gateway-command.ts:2256），
  新拓扑下平台 PID 只代表平台监听就绪，node 就绪由编排层逐个确认并汇总。
- nodes 最后：按 registry 顺序（auto_start=true 的）逐个 spawn + 健康确认；
  无 registry → 隐式单节点（`node start --daemon`，dataDir = 舰队根）。
  node 之间无依赖，串行即可（P1 保守；并行是 P3 优化，不影响语义）。
- adopt 场景（平台热替换后 node 已在跑）：node 检测拍命中 running → 跳过；
  平台侧 adopt 登记（只读检测）照常发生——**adopt 是登记不是生命周期动作**（D2）。

### 4.4 失败策略：不自动回滚，收敛靠重跑

现状 gateway start 任一 node 失败 → 回滚（停已 spawn 子进程 + 停平台）。新编排**不自动回滚**：

- 已健康确认的组件保持运行（它们可能已在服务会话；停它们 = 破坏性动作，须显式）；
- 失败组件如实报告（原因 + 日志路径），汇总 exit 1；
- 用户修复后**重跑 `vessel start` 即收敛**（幂等：成功的跳过，只补失败的）——
  这正是幂等编排的红利；需要清场时显式 `vessel stop`。
- 例外：平台 bind 失败时还没有任何 node 被 spawn（顺序保证），无残留。

> 与现状回滚语义的差异是有意决策：回滚把「启动失败」升级成「停止已运行组件」，
> 在幂等编排下既无必要又危险。列入 §12 开放问题供 main 复核。

### 4.5 与 gateway start 的职责切分

- `gateway start` 前台管线（runPlatformGatewayForeground）剥离 spawn node/hub 段
  （2941-3095 的 hub autoStart / node phase A/B），只留平台 bind + 守卫 + platform.pid + adopt 登记。
- `startGatewayDaemon` 的 waitMs 语义随之简化（只等平台 PID，不再等 node readiness）。
- 剥离出的 spawn 逻辑不是删除而是**上移**：编排层复用 node-supervisor 的 spawn/manifest 写入接缝。
  manifest 写入者改为编排层调用的共享函数（平台只读 manifest 做代理登记/归属复核）；
  SpawnedChildRecord 形状不变。`gateway stop` 不再消费 manifest 停子进程。
- watchdog/supervisor 的 respawn 职责收窄为「崩溃自愈」（§6.2），不再承担 auto_start。## 5. `vessel stop`：递归优雅停止

### 5.1 检测（只读清点，本舰队）

沿用 fleet/stop-command.ts S2 清点并扩为**组件级**清单（与 `vessel status` 同口径）：

- gateway：collectGatewayState 全实例（platform 族；legacy node 族按 VESSEL_LEGACY_SERVE 分流不变）；
- node：registry 节点 + 隐式单节点 + manifest 子进程，逐个读其 dataDir 的 gateway.pid + 探活；
  registry 报告层区分 manifest 内（本舰队 spawn/接管）与 external（登记但非本舰队 spawn）——
  **登记即成员**：external/adopt 来源的节点同样属于本舰队停止范围（§3.1 规则 4），
  但「手工外部启动且未登记」的进程不动（无归属证据，既有 fail-closed 口径）；
- hub：hub.lock（config.hub.dataDir 或 <dataDir>/hub）+ 探活；
- 池残留：只读清点 + 提示（S5.4 不变，停止方不 terminate engine）。

清点抬头打印 dataDir + 来源（§3.2）；逐组件一行（kind/name/pid/state/url）；
`stop.warning.activeSessions` 警告保留；S3 确认规则不变（--yes / 非交互拒绝 / N 取消零杀）。

### 5.2 停止时序与依赖论证（main-2）

**推荐时序：nodes drain → gateway 停 → hub 停**（任务书方案 B 的精化版）：

```
vessel stop
  ├─ 1. 只读清点 + 确认（§5.1）
  ├─ 2. 对每个运行中 node 调用 node stop 共享接缝（串行；默认优雅不限时）
  │     node 进程内：beginDrain fence 拒新 → drain-to-quiesce（等活跃 run 到安全边界）
  │     → 写 resume 标记 → 干净落盘 → 退出
  │     停止方：每 5s 打印该 node 的 drain 进度（§5.3）
  ├─ 3. 对每个运行中 gateway 实例调用 gateway stop 共享接缝
  │     平台进程内：gateway.shutdown 受理 → 关监听/代理 → lock.release → 退出
  │     （平台无 run 面，等待短；node 已停，无 handoff 保活需求，清残留 marker）
  ├─ 4. hub stop 共享接缝（停受理 + flush + 退出）
  └─ 5. 池残留提示 + 逐组件汇总（stopped / failed+原因 / skipped(not running)）
```

论证（对比方案 A「gateway 先停接收 → node drain → gateway 退出」）：

- **fence 权威在 node 准入层**（beginDrain beginFence），不在平台代理。方案 A 需要给平台
  新增「只 fence 不退出」的中间态（新 RPC/新状态），而方案 B 里 node 自己的 beginDrain
  第一拍就拒新 run——平台代理转发来的新请求会拿到 node 的干净拒绝，**无需平台中间态**。
- **最长的等待发生在观测面还活着的时候**：node drain 可能分钟级（长工具/长模型流）；
  方案 B 期间平台代理/WebUI 仍在，用户能在 UI 里看 run 状态、经代理做外科手术式取消（§5.5）；
  方案 A 先杀平台则 drain 期间 UI 全黑，进度只能靠 CLI 轮询 node 端口，体验倒退。
- **hub 最后停**：node 出站事件（hub.direction=node）依赖 hub 活着才能把 drain 期间的
  终态事件/标记同步出去；hub 无 run 面，停它最快，放最后不拖长总时长。
- **gateway 在 node 之后停**：平台无 run 面，它的优雅退出不依赖 node；
  反过来若平台先死，node 的代理注册/心跳会报错制造噪音。node 全停后平台退出是干净收尾。
- **失败隔离**：某 node 未确认停止 → 记录失败、继续其余组件（编排不代管生命周期，
  残留 node 是独立进程，如实报告 + 记录保留供重试）；gateway/hub 失败同理；汇总 exit 1。
  与现状 stopSpawnedChildren「未确认停止保留条目」同哲学。
- **--force 时序**：同一依赖序，但每个组件走 force 分支（§5.4）；
  顺序仍保持（先 node 后 gateway 后 hub），保证审计快照时观测面还在、
  且 hub 最后死让 node 的最后一批事件有机会出去。

### 5.3 不限时间 ≠ 无反馈（main-3）

- 组件 stop 共享接缝接受 `onProgress` 回调（镜像既有 `onDrainSkipped` 注入缝，
  node-supervisor.ts:536 先例）；编排层把回调渲染为进度行。
- 进度数据源：node 的既有 RPC 快照面（`gatewayStatusRpc` 消费的 runControl/scheduler 快照：
  running/queued run 清单，含 run_id/session_id/已运行时长）。drain 期间 node 监听仍在
  （fence 只拒新 run，不关读面），停止方每 5s 拉一次：

  ```
  ⏳ node default: draining… 2 run(s) active (waited 35s)
     run a1b2c3 (session s-foo, 4m12s, tool bash running)
     run d4e5f6 (session s-bar, 1m03s, llm streaming)
     escalate: vessel runs cancel a1b2c3   |   vessel stop --force
  ```

- 进度行同时给出**升级阶梯的下一步命令**（§5.5），防「看起来卡死」：
  用户随时知道在等什么、能做什么。
- 另端升级：另一终端执行 `vessel stop --force` 不需要等待第一个进程——force 分支直接
  归属复核 + 终止（幂等：第一个编排进程随后发现进程已死，按 stopped 汇总）。
  两个编排进程并发不互斥（无编排锁），安全性由组件层归属复核 + 条件清理保证（§9）。
- Ctrl-C 语义：第一次 Ctrl-C 打印「仍在等待 drain；再按一次中止编排（组件继续 drain），
  或另端 --force 升级」；第二次中止编排进程本身，**不**顺手杀组件（优雅意图不被误触升级）。
- 显式 `--timeout`：到点不自动强杀，打印阻塞者快照 + 升级提示，exit 1（D4）。

### 5.4 graceful / force 语义与审计（用户⑥⑧）

**graceful（默认）**：
- 组件进程内跑完整退出序列（shutdown-sequence：beginDrain → gateway.stop → transport →
  closeTenants → shutdown）；drain 段按 graceful-restart-design 的 drain-to-quiesce
  等活跃 run 到安全边界（无在途工具 + 无未落盘模型输出），**不 interrupt**；
- 全量干净落盘：resume 标记（如需续跑）、transcript、usage、inbox 持久化全部 flush；
- 会话状态 = 正常终态（run 自然 completed，或干净 checkpoint 的 interrupted-可续跑）；
- 停止方确认自死才算停成（waitUntilDead 无 deadline 版），条件清理 pid/lock/owner。

**force（显式 --force，递归传播）**：
- 跳过优雅等待：终止前**先快照**在跑 run（runControl 快照 RPC；拿不到则如实记「快照不可用」），
  然后 POSIX SIGKILL / Windows process.kill + taskkill /T /F（terminateChild force 先例，
  node-supervisor.ts:481-507）；
- **审计留痕，不能静默**（用户⑥）：停止方代打结构化审计行（镜像 node.drain.skipped 先例）：

  ```
  ⚠ stop.forced component=node name=default pid=12345 abnormal_exit=true runs_cut=2
    sessions=[s-foo,s-bar] runs=[a1b2c3,d4e5f6] signal=SIGKILL
  ```

  同时写入舰队日志（结构化事件，与 web.build.interrupted 代打同机制）；
  汇总行明示「非正常退出：N 个 run 被切断」（i18n en/zh-CN 同步）；
- **状态语义**（用户⑧）：被切断 session 不是 completed——进程内来不及写 checkpoint 时，
  下次启动的既有恢复路径（node-resume 扫 marker / 悬空 tool_use 合成 / ensureSessionShell /
  rotate handoff / inbox 持久化）按 interrupted/crashed 处理（graceful-restart-design D9 的
  「有疤模式」：恢复卡 + nudge + outcome unknown 合成，先核对再继续）。
  force 路径**不新增**状态实体，复用既有 marker/恢复机制；审计行是停止方的如实记录，
  不是第二真相源。
- force 仍做归属复核（pid + started_at / recordOwnsPid）与条件清理——
  **force 升级的是等待策略，不是归属判据**（绝不杀身份未确认的进程）。

### 5.5 升级阶梯（用户⑦）

```
第一级：优雅等待（默认）——drain 进度可见（§5.3），run 自然走到安全边界
第二级：外科手术式取消单个阻塞 run——进度行给出 run_id，用户另端执行精准取消，
        让优雅 drain 自行完成（不必全杀）
第三级：vessel stop --force——全舰队非正常退出（审计留痕）
```

第二级的机制复用（不新造执行面）：
- `runs.cancel` RPC 已存在（packages/serve/src/gateway/methods/runs.ts:276，
  含 save_failed 审计先例）；agent send interrupt 是成员级取消的既有通道。
- CLI 面：新增薄包装 `vessel runs cancel <run_id> [--node <name>]`（P2，additive；
  寻址 = 本舰队 node 的 RPC 目标，经平台代理或直连 node 端口），
  取消后 drain 进度行自然收敛——这就是「force 不必全有全无」的落点。
- 编排进程自身不做自动升级（默认路径永远优雅）；升级决策恒在用户/运维 agent 手里。

### 5.6 与 graceful-restart-design 的分工

- 该文档负责**进程内** drain-to-quiesce / resume 清单 / auto-resume / 无感-有疤两模式的语义；
- 本文负责**命令面**：谁调用谁、等待预算在哪、进度怎么输出、force 怎么传播与审计；
- 接线点：组件 stop 共享接缝的 graceful 分支 = 触发该文档的 drain 模式（intent: 'stop'），
  等待无 deadline；`vessel restart` 的 stop 段用 intent: 'restart'（quiesce 后 auto-resume 续跑）。
  两段共用同一套进度/升级/审计机制；该文档未落地前，P1 的 graceful 分支退化为
  现有 beginDrain（2s settle）+ 不限时等死，语义差异在 §11 分期里显式标注。## 6. 组件级 stop 语义（gateway / node / hub）

> 共同口径（用户⑤）：默认优雅（进程内 drain + 停止方不限时等死 + 进度回调）；
> `--force` = 显式非正常退出（快照 + 强杀 + 审计，§5.4）；归属复核与条件清理两分支共用。
> 每个组件 stop 都导出**共享接缝函数**（供舰队编排调用，镜像 stopGateway 被 fleet stop 复用的先例），
> CLI 命令与编排调用同一函数——「编排调用各组件自己的 stop」不是 shell 出去再跑一遍 CLI，
> 而是进程内调用同一接缝（无子 CLI 进程、无 env 二次继承风险）。

### 6.1 gateway stop / restart（平台-only）

- `stopGateway` 收窄：删除 keepNodes 分支与 stopSpawnedChildren 调用（944-991 段），
  只保留平台进程停止（graceful-first RPC → 等死 → 条件清理 → reportChildLifecycle 改为
  **只读交代**「node/hub 仍在跑，停它们用 vessel stop」）。
- handoff marker：`gateway restart`（平台热替换）仍写 marker 供新平台 adopt 登记；
  `gateway stop`（真停）清残留 marker（现状 1087-1093 逻辑保留，keepForHandoff 判据改为
  「调用方是 restart 还是 stop」而非 keepNodes 参数）。
- `gateway restart` = 平台 stop + 平台 start（daemon/前台双路径保留，resolveRestartDaemonMode 不变）；
  node/hub 天然保活（根本不被触碰），新平台 adopt 登记后照常代理。
  「node 仍跑旧代码」提示保留，升级命令改为 `vessel restart`（§8）。
- 平台 graceful 等待默认不限时（平台无 run 面，实际等待短）；`--force` 同 §5.4
  （平台审计行 runs_cut 恒 0——平台不跑 run；仍记录 abnormal_exit）。

### 6.2 node stop（解除 managed 拒绝 + 优雅不限时）

- **解除拒绝**：node-command.ts:294-304 的两道 managed 判定从「拒绝 exit 1」改为「提示行」：
  `node default 由平台实例 X 托管；只停本 node（平台与其他 node 不受影响）`。
  理由：新拓扑下平台不再代管 node 生命周期（D2），node stop 是 node 停止的唯一正规路径；
  舰队编排（§5.2 第 2 拍）调用的就是它。保留判定本身用于**提示与审计**（托管关系如实可见）。
- **supervisor/watchdog 协调（防 respawn 打架）**：平台侧 NodeSupervisor/watchdog 今天对
  子进程退出有 respawn/stall-restart 逻辑（watchdog.ts:181-205）。有意停止必须不被 respawn：
  - graceful 分支：node 进程内 drain 写 resume 标记 + 正常退出码；supervisor 检测到
    「drain 标记存在 / 退出码=有意停止」→ 标记该 node 为 stopped-intentional，不 respawn、
    从 manifest 移除条目（或标 stopped），watchdog 不探活（watchdog.ts:16 已有
    「正在 stop/restart 不探活」先例，扩展为「有意停止不探活」）。
  - force 分支：停止方在终止前写**stop-intent 记录**（复用 handoff marker 的文件模式，
    新增 kind:'stop'，TTL 同 120s 先例）——Windows 强杀下宿主来不及自证，
    supervisor 见 marker 即知是有意停止。marker 消费后清理（consumeHandoffMarker 先例）。
  - 崩溃（无 marker、非零退出）→ 既有自愈 respawn 不变。
- **优雅不限时**：删除硬编码 10s（node-command.ts:316/347），graceful 等死无 deadline +
  onProgress（§5.3）；`--timeout` 可选上限（到点报告不强杀）。
- `--force`：快照 + SIGKILL/taskkill + stop.forced 审计（§5.4）+ stop-intent marker。
- 多 node 寻址：P1 维持隐式单节点/registry 缺省口径；`--node <name>` 接口预留（§10）。

### 6.3 hub stop（新增）

- 寻址：`config.hub.dataDir`（expandHome + resolve）或 `<dataDir>/hub` 的 hub.lock
  （readHubLockFile 先例，gateway-command.ts:1319）；lock 缺失/死 pid → 「未运行」+ stale 清理。
- graceful：hub 无 run 面——进程内停受理（关监听）+ flush 落盘 + 退出；
  触发接缝 = hub 进程新增 shutdown 受理（镜像 node admin.ts gateway.shutdown 的
  「只受理 defer 一拍」形状；hub 已有 HTTP 面，additive 一个 admin 端点/RPC）。
  老 hub 无该端点 → not_found → 如实报告并提示 --force（不假成功，镜像平台老版本回退先例）。
- `--force`：归属复核（hub.lock pid + 探活）+ 强杀 + 审计（runs_cut 恒 0）。
- 舰队编排第 4 拍调用本接缝；standalone hub（不在任何 manifest）从此有正规停止路径
  （补上 fleet/stop-command.ts:212「hub stop 不在本轮」的缺口）。

## 7. `vessel restart`：stop + start 编排

```
vessel restart [--instance N | --port N | --all] [--force] [--yes] [--timeout <dur>]
```

- 语义 = `vessel stop`（§5 全部机制：清点/确认/递归优雅/进度/升级阶梯）
  → 全成后 `vessel start`（§4 幂等编排）。
- **stop 未全成 → 不 start**（防双跑/端口冲突；现状 restartDaemonCommand 的
  stopCode≠0 即返回先例保留），如实报告失败组件 + 提示 `vessel stop --force` 升级后重跑。
  昨日金丝雀「停了旧没起新」的坑在新命令面下的正解：失败可见 + 升级阶梯 + 幂等重跑收敛，
  而不是把停止预算调大碰运气。
- `--force` 只传播到 stop 段（start 段无 force 语义——启动恒幂等检测）。
- stop 段 intent='restart'：drain-to-quiesce 后写 resume 清单，start 段健康确认后
  auto-resume 续跑（graceful-restart-design §5 的触发面；该文档落地前 P1 退化为
  现有 marker 恢复卡路径，§5.6）。
- 确认一次（restart 开头 S3 确认覆盖 stop+start 全程；--yes 跳过）。
- `gateway restart --stop-nodes` 的等价映射目标就是本命令（§8）。
- 远程 restart 不在本轮（远程 stop 已有 S7；远程 start 涉及 spawn 面，生命周期强杀恒本机
  的边界下远程编排另案）。

## 8. 兼容与弃用路径（main-4）

### 8.1 --stop-nodes / --keep-nodes / --no-keep-nodes 弃用三步

| 阶段 | 行为 |
|---|---|
| P1（弃用警告 + 等价映射） | 解析保留（args.ts:1984-1996 / 2128-2140）。`gateway stop --stop-nodes` → stderr warning「--stop-nodes 已弃用：gateway stop 只停平台进程；本次等价执行 vessel stop（舰队级递归停止）」→ 内部转调 stopFleetCommand 共享接缝。`gateway restart --stop-nodes` → warning + 等价映射 `vessel restart`。`--no-keep-nodes` 同 --stop-nodes；`--keep-nodes` 等价缺省（warning 提示可省略） |
| P2 | 映射行为不变；help/completion 里隐藏弃用 flag（不再补全提示），docs 全量改口径 |
| P3（移除） | 解析删除 → 未知参数报错，错误信息指路 `vessel stop` / `vessel restart`；keepNodes 参数从 GatewayCommand/stopGateway 签名移除 |

- 映射期退出码口径 = 目标命令口径（fleet stop 的 0/1 规则）；warning 走 stderr 不污染 --json。
- 0.55.2 的「缺省 keep nodes」行为在 P1 即变为「gateway stop 永不碰 node/hub」——
  对缺省路径用户**无感**（本来就只停平台）；对 --stop-nodes 用户是显式弃用警告 + 等价语义。

### 8.2 输出口径同步（不能让用户学到旧命令）

- `reportChildLifecycle`（gateway-command.ts:1296/1326/1334）三处
  `stop it with vessel gateway stop --stop-nodes` → `stop the fleet with vessel stop`；
- restart 的「to restart them too: gateway restart --stop-nodes」提示（2385/2835）→
  `to restart the whole fleet: vessel restart`；
- node stop managed 拒绝文案（i18n node.managedByGateway）→ 提示行文案（§6.2）；
- i18n：src/i18n/messages/en.ts / zh-CN.ts 增改同步（stop.forced 审计、drain 进度、
  弃用 warning、start 逐组件行）；数据值保持英文、人类输出走 ui + t() 的既有口径。
- completion-command.ts：补 `vessel start/restart`、`hub stop`、`node stop --force`、
  `runs cancel`；弃用 flag 按 P2 隐藏。
- docs 交接：README/CLI 帮助、docs/dev/research/redblue-operations-manual.md（运维手册
  停止/重启章节）、graceful-restart-design.md 交叉引用段、CONTRACT-stop-semantics 相关
  i18n 注释（S4 共享接缝描述改为「各组件自己的 stop」）。kanban 交接口径由 main 同步。

### 8.3 不变面（兼容承诺）

- `vessel stop --connect` 远程分支（S7）行为不变；
- `gateway reload` / `node reload`（热加载）不变；
- 实例选择器、--daemon/--log、service install/uninstall、gateway nodes registry 管理不变；
- legacy `VESSEL_LEGACY_SERVE=1` 单进程族分流保留（stateKind='node' 路径不删，
  其 stop 同样升级为优雅不限时 + --force）；
- 状态文件形状（pid/lock/manifest/registry/handoff marker）不变——
  新旧 CLI 混跑窗口内（P1 映射期）旧记录可被新命令读，新命令不写新形状文件。