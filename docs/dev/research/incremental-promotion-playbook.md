# 增量晋升 playbook（Incremental Promotion Playbook）

> 调研 + 文档产物，不改任何产品代码。分支 `design/q-promotion`，基线 `57407f62`。
> 任务：把红蓝手册（`redblue-operations-manual.md`，q-redblue，636 行，终版 commit `1dc61c72`）
> §6 的「整体切换闭环」改写为**节点级持续增量晋升**：稳定 node 日用不动，金丝雀 node 跑新代码
> 实验验证，验证 OK 的改动**逐步晋升回稳定线**——不做整体入口切换、不做会话宇宙迁移。
> 证据标注：**[事实]** = 本仓文档/代码锚点；**[推断]** = 作者判断；**[业界]** = 外部来源
> （沿用红蓝手册 §3/§10 已核实的业界调研，不重复抓取）。
> 宪法约束（本 playbook 自身与推荐流程都遵守）：零测试 / 零探针 / 零临时验证进程；行为验证由
> 用户本人做，证据只来自只读真实日志 / 数据 / 构建产物。金丝雀线是**真实实验线**（真实数据根、
> 真实工作），不是临时探针。

## 裁决记录（2026-11-24，用户）

**丢弃整体蓝绿切换，改为节点级持续增量晋升**：开两个 node（稳定 production + 金丝雀），
金丝雀跑新代码实验验证，OK 后把改动逐步晋升回稳定线代码；不做整体入口切换 / 会话宇宙迁移。
**整体切换降级为罕见特殊迁移**——只用于数据格式单向门等破坏性变更（§5），不再是常规发布路径。

与既有裁决的关系（2026-11-23 三条，[事实] `docs/operations/version-isolation-blue-green.md` 头部）：
① 不加 profile 新实体——**继续遵守**（晋升全部用既有杠杆：git + build + restart）；
② 切换 = 新会话宇宙、不做离线迁移——**不被推翻，被绕开**：增量晋升根本不切换宇宙，
稳定线会话原地保留；该裁决只在罕见特殊迁移（§5）中继续生效；
③ 双行期不跑 install-service——**继续遵守**。

## 0. 结论先说

**推荐方法一句话**：稳定线（production）永远是日用入口，金丝雀线（canary）长期常驻跑新代码
做真实实验；每个**已验证的 commit 批次**经三道闸门（金丝雀验证 + build 绿 + 用户行为验收）
加一道硬闸门（数据向后兼容，§4）后，merge/cherry-pick 回稳定线代码 → rebuild →
`gateway restart --stop-nodes` 换代码；稳定线会话靠 durable-resume 原地保住，用户不换入口、
不丢会话宇宙。回滚 = commit 粒度 revert + 同样的 rebuild/restart。整体蓝绿切换降级为
破坏性格式变更的罕见特殊迁移（§5）。

**晋升循环六步**（详细命令与证伪信号见 §2）：

1. **金丝雀开发**：改动在金丝雀 checkout 的任务 worktree 小批量做，build 后
   `restart --stop-nodes` 让金丝雀 node 换代码（R11）。
2. **金丝雀验证**：只读自检清单 + 真实实验工作 + 时间盒观察窗；报告经 federation 通知
   稳定线记录员，**关键证据落 git**。
3. **闸门裁决**：三道闸门全绿 + 数据兼容分类通过（§3/§4），用户裁决晋升；任一红 → 回 step 1。
4. **晋升**：已验证 commit 批次 merge/cherry-pick 进稳定线分支 → 稳定 checkout
   `bun run build` → 稳定舰队 `gateway restart --stop-nodes`。
5. **恢复与核对**：稳定线 durable-resume（重启卡 + human 输入重放 + 必要时手动
   `vessel resume`）；版本读数核对（防 R11 假升级）；用户刷新页面做晋升后冒烟。
6. **台账与下一批**：晋升记录（批次范围 / 闸门证据 / 回滚点）git commit；金丝雀继续
   下一批实验。**小步高频**，防 delta 重新变大。

