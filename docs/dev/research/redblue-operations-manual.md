# 红蓝运维手册（Red-Blue Operations Manual）

> 调研 + 文档产物，不改任何产品代码。分支 `design/q-redblue`，基线 `8694a681`。
> 任务：把「旧版 agent 起新版 → 新版自检回报 → 修复 → 回归 → 入住 → 迭代」闭环落到 vessel 既有原语上。
> 证据标注：**[事实]** = 本仓文档/代码锚点；**[推断]** = 作者判断；**[业界]** = 外部来源（URL 见 §10）。
> 宪法约束（本手册自身与推荐流程都遵守）：零测试 / 零探针 / 零临时验证进程；行为验证由用户本人做，
> 证据只来自只读真实日志 / 数据 / 构建产物。B 行是**候选生产线**（真实数据根、真实工作），不是临时探针。

## 0. 结论先说

（调研完成后填写：推荐方法一句话 + 闭环六步摘要 + 最重要的三条纪律。）

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

（填写：已具备 / 缺口 / 替代做法 三列映射表。）

## 5. 缺口分析

（填写：区分「可补缺口」与「裁决边界（不补，绕行）」，每条给缓解。）

## 6. 推荐方法 + 操作步骤（闭环 playbook）

（填写：6.0 前置纪律；6.1 旧版 agent 起新版；6.2 新版自检回报；6.3 修复；6.4 回归；6.5 入住；6.6 迭代与回退。）

## 7. 跨节点场景

（填写：多机 handoff、federation 回报、hub join、会话宇宙切换的跨机形态。）

## 8. 风险登记

（填写：继承配方 R1–R10 + 闭环新增风险。）

## 9. 未证 / 待实测

（填写。）

## 10. 参考

（填写：本仓文档锚点 + 业界 URL。）