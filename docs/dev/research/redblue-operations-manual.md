# 红蓝运维手册（Red-Blue Operations Manual）

> 调研 + 文档产物，不改任何产品代码。分支 `design/q-redblue`，基线 `8694a681`。
> 任务：把「旧版 agent 起新版 → 新版自检回报 → 修复 → 回归 → 入住 → 迭代」闭环落到 vessel 既有原语上。
> 证据标注：**[事实]** = 本仓文档/代码锚点；**[推断]** = 作者判断；**[业界]** = 外部来源（URL 见 §10）。
> 宪法约束（本手册自身与推荐流程都遵守）：零测试 / 零探针 / 零临时验证进程；行为验证由用户本人做，
> 证据只来自只读真实日志 / 数据 / 构建产物。B 行是**候选生产线**（真实数据根、真实工作），不是临时探针。

## 0. 结论先说

**推荐方法**：以已裁决的蓝绿隔离配方为骨架，叠加 team/node 粒度的 cohort 金丝雀（先让一个团队
入住 B 行，federation 保持两线互通）、config 级开关台账（不建 flag 框架）、expand-contract 节奏
（旧宇宙整体保留 = 推迟 contract），回退 = 入口换回 A 行（零成本）。业界来源与取舍见 §3，
逐要素映射见 §4，缺口与绕行见 §5。

**闭环六步**（详细命令与证伪信号见 §6）：

1. **起新版**：A 行 agent 按配方起 B 舰队（UC/DD/instance/端口整体搬出），写出生证进 git。
2. **自检回报**：B 行 agent 跑只读自检清单（状态/版本/日志/真实工作/隔离），经 federation
   peer 通道发结构化报告给 A 行记录员；记录员按 message_id 去重落 git + 回 ack。
3. **修复**：B worktree 小批量修，`bun run build` 后 **`gateway restart --stop-nodes`** 换代码
   （缺省 restart 不换 node 代码——最大坑），c 档恢复兜底，回 step 2 出增量报告。
4. **回归**：用户按清单做行为验证（agent 只备读数不代跑），全绿由用户裁决入住。
5. **入住**：冻结 A → handoff 文档落 git + federation 指针 → B 行重建成员 → 换入口（刷新+重登录）
   → A 保留为回退线。**会话不迁移**（裁决②），工作连续性靠 git + 文档 + 消息。
6. **迭代**：B 转正；开关台账清零；下一轮候选复用 B checkout 或起 C 行；并发最多两行；
   回退随时 = 入口换回。

**三条最重要的纪律**：
① 换代码必须 `restart --stop-nodes`，且自检核对版本读数（R11）；
② B 行独立 worktree + 独立 dataDir + 独立池 instance，永不共享 workspace / 数据根（R1/R3/R8）；
③ git 文档序列是跨会话宇宙的 durable 状态——federation 只当通知通道，关键报告 / handoff /
裁决记录必须落 git（G6/R12）。

## 1. 范围与术语

| 术语 | 定义 |
|---|---|
| A 行（红） | 旧版生产线：默认根 `~/.vessel`，端口 8642/8644(/8643)，日用干活 |
| B 行（蓝） | 新版候选线：独立 checkout + `--user-config` / `--data-dir` / `--instance` 整体搬出，端口错开（示例 8652/8654/8653） |
| 会话宇宙 | 一个 dataDir 下的全部会话/成员/事件。裁决②：**切换 = 新会话宇宙，不做离线数据迁移** |
| 入住 | 用户把日用入口从 A 行换到 B 行；工作连续性靠 git + handoff 文档 + federation 消息，不靠会话搬运 |
| 回归 | 用户行为验证 + 只读真实读数核对（宪法第四条），不是自动化测试 |
| 迭代 | 入住后 B 成为新 A，下一轮候选线再起；回退 = 入口换回旧 A（零成本） |

裁决基线（2026-11-23，[事实] `docs/operations/version-isolation-blue-green.md` 头部）：
① 不加 profile 新实体，全部用既有杠杆；② 切换 = 新会话宇宙，不做离线迁移；
③ 双行期不跑 `install-service`。本手册不推翻任何一条，只在其上补操作流程。

## 2. 既有原语盘点（本仓事实）

### 2.1 隔离与生命周期

| 原语 | 语义 | 锚点 |
|---|---|---|
| 不对称隔离配方 | A 留默认根；B 用 `--user-config` + `--data-dir` + `engine_pool.instance` + 端口错开整体搬出 | [事实] version-isolation-blue-green.md §1–2 |
| DD 分离 ⇒ token 互不认 | 各线 root-secret 不同，派生 token 跨舰队 401 fail-closed；peer token 是独立命名空间 | [事实] 同上 §1；REMOTE.md §3.5.1 |
| `gateway start` 分段启动 | 平台先 ready；node/hub 后台逐个结算，单节点失败只标它自己 | [事实] gateway-lifecycle.md；GATEWAY.md §1 |
| adopt / handoff marker | 缺省 stop/restart 只停平台层，写保留标记，子进程存活，下次 start adopt | [事实] gateway-lifecycle.md 生命周期表 |
| `--stop-nodes` 真停 | node 先 `gateway.shutdown` drain（写 resume 标记）≤10s，超时强杀；池只 terminate owned | [事实] GATEWAY.md §4 |
| **restart 缺省不换 node 代码** | `gateway restart` 后 node 仍跑旧代码（命令打印提示）；换代码必须 `restart --stop-nodes` | [事实] GATEWAY.md §4 表 + 提示行 |
| graceful-first（Q4-C） | 平台停止也先进程内 `gateway.shutdown`（含池 stop），关闭 Windows owned engine 孤儿缺口 | [事实] GATEWAY.md §4 |
| `vessel stop` 舰队级 | manifest 三元复核（pid + started_at + node_id/hub lock），adopt/external 永不杀 | [事实] gateway-lifecycle.md；GATEWAY.md §4 |
| Windows 句柄继承坑 | 只 taskkill 平台进程会让 detached 子进程继续持有监听 socket；恒用命令整舰队停 | [事实] version-isolation-blue-green.md §3 |

### 2.2 中断恢复（durable resume / node-resume）

| 原语 | 语义 | 锚点 |
|---|---|---|
| RunStore checkpoint | run 开始 / 每轮 tool-call 后 / 结束写 checkpoint；`runs.resume` 接受 `running\|interrupted` | [事实] ADR-040；graceful-restart.md §2 |
| 手动 `vessel resume` | 列 interrupted 再 resume；**启动期不自动续 run** | [事实] graceful-restart.md §2 |
| node-resume 重启卡 | 启动扫 `resume_after_restart` 标记 → 发 restart EnvCard（模型+用户同源）→ FIFO 重放 human 输入 → 卡准入后清标记；去重键 run_id + interrupted_at | [事实] src/node-resume.ts 头注 |
| 三档「无感」 | a 档（热升级）不可达；b 档（续跑）原料在、缺自动串接；c 档（任务重投）已实现 | [事实] graceful-restart.md §1/§3 |
| rotate / sessions.restart | 同进程换 body（epoch+1），startup_prompt 是唯一 handoff 通道；**不是换代码** | [事实] agent 工具语义；graceful-restart.md §2 |

### 2.3 跨节点（federation / hub）

| 原语 | 语义 | 锚点 |
|---|---|---|
| federation 数据面 | node→node 一条消息；地址 `<principal>@<node_id>:<team_id>`；入站落 Team 日志，最多 1 个 run（唯一 present 非 private 成员） | [事实] federation-hub.md §federation |
| peer 配置 | `federation.peers[]` 显式 allowlist；bearer 只从 `tokenEnv` 读；非回环必须 https；回环 http 可 | [事实] federation-hub.md；src/federation-config.ts |
| 失败顺序 fail-closed | enabled → bearer → direction → from=peer → 严格解析 → team 映射 → hop → 自指环 → team 存在 → 去重 → 写日志 | [事实] federation-hub.md §federation-guards |
| 无离线队列/重试/exactly-once | 去重是进程内 LRU 1024；限流缺省 60/min；hop 恒 1 | [事实] federation-hub.md；REMOTE.md §3.3.1 |
| agent send 地址形态 | 跨节点目标不支持 interrupt / notify（0.41） | [事实] packages/agent/src/tool.ts:903 附近 |
| hub 控制面 | 只传目录/指针元数据，不代理正文；join-code/join；同机回环无码自助重 join | [事实] federation-hub.md §pairing/§auto-join |
| 派生白名单 D 定格 | D 在 join / 平台启动那一刻定格，运行期不刷新；新 node 要平台重启才被认识 | [事实] node-auto-join.md §10.3 |
| 不做远程生命周期 | federation 不做远程 spawn / close / rotate / resume / create | [事实] federation-hub.md §不做什么 |