**三条最重要的纪律**（与红蓝手册同源，但重心变了）：
① **换代码必须 `restart --stop-nodes`**，且晋升后核对稳定线版本读数——现在这个坑落在
**生产线**头上，比候选线更疼（R11/R23）；
② 两 node **永不共享 dataDir / 池 instance / workspace**（R1/R3/R8）——增量晋升下金丝雀
长期常驻，隔离纪律是常设纪律而不是双行期临时纪律；
③ **git commit 序列 = durable 台账**：晋升批次、闸门证据、回滚点全部落 git；federation
只当通知通道（G6/R12）。会话不搬 ≠ 状态不记——稳定线会话原地保留，但「哪个 commit 在跑、
验证过什么、怎么退」必须写在 git 里。

**与整体切换的根本差异**：整体切换把「验证通过的新宇宙」换成日用入口，旧宇宙整体抛弃
（会话不迁移，靠 handoff 文档补偿）；增量晋升把「验证通过的代码」搬回**不动的**日用宇宙，
会话、成员、历史全部原地保留，代价从「宇宙切换 + handoff」变成「一次 c 档重启」。
只要数据向后兼容闸门把住（§4），这个代价就是小且可控的。[推断]

## 1. 术语与框架重命名

> 重命名不是修辞：红蓝手册的 A/B 隐含「B 验证通过后转正、A 退役」的**角色轮转**；
> 增量晋升里**稳定线永不退役、金丝雀永不转正**，两条线的角色是固定的。[推断]

| 术语 | 定义 | 对应红蓝手册 |
|---|---|---|
| **稳定 node（stable / production）** | 日用生产线：默认根 `~/.vessel`，instance `default`，端口 8642/8644(/8643)。入口永远指它；会话宇宙唯一且连续 | A 行（红），但不再「冻结→退役」 |
| **金丝雀 node（canary）** | 常驻实验线：独立 checkout + `--user-config`/`--data-dir`/`engine_pool.instance: canary` 整体搬出，端口 8652/8654/8653。跑新代码做真实实验工作，**不接日用入口** | B 行（蓝），但不再「入住转正」 |
| **晋升（promotion）** | 把金丝雀上已验证的 commit 批次 merge/cherry-pick 回稳定线分支 + rebuild + `restart --stop-nodes`。**搬的是代码，不是会话/数据** | §6.5「入住」的替代物 |
| **晋升批次（batch）** | 一次晋升携带的 commit 集合：一个连贯、可独立验证、可独立回滚的最小单元。小步高频的「步」 | 无对应（整体切换是一次性大爆炸） |
| **晋升台账（ledger）** | git 文档序列：每批的范围 / 闸门证据 / 稳定线前后 commit / 重启时刻 / 回滚点。durable 状态唯一权威 | handoff 文档的常态化替代 |
| **特殊迁移（special migration）** | 罕见流程：破坏性数据格式变更（单向门）无法增量晋升时，显式停两线 → 备份 → 迁移/新宇宙 → 换入口。整体蓝绿切换降级为此 | §6.5 整体切换（降级保留） |
| **回归 / 验收** | 用户行为验证 + 只读真实读数核对（宪法第四条），不是自动化测试 | 不变 |

拓扑说明 [推断]：「两个 node」按已裁决配方落地为**两个舰队**（各含自己的 node），而不是
单 gateway 下挂两个 node——单 gateway 的 node 子进程从**同一个 checkout** spawn
（[事实] gateway-lifecycle.md 分段启动），跑不了两份代码；且池 adopt 无版本闸（R1），
混居不安全。两舰队配方（UC/DD/instance/端口整体搬出）是唯一已裁决、已实测的隔离形态。
federation peers 保持两线互通（报告通道，§2.2）。

命名表（防碰撞，继承红蓝手册 §6.0 第 7 条并改名）[推断]：

| 线 | instance | 端口（gateway/node/hub） | 数据根 | 角色 |
|---|---|---|---|---|
| 稳定 | `default` | 8642/8644/8643 | `~/.vessel/data` | 日用，永不动 |
| 金丝雀 | `canary` | 8652/8654/8653 | `fleets/canary/data` | 常驻实验 |
| 迁移目标（仅特殊迁移临时起） | `migrate` | 8662/8664/8663 | `fleets/migrate/data` | §5 用完归档 |

