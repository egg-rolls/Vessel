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

> 裁决（2026-11-24）：整体蓝绿切换**降级为罕见特殊迁移**。它不再是常规发布路径，
> 只在增量晋升被硬闸门（§4 G-D）拦下时启用。红蓝手册 §6.5「入住」整套流程在此保留，
> 但触发条件收窄、纪律加重。[推断]

### 5.1 触发条件（满足其一才考虑）

1. **one-way 格式变更**：新代码首写即破坏稳定线旧数据可读性（v4→v5 类，§4.2），
   无法拆成 expand/contract 两批。
2. **断代升级**：目标版本不认稳定线现有格式（`legacy_session_unsupported` 类），
   且无 additive 过渡路径。
3. 用户显式裁决要换会话宇宙（例如数据根整体搬家）——这是裁决②的原始场景，仍然有效。

**不触发**的情况：pure-code / additive / contract 批次一律走 §2 增量晋升；
「改动很大」不是触发条件——大 delta 应拆批（R21），不是借特殊迁移搞大爆炸。[推断]

### 5.2 显式迁移步骤（继承红蓝手册 §6.5，加重备份纪律）

前提：用户裁决启用特殊迁移；G-D 分类论证落台账；迁移目标线（`migrate`/866x，§1 命名表）
按配方起好并自检通过（红蓝手册 §6.1–6.4 全套照走）。

1. **冻结**：稳定线停止接新工作（只读过渡期，Fowler 蓝绿细节 1 的 vessel 形态）。
   记录员写 handoff 文档：工作状态 / 未竟事项 / 关键路径 / 成员名册 / 已知坑 → git commit。
2. **整根备份**（比红蓝手册更重——这是单向门，没有零成本回退）[推断]：
   停两线（`gateway stop --stop-nodes`，真停）→ 稳定线 dataDir **整根备份**（复制，不移动）
   → 核对备份完整。配方 §4 的迁移警示顺序在此生效：回退 = 停进程 → 恢复备份 → 回退二进制，
   **不能反**。
3. **迁移 / 新宇宙二选一**：
   - **新宇宙**（裁决②默认形态）：不复制数据，迁移目标线是全新宇宙；工作连续性靠
     handoff 文档 + federation 指针消息 + 目标侧 `agent create`/`hire` 重建成员
     （红蓝手册 §6.5 步骤 2–3 全套）。
   - **显式数据迁移**（仅当用户裁决要保数据）：停两线 → 整根备份 → 复制 dataDir 到
     目标线 → 目标线新代码首写完成格式转换（留 `.v4.bak`）。**这是单向门**：转换后旧二进制
     不认新格式，回退只能靠备份恢复。`vessel migrate` 只覆盖存储格式（sqlite/file-v1→file-v2），
     跨版本会话格式转换没有通用命令，逐格式人工论证。[事实] MIGRATION.md §1–2；配方 §4
4. **换入口**：浏览器 → 迁移目标 origin（刷新 + 重新登录）；CLI → 目标 UC/DD 或 `--connect`。
   目标线自此成为**新稳定线**（命名表角色更新，台账记录）。
5. **旧稳定线处置**：保留为回退线（数据根**归档不删**）；确要停则显式 `--stop-nodes`。
   回退 = 入口换回 + （若已发生格式转换）恢复备份 + 回退二进制。
6. **记录**：迁移事件（时间 / 入口 / 版本 / 备份位置 / 裁决人）落台账 git commit。

证伪信号：迁移后目标线读不回旧会话（新宇宙形态下属预期，handoff 文档补偿；显式迁移形态
下 = 迁移失败，恢复备份）；回退时发现备份没做 / 数据根被删（违反「归档不删」）。

### 5.3 与增量晋升的关系

- 特殊迁移是**逃生门**，不是迭代节奏：一次迁移后，新稳定线重新进入 §2 增量晋升循环。
- 频率预期：罕见。若发现「几乎每批都要特殊迁移」，说明格式演进没走 expand-contract
  （§4 纪律失效），应修设计而不是修流程。[推断]
- 金丝雀线在迁移中的角色不变：它仍是实验线；迁移目标线是临时第三线（用完归档，
  并发活跃线仍压到最少——迁移窗口内稳定 + 目标两线，金丝雀可暂停）。[业界] Sato 并发版本数

## 6. 回滚（commit 粒度）

> 增量晋升的回滚比整体切换**更细**：整体切换只能整宇宙换回（入口换回 A）；增量晋升
> 可以只退**出问题的那一批 / 那一个 commit**，其余已晋升改动保留。[推断] 核心收益