### 2.4 工作区与共享面

| 原语 | 语义 | 锚点 |
|---|---|---|
| write.lock 合作式 | 只有新版 edit/write 持锁；旧版是非合作写入者 ⇒ 同 workspace 双版本并行写不安全（R8） | [事实] version-isolation-blue-green.md §5 R8 |
| 共享 `~/.vessel` 面 | 用户插件发现 / update 缓存 / marketplace / OS 服务不随 UC/DD 移动；`VESSEL_NO_EXTERNAL_PLUGINS=1` + 双行期纪律 | [事实] 同上 §1/§5 R4–R6 |
| 数据格式单向门 | 成员快照 v4→v5 首写清旧字段（留 `.v4.bak`）；0.55+ 不认旧格式会话 | [事实] 同上 §4 |
| `vessel migrate` | 只做 sqlite/file-v1→file-v2 存储格式迁移，默认 dry-run；不是跨版本会话迁移 | [事实] MIGRATION.md §1–2 |

## 3. 业界方法调研

> 来源均为 2026-11-24 本次调研直接抓取的权威页面（URL 见 §10；bocha 搜索后端对英文查询命中差，
> 故以搜索定位 + 直接抓取原文为准）。本仓 `graceful-restart.md` §4 已调研过的进程级优雅重启族
> （nginx / k8s / systemd / Erlang / pm2 / Claude Code / OpenHands）不重复调研，只引用结论（§3.6）。

### 3.1 蓝绿部署（Blue-Green Deployment）

[业界] Martin Fowler, *BlueGreenDeployment*（2010-03-01，2015-06-05 更新）：

- 机制：两套**尽量同构**的环境，任一时刻一套 live；新版本在闲置套做最后阶段验证；验证通过后
  **切路由器**让全部请求进新套；出问题**切回**旧套即回退。
- 三个值得抄的细节：
  1. **切换期丢事务问题**：green live 期间 blue 会错过事务。解法要么双喂（两套都收事务、旧套当备份），
     要么切换前先进**只读过渡期**跑一段再切读写。
  2. **角色轮转**：切换稳定后，旧套变成下一版的 staging；两套在 live / 回退备份 / 下一版 staging
     三个角色间循环。副产品：每次发布都顺带演练了灾备切换。
  3. **数据库与应用升级解耦**：先做 schema 重构让**新旧两版应用都能跑**（expand）→ 验证 → 部署新应用
     → 稳定后再移除旧版支持（contract）。schema 变更与应用变更是两次独立部署。
- 对 vessel：骨架**就是**已裁决配方（A 留默认根、B 整体搬出、切换 = 换入口、回退 = 换回）。
  vessel 没有路由器实体 ⇒ **入口即路由器**（浏览器 origin / CLI flag / `--connect`）。
  「只读过渡期」对应入住前冻结 A 行新工作（§6.5）；「角色轮转」对应迭代期 B 转正、旧 A 转回退线（§6.6）。
  「双喂」在 vessel 无对应原语且裁决②不迁移数据 ⇒ 不抄，用 handoff 文档补偿（§5 G1）。

### 3.2 金丝雀发布（Canary Release）

[业界] Danilo Sato, *CanaryRelease*（2014-06-25）+ Google SRE Workbook ch16 *Canarying Releases*：

- 机制：新版本先部署到**无流量**的基础设施子集 → 路由少量选定用户 → 逐步扩大 → 全量；
  回退 = 把用户路由回旧版。Sato 明确：金丝雀是 **ParallelChange 的一种应用**（migrate 阶段
  持续到全部用户迁完，然后才 decommission 旧套）。
- cohort 选择策略：随机抽样 / **内部员工先行** / 用户画像 / 地理区域 / 品牌分区。
  Facebook 用多级金丝雀：第一级仅内部员工可见、且把所有 feature flag 打开以尽早暴露问题。
- SRE 的三要求：① 能把变更部署到服务总体的一个子集；② 有评估过程判 canary 相对 control 的好坏；
  ③ 评估结果接回发布流程（决定继续 / 回退）。另两条经验：**多数事故由二进制或配置推送触发**；
  小而自包含的变更回退更便宜 ⇒ 小批量、高频次。
- **按变化速率分离组件**：二进制 / 环境 / 服务配置 / feature 实验配置 / 用户配置各自独立发布；
  一个二进制带多个 feature 时逐个开 flag，坏的那个单独关，不必整包回退。
- IMVU「cluster immune system」：业务指标统计显著回归 ⇒ 自动回退（金丝雀的自动化极端形态）。
- 代价：同时管理多版本，**并发版本数压到最少**；分发到用户设备的客户端软件难控升级时机，
  用 ParallelChange 让后端同时支持两版、监控旧版用量降到阈值再 contract。
- 对 vessel：没有流量切分面 ⇒ **cohort 的粒度只能是 team / node / 人**：先让一个团队（或一台机器）
  入住 B 行，其余留在 A 行，federation 保持两线互通；观察窗时间盒化。评估 = 只读读数清单 +
  用户行为验证（宪法禁自动探针 ⇒ 不抄 cluster immune system 的自动化，抄它的「先定判据再放量」）。
  「内部员工先行」天然成立：B 行第一批用户就是开发者自己。「按变化速率分离」对应 vessel 的
  代码重启（`restart --stop-nodes`）与配置热更（`gateway reload`）两条独立通道（§4）。

### 3.3 特性开关（Feature Toggles / Flags）

[业界] Pete Hodgson, *Feature Toggles*（2017-10-09）：

- 四类别（按用途）：**Release**（未完成功能隔离，短命，周级，使命结束必须删）/
  **Experiment**（A/B 分流）/ **Ops**（运维降级、熔断，长命）/ **Permissioning**（按用户层级放权，长命）。
  两维度：static vs dynamic（配置改 vs 运行时改）、transient vs long-lived。不同类别管理方式不同，
  混在一个桶里是痛苦之源。
- 纪律：**限制开关总数**（carrying cost：每个开关都是要维护、要验证两态的分支）；release toggle
  完成使命即删；**优先静态配置**（动态路由是重武器）；决策点与决策逻辑解耦；暴露当前开关状态。
- 对 vessel：没有 per-request flag 框架，**也不建议建**（API 表面税 + plugin-first 宪法）。
  既有粗粒度开关已够用：config 键（`engine_pool` / `tools_engine.mode` / `hub.direction`…）、
  env（`VESSEL_NO_EXTERNAL_PLUGINS`）、插件 enable/disable、`gateway reload --scope`。
  抄的是**管理纪律**：候选线相对生产线的 config diff 就是「开关台账」，入住后 diff 清零或转正，
  不留长命 release toggle（§6.6）。Ops 类长命开关（如降级）在 vessel 对应 config 常设键，合理保留。

### 3.4 数据库迁移 / 接口演进：ParallelChange（expand–contract）

[业界] Danilo Sato, *ParallelChange*（2014-05-13）：

- 三相：**expand**（增新不删旧，接口同时支持新旧两版）→ **migrate**（消费者逐个增量切换，
  外部消费者时此相最长）→ **contract**（确认全部迁完才删旧）。**任一相都可发布**，
  破坏被限制在单相内而不是摊满整个代码库。