## 2. 晋升循环（核心 playbook）

> 下面的命令是给**操作者**（舰队 agent 或人）执行的步骤说明；本 playbook 作者不执行任何一条
> （宪法）。每阶段标：用到的原语 [事实] / 组合判断 [推断] / 证伪信号（做错了会看到什么）。
> 角色分工（继承红蓝手册 §6.0 第 6 条）：金丝雀 agent = 开发者 + 自检者；稳定线 agent =
> 记录员 + 晋升执行者；**用户 = 闸门与回滚的唯一裁决者**；main = 分支合并裁决者。

```
        稳定线（production，入口/会话宇宙不动）          金丝雀线（常驻实验）
        ─────────────────────────────────────          ────────────────────────
              ▲                                        2.1 开发：任务 worktree
              │                                            小批量改 + build
              │ 2.4 晋升：merge/cherry-pick 已验证批次      + restart --stop-nodes
              │     → 稳定 checkout rebuild                    │
              │     → 稳定舰队 restart --stop-nodes       2.2 验证：只读自检
              │                                            + 真实实验工作
              │ 2.5 恢复：durable-resume 保住会话          + 时间盒观察窗
              │     版本核对 + 用户刷新冒烟                + federation 报告
              │                                            │
              │ 2.6 台账 git commit                   2.3 闸门：三齐 + 数据兼容
              │                                            │（§3/§4，用户裁决）
              └────────────── 全绿 ◄───────────────────────┤
                                                           │ 任一红
              下一批（小步高频）──► 2.1 ◄──────────────────┘
```

### 2.0 前置与纪律（常设，不是每轮临时核对）

继承红蓝手册 §6.0 全部七条，按增量晋升改三处 [推断]：

1. 两 checkout 各自 `bun install`（apps/web 另需 `bun install --cwd apps/web`），不得
   junction 共享 node_modules。[事实] 配方头部
2. 金丝雀 config yaml 按配方 §2 模板（data_dir / 端口 8652/8654/8653 /
   `engine_pool.instance: canary` / `update.auto_check: false`）；yaml 不放任何密钥（R10）。
   [事实] 配方 §1–2
3. 金丝雀启动恒带 `VESSEL_NO_EXTERNAL_PLUGINS=1`。[事实] 配方 §2
4. **双线常驻期**冻结三类动作：`install-service` / marketplace install / update apply
   （都写共享 `~/.vessel`）。整体切换是「双行期」临时冻结；增量晋升下这是**常设纪律**，
   直到金丝雀线退役。[事实] 裁决③、配方 R4–R6；[推断] 常设化
5. 金丝雀工作区 = 独立 worktree（`worktrees/<topic>`），不碰主 checkout、不碰稳定线
   workspace（R8）。**稳定 checkout 同样不直接开发**——它只接受晋升 merge，是「已验证
   代码的部署副本」，不是开发分支。[推断]
6. 端口 / instance 按 §1 命名表；`--port 0` 必须配 `--instance`。[事实] 配方 §2
7. **新增：稳定线分支纪律** [推断]：稳定 checkout 停在稳定分支（如 `main` 或专用
   `stable` 分支，由 main 裁决）；晋升 = 把已验证 commit 合入该分支；禁止在稳定 checkout
   里直接改代码（改了就没有「已验证」属性，闸门失效）。

### 2.1 金丝雀开发（改动只在金丝雀侧发生）

**原语**：worktree 纪律 + 构建时检查 + `restart --stop-nodes` + c 档恢复。
[事实] AGENTS.md；GATEWAY.md §4；src/node-resume.ts

1. 改动在**金丝雀 checkout 的任务 worktree** 小批量做（自己的分支），不碰主 checkout、
   不碰稳定线 workspace。一批 = 一个连贯可验证单元（§3 闸门以批为单位）。