### 6.1 回滚操作（revert + rebuild + restart）

前提：用户裁决回滚；台账里有本批回滚点（晋升前稳定线 commit）。

1. **定位**：台账查批次范围 → 确定要退的 commit 集合（整批或单个）。
2. **revert**（默认，保持台账 append-only）：
   ```bash
   # 稳定 checkout 内
   git revert --no-edit <批次终点>..<批次起点>   # 整批；单 commit 则只 revert 它
   bun run build                                # 回滚也要 build 绿
   vessel gateway restart --instance default --stop-nodes
   ```
   - revert 产生新 commit = 台账新增一条回滚记录（范围 / 原因 / 裁决人），历史不改写。
   - **应急形态**（revert 冲突解不开时）：`git reset --hard <回滚点>` + rebuild + restart；
     台账必须记录 reset 事件与被丢弃的 commit（durable 历史靠台账补）。[推断]
   - cherry-pick 批次回滚用台账里的**稳定线 hash**（不是金丝雀 hash，R25 映射）。
3. **恢复与核对**：与晋升后相同（§2.5）——durable-resume 保住会话；版本读数 = 回滚点；
   用户刷新冒烟确认坏行为消失。
4. **回滚后**：坏 commit 回到金丝雀侧修复，重走 §2 闸门再晋升；稳定线不带病运行。

证伪信号：revert 后版本读数不对（restart 忘了 --stop-nodes，R11）；回滚后历史会话读不回
（反向单向门，§6.3——说明 G-D 漏判或 contract 批已关闭回滚窗口）。

### 6.2 为什么回滚窗口依赖 G-D

回滚 = 让**旧代码**重新读**新代码写过**的数据。只要晋升批是 pure-code / additive，
旧代码读新数据无碍（additive 只增不删），回滚窗口开放。一旦新代码做了**破坏性首写**
（one-way）或 contract 批删了旧格式支持，旧代码读不了新数据——回滚窗口关闭。
所以 §4 硬闸门同时是**回滚可行性的闸门**：把住 one-way 不静默晋升，就是保住「随时可退」。[推断]

### 6.3 反向单向门（回滚的边界）

[事实] 配方 §4：v4→v5 首写清旧字段留 `.v4.bak`；旧二进制不认 v5。若某批晋升后新代码
已把稳定线快照写成 v5，此时代码回滚到 v4-only 二进制会读不了——**回滚顺序必须是**：
停进程 → 恢复 `.v4.bak`（或整根备份）→ 回退二进制，不能反（先回退二进制会面对读不了的数据）。

纪律 [推断]：
- contract 批（§4.2）晋升前，用户裁决必须显式确认「回滚窗口关闭」——此批之后回滚
  可能需要数据恢复，不再是纯代码 revert。
- 台账每批标注回滚窗口状态（开放 / 关闭 / 需数据恢复）；回滚决策先查这一栏。
- 最坏情况兜底 = §5.2 的整根备份（特殊迁移才强制；常规增量晋升靠 G-D 把住，不强制每批备份）。

## 7. 与红蓝手册的差异

> 逐节对照 `redblue-operations-manual.md`（q-redblue，终版 `1dc61c72`）。
> 三档：**保留** = 原样继承；**替换** = 增量晋升改写；**新增** = 红蓝手册没有。

| 红蓝手册 | 本 playbook | 档 | 说明 |
|---|---|---|---|
| §0 推荐组合（蓝绿骨架 + cohort 金丝雀 + 入口切换回退） | §0 稳定/金丝雀常驻 + 增量晋升 + commit 回滚 | 替换 | 骨架从「切换」变「晋升」 |
| §1 A/B 行、会话宇宙、入住、迭代 | §1 稳定/金丝雀、晋升、批次、台账、特殊迁移 | 替换 | 角色固定，不轮转 |
| §2 原语盘点 | 不重复，直接引用 | 保留 | 隔离/生命周期/federation/共享面事实全部沿用 |
| §3 业界调研 | 不重复，引用结论 | 保留 | Fowler/Sato/SRE/Hodgson/Argo 已核实 |
| §4 映射 M1–M30 | 大部分沿用；M2/M3/M5/M15/M16 语义变 | 替换 | 见下「映射语义变化」 |
| §5 缺口 G1–G13 | 全部沿用；G1 绕行方式变 | 保留+ | G1 从「换宇宙」变「不切换宇宙」（§4 硬闸门） |
| §6.0 前置纪律 | §2.0 | 保留+ | 冻结纪律常设化；新增稳定分支纪律 |
| §6.1 起新版 | §2.0/§2.1（金丝雀常驻，一次起） | 替换 | 不再每轮起新舰队 |
| §6.2 自检回报 | §2.2 | 保留+ | 清单加 h 项数据兼容分类；报告改名 canary-report |
| §6.3 修复 | §2.1 | 保留 | restart --stop-nodes / c 档兜底不变 |
| §6.4 回归 | §3 G-C | 保留+ | 加晋升后冒烟（第 7 项） |
| §6.5 入住（换宇宙 + handoff） | §2.4 晋升 + §5 特殊迁移 | **替换** | 核心差异：常规路径不再换宇宙 |
| §6.6 迭代/回退（入口换回） | §2.6 台账 + §6 commit 回滚 | 替换 | 回退粒度从整宇宙 → 单批/单 commit |
| §7 跨节点场景 | 沿用（federation 通道形态不变） | 保留 | 跨机晋升 = git push/pull 搬代码，更自然 |
| §8 风险 R11–R20 | §8 继承 + R21–R28 | 保留+ | 新增增量晋升特有风险 |