- 应用域：方法签名重构、PublishedInterface、**数据库重构（evolutionary database design 的基石）**、
  部署（金丝雀 / 蓝绿都是它的实例）。Fowler 蓝绿页的 DB 段（§3.1 细节 3）就是本模式在 schema 上的用法。
- 对 vessel：裁决②不做离线迁移 ⇒ **不走「共享 schema 支持两版」路线**；DD 分离让两线数据根各自独立，
  contract 相被「旧宇宙整体保留当回退线」替代——这是 expand-contract 在「不共享状态」约束下的变体：
  **expand = 起新宇宙，migrate = 换入口 + handoff，contract = 旧线退役（可选、可无限推迟）**。
  但三相节奏对**接口契约**仍然适用：federation envelope、config 键、RPC 形状先 additive 后删除。
  反面教材就在本仓：成员快照 v4→v5 首写清旧字段是「跳过 expand 直接 contract」的单向门
  （[事实] 配方 §4 警示），红蓝双行期靠 DD 分离绕开它，而不是靠迁移穿过它。

### 3.5 自动化渐进交付（Argo Rollouts 为代表）

[业界] Argo Rollouts 官方文档（https://argoproj.github.io/rollouts/）：

- 能力：blue-green / canary CRD、细粒度加权流量、查询外部指标驱动**自动 promote / rollback**、
  **manual judgement 是一等选项**、与 ingress / service mesh / Prometheus 等集成。
- 它列举的原生 rolling update 局限（正好是 vessel 该警惕的）：滚动速度控制少、无法控制流量走向、
  **readiness 探针不适合做深度 / 压力 / 一次性检查**、无法查外部指标验证更新、能暂停但**不能自动中止回退**。
- 对 vessel：抄两条——① **readiness ≠ 验收**：`/health` / node ready 只是就绪信号，
  验收必须是真实工作读数 + 用户行为验证（§6.4）；② manual judgement 与宪法「用户是裁决者」同构，
  入住 / 回退决策永远留给人。不抄：加权流量（无切分面）、自动指标分析（零探针宪法）。

### 3.6 本仓已调研的进程级优雅重启族（引用，不重复）

[事实] `docs/dev/research/graceful-restart.md` §4 业界表 + §3 三档判定：

| 来源 | 结论一句话 |
|---|---|
| nginx SIGHUP reload | 老 worker 处理完现存连接才退 ⇒ drain 应「等终态」而非 cancel |
| k8s rolling update | readiness 过了才接流量；30s grace + preStop；先拒新活再等旧活 |
| systemd socket activation | 重启期间连接不丢的等价物在 vessel 是 **inbox 落盘重投**，不是 socket |
| Erlang/OTP 热升级 | 唯一真 a 档，是 runtime 能力 ⇒ JS/Bun 侧不必硬凑 |
| pm2 cluster reload | 超时退化成硬重启是可接受策略 ⇒ drain 超时标 interrupted 继续 |
| Claude Code sessions | 同行主流停在 c 档：在途工具调用 resume 后**不重跑** |
| OpenHands | 「等人批准」要能持久化穿越重启（本仓 pendingPermissions 曾是内存 Map） |

三档结论（[事实] 同文 §1/§3）：**a 档（进程内热升级）本仓不可达**；**b 档（checkpoint 续跑）原料在、
缺自动串接**，且在途写类工具不可安全重放 ⇒ 不承诺；**c 档（任务重投）0.53 已实现**。
红蓝闭环站在 c 档 + 会话宇宙切换上，不承诺 b 档。

### 3.7 挑选小结：抄什么、不抄什么

| 方法 | 抄 | 不抄 | 理由 |
|---|---|---|---|
| 蓝绿 | 双环境 + 入口切换 + 零成本回退 + 角色轮转 + 切换前冻结 | 双喂事务、共享 DB | 裁决②不迁移；入口即路由器 |
| 金丝雀 | cohort 先行（team/node 粒度）+ 先定判据再放量 + 时间盒观察窗 + 并发版本数最少 | 百分比流量、自动指标回退 | 无切分面；零探针宪法 |
| 特性开关 | 分类管理 + 静态配置优先 + 台账与清理纪律 | per-request flag 框架 | API 表面税；config/env/插件开关已够 |
| expand-contract | 三相节奏用于接口契约；「旧宇宙保留 = 推迟 contract」 | 共享 schema 双版支持 | DD 分离替代迁移 |
| Argo 式自动化 | readiness≠验收、manual judgement | 加权流量、自动 promote/rollback | 用户是裁决者 |
| 优雅重启族 | drain 等终态、超时硬来、inbox 重投 | a 档热升级、b 档承诺 | runtime 能力不可达；写工具不可重放 |

## 4. 映射：业界方法 → vessel 原语

> 状态三档：**已具备** = 有原语且语义对得上；**替代** = 无同形原语，但可用既有杠杆组合出等效做法；
> **缺口** = 既无原语也无干净替代，需要纪律绕行或将来补（§5 逐条分析）。
> 每行给锚点；组合做法标 [推断]。