2. `bun run build`（typecheck + lint 是构建时检查，不是运行时探针）；只读核对 dist 非空。
   [事实] AGENTS.md 验证分层
3. 合入金丝雀分支，让金丝雀 node 换代码：
   ```bash
   bun run src/cli.ts --user-config <canary.yaml> --data-dir <canary-data> \
     gateway restart --instance canary --stop-nodes
   ```
   - [事实] **缺省 `restart` 不换 node 代码**（新平台 adopt 回旧 node，GATEWAY.md §4 表
     + 提示行）——R11 在金丝雀侧同样成立，自检版本核对兜底。
   - [事实] `--stop-nodes`：node 先 `gateway.shutdown` drain（写 resume 标记 + interrupt）
     ≤10s，超时强杀；池只 terminate owned engine。
   - [事实] `agent rotate` / `sessions.restart` 是同进程换 body，**不是换代码**；配置热更
     走 `gateway reload --scope config`（TLS/token/端口/provider 除外）。
4. 金丝雀重启代价由 c 档兜底（重启卡 + human 输入重放，§2.5 同机制）；金丝雀跑的是实验
   工作，重启时机约束比稳定线宽松。[推断]

证伪信号：restart 后金丝雀版本读数仍是旧 commit（忘了 --stop-nodes）；重启卡没出现。

### 2.2 金丝雀验证与回报

**原语**：federation 数据面 + 只读读数 + 真实工作。[事实] federation-hub.md；宪法第四条

**(a) 回报通道**：两线 config 互配 `federation.peers[]`（形状 / fail-closed 守卫 / tokenEnv
纪律全部继承红蓝手册 §6.2a，不重复抄）。要点重述 [事实]：url 指对端 **Node API**
（node.port，不是平台端口）；回环 http 允许、非回环必须 https；DD 分离 ⇒ 派生 token 跨舰队
401，peer token 是独立命名空间；secret 只进双方 env 不进 yaml（R10）。

**(b) 金丝雀自检清单**（继承红蓝手册 §6.2b，改两处）：

| # | 项 | 做法 | 证伪信号 |
|---|---|---|---|
| a | 舰队状态 | `gateway status --json`（带金丝雀 UC/DD） | 任一节点 `failed` / hub 缺席 |
| b | 版本核对 | `git log -1` + CLI 版本 vs 本批预期 commit | commit 不符（起错 checkout / 假升级） |
| c | 日志扫描 | 只读 `<canary-data>/logs/gateway.log` | `node_start_failed` / `data_locked` 等 fail-closed 行 |
| d | 真实实验工作 | 金丝雀 agent 在**自己的 worktree** 做真实任务，覆盖本批改动的行为面 | 工具报错 / 行为与预期不符 |
| e | 会话可见性 | 用户开金丝雀 origin 看 timeline（先刷新排除 R9） | 缺口 / 假报 |
| f | 回报通道 | 报告发稳定线记录员 | 401/404/429 |
| g | 隔离核对 | 稳定线 status / 端口 / config 未被触碰；池文件在 `engine-pool-canary/` | 稳定线读数变化（R1–R6 任一破防） |
| h | **数据兼容分类**（新增） | 本批每个改动按 §4 矩阵分类；涉及持久化格式的改动给出「新代码读旧数据」的论证 | 分类缺失 / 单向门未识别（§4 金丝雀盲区） |

**(c) 观察窗**：时间盒化（建议 1–3 天真实实验工作，非用户裁决），期间稳定线日用不受影响。
金丝雀的「放量」不是流量百分比（无切分面），而是**实验工作的覆盖面**：本批改动的每条行为
路径都有真实工作走过。[业界] SRE「先定判据再放量」；[推断] vessel 形态

**(d) 报告契约**（继承红蓝手册 §6.2c 的文本约定，改名）[推断]：

```
[canary-report] batch=<批次名> round=<N> seq=<M> message_id=<uuid>
version=<commit> instance=canary ports=8652/8654/8653
checklist: a=ok b=ok c=ok d=ok e=ok f=ok g=ok h=ok   # 或逐项 fail+原因
compat: <§4 分类结果：pure-code / additive / contract / one-way>
gaps: <列表或 none>
ledger: <git 分支/文档路径>
```