**映射语义变化**（§4 表中随框架变的几行）[推断]：
- M2「入口即路由器」：增量晋升下**入口不动**，路由器隐喻失效；「切换」只发生在特殊迁移。
- M3「快速回退 = 入口换回」：变为「revert + rebuild + restart」，粒度更细但需重启。
- M5「角色轮转」：**取消**——稳定/金丝雀角色固定，不轮转。
- M15「migrate 相 = 换宇宙」：变为「merge/cherry-pick 搬代码」；会话不迁移。
- M16「contract 相 = 旧线退役」：回归经典 expand-contract——contract = 删旧格式支持（§4.2）。

**一句话总结差异**：红蓝手册把「新宇宙」当发布单元，整体切换、会话抛弃、入口回退；
本 playbook 把「已验证 commit 批」当发布单元，增量晋升、会话保留、代码回退。
隔离配方 / 生命周期原语 / federation 纪律 / 宪法边界**全部不变**——变的是发布节奏与回滚粒度。[推断]

## 8. 风险登记

> 配方 R1–R10 + 红蓝手册 R11–R20 **全部继承**（[事实] version-isolation-blue-green.md §5；
> redblue-operations-manual.md §8，不重复抄表）。增量晋升特有新增：

| # | 风险 | 缓解 | 锚点 |
|---|---|---|---|
| R21 | **delta 重新变大**：批次积压 / 金丝雀长期不晋升，退回大爆炸切换老路 | 小步高频；台账监控未晋升 commit 数；大 delta 拆批而非借特殊迁移 | [推断] §2.6/§5.1；[业界] SRE 小批量 |
| R22 | **金丝雀盲区**：新宇宙验不出「新代码读旧数据」的单向门 | G-D 硬闸门 = 设计时分类论证，不靠金丝雀读数；晋升前只读核对稳定数据格式；冒烟含历史读回 | [推断] §4.3 |
| R23 | **晋升重启打断生产线 run**：c 档代价现在落在日用稳定线（比候选线疼） | idle/轮次边界重启；先只读核对无 active run；一批一次重启；重启卡 + 输入重放 + 手动 resume 兜底 | [事实] node-resume.ts；GATEWAY.md §4；§2.4 |
| R24 | **反向单向门**：新代码已写新格式，代码回滚后旧二进制读不了 | G-D 把住 one-way 不静默晋升；contract 批显式裁决关闭回滚窗口；回滚顺序 = 停进程→恢复备份→回退二进制 | [事实] 配方 §4；§6.3 |
| R25 | **cherry-pick 分叉**：摘取产生新 hash，金丝雀/稳定分支分叉，后续 merge 冲突 | 默认 merge；cherry-pick 台账记 hash 映射；下批前先处理分叉 | [推断] §2.4/§2.6 |
| R26 | **晋升后前端缓存**：同 origin 新后端，旧前端假报 timeline 缺口（R9 晋升形态） | 晋升后恒刷新页面；冒烟先排除缓存 | [事实] 配方 R9；§2.5 |
| R27 | **金丝雀范围 creep**：常驻实验线变成第二生产线，数据根膨胀 / 隔离纪律松弛 | 金丝雀只跑实验不接日用；常设隔离纪律（§2.0）；定期归档实验数据根 | [推断] §1/§2.0 |
| R28 | **批次依赖断裂**：cherry-pick 的 commit 依赖未晋升 commit，晋升后行为与金丝雀不一致 | 批次自包含；G-B 在稳定树复核 build；冒烟对比金丝雀行为 | [推断] §2.4/§3 |