| # | 业界方法 / 要素 | vessel 原语 | 状态 | 锚点 / 替代做法 |
|---|---|---|---|---|
| M1 | 蓝绿：两套同构环境 | 不对称隔离配方：A 默认根；B `--user-config` + `--data-dir` + `engine_pool.instance` + 端口错开 | 已具备 | [事实] 配方 §1–2；两 checkout 各自 bun install |
| M2 | 蓝绿：路由器切换 | 无路由器实体；**入口即路由器**：浏览器 origin / CLI UC/DD flag / `--connect` + connect token | 替代 | [事实] 配方 §2 入口对照表；[推断] 切换动作 = 人改入口，无集中开关 |
| M3 | 蓝绿：快速回退 | A 根 / 配置 / 端口未被触碰 ⇒ 入口换回即回退，零成本 | 已具备 | [事实] 配方 §4 |
| M4 | 蓝绿：切换前只读过渡 / 双喂 | 无只读模式原语；双喂不做（裁决②） | 替代 | [推断] 入住前冻结 A 行新工作 + handoff 文档落 git（§6.5 步骤 1）；共享 workspace 按 R8 分区 |
| M5 | 蓝绿：角色轮转（旧套变下版 staging） | B 转正后旧 A 保留为回退线；下一轮候选可复用 B checkout 或起 C 行 | 替代 | [推断] §6.6；端口 / instance 命名表防碰撞 |
| M6 | 蓝绿：schema 先行、应用后上 | 不共享 dataDir ⇒ 无共享 schema 可先行；数据格式单向门靠 DD 分离绕开 | 缺口（裁决边界） | [事实] 配方 §4–5 R7；裁决②不迁移（§5 G1） |
| M7 | 金丝雀：子集部署 | B 行整舰队独立起；cohort 粒度 = team / node / 人 | 替代 | [事实] 配方 §2；[推断] 先迁一个团队入住 B，federation 保持互通 |
| M8 | 金丝雀：canary vs control 评估 | `/health` + `gateway status --json` + 真实日志 + 用户行为验证 | 替代 | [事实] GATEWAY.md；宪法第四条；[推断] 清单即 oracle（§6.4），无自动指标分析 |
| M9 | 金丝雀：评估接回发布流程 | 无 promote 闸门原语；用户裁决 = 闸门 | 替代 | [推断] 回归清单全绿 → 用户口头 / 文档裁决入住（§6.4→6.5） |
| M10 | 金丝雀：内部员工先行 | B 行第一批用户 = 开发者自己（日用 A 不动） | 已具备 | [推断] 配方场景定义本身 |
| M11 | 特性开关：release toggle | config 键 + env + 插件 enable/disable；候选线 config diff = 台账 | 替代 | [事实] CONFIG.md 层序；`VESSEL_NO_EXTERNAL_PLUGINS`；[推断] 入住后 diff 清零纪律（§6.6） |
| M12 | 特性开关：运行时动态改 | `gateway reload --scope config,plugins,permission,tools,mcp`；TLS/token/端口/provider 改动必须 restart | 已具备（粗粒度） | [事实] packages/serve/src/gateway/methods/admin.ts:21 `RELOAD_SCOPES`；REMOTE.md §3.4；无 per-request flag，不建（§5 G13） |
| M13 | 特性开关：Ops 长命开关 | config 常设键（降级 / 池开关 / hub direction） | 已具备 | [事实] CONFIG.md；[推断] 长命键合理保留，不算债 |
| M14 | expand-contract：接口三相 | federation envelope / RPC / config 键 additive 演进；本仓文档门（doc-sync）约束形状 | 已具备（纪律层） | [事实] federation-hub.md envelope 固定字段；[推断] 红蓝期接口变更先 additive |
| M15 | expand-contract：migrate 相 | 会话宇宙切换：换入口 + handoff 文档 + federation 消息 + B 行重建成员 | 替代 | [事实] 裁决②；rotate startup_prompt 语义；[推断] §6.5 |
| M16 | expand-contract：contract 相 | 旧线退役 = `stop --stop-nodes` + 数据根归档（不删）；可无限推迟 | 替代 | [事实] GATEWAY.md §4；[推断] §6.6 |
| M17 | Argo：readiness ≠ 验收 | `/health` / node ready 只是就绪；验收 = 真实工作 + 用户验证 | 已具备（区分） | [事实] gateway-lifecycle.md 分段启动；宪法第四条 |
| M18 | Argo：manual judgement | 用户裁决入住 / 回退；agent 只备清单不代跑 | 已具备 | [事实] 宪法；[推断] §6.4 |
| M19 | Argo：自动 promote/rollback、加权流量 | 无 | 缺口（宪法边界） | 不补：零探针 + 无切分面（§5 G4/G12） |
| M20 | rolling：优雅 drain | `gateway.shutdown`：node 写 resume 标记 + interrupt ≤10s，超时强杀；池只 terminate owned | 已具备 | [事实] GATEWAY.md §4；配方 §3 |
| M21 | rolling：重启不丢任务 | c 档：inbox 落盘重投（human 源 FIFO）+ 重启 EnvCard + 标记准入后清 | 已具备 | [事实] src/node-resume.ts 头注；graceful-restart.md §1 |
| M22 | rolling：checkpoint 续跑（b 档） | RunStore checkpoint + `runs.resume`（running\|interrupted）+ 手动 `vessel resume`；**启动期不自动续** | 缺口（可补，目标态） | [事实] ADR-040；graceful-restart.md §2；§5 G9 |
| M23 | 换代码 vs 换配置两条通道 | 代码：`restart --stop-nodes`（缺省 restart **不换 node 代码**）；配置：`reload` | 已具备 | [事实] GATEWAY.md §4 表 + 提示行 |
| M24 | 跨版本 handoff（同进程） | `agent rotate`：startup_prompt 是唯一 handoff 通道，新 body 不继承对话 | 已具备（同进程） | [事实] agent 工具语义；**不是换代码**（graceful-restart.md §2） |
| M25 | 跨节点 handoff | federation 不做远程 spawn/rotate/resume ⇒ handoff = git 文档 + 地址消息 + 目标侧重建成员 | 替代 | [事实] federation-hub.md §不做什么；[推断] §6.5/§7 |
| M26 | 跨节点回报通道 | `POST <peer.url>/v1/federation/messages`；`vessel federation post --to --from`；agent send 地址形态（跨节点无 interrupt/notify） | 已具备 | [事实] src/federation-client.ts:4,26；cli-args.ts:3973；packages/agent/src/tool.ts |
| M27 | 回报可靠性（离线队列 / exactly-once） | 无离线队列 / 重试 / 跨重启 exactly-once；去重仅进程内 LRU 1024；限流 60/min | 缺口（可补，现绕行） | [事实] federation-hub.md §guards；[推断] 幂等 message_id + ack + 重发 + git 落盘（§6.2） |
| M28 | 热备 / 灾备演练 | A 行保留 = 热备回退线；每次入住演练一次回退路径 | 已具备 | [推断] Fowler 角色轮转副产品在 vessel 的对应 |
| M29 | 工作区并发安全 | write.lock 合作式（仅新版 edit/write 持锁）；旧版是非合作写入者 | 缺口（纪律绕行） | [事实] 配方 R8；B 行独立 worktree 根治 |
| M30 | 共享面隔离（插件 / 更新 / 服务） | `~/.vessel` 硬编码面不随 UC/DD 移动；env + 双行期纪律 | 替代 | [事实] 配方 §1/§5 R4–R6 |

## 5. 缺口分析

> 分两类：**裁决 / 宪法边界**（用户已裁决不做或宪法禁止 ⇒ 不补，只给绕行）与
> **真实缺口**（原语缺失，可将来补；本手册不改代码，只给绕行 + 标注目标态）。
> 每条：现象 → 对闭环的影响 → 绕行 → 是否值得补。

### 5.1 裁决 / 宪法边界（不补，绕行）

| # | 边界 | 对闭环的影响 | 绕行 |
|---|---|---|---|
| G1 | **不做离线数据迁移**（裁决②，2026-11-23） | 旧会话 / 成员 / 事件不在 B 行出现；「入住」不是数据搬家 | 会话宇宙切换：git + handoff 文档 + federation 消息承载工作连续性（§6.5）；旧宇宙整体保留 = 回退线 + 只读查询入口。数据格式单向门（v4→v5、`legacy_session_unsupported`）使迁移本身就是高风险动作，裁决合理 [推断] |
| G2 | **不加 profile 新实体**（裁决①） | 双行配置是手工组合既有杠杆，无一键 profile | 配方 §2 模板 + 出生证记录（§6.1）；组合正确性靠清单核对，不靠新抽象 |
| G3 | **双行期不跑 install-service**（裁决③）+ 共享面纪律（R4–R6） | OS 服务 / marketplace / update apply 会写共享 `~/.vessel` 波及生产线 | B 行 `VESSEL_NO_EXTERNAL_PLUGINS=1` + `update.auto_check: false`；双行期冻结这三类动作（§6.0） |
| G4 | **零探针 / 零自动验证**（宪法第四条） | 无自动金丝雀分析、无自动 promote 闸门 | 清单即 oracle + 用户行为验证 + 用户裁决（§6.4）；Argo 的 manual judgement 同构 |

### 5.2 真实缺口（可补；本手册只绕行）