**(e) 稳定线接收与落盘**：继承红蓝手册 §6.2d 全部纪律——记录员 present 且名字唯一
（入站 dispatch 判据 [事实] federation-hub.md）；按 message_id 文档去重（federation 去重
仅进程内 LRU [事实]）；报告 append 进台账并 git commit；按 `federation.from_addr` 回 ack。
**关键证据（闸门判定 / 晋升裁决）必须落 git，federation 只当通知通道**（G6/R12）。

### 2.3 闸门裁决（详见 §3/§4）

三道闸门（金丝雀验证 + build 绿 + 用户行为验收）**加**数据兼容硬闸门，四者全绿才晋升；
用户是唯一裁决者，agent 只备证据不代裁决。任一红 → 回 2.1 修复，出增量报告（seq+1）。

### 2.4 晋升操作（搬代码回稳定线）

**原语**：git merge/cherry-pick + 构建时检查 + `restart --stop-nodes`。[推断] 组合做法

前提：用户裁决晋升；台账里本批闸门证据完整；稳定线当前 commit 已记录（= 回滚点）。

1. **选批次**：从金丝雀分支取已验证 commit 范围。两种形态 [推断]：
   - **merge**（默认）：金丝雀分支整段合入稳定分支——历史连贯、无重复 commit；适合
     金丝雀分支自上次晋升后**全部**改动都已验证的情形。
   - **cherry-pick**（挑选）：只摘已验证的 commit——适合金丝雀分支上混有未验证/实验性
     改动的情形。代价：产生新 hash，台账必须记录「金丝雀 hash ↔ 稳定 hash」映射，
     且后续 merge 可能冲突（R25）；依赖未晋升 commit 的摘取会破坏连贯性（R28），
     批次必须自包含。
   - 合并裁决者 = main（角色分工）；稳定分支若受保护，按仓库发布纪律走（AGENTS.md：
     1.0 前本地 squash 到 main 后 push，不开 PR 除非用户要求）。[事实] AGENTS.md 发布纪律
2. **稳定 checkout rebuild**：
   ```bash
   # 稳定 checkout 内（只接受晋升 merge，不直接开发——§2.0 第 7 条）
   bun install            # 仅当本批动了依赖
   bun run build          # typecheck + lint = 构建时检查；闸门 G-B 在此复核
   ```
   只读核对 `apps/web/dist` 非空。build 红 = 晋升中止（批次依赖断裂 / 合并冲突解决错误），
   稳定线进程**尚未重启，仍在跑旧代码**——这是把 build 闸门放在 restart 之前的意义。[推断]
3. **稳定舰队换代码**（唯一让新代码生效的动作）：
   ```bash
   vessel gateway restart --instance default --stop-nodes
   ```
   - [事实] R11：缺省 restart 不换 node 代码；恒带 `--stop-nodes`。
   - [事实] drain：node 先 `gateway.shutdown`（写在跑 run 的 resume 标记 + interrupt）
     ≤10s，超时强杀 + `node.drain.skipped` 日志行；平台层同样 graceful-first（Q4-C）。
   - [推断] **时机选 idle / 轮次边界**：这次重启打断的是**生产线**在途 run（R23），
     比金丝雀重启疼。操作者先只读核对稳定线无 active run（`gateway status` / 会话读数），
     有在途工作则等轮次收尾或请用户裁决时机。一批一次重启，不逐 commit 重启。
4. **晋升后即时核对**（只读）：稳定线 `git log -1` = 批次终点 commit；`gateway status`
   全 ready；`logs/gateway.log` 无 fail-closed 行；CLI 版本读数与预期一致。

证伪信号：restart 后稳定线版本读数仍是旧 commit（R11 假升级——**生产线假升级比候选线
更危险**：用户以为新行为已生效，实际没有）；build 红但已 restart（顺序错）；cherry-pick
后稳定线行为与金丝雀不一致（依赖断裂，R28）。

### 2.5 恢复与用户冒烟（会话不搬的代价与兜底）