**风险重心转移** [推断]：红蓝手册最疼的是 R11（候选线假升级）与 R13（handoff 断档）；
增量晋升下 R11 落在**生产线**（更疼，R23 同源），R13 被「会话不搬」大幅缓解（稳定线上下文
原地保留），但新增 R22/R24（数据兼容）成为头号风险——**硬闸门 G-D 是增量晋升的安全基石**。

## 9. 未证 / 待实测

1. **晋升循环整体未端到端实测**：本 playbook 是调研产物，作者按宪法不启动舰队、不跑探针。
   每步有文档/代码锚点，但组合行为（金丝雀验证 → 闸门 → merge → 稳定 rebuild → restart →
   durable-resume → 冒烟）待用户按 §2 真实走一轮验证。[推断] 各步独立语义已证，组合未证。
2. **G-D 分类论证的可靠性未证**：「新代码读旧数据」靠设计时人工分类，无自动校验（宪法禁探针）；
   首轮建议晋升前只读核对稳定数据格式 + 冒烟重点打开历史会话。
3. **cherry-pick 分叉处理**（R25）的具体 git 工作流未展开；默认 merge 路径更稳，挑选路径待实测。
4. 观察窗「1–3 天」、台账路径 `docs/operations/promotion-ledger.md`、稳定分支名（main vs stable）、
   迁移线命名 migrate/866x 均为**建议**，非用户裁决。
5. **反向单向门的数据恢复时序**（§6.3）继承配方 §4 警示，本 playbook 未新增实测；
   `.v4.bak` 恢复在真实稳定线上的操作待验证。
6. b 档自动串接（G9 目标态）与 D 运行期刷新（G8 目标态）仍是将来代码工作，本 playbook 只绕行
   （继承红蓝手册 §9）。
7. 跨机晋升（git push/pull 搬代码 + 各机本地 restart）的通道形态沿用红蓝手册 §7，未新增实测。

## 10. 参考

### 本仓锚点（基线 57407f62）

- `docs/dev/research/redblue-operations-manual.md` —— q-redblue 红蓝手册（本 playbook 的改写基础；
  §2 原语 / §3 业界 / §4 映射 / §5 缺口 / §8 风险 R11–R20 全部继承）
- `docs/operations/version-isolation-blue-green.md` —— 2026-11-23 裁决配方（隔离骨架；§4 单向门警示）
- `docs/operations/GATEWAY.md` §4 —— stop/restart/--stop-nodes 语义表（R11 锚点）
- `docs/architecture/gateway-lifecycle.md` —— 分段启动 / adopt / 归属三元复核
- `docs/architecture/federation-hub.md` —— federation 数据面 / guards / 不做什么
- `docs/operations/REMOTE.md` §3.4 / §3.5.1 —— reload scope / token 词表
- `docs/operations/MIGRATION.md` §1–2 —— vessel migrate 只做存储格式迁移（非跨版本会话迁移）
- `docs/adr/ADR-040-durable-run-store-checkpoint-resume.md` —— checkpoint / runs.resume 语义
- `docs/dev/research/graceful-restart.md` —— 三档判定（c 档已实现，b 档不承诺）
- 代码：`src/node-resume.ts`（重启卡四步序）、`src/federation-config.ts`（peer fail-closed）、
  `src/federation-client.ts`（POST federation/messages）、`packages/agent/src/tool.ts`（agent send 地址形态）

### 业界来源（沿用红蓝手册 §10 已核实条目，不重复抓取）

| 来源 | 用在 |
|---|---|
| Martin Fowler, *BlueGreenDeployment* | §5 特殊迁移（只读过渡 / 角色轮转降级）/ DB 解耦 |
| Danilo Sato, *CanaryRelease* | §2.2 观察窗 / 并发版本数最少 |
| Google SRE Workbook ch16, *Canarying Releases* | §3 小批量高频 / 先定判据再放量 / 二进制推送是事故主因 |
| Pete Hodgson, *Feature Toggles* | config diff 台账纪律（继承） |
| Danilo Sato, *ParallelChange* | §4 expand–migrate–contract 三相（增量晋升回归经典含义） |
| Argo Rollouts 官方文档 | §3 readiness≠验收 / manual judgement |

> 检索说明：业界 URL 与抓取核实见红蓝手册 §10（2026-11-24 调研）；本 playbook 不重复抓取，
> 只引用其已核实结论。