| # | 缺口 | 现象 / 锚点 | 对闭环的影响 | 绕行 | 值得补？ |
|---|---|---|---|---|---|
| G5 | **adopt 无版本闸** | 池状态文件 version 字段只做形状校验、从不比较（配方 R1）；node/hub 归属复核是 pid + started_at + node_id/hub lock 三元，不比版本 [事实] gateway-lifecycle.md §不越界 | 若误共享 poolDir / dataDir，新 gateway 静默收编旧 engine / 旧 node，「新版舰队」混入旧代码 | `engine_pool.instance` + DD 分离根治；出生证记录各线 commit，自检核对（§6.2） | 值得（目标态：adopt 判据加版本比较），但隔离纪律已覆盖红蓝场景，非本任务 |
| G6 | **federation 无离线队列 / 重试 / 跨重启 exactly-once** | hop 恒 1、去重仅进程内 LRU 1024、限流 60/min [事实] federation-hub.md §guards | 自检回报 / handoff 消息可能丢（对端重启窗口）或重（跨重启重发） | 幂等 `message_id` + 接收方按 id 文档去重 + ack 回执 + 失败重发；**关键报告同时落 git 文档**（durable 兜底，§6.2） | 队列 / 重试值得将来评估；exactly-once 与「无中心可嵌入」冲突，文档已明确不声称 |
| G7 | **无远程生命周期操作** | federation 不做远程 spawn / close / rotate / resume / create [事实] federation-hub.md §不做什么 | 跨节点入住不能自动把 A 行成员「搬」到 B 行 | handoff = git 文档 + 地址消息 + 目标侧 agent create/hire 重建（§6.5/§7）；这是裁决②的必然配套 [推断] | 不补（与 G1 同源）；文档 handoff 是正解 |
| G8 | **派生白名单 D 定格** | D 在平台启动 / join 那一刻定格，运行期刷新是 target [事实] node-auto-join.md §10.2–10.3 | 跨机新 node 加入后，老平台不认识其 origin ⇒ 浏览器直连 403 | 同机回环天然不受影响；跨机：显式 `node.allowed_origins`（可 `reload --scope config` 热更 [事实] REMOTE.md §3.4）或重启平台 | 值得（target 已列：hello 帧带 trusted_origins），非本任务 |
| G9 | **b 档不自动串接** | checkpoint + `runs.resume` 原料在，但启动期不自动续 run；在途写类工具不可安全重放 [事实] graceful-restart.md §2–3 | `restart --stop-nodes` 后 interrupted run 要手动 `vessel resume`；闭环的「修复→重启」步有可见中断 | c 档兜底（重启卡 + human 输入重放）+ 手动 resume；重启时机选 idle / 轮次边界（§6.3） | 值得（目标态：drain 标记自动串接 + 工具可重放标签），但先给工具打标签否则是假承诺 |
| G10 | **write.lock 合作式** | 只有新版 edit/write 持锁；0.54 无 write 工具无锁 = 非合作写入者 [事实] 配方 R8 | 同 workspace 双版本并行写可静默覆盖 | **B 行独立 worktree/workspace 根治**；必须共享时 A 只读或人工分区 + expected_content | 不补（跨版本锁协议无意义）；隔离是正解 |
| G11 | **无统一入口 / 流量切分** | 无路由器 / 代理实体；hub 只传目录指针不代理正文 [事实] federation-hub.md | 切换是人工动作；做不了百分比金丝雀 | 入口对照表（配方 §2）+ cohort 粒度（team/node/人）+ 时间盒观察窗（§6.4/6.6） | 不建（API 表面税）；人工入口切换与宪法同构 |
| G12 | **无 flag 框架** | 无 per-request toggle；只有 config/env/插件粗粒度开关 | 功能级灰度只能整线切换 | config diff 台账 + 入住后清零纪律（§6.6）；插件 enable/disable 当功能开关 | 不建（Hodgson：优先静态配置；本仓 config 层序已够） |
| G13 | **回报无结构化契约** | federation content 是自由文本；无 schema / ack 原语 [事实] federation-hub.md envelope | 自检报告格式靠约定，机器不可校验 | §6.2 给固定文本契约 + message_id；接收方 agent 按契约解析落文档 [推断] | 轻量值得（约定即可，不必新 RPC）；重 schema 违反 API 表面税 |

### 5.3 小结

闭环六步里，**起新版 / 修复 / 回归 / 回退**四步的原语已齐（配方 + 生命周期 + c 档恢复）；
**自检回报**步靠 federation + 幂等纪律补可靠性（G6/G13）；**入住**步的「搬会话」被裁决②替换为
「换宇宙 + handoff」（G1/G7），这是设计选择不是缺陷。真正值得将来补的代码级缺口只有
G5（版本闸）、G8（D 刷新）、G9（b 档串接）三项，且都已有 target 记录，不属于本手册任务。

## 6. 推荐方法 + 操作步骤（闭环 playbook）

> 推荐组合一句话：**蓝绿骨架（已裁决配方）+ team/node 粒度 cohort 金丝雀 + config 级开关台账
> + expand-contract 节奏（旧宇宙保留 = 推迟 contract）+ 入口切换回退**。
> 下面的命令是给**操作者**（舰队 agent 或人）执行的步骤说明；本手册作者不执行任何一条（宪法）。
> 每阶段标：用到的原语 [事实] / 组合判断 [推断] / 证伪信号（做错了会看到什么）。

```
        ┌────────────────────────────────────────────────────────────┐
        │                                                            │
  6.1 起新版 ──► 6.2 自检回报 ──► 6.3 修复 ──► 6.4 回归 ──► 6.5 入住 ──► 6.6 迭代
  (A 行 agent     (B 行 agent      (B worktree   (用户裁决)   (换宇宙+     (B 转正/
   起 B 舰队)      federation      + restart     清单全绿     handoff)     回退=换回)
                   回报 A 行)      --stop-nodes)      │            │
        ▲               ▲              ▲            │ 失败       │ 下一轮
        └───────────────┴──────────────┴────────────┘            └──► 6.1
```

### 6.0 前置与纪律（每轮闭环开始前核对）

1. 两 checkout 各自 `bun install`（apps/web 另需 `bun install --cwd apps/web`），**不得 junction 共享
   node_modules**。[事实] 配方头部
2. B 行 config yaml 按配方 §2 模板（data_dir / 端口 8652/8654/8653 / `engine_pool.instance: blue` /
   `update.auto_check: false`）；**yaml 不放任何密钥**（自定义路径不在 denylist，read/bash 读得到）。
   [事实] 配方 §1–2、R10
3. B 行启动恒带 `VESSEL_NO_EXTERNAL_PLUGINS=1`（用户插件发现根是 homedir 硬编码，此 env 是唯一隔离手段）。
   [事实] 配方 §2
4. 双行期冻结三类动作：`install-service` / marketplace install / update apply（都写共享 `~/.vessel`）。
   [事实] 裁决③、配方 R4–R6
5. B 行工作区 = 独立 worktree（`worktrees/<topic>`），不碰主 checkout、不碰 A 行 workspace。
   [事实] 配方 R8；AGENTS.md worktree 规则
6. 角色分工 [推断]：A 行 agent = 发起者 + 记录员；B 行 agent = 自检者 + 修复者；
   **用户 = 回归与入住的唯一裁决者**；main = 分支合并裁决者。agent 不代用户做行为验证。
7. 端口 / instance 命名表（防迭代碰撞）[推断]：A = default/8642/8644/8643；B = blue/8652/8654/8653；
   下一轮 C = green/8662/8664/8663。`--port 0` 临时端口必须配 `--instance`。[事实] 配方 §2

### 6.1 旧版 agent 起新版

**原语**：不对称隔离配方 + 分段启动 + adopt。[事实] 配方 §1–2；gateway-lifecycle.md

步骤（A 行 agent 经 bash 执行，A 行自身不重启、日用零影响）：

1. 核对 B checkout 就绪：`git log -1`（记录 commit）、分支正确、`apps/web/dist` 存在且非空
   （只读构建产物，不跑构建探针）。[推断] 出生证要可追溯
2. 起 B 舰队（B checkout 内，配方 §2 原命令）：
   ```bash
   VESSEL_NO_EXTERNAL_PLUGINS=1 bun run src/cli.ts \
     --user-config D:/Application/APP/Vessel/fleets/blue/config.yaml \
     --data-dir  D:/Application/APP/Vessel/fleets/blue/data \
     gateway start --instance blue --daemon
   ```
3. 就绪读数（只读）：`gateway status --json`（带同样 UC/DD，或 `--connect http://127.0.0.1:8652`
   + connect token）；`<blue-data>/logs/gateway.log` 的 node ready 行。分段启动下单节点失败只标它
   自己（`failed` 可见），不会静默。[事实] gateway-lifecycle.md；GATEWAY.md §1
4. 写**出生证**进 handoff 文档（git commit）：commit / 版本 / 端口 / dataDir / instance / UC 路径 /
   启动时间 / node_id（`<blue-data>/node.json`）/ team id。[推断] 这是跨宇宙 durable 状态的第一块
5. 跨机变体：目标机 agent 执行同命令（或 SSH）；hub join 见 §7。

证伪信号：bind fail-fast（端口撞了）；`node_start_failed`（配置错）；status 里 B 节点 `failed`。
**注意**：起的是候选生产线（真实数据根、真实工作），不是临时探针——这是裁决配方允许的动作，
与宪法「零临时验证进程」不冲突。[推断]

### 6.2 新版自检回报

**原语**：federation 数据面 + Team 日志落点。[事实] federation-hub.md §federation

**(a) 回报通道一次性搭建**（两线各自 config；token/端口类改动需 restart，不可 reload [事实] REMOTE.md §3.4）：