**原语**：node-resume 重启卡 + inbox 重投 + 手动 resume（c 档）。
[事实] src/node-resume.ts 头注；graceful-restart.md §1/§3；ADR-040

**会话不搬**：稳定线 dataDir 未被触碰，全部会话 / 成员 / 历史原地保留——这是增量晋升
相对整体切换的核心收益。代价是一次 c 档重启（不承诺 b 档 [事实] graceful-restart.md §3）：

1. [事实] 被打断会话：启动扫 `resume_after_restart` 标记 → 发重启 EnvCard（模型 + 用户
   同源，下一次请求、用户输入之前注入）→ FIFO 重放 human 输入 → 卡准入（`message.injected`
   后有 `llm.request`）才清标记；去重键 run_id + interrupted_at。
2. [事实] interrupted run 可手动 `vessel resume`（`runs.resume` 接受 running|interrupted）；
   **启动期不自动续 run**；在途写类工具不重放（同行主流同此）。
3. [推断] 用户侧动作：**刷新浏览器页面**（同 origin 新后端，旧前端缓存会假报 timeline
   缺口——R9 的晋升形态，R26）；看重启卡是否出现、输入是否重放；做一遍晋升后冒烟
   （本批改动的行为面在**稳定线真实会话**里走一次）。
4. [推断] 冒烟红 → 回滚（§6），不是热修：稳定线不接受未验证改动（§2.0 第 7 条），
   修复必须回金丝雀重走闸门。

证伪信号：重启卡缺席 / 输入丢 / 标记不清（下次启动重复发卡）；用户 timeline 缺口
（先刷新排除缓存）；稳定线会话「记得」金丝雀实验内容（不可能——两宇宙隔离，除非台账写了）。

### 2.6 台账与下一批

**台账条目模板**（每批一条，git commit；建议落 `docs/operations/promotion-ledger.md`，
路径属建议非裁决 [推断]）：

```
## batch-<N> <日期>
- 范围: <金丝雀 commit 范围> → <稳定线 commit>（cherry-pick 时附 hash 映射）
- 分类: <§4 兼容分类>
- 闸门: 金丝雀验证=<报告 message_id/台账锚点> build=<绿/时刻> 用户验收=<裁决记录>
- 回滚点: <晋升前稳定线 commit>
- 重启: <时刻> drain=<正常/超时> 恢复=<重启卡数/重放条数/手动 resume 数>
- 冒烟: <用户结果>
- 裁决人: <用户>
```

下一批：金丝雀分支继续开发（若本批是 cherry-pick，先处理与稳定线的分叉，R25）；
**小步高频**——批次积压会让 delta 重新变大，退回大爆炸切换的老路（R21）。
台账序列 + 稳定线 git 历史共同构成 durable 状态：会话是宇宙内的，台账是跨批次的。[推断]

## 3. 晋升闸门清单

> 三齐才晋升（用户裁决 2026-11-24）：**金丝雀验证 + build 绿 + 用户行为验收**；
> 另加一道**硬闸门**：数据向后兼容（§4）——它不是「三齐」之一，而是**一票否决**：
> 前三道全绿但分类为单向门的批次，照样不得增量晋升。[推断] 结构安排

| 闸门 | 判据 | 证据（全部只读/真实工作） | 裁决者 | 证伪信号 |
|---|---|---|---|---|
| **G-A 金丝雀验证** | §2.2b 清单 a–h 全 ok + 观察窗内本批每条行为路径有真实实验工作走过 + gaps 清零或显式接受 | `[canary-report]` 序列（message_id 去重落台账）；金丝雀日志；worktree git 历史 | 用户（agent 只备读数） | 清单任一 fail；观察窗内改动路径没被真实工作覆盖（「验证过」是假报） |
| **G-B build 绿** | 晋升 merge 后**稳定 checkout** `bun run build` 通过（typecheck + lint）；dist 非空 | build 输出 + 只读产物核对；台账记录时刻 | 构建本身（客观）+ 记录员落台账 | build 红（依赖断裂 / 冲突解决错）；**在金丝雀 build 绿不算数**——合并后的稳定树才是晋升对象 |
| **G-C 用户行为验收** | 用户在金丝雀 origin 按清单做行为验证（下表）；晋升后在稳定线冒烟复核 | 用户裁决记录（口头 → 记录员落台账） | **用户唯一** | 任一红 → 回 2.1；agent 代跑 / 代裁决 = 违宪 |
| **G-D 数据兼容（硬）** | 本批按 §4 矩阵分类为 pure-code / additive / contract（contract 需额外裁决）；one-way → 走 §5 | 分类论证（改动 × 持久化格式）；必要时只读核对稳定线数据格式读数 | 用户（分类论证由 agent 备） | 分类缺失；「金丝雀没报错」被当成兼容证据（金丝雀盲区，§4.3） |