```yaml
# A 行 config（~/.vessel/config.yaml）追加：
federation:
  peers:
    - nodeId: <B 的 node_id>        # 出生证里有
      teamId: <B 行接收 team id>
      url: http://127.0.0.1:8654    # 对端 Node API（node.port），不是平台 8652
      tokenEnv: VESSEL_PEER_BLUE    # 双方 env 里放同一个随机 secret
      direction: both
      localTeamId: <A 行接收 team id>
# B 行 config 对称配 A（url: http://127.0.0.1:8644）
```

- [事实] peer 形状：`federation.peers[]` 显式 `(nodeId, teamId)` / url / tokenEnv / direction /
  localTeamId? / caFile?；明文 token 被 validator 拒绝；缺 token 的 peer 直接丢弃（fail-closed）；
  同一 token 命中多 peer 全部丢弃（src/federation-config.ts 头注）。
- [事实] `enabled` 缺省 true，但**无 peers = 无通道**；入站 `POST <peer.url>/v1/federation/messages`
  注册在 Node API（src/federation-client.ts:4,26）。
- [事实] 回环 http 允许；非回环必须 https（跨机见 §7）。
- [事实] DD 分离 ⇒ 派生 token 跨舰队 401；**peer token 是独立命名空间**，与 gateway 用户 / hub node
  token 不交叉（REMOTE.md §3.5.1）——跨线回报必须显式配 peer，不能复用 connect token。
- [推断] secret 由操作者生成（随机串），只进双方 env，不进 yaml（R10）。

**(b) B 行自检清单**（全部只读读数或真实工作，零探针）：

| # | 项 | 做法 | 证伪信号 |
|---|---|---|---|
| a | 舰队状态 | `gateway status --json`（带 UC/DD） | 任一节点 `failed` / hub 缺席 |
| b | 版本核对 | `git log -1` + CLI 版本 vs 出生证 | commit 不符（起错 checkout） |
| c | 日志扫描 | 只读 `<blue-data>/logs/gateway.log` | `node_start_failed` / `data_locked` / `hub_registry_corrupt` 等 fail-closed 行 |
| d | 工具面真实工作 | B 行 agent 在**自己的 worktree** 做一件真实小任务（read/write/edit/bash 各用到） | 工具报错 / write.lock 冲突 |
| e | 会话可见性 | 用户开 B origin 看 timeline（agent 看到的 = 用户看到的） | 缺口 / 假报（先刷新页面排除 R9 旧缓存） |
| f | 回报通道 | 把本报告发 A 行（下面 (c)） | 401（token 错）/ 404（principal 不唯一）/ 429（限流） |
| g | 隔离核对 | A 行 status / 端口 / config 未被触碰；池状态文件在 `engine-pool-blue/` | A 行读数变化 / 池文件在默认目录 |

**(c) 报告契约**（自由文本通道上的约定 schema，G13 绕行）[推断]：

```
[blue-report] round=<N> seq=<M> message_id=<uuid>
version=<commit> instance=blue ports=8652/8654/8653
checklist: a=ok b=ok c=ok d=ok e=ok f=ok g=ok   # 或逐项 fail+原因
gaps: <列表或 none>
handoff: <git 分支/文档路径>
```

发送（B 行 agent 二选一）：
- `agent send` to=`<A 行记录员名>@<A node_id>:<A team_id>`（地址形态；**跨节点不支持
  interrupt/notify** [事实] packages/agent/src/tool.ts）；
- CLI：`vessel federation post --to <addr> --from <B addr> <content...>`（一次性进程，结果走
  exit code / JSON [事实] cli-args.ts:3973；federation-hub.md）。

**(d) A 行接收与落盘**：

- [事实] 入站落 Team 日志（`from = federation:<node>:<team>`），最多 1 个 run：principal 必须命中
  **唯一 present 非 private 成员**，否则 404 零写入；`human` 只写日志 0 run。⇒ A 行接收 team 里
  记录员必须 present 且名字唯一。
- [推断] 记录员 agent 收到报告后：① 按 `message_id` 在 handoff 文档里查重（federation 去重只是
  进程内 LRU，跨重启不保 [事实]）；② 新报告 append 进文档并 git commit（**durable 兜底 G6**）；
  ③ 按日志条目自带的 `federation.from_addr` 回 ack（「按地址回复」[事实] federation-hub.md §federation）。
- 发送失败处理 [推断]：401 查 tokenEnv 双方一致；404 查 principal present/唯一；429 等下一分钟窗口；
  对端重启窗口丢消息 ⇒ 重发同 message_id（接收方文档去重）。关键报告（出生证 / 入住裁决）
  **必须同时落 git**，federation 只当通知通道，不当唯一存储。

### 6.3 修复

**原语**：worktree 纪律 + 构建时检查 + `restart --stop-nodes` + c 档恢复。
[事实] AGENTS.md；GATEWAY.md §4；src/node-resume.ts

1. 缺陷来源：自检 gaps / 用户回归反馈 / A 行对照。修复在 **B checkout 的任务 worktree**
   （`worktrees/<topic>`，自己的分支），不碰主 checkout、不碰 A 行 workspace（R8）。
2. 改后 `bun run build`（typecheck + lint 是构建时检查，不是运行时探针）；只读核对 dist 产物非空。
   [事实] AGENTS.md 验证分层
3. **让新代码生效 = 换进程，不是 rotate**：
   ```bash
   bun run src/cli.ts --user-config <blue.yaml> --data-dir <blue-data> \
     gateway restart --instance blue --stop-nodes
   ```
   - [事实] **缺省 `restart` 不换 node 代码**（新平台 adopt 回旧 node，命令打印提示
     `to restart them too: vessel gateway restart --stop-nodes`，GATEWAY.md §4 表）。
     这是闭环里最容易踩的坑：以为重启了、实际 node 还跑旧代码。
   - [事实] `--stop-nodes`：node 先经 `gateway.shutdown` drain（写 resume 标记 + interrupt）≤10s，
     超时回退强杀；池只 terminate owned engine（adopt/external 永不杀）。
   - [事实] `agent rotate` / `sessions.restart` 是同进程换 body（epoch+1），**不是换代码**
     （graceful-restart.md §2）；配置热更走 `gateway reload --scope config`（TLS/token/端口/provider 除外）。
4. 重启代价与恢复（c 档，不承诺 b 档）：
   - [事实] 被打断会话：启动扫 `resume_after_restart` 标记 → 发重启 EnvCard（模型 + 用户同源，
     下一次请求、用户输入之前注入）→ FIFO 重放 human 输入 → 卡准入（`message.injected` 后有
     `llm.request`）才清标记；去重键 run_id + interrupted_at（src/node-resume.ts 头注）。
   - [事实] interrupted run 可手动 `vessel resume`（`runs.resume` 接受 running|interrupted，
     ADR-040）；**启动期不自动续 run**。
   - [推断] 重启时机选 idle / 轮次边界，把可见中断压到最小；在途写类工具不重放（同行主流同此，
     graceful-restart.md §3）。
5. 每修一批 → 回 6.2 出增量报告（seq+1，同 round）。小批量、高频次（SRE：小变更回退便宜）。[推断]

证伪信号：restart 后 node 版本读数仍是旧 commit（忘了 --stop-nodes）；重启卡没出现（标记没写 /
没准入）；human 输入没重放（inbox 条目非 human 源 / 无 session_id）。

### 6.4 回归（用户裁决，agent 只备清单）

**原语**：宪法第四条（行为验证由用户做，证据来自只读真实读数）+ readiness≠验收（§3.5）。

回归清单（用户执行 / 观察；每项给证伪信号，风格仿 node-auto-join.md §10.4）：