**G-C 用户行为验收清单**（继承红蓝手册 §6.4，改两处：入口不切换、增加晋升后冒烟）：

| # | 项 | 用户动作 | 失败会看到 |
|---|---|---|---|
| 1 | 金丝雀入口 | 浏览器开金丝雀 origin，登录，**刷新页面** | 打不开 / 旧缓存假报缺口（R9） |
| 2 | 本批行为面 | 在金丝雀真实会话里走本批改动的每条行为路径 | 行为与预期不符 / 工具报错 |
| 3 | 历史读回 | 打开金丝雀自己的历史会话 | 读不回 / 格式错 |
| 4 | 中断恢复 | 金丝雀真实跑一次 `restart --stop-nodes`，观察重启卡 + 输入重放 | 卡缺席 / 输入丢 / 标记不清 |
| 5 | federation 双向 | 金丝雀→稳定线报告到达 Team 日志并 dispatch；按地址回 ack | 401/404/429；`federation.rejected` |
| 6 | 隔离 | 稳定线端口 / 数据根 / config 读数不变；池文件归属 canary | 稳定线被波及（R1–R6 任一破防） |
| 7 | **晋升后冒烟**（新增） | 晋升重启后刷新稳定线页面，在**日用真实会话**里复核本批行为面 + 历史会话完整 | 新行为未生效（R11 假升级）/ 历史读不回（G-D 漏判）/ timeline 缺口（R26 缓存） |

**批次纪律**（闸门的隐含前提）[推断]：
- 一批 = 一个连贯单元：自包含（不依赖未晋升 commit）、可独立验证、可独立回滚（§6）。
- 闸门证据以**批**为单位归档；跨批混验（「上批验过的一半 + 这批的一半」）= 证据失效。
- readiness ≠ 验收（[业界] Argo；红蓝手册 §3.5）：`/health` / node ready 只是就绪信号，
  不能替代 G-A/G-C。
- 小批量、高频次（[业界] SRE：多数事故由二进制/配置推送触发，小变更回退便宜）——
  增量晋升把「一次大推送」拆成「多次小推送」，**每次推送仍然是一次事故机会**，
  所以闸门不因批次小而豁免，只是证据量随批次缩小。

## 4. 数据向后兼容矩阵（expand-contract 硬闸门）

### 4.1 兼容方向：新代码 × 旧数据

增量晋升下，稳定线 dataDir 里的会话 / 成员快照 / run checkpoint 是**旧代码写的**；
晋升后新代码必须能读它们。兼容方向是**向后兼容（新读旧）**，不是双版本共享数据
（两线永不共享 dataDir，R3）。[推断]

[事实] 本仓已知的格式单向门（配方 §4）：
- 成员快照 **v4→v5**：新版首写一次性清旧 model 字段（留 `.v4.bak`，备份失败放弃写入）；
  **旧二进制不认 v5**——这同时封死了「晋升后回滚代码」的路（§6 反向单向门）。
- **0.55+ 不认旧格式会话**（`legacy_session_unsupported`，用 0.54 导出）。
- `vessel migrate` 只做 sqlite/file-v1→file-v2 **存储格式**迁移，默认 dry-run，
  不是跨版本会话迁移（[事实] MIGRATION.md §1–2）——不能拿它当格式单向门的通行证。

### 4.2 变更分类 × 晋升路径矩阵

| 类 | 定义 | 例子 | 晋升路径 | 回滚窗口 |
|---|---|---|---|---|
| **pure-code** | 不触碰任何持久化格式 / 接口契约的逻辑改动 | 工具行为修复、UI 渲染、prompt 组装 | 直接增量晋升（三闸门） | 开放：revert 即退（§6） |
| **additive（expand）** | 持久化格式 / config 键 / RPC / federation envelope **只增不删**；旧代码读新数据忽略新增项，新代码读旧数据走缺省 | 快照加可选字段、config 新键带缺省值、envelope 加可选字段 | 直接增量晋升；台账标注「expand 批」 | 开放（旧字段仍在，revert 后旧代码可读） |
| **contract（收缩）** | 删除旧格式支持 / 旧字段 / 旧键——**前提是所有数据已写成新格式且不再需要回滚** | 确认稳定线全部快照已 v5 后删除 v4 读路径 | 单独一批晋升，**额外用户裁决**：确认回滚窗口关闭（§6.3）；不得与 expand 同批 | **关闭**：此批之后 revert 到 expand 之前可能读不了数据 |
| **one-way（单向门）** | 新代码**首写即破坏**旧格式可读性，无 expand 相 | v4→v5 清旧字段、`legacy_session_unsupported` 类断代 | **禁止增量晋升** → §5 特殊迁移 | 不存在（除非 `.v4.bak` 恢复，§5/§6） |

纪律（[业界] Sato ParallelChange 三相，红蓝手册 §3.4 的增量晋升形态）：
- **expand 与 contract 必须是两次独立晋升**，中间隔着观察窗——「任一相都可发布，
  破坏被限制在单相内」。整体切换时代 contract 被「旧宇宙整体保留」替代；增量晋升时代
  contract 回归经典含义：**确认不再回滚后才删旧支持**。[推断]
- 接口契约（federation envelope / RPC 形状 / config 键）同样先 additive 后删除：
  两线常驻互通，金丝雀新 envelope 必须让稳定线旧代码仍能解析（additive），
  反向亦然。[事实] federation-hub.md envelope 固定字段；[推断] 常驻互通的约束
- 分类论证是**设计时**动作（读改动 diff × 格式读写路径），不是运行时探测（宪法）。

### 4.3 金丝雀盲区（为什么 G-D 必须是硬闸门）

**金丝雀验证不能证明向后兼容** [推断]：金丝雀 dataDir 是新宇宙，从第一天起就由新代码
书写——v4→v5 类单向门在金丝雀上**永远不会触发**（没有 v4 数据可破坏）。金丝雀全绿
只证明「新代码 × 新数据」自洽，不证明「新代码 × 稳定线旧数据」可读。所以：

1. G-D 的证据是**分类论证**（§2.2b 清单 h 项），不是金丝雀读数；
2. 涉及持久化格式的批次，晋升前可**只读**核对稳定线真实数据的格式版本读数
   （如快照 version 字段——证据来自只读真实数据，宪法允许）；
3. 晋升后冒烟（G-C 第 7 项）必须包含**打开稳定线历史会话**——这是「新读旧」的第一次
   真实检验，放在用户眼皮底下做，红了立即回滚（§6）；
4. 若分类拿不准，按 one-way 处理（从严）：宁可走 §5 显式迁移，不可静默晋升。

## 5. 特殊迁移流程（罕见：整体切换的降级形态）

（待扩充：触发条件 / 显式迁移步骤 / 与红蓝手册 §6.5 的关系）

## 6. 回滚（commit 粒度）

（待扩充：revert + rebuild + restart；反向单向门；回滚窗口）

## 7. 与红蓝手册的差异

（待扩充：逐节对照表——保留什么 / 替换什么 / 新增什么）

## 8. 风险登记

（待扩充：继承 R1–R20 + 增量晋升特有风险）

## 9. 未证 / 待实测

（待扩充）

## 10. 参考

（待扩充：本仓锚点 + 业界来源指针）