| # | 项 | 用户动作 | 失败会看到 |
|---|---|---|---|
| 1 | 入口 | 浏览器开 B origin，登录，**刷新页面** | 打不开 / 旧缓存假报 timeline 缺口（R9） |
| 2 | 会话全链路 | 新会话 → 发消息 → 工具调用 → 看 timeline | agent 看到的 ≠ 用户看到的；工具报错 |
| 3 | 历史读回 | 打开 B 行自己的历史会话 | 读不回 / 格式错（B 宇宙内应完整） |
| 4 | 中断恢复 | 真实跑一次 `restart --stop-nodes`，观察重启卡 + 输入重放 | 卡缺席 / 输入丢 / 标记不清（下次启动重复发卡） |
| 5 | federation 双向 | B→A 报告到达 Team 日志并 dispatch；A→B 按地址回复 | 401/404/429；日志有 `federation.rejected` |
| 6 | 隔离 | A 行端口 / 数据根 / config 读数不变；池文件归属 blue | A 行被波及（R1–R6 任一破防） |
| 7 | 工作区 | B worktree `git status` 干净、write.lock 无跨线争用 | 跨线覆盖（R8） |

- 判定：全绿 → **用户裁决入住**（口头或文档记录）；任一红 → 回 6.3。
- agent 职责边界 [推断]：只准备读数、整理证据、解释失败；**不代跑探针、不代裁决**。
  清单外的探索性使用（用户日常真实工作）是最终 oracle——cohort 观察窗建议时间盒化
  （如 1–3 天日用），期间 A 行保持可用（金丝雀回退路径常开）。

### 6.5 入住（会话宇宙切换）

**原语**：裁决②（切换 = 新会话宇宙，不迁移）+ federation handoff + agent create/hire。
[事实] 配方 §4；federation-hub.md §不做什么

前提：用户裁决；回归全绿；handoff 文档完整。**入住不是数据搬家，是工作连续性交接**：

1. **冻结**：A 行停止接新工作（只读过渡期，Fowler §3.1 细节 1 的 vessel 形态）。A 行记录员写
   handoff 文档：当前工作状态 / 未竟事项 / 关键路径 / 成员名册与职责 / 已知坑 → git commit。[推断]
2. **handoff 消息**：A 记录员经 federation 发指针给 B 行（地址形态，内容 = 文档路径 + 摘要 +
   message_id）；B 行 agent 读文档。git 是 durable 通道，消息只是通知（G6 绕行）。[推断]
3. **B 行重建成员**：`agent create` / `hire`，system_prompt / 首条消息携带 handoff 文档路径与摘要。
   - [事实] 跨宇宙**没有会话迁移**（裁决②）；`rotate` 的 startup_prompt 只是同进程 body handoff，
     不能跨舰队。新成员 = 新会话，上下文靠文档重建。
   - [事实] federation 不做远程 create/spawn ⇒ 重建必须由 B 行本地 agent 执行（G7）。
4. **换入口**（= 切路由器）：浏览器 → B origin（刷新 + 重新登录，凭据按 origin 隔离只进
   sessionStorage [事实] 配方 §2）；CLI → 带 B 的 UC/DD 或 `--connect` + connect token；TUI 同理。
5. **A 行处置**：推荐**保留为回退线**（零成本热备，§3.1 角色轮转）；确要停则
   `gateway stop --instance default --stop-nodes`（真停；缺省只停平台层）。双行期不卸载、
   不 install-service。[事实] 配方 §3；裁决③
6. **记录**：宇宙切换事件（时间 / 入口 / 版本 / 裁决人）写进 handoff 文档并 git commit。
   B 行自此成为新 A（生产线）。[推断]

旧会话怎么办：留在 A 宇宙。A 保留时可经 A 入口只读查询；确要导出注意
`legacy_session_unsupported`（0.55+ 不认旧格式，用 0.54 导出 [事实] 配方 §4）。
**不做**：停两行 → 备份 → 复制 dataDir 的离线迁移（裁决②禁止；单向门警示见配方 §4）。

证伪信号：B 行成员「记得」A 行会话内容（不可能——除非 handoff 文档写了，说明文档在起作用）；
用户浏览器仍指 A（入口没切）；A 行被停掉后想回退发现数据根被删（违反「归档不删」）。

### 6.6 迭代与回退

**回退**（入住后任何时刻）：
- 入口换回 A 即回退，A 根 / 配置 / 端口未被触碰，零成本。[事实] 配方 §4
- B 行已产生的工作：**git 提交仍在仓库**（工作区是 git，不是 dataDir）；B 宇宙会话状态留在 B，
  需要时经 B 入口只读查询或写进 handoff 文档。[推断] 这是「不迁移」的代价，文档补偿。
- 回退后 B 行保留现场（不删数据根）供排查；修复后重走 6.2–6.5。[推断]

**迭代**（下一轮候选）：
- 角色轮转（Fowler）：B 转正后，下一轮候选可复用 B checkout（pull 新 main）或起 C 行
  （green/8662/8664/8663，§6.0 命名表）；旧 A 在稳定窗后退役：`stop --stop-nodes` + 数据根**归档不删**。
- **并发版本数压到最少**（Sato）：同一时刻最多两行活跃（生产 + 候选）。[业界] §3.2
- **开关台账清零**（Hodgson）：候选线相对生产线的 config diff 逐项处置——转正为正式配置或删除；
  不留长命 release toggle。[业界] §3.3；[推断] 台账就是 handoff 文档的一节。
- 每轮闭环产物全部进 git（出生证 / 自检报告序列 / 回归记录 / 入住记录 / 回退记录）——
  **git 文档序列是跨会话宇宙的 durable 状态**，会话是宇宙内易失的。[推断] 这是本手册的核心推荐。

## 7. 跨节点场景

> 同机双行（§6 主线）是回环特例；跨机时多三件事：TLS、hub 目录、D 定格。闭环六步不变，
> 只有通道搭建与入住动作的形态不同。

### 7.1 拓扑与通道

- **控制面（hub）**：B 机 node 出站加入 A 机 hub（或独立 hub 机）。[事实] REMOTE.md §3.6：
  ```bash
  # hub 侧（独立 dataDir，必须与节点 dataDir 不同）
  vessel hub join-code --data-dir <hubDir> --ttl 300 --json
  # node 侧：一次性 code 换 token（只进 SecretStore，不落 YAML/日志）
  vessel hub join https://hub.example:8643 --code <CODE> \
    [--public-url <url>] [--ca <file>] [--data-dir <nodeDir>]
  ```
  同机回环有无码自助重 join（auto-join 已实现 [事实] node-auto-join.md 状态行）；跨机走 join-code。
  hub 只传目录 / 指针元数据，**不代理正文**；节点离线保留最后快照只读展示。[事实] federation-hub.md
- **数据面（federation）**：peers url 非回环**必须 https**（无 `--insecure` 逃生口 [事实] REMOTE.md §1）。
  TLS 两条路 [事实] REMOTE.md §2.1/§3：① node 自带 TLS：`allow_remote: true` + token + `tls.cert_file/key_file`
  （SAN 必须覆盖客户端实际使用的 host/IP，否则启动失败 / 校验失败）；② 反向代理终结 TLS，node 留回环，
  `--connect https://...` 指代理。自签证书用 peer 的 `caFile` 指定 CA。
- **NAT**：`hub.direction: node` 只保证元数据可达；没有浏览器可达地址的节点要隧道 / 反向代理，
  可用 `public_url` 声明 origin；`data_plane: direct|unreachable` 由 `public_url ?? url` 派生。
  [事实] CONFIG.md §2.13
- **D 定格（G8）**：新 node join 后，老平台的派生白名单不运行期刷新 ⇒ 浏览器直连新 node 会 403。
  绕行：显式 `node.allowed_origins`（`reload --scope config` 可热更 [事实] REMOTE.md §3.4）或重启平台。
  [事实] node-auto-join.md §10.2–10.3

### 7.2 跨机闭环差异（相对 §6）

| 阶段 | 跨机形态 |
|---|---|
| 6.1 起新版 | B 机 agent 本地执行启动命令（A 机 agent 经 federation 下指令，**不是远程 spawn**——federation 不做远程生命周期 [事实]）；出生证照写，git push 共享 |
| 6.2 自检回报 | 通道 = https peers（§7.1）；报告契约不变；git 兜底更重要（跨机网络窗口更多）[推断] |
| 6.3 修复 | 修复在 B 机 worktree；`restart --stop-nodes` 由 B 机 agent 本地执行；A 机只收报告 [推断] |
| 6.4 回归 | 用户浏览器经代理 / 隧道开 B origin；其余清单不变 |
| 6.5 入住 | handoff 文档经 **git push/pull** 跨机（durable 主通道）+ federation 指针消息；B 机本地重建成员；用户入口指 B 机；A 机保留为回退线 [推断] |
| 6.6 迭代/回退 | 回退 = 入口指回 A 机；两机数据根各自独立，互不触碰 [事实] 配方 DD 分离 |

### 7.3 跨节点 handoff 的边界（再强调）

- federation **不做**远程 spawn / close / rotate / resume / create、自动中继 / mesh、离线队列 / 重试。
  [事实] federation-hub.md §不做什么
- 所以「把 A 机的 agent 搬到 B 机」永远 = **文档 + 消息 + 目标侧新建**，没有别的形态。
  会话宇宙切换（裁决②）在跨机场景同样成立：不迁移数据，只交接工作。[推断]
- hop 恒 1：A↔B 直连；经第三机中转不支持（maxHops 只是防御上界）。[事实] federation-hub.md §guards

## 8. 风险登记

> 配方 R1–R10 全部继承（[事实] version-isolation-blue-green.md §5，不重复抄表）：
> R1 池 adopt 无版本闸 / R2 端口冲突 / R3 共享 dataDir 互扰 / R4 OS 服务拉错版本 /
> R5 插件与 marketplace 共享 / R6 更新缓存共享 / R7 数据格式单向门 / R8 同 workspace 并行写 /
> R9 浏览器旧缓存 / R10 舰队 yaml 可读。闭环新增：

| # | 风险 | 缓解 | 锚点 |
|---|---|---|---|
| R11 | **假升级**：`restart` 缺省不换 node 代码，以为升了实际没升 | 换代码恒 `--stop-nodes`；自检 b 项版本核对；命令自带提示行 | [事实] GATEWAY.md §4 |
| R12 | 回报丢 / 重（federation 无离线队列，去重仅进程内） | 幂等 message_id + 接收方文档去重 + ack + 重发；关键报告落 git | [事实] federation-hub.md §guards；§6.2(d) |
| R13 | handoff 文档过期 / 不全 ⇒ B 行新成员上下文断档 | 冻结期写文档 + 模板（状态/未竟/路径/名册/坑）+ 用户核对 | [推断] §6.5 |
| R14 | 入口切换不彻底（浏览器缓存 / CLI 仍指 A）⇒ 假回归 | 刷新 + 重新登录 + 入口对照表逐项核对 | [事实] 配方 §2、R9 |
| R15 | 回退线被误停 / 数据根被删 ⇒ 无路可退 | A 行保留为默认处置；停要显式 `--stop-nodes` 并记录；数据根归档不删 | [推断] §6.5–6.6 |
| R16 | 迭代期端口 / instance 碰撞 | §6.0 命名表；bind fail-fast 可见 | [事实] 配方 R2 |
| R17 | 长命 release toggle 债（候选 config diff 滞留） | 入住后台账清零或转正 | [业界] Hodgson；§6.6 |
| R18 | 修复重启打断在途 run（c 档可见代价） | idle / 轮次边界重启；重启卡 + 输入重放兜底；必要时手动 `vessel resume` | [事实] node-resume.ts；ADR-040 |
| R19 | 跨机新 node origin 不被老平台认识（D 定格）⇒ 403 | 显式 `node.allowed_origins`（可热更）或重启平台 | [事实] node-auto-join.md §10.3；REMOTE.md §3.4 |
| R20 | peer secret 进 yaml / 日志 | 只走 tokenEnv；yaml 不放密钥（R10）；token 解析后不落盘不打印 | [事实] federation-config.ts 头注 |

## 9. 未证 / 待实测

1. **闭环整体未端到端实测**：本手册是调研产物，作者按宪法不启动舰队、不跑探针。每步都有
   文档 / 代码锚点，但组合行为（federation 报告 → dispatch → 记录员落文档 → ack 回程）
   待用户按 §6 真实走一轮验证。[推断] 各步独立语义已证，组合未证。
2. 报告契约（§6.2c）是文本约定不是 schema：接收方 agent 解析可靠性未证；首轮建议人工核对落盘结果。
3. cohort 观察窗「1–3 天」、C 行命名 green/866x、角色分工均为**建议**，非用户裁决。
4. 跨机 TLS 终结的具体代理配置未展开（属 REMOTE.md / 运维范畴）；`caFile` 自签链路待实测。
5. Windows 下 drain 超时回退强杀的实际时序、`--stop-nodes` 后池孤儿残留形态：见 GATEWAY.md §4
   与配方 §3 的既有实测记录，本手册未新增实测。
6. b 档自动串接（G9 目标态）与 D 运行期刷新（G8 目标态）是将来代码工作，本手册只绕行。

## 10. 参考

### 本仓锚点（基线 8694a681）

- `docs/operations/version-isolation-blue-green.md` —— 2026-11-23 裁决配方（本手册骨架）
- `docs/operations/GATEWAY.md` §4 —— stop / restart / --stop-nodes 语义表
- `docs/architecture/gateway-lifecycle.md` —— 分段启动 / adopt / handoff / 归属三元复核 / Q4-C
- `docs/architecture/federation-hub.md` —— federation 数据面 / guards / hub 控制面 / 不做什么
- `docs/architecture/node-auto-join.md` §10 —— auto-join 现态 / D 定格 / 证伪方式
- `docs/operations/REMOTE.md` §2.1 / §3.3.1 / §3.4 / §3.5.1 / §3.6 —— TLS / 寻址 / reload / token 词表 / hub join
- `docs/operations/CONFIG.md` §2.13 —— hub direction / NAT 数据面
- `docs/operations/MIGRATION.md` —— vessel migrate 只做存储格式迁移（非跨版本会话迁移）
- `docs/adr/ADR-040-durable-run-store-checkpoint-resume.md` —— checkpoint / runs.resume 语义
- `docs/dev/research/graceful-restart.md` —— 三档判定 + 进程级优雅重启业界表（nginx / k8s / systemd / Erlang / pm2 / Claude Code / aider / OpenHands，URL 见该文 §4）
- 代码：`src/node-resume.ts`（重启卡四步序）、`src/federation-config.ts`（peer 归一化 fail-closed）、
  `src/federation-client.ts`（`POST <peer.url>/v1/federation/messages`）、`src/cli-args.ts:3973`
  （federation post/peers）、`packages/serve/src/gateway/methods/admin.ts:21`（RELOAD_SCOPES）、
  `packages/agent/src/tool.ts`（agent send 地址形态，跨节点无 interrupt/notify）

### 业界来源（2026-11-24 本次调研直接抓取）

| 来源 | URL | 用在 |
|---|---|---|
| Martin Fowler, *BlueGreenDeployment*（2010，2015 更新） | https://martinfowler.com/bliki/BlueGreenDeployment.html | §3.1 骨架 / 只读过渡 / 角色轮转 / DB 解耦 |
| Danilo Sato, *CanaryRelease*（2014） | https://martinfowler.com/bliki/CanaryRelease.html | §3.2 cohort / ParallelChange 应用 / 并发版本数 |
| Google SRE Workbook ch16, *Canarying Releases* | https://sre.google/workbook/canarying-releases/ | §3.2 三要求 / 小批量 / 按变化速率分离 |
| Pete Hodgson, *Feature Toggles*（2017） | https://martinfowler.com/articles/feature-toggles.html | §3.3 四类别 / carrying cost / 静态优先 |
| Danilo Sato, *ParallelChange*（2014） | https://martinfowler.com/bliki/ParallelChange.html | §3.4 expand–migrate–contract |
| Argo Rollouts 官方文档 | https://argoproj.github.io/rollouts/ | §3.5 readiness≠验收 / manual judgement / rolling 局限 |

> 检索说明：web_search（bocha 后端）对英文查询命中质量差，以上 URL 经搜索定位候选后
> 以 web_fetch 直接抓取原文核实；未采信搜索摘要中的二手转述。