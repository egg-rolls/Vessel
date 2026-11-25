# run lost 非优雅中断 + inbox 重启不唤醒审查

状态：调研审计 + 设计稿（纯文档，零代码改动）。分支 design/q-runlost-audit。
任务来源：用户实测报告——main 自重启生产 gateway（`vessel restart --force --yes`）后
run 报「run lost: owning process exited before completion」被中断；inbox 预留的续作笔记
没有自动唤醒新身体，用户手动发消息才唤醒。用户裁定：①该错误说明 run 被中断而非优雅重启，
需审查；②自重启 + 续作链路应跑通。
行为验证归用户；本设计不引入测试/探针/临时进程。

## 0. 摘要与结论

**问题 1（run lost）结论**：错误文本由**新进程**的启动对账 sweep 写入
（`src/session/session-liveness.ts:50`），是「旧进程死亡时 run 仍活跃」的事后审计，
不是旧进程的临终遗言。用户用了 `--force`——按用户裁定 #5 这是**显式非正常退出**
（快照 + SIGKILL + `stop.forced` 审计，跳过一切优雅等待），run lost 是该路径的
**预期产物**，假设 (a) 成立。但审查发现两个更深的缺口：

1. **「优雅 stop」并不 drain run 到完成**。q-graceful-stop 落地的是「停止方不限时等
   进程自死」，进程内的 drain 仍是 `interrupt('shutdown') + 2s settle`
   （`src/node/node-drain.ts:28`）——run 被打断、落 interrupted checkpoint + resume
   标记，而不是等完。drain-to-quiesce（等活跃 run 到安全边界）是 q-restart 设计稿
   （`docs/dev/plans/graceful-restart-design.md`），**尚未实现**。
2. **自重启存在「编排者悖论」**：触发 restart 的 run 用 bash 工具跑 restart CLI，
   CLI 是被杀进程的后代。优雅路径的 interrupt 会 abort bash 工具并杀其进程树
   （POSIX 连编排者一起杀；Windows/WSL 因 VM 隔离侥幸存活）；async bash 作业也会被
   进程退出兜底杀掉。**今天 --force 反而是唯一能可靠完成自重启的方式**——因为它
   跳过了一切会误杀编排者的协作机件。代价就是 run lost + 无标记 + 无续作。

**问题 2（inbox 不唤醒）结论**：续作笔记（`inbox insert`）按现行语义**永不自动执行**
——quiet 投递、无 session_id、source=自己，三重排除在启动恢复判据之外；force 强杀
又不写 resume 标记，连恢复卡都没有。启动恢复只重放 **human 源**输入
（`packages/agent/src/service.ts:3986`），agent 源条目设计上「保持 unread 等模型
`inbox read`」——但没有任何机制起那个「模型去读」的 run。所有通知通道
（inbox notice hook / runtime notice hook / 恢复卡）都是 **BeforeLlm 被动注入**，
只在 run 已经发起时搭车，从不发起 run。于是系统停在「身体已 spawn、无人点火」的
冷寂状态，直到人类消息到来。这不是单点 bug，是**启动侧缺一条主动续作链路**。

**修复方向**（§4/§5）：自重启 = 等待方向反转（restart 等 run 完成，而非 run 等
restart 返回）+ detached 编排者 + 持久 handoff 标记 + 启动 auto-resume；inbox 唤醒 =
启动 dispatch sweep（同一条恢复扫描扩判据，不加第二条注入路径）+ 续作笔记改走
handoff/startup_prompt 通道（不改 quiet 语义）。与 q-restart 设计稿对齐复用，不另造
第二套 restart 协议。

## 1. 用户实测序列重建（逐步带锚点）

前提拓扑：生产 gateway = 平台进程（`vessel gateway start`，监听 + 监督）+ node 子进程
（agent/session/run 的实际宿主）。main 的 run 跑在 node 进程里。

| 步 | 发生什么 | 锚点 |
|---|---|---|
| 1 | main 的 run 内执行 bash `vessel restart --force --yes`（同步）。Windows 上 bash 经 WSL 启动器（system32\bash.exe → WSL VM），CLI 实际跑在 WSL Linux 侧 | `plugins/tools/basic-tools/src/index.ts:1202-1213`（WSL 判定）、`:1298-1334`（spawnBash） |
| 2 | CLI 进 `restartFleetCommand` → `restartInstances` → `stopGateway({force:true, keepNodes:false})` | `src/cli/commands/fleet/restart-command.ts:168-175` |
| 3 | stop 段先停 node 子进程：force 分支**跳过** `tryGracefulNodeShutdown`，只快照在跑 run（`stop.forced` 审计），然后 `terminateChild(force)`：Windows `process.kill` + `taskkill /PID <node> /T /F`；POSIX `SIGKILL` | `src/gateway/node-supervisor.ts:679-708`、`:506-530` |
| 4 | node 进程被强杀：**没有 drain、没有 interrupt checkpoint、没有 resume 标记**。RunRecord / SessionState 停在 `running`，SessionLease 文件残留（pid 已死）。bash 工具宿主同死；WSL VM 里的 restart CLI 不在 Windows 进程树内，存活 | `src/session/session-liveness.ts:1-28`（三份判活证据的设计前提） |
| 5 | CLI 再强杀平台进程（`terminateProcess(pid, platform, true)` = SIGKILL / Windows 无条件终止），然后 `startDaemonCommand` 拉起新平台 → 新平台 spawn 新 node | `src/cli/commands/gateway/gateway-command.ts:214-216`、`:1187-1215`；`restart-command.ts:182-199` |
| 6 | 新 node 启动 sweep：main 的 session `status==='running'` 且三份证据全失效（session 写锁 absent、run 写锁 absent、SessionLease 同主机死 pid 快路径判失效）→ 追加 `run.failed {error: 'run lost: owning process exited before completion', error_code:'process_lost'}`，session/RunRecord 落 `interrupted` | `src/cli.ts:1033`（sweep 入口）→ `src/session/session-liveness.ts:109-281`（reconcileSession）、`:50`（错误文本）；`src/run/lease-service.ts:160-167`（死 pid 快路径） |
| 7 | 启动恢复扫 `resume_after_restart` 标记：**一条都没有**（force 没写）。`recoverPendingInputs` 扫 inbox：续作笔记是 quiet 自述（无 session_id、source=main 自己）→ 三重排除，不重放。main 的 body 经 `startOwner()` spawn（presence=live、idle），但**没有 run 被发起** | `src/runtime/bootstrap.ts:1656`（startOwner）、`:1673-1756`（恢复接线）；`packages/agent/src/service.ts:3985-3986`（恢复判据） |
| 8 | 系统冷寂：inbox notice hook 只在 BeforeLlm 报「N unread」，没有 run 就没有 BeforeLlm。直到用户手动发消息 → admit → run 发起 → hook 报未读 → 模型 `inbox read` 读到续作笔记 | `packages/agent/src/inbox.ts:1086-1166`（notice hook）；`src/runtime/runtime-notice-hook.ts:189-251` |

用户看到的「run lost 中断」= 步 6 的事后审计；「inbox 不唤醒」= 步 7-8 的主动链路缺失。

## 2. 问题 1：run lost 触发条件与 stop/restart 现状

### 2.1 错误来源与触发条件（file:line）

- **文本定义**：`src/session/session-liveness.ts:50`
  `const RUN_LOST_ERROR = 'run lost: owning process exited before completion'`。
  全仓库唯一出处（packages/agent/src/service.ts 并无此字符串，任务书锚点修正）。
- **写入时机**：`reconcileSession()`（`session-liveness.ts:109-281`）——
  session `status==='running'` 且以下**三份持久证据全部失效**时，抢 session 写锁、
  锁内复查后追加 `run.failed`（`error_code:'process_lost'`, `retryable:false`，
  `:200-215`），session/RunRecord 落 `interrupted`（`:222-268`）：
  1. session 写锁（`:121-127`）；
  2. run 写锁（resumeRun 路径，`:130-139`）；
  3. SessionLease（0.34 Stage 3 起正常 run 的唯一持有物，`:147-148`；
     判活口径 `src/run/lease-service.ts:160-167`：`expires_at` 未过期 **且**
     同主机 pid 活着；同主机死 pid 立即失效 = 回收快路径）。
- **触发入口**：启动 sweep `reconcileStaleSessions`（`session-liveness.ts:287-326`，
  由 `src/cli.ts:1033` 在 node serve 启动时调用）+ 读时兜底 `withLivenessRepair`
  （`:332-392`，load/listRich 顺带修复）。
- **语义**：这是**崩溃/强杀对账**，不是优雅退出路径。优雅 interrupt 的 run 自己落
  `interrupted` checkpoint（可 resume），sweep 读到非 running 直接跳过（`:118`），
  不会出现 run lost。**看到 run lost ≡ 旧进程没来得及给这个 run 收口**——
  SIGKILL / 断电 / 原生崩溃 / force stop。用户裁定①的判断正确。

### 2.2 stop/restart 链路现状：force 与「优雅」各做了什么

**force（用户所用）**：`stopGateway` force 分支（`gateway-command.ts:1187-1215`）
= 快照在跑 run → 代打 `stop.forced` 审计（abnormal_exit / runs_cut）→ 强杀。
node 侧同款（`node-supervisor.ts:679-708`）。**跳过一切优雅等待是设计意图**
（用户裁定 #5：force = 显式非正常退出；升级的是等待策略，不是归属判据）。
run lost 在此路径下是诚实的审计结果，不是 bug。

**优雅（缺省，无 --force）**：停止方经 `gateway.shutdown` RPC 请进程自己跑退出序列
（`gateway-command.ts:1216-1283`；node 侧 `node-supervisor.ts:459-484`），然后
**不限时等进程自死** + 5s 进度采样（`src/gateway/stop-drain.ts:70-107`，用户裁定 #5）。
进程内的退出序列是 `shutdownServeStack`（`src/gateway/shutdown-sequence.ts:45-57`）：

```
beginDrain() = fence 拒新 → 只给有在跑 run 的会话写 resume 标记
             → interrupt('shutdown') → settle ≤2s → flush
```

（`src/node/node-drain.ts:141-268`；`NODE_DRAIN_SETTLE_MS = 2000` `:28`；
装配 `src/runtime/bootstrap.ts:2282-2304`；fence `service.ts:7394`）。

**关键修正（任务书假设核对）**：「graceful stop 应 drain 活跃 run 再退」——
**现状不是这样**。q-graceful-stop 落地的「drain」是停止方等进程优雅自死（而非 2s 后
强杀），进程内对 run 仍是 **interrupt + 2s settle**：长工具/模型流被 abort 切断，
run 落 interrupted checkpoint（可 resume）+ resume 标记，启动后发恢复卡 + 重放
human 输入，**不续 run**（`src/node/node-resume.ts:16`「不续 run、不重放工具调用
（已否决）」）。等 run 到安全边界的 drain-to-quiesce 是 q-restart 设计稿
（`graceful-restart-design.md` §3），代码中无 `quiesce`/`requestRestartPause` 实现。

**平台层 handoff 例外**：`vessel gateway restart`（缺省）只换平台层，node/hub 保活
并被新平台 adopt（`gateway-command.ts:3327-3341`；`ResumeAfterRestart` 注释
「gateway restart 不写标记」，`packages/core/src/types/session.ts:169-189`）——
**平台代码更新本不打断 run**。用户用的 `vessel restart` 是舰队级冷重启
（keepNodes:false，连 node 一起停），两者意图不同。

### 2.3 三个假设的核对

- **(a) --force 跳过 drain**：✅ 成立，且是设计意图（用户裁定 #5）。这是本次
  run lost 的直接原因。
- **(b) 触发者 run 与 drain 互相等待 → 死锁**：❌ 在**现行代码**不成立——
  node drain 不等 run 完成，直接 interrupt（触发者 run 也被打断，bash 工具被 abort）。
  但它是**自重启设计的核心矛盾**：若按 q-restart 实现 drain-to-quiesce，
  「等触发者 run 的工具批完成」与「工具批里的 restart CLI 等 quiesce」互锁，
  只能靠硬截止 abort 收场（q-restart §9 开放问题 2 已预见此悖论）。§4 的设计
  用等待方向反转拆掉它。
- **(c) detached restart 的 stop 段没等 drain**：❌ 不适用——`vessel restart` 没有
  detached 模式，stop 段在 CLI 进程内同步执行；force 下根本不等 drain（见 a）。
  但有一个**衍生发现**值得记录：restart CLI 作为 bash 工具的后代，其存活依赖平台
  进程树语义（§2.4），编排者自身的生命周期没有任何保障——这是自重启链路真正的
  结构性缺口。

### 2.4 自重启悖论：编排者是被杀进程的后代

触发链：main 的 run → bash 工具 → `vessel restart` CLI。CLI 的生死取决于平台：

| 平台/方式 | 编排者（restart CLI）命运 | 锚点 |
|---|---|---|
| Windows + WSL bash（用户环境） | bash 经 system32 启动器进 WSL VM；`taskkill /T` 杀的是 Windows 树（含 wsl.exe 中继），VM 内 Linux 进程不在树内 → **CLI 存活**，restart 完成 | `basic-tools/src/index.ts:1202-1213`、`:1340-1347`；`node-supervisor.ts:524-528` |
| POSIX 同步 bash | bash `detached:true` 自成进程组；**force**：SIGKILL 只打 node pid，组不受影响 → CLI 存活；**优雅**：interrupt → run abort → bash 工具 `killProcessTree` 杀整组（`process.kill(-pid,'SIGTERM')`）→ **CLI 被自己触发的 drain 杀死**，restart 半途而废（node 已停、平台未换） | `index.ts:1325`、`:1351-1357` |
| async bash（两平台） | 作业不挂 run 的 AbortSignal（interrupt 不杀它），但进程优雅退出时 `process.once('exit')` 兜底 `killLiveAsyncJobs('exit')` 杀全部在跑作业 → **优雅路径仍杀编排者**；force（SIGKILL）不跑 exit handler → 存活 | `index.ts:1391-1392`、`:1526`、`:1548-1559` |

**讽刺的事实**：今天 --force 是唯一在两平台都能可靠完成自重启的方式，因为它跳过
了所有会误杀编排者的协作机件。代价 = run lost + 无 resume 标记 + 无续作。
「优雅自重启」不是把 --force 去掉就能得到的——去掉后编排者反而可能死在半路。

另一相关事实：async bash 的完成通知是 BeforeLlm 被动注入
（`index.ts:1373-1381`），作业表/通知槽是 host 内存资产，进程重启即丢
（q-restart D7/P3 的 adopt 尚未实现）——即使编排者活下来完成了 restart，
「restart 完成」这个结果也没有通道送回新身体。

## 3. 问题 2：inbox 重启不唤醒——链路缺口定位

### 3.1 现行唤醒链路盘点

**live 期（进程活着）**：
- input 投递（人类消息 / `agent send` 缺省）：`admitInternal` → trackInbox（hold）
  → mailbox → scheduler → run（`service.ts:2983-3131`）。**唯一会发起 run 的投递**。
- wake 投递（`agent send notify:true`）：append wake 条目（**无 session_id**）→
  `noticeDirty.add` → `dispatchInbox`：目标有活的空闲 body → 队头直投（走
  admitInternal，起 run）；目标忙 → 留队列，run 收口时 `settleHandle` 再投；
  **没有 live body → 什么都不做**（`canDispatchInbox` 绝不 ensure/spawn，
  `service.ts:5270-5286`）。
- quiet 投递（`inbox insert` 自述 / rotate 窗口留档）：**只落盘，不唤醒、永不当
  run input**（`inbox.ts:1345-1350` 注释明示；`service.ts:3227-3232` 把
  「wake/quiet 不带 session_id」定为语义边界）。

**启动期（进程重启后）**：
- 扫 `resume_after_restart` 标记（**只有优雅 drain 写过才有**）→ 每会话发恢复卡
  （runtime.notice，**被动**：下一次请求才注入）→ `recoverPendingInputs` 重放
  → 等准入清标记（`bootstrap.ts:1673-1756`；`node-resume.ts:1-26`）。
- `recoverPendingInputs` 判据（`service.ts:3936-3991`）：unread + 未 held +
  **有 session_id**（`:3985`）+ **source==='human'**（`:3986`）+ binding 可重建。
  上限 8 会话（spawn 是真实成本）。
- agent 源条目的既定命运：「保持 unread（模型 `inbox read` 取）」
  （`service.ts:3145-3146` deferredResult 注释）——**前提是有一个 run 让模型去读**。

### 3.2 缺口清单（本次现象的完整因果）

| # | 缺口 | 锚点 | 后果 |
|---|---|---|---|
| G1 | force 强杀不写 resume 标记（SIGKILL 无可执行代码） | `node-drain.ts` 只在优雅路径 arm | 启动恢复扫不到任何标记，恢复卡都没有 |
| G2 | 续作笔记走 `inbox insert` = quiet：不唤醒、永不执行 | `inbox.ts:1348` | 笔记按设计就是 passive 留档，选错通道 |
| G3 | 启动恢复只认 human 源；agent 源（含自述）排除 | `service.ts:3986` | 即使有 session_id 的 agent 源孤儿输入也不重放 |
| G4 | wake/quiet 条目无 session_id（语义边界） | `service.ts:3227-3232` | 恢复扫描第一道判据就排除 |
| G5 | `noticeDirty` 是内存 Set，重启即丢；启动侧无 dispatchInbox sweep | `service.ts:954`；dispatchInbox 仅 3 个调用点（unblockBodies/settleHandle/wakeDelivery） | live 期「忙时留队列、空下来再投」的兜底在重启后断链 |
| G6 | 所有通知通道都是 BeforeLlm 被动注入，从不发起 run | `inbox.ts:1086-1166`；`runtime-notice-hook.ts:203-251`；恢复卡同理 | 「有 unread」这件事本身点不着火 |
| G7 | presence 不持久化，重启后成员皆 gone；普通 agent send（strict）对 gone 目标抛 member_stale | `registry.ts:79-80`；`service.ts:4720`、`:2913-2914` | 重启后 agent 间互相唤醒也冷断（只有 human 输入能复活成员）；main 因 startOwner 自动 spawn 而 live，但 idle 无 run |

**用户现象解释**：笔记命中 G2+G4+G3（三重排除），force 命中 G1，G5/G6 保证没有
任何兜底点火，G7 保证别的 agent 也唤不醒 main（除非 main 已 live——它是，但
idle 的 main 收 wake 也只留队列）。用户手动发消息 = 唯一现存的点火通道
（human input → admit → run → BeforeLlm 报 unread → 模型读笔记）。与实测完全吻合。

**设计意图核对**：G3/G4 不是疏忽——0.55 硬错误闸事故（别的成员每来一条报告就自动
唤醒 main 重发必然 400 的上下文）之后，「agent 投递不当解闸/点火信号」是刻意裁定
（`service.ts:2937-2941`）。修复**必须保留预算/循环闸**，不能简单把 agent 源加进
重放判据就完事（§5.4）。

## 4. 设计：自重启优雅路径

### 4.1 目标与不变式

- I1（编排者存活）：restart 编排者**不得**是被重启进程的后代，不得被 drain 的
  工具 abort / 进程 exit 兜底杀死。
- I2（等待方向反转）：**restart 等触发者 run 到终态，触发者 run 不等 restart**。
  拆掉假设 (b) 的互锁：run 的最后一个工具调用是「预约重启」，立即返回；模型收尾
  结束回合 → run 自然完成（最优边界，q-restart §3.1）→ 编排者才动手 stop。
- I3（续作有着落）：触发者（及其它被打断者）的续作意图**持久落盘**，新进程启动
  主动续跑，不依赖人类消息点火。
- I4（force 语义不弱化）：--force 仍是显式非正常退出（用户裁定 #5）；优雅自重启
  是**新增意图**，不是把 force 偷偷变优雅。force/崩溃的事后恢复走有疤路径（§4.5）。
- I5（单消费者/幂等）：续作投递复用既有 admitInternal + reuse_message_id 幂等，
  不造第二条注入路径（`service.ts:3948-3950` 的禁令）。

### 4.2 三件套

**件 1：持久 restart handoff（marker additive 扩展）**

沿用 q-restart D6 的 additive 路线，在 `ResumeAfterRestart`
（`packages/core/src/types/session.ts:169`）上加可选字段（旧代码忽略，回滚安全）：

```ts
intent?: 'stop' | 'restart';        // q-restart D6 已设计
continuation?: {                    // 自重启专属：触发者的续作嘱托
  prompt: string;                   // 等价 rotate startup_prompt 的形状
  requested_at: number;
  orchestrator_pid?: number;        // 编排者归属复核用
};
```

写入时机：预约重启的 RPC/CLI 受理时，经 RunJournal 单写口写进**触发者会话**的
SessionState（与 armResumeAfterRestart 同口，竞态防护复用 ResumeMarkerRegistry）。
与 q-restart 的 quiesce marker 关系：quiesce 成功时 marker 带 boundary（无感续跑）；
自重启预约时触发者 run 尚未结束，先写 continuation，run 自然完成后**不需要**
boundary（run 已终态，续作 = 以 continuation 为输入起**新 run**，不是 resumeRun
旧 run——旧 run 已 completed，没有悬空工具，天然无疤）。

**件 2：detached 编排者（等待方向反转的执行体）**

新增自重启入口（CLI `vessel restart --self` 或 RPC `node.restart.self`，
权限与 node stop 同级）受理时：

1. 写 handoff marker（件 1）；
2. spawn **detached + unref** 的编排进程（独立进程组/脱离 Windows 进程树；
   Windows 上经 WSL 或等价物，实现期按平台裁决），编排者命令行携带
   触发者 run_id / session_id / 目标实例；
3. **立即返回**给工具调用方：「重启已预约，编排者将在你的 run 结束后执行；
   请收尾本回合」。模型结束回合 → run completed。

编排者序列（全部在受害进程之外）：

```
wait: 轮询 runs.get(触发者 run_id) 至终态（有界，缺省 120s，可配；
      超时 → 如实报告 + 不重启，fail-safe 同 q-restart §6）
stop: 优雅 stopGateway（其余活跃 run 按现行 interrupt+marker；
      q-restart P1 落地后自动升级为 quiesce）
start: startDaemonCommand（原实例/端口恢复，复用 restartInstances 既有段）
留痕: 编排者自身 pid 文件 + TTL（仿 platform-handoff.json），
      新进程启动可核对「这次重启是谁编排的」；编排者崩溃 → 新进程见
      handoff marker 无编排者存活 → 走有疤恢复（不永等）
```

要点：stop 段开始时触发者 run 已终态 → drain 的「等活跃 run」集合里**没有触发者**
→ 假设 (b) 的互锁从根上不存在。其余成员的 run 照常被 drain 保全（它们不是编排者
的后代，无悖论）。

**件 3：启动 auto-resume / 续作投递**

新进程启动恢复（node-resume 之后、同一装配位）增加主动续作段：

- 扫到 `continuation` marker 且触发者 run 已终态、member 未关闭 →
  经 `deliverStartupPrompt` 同款路径（`service.ts:1566-1578`，
  `admitInternal {startup:true}`：直接作首轮 run input、不进 inbox）投递
  continuation.prompt → 新 run 发起 → 续作开始。投递成功后经单写口清 continuation。
  这是 rotate 交接嘱托的跨进程版——**机制已存在，缺的只是持久化触发源**。
- 扫到 intent='restart' + boundary 的 quiesce marker → 按 q-restart P2 无感
  resumeRun（该设计已覆盖，本审计不重复设计）。
- 限次：continuation 投递失败保持 marker，下次启动再试；attempts 上限沿用
  q-restart §5.5（缺省 3），超限降级恢复卡。

### 4.3 时序（自重启 happy path）

```
main run N:  bash「vessel restart --self」
             → 写 continuation marker → spawn detached 编排者 → 立即返回
             → 模型收尾（可 inbox insert 补充笔记，quiet 语义不变）
             → run N completed
编排者:      见 run N 终态 → 优雅 stop（其余 run interrupt+marker / 未来 quiesce）
             → start 新平台/node
新进程:      sweep（无 running 残留，无 run lost）
             → node-resume（其余会话恢复卡）
             → continuation 投递 → main run N+1 以嘱托为输入起跑
             → 模型读 inbox 笔记（notice hook 报 unread）→ 续作
```

全程无 run lost、无悬空 tool_use、无人类点火。

### 4.4 与现行 CLI 的关系

- `vessel restart --force --yes` 语义不动（I4）。审计建议仅在帮助文本/文档指路：
  平台代码更新优先 `vessel gateway restart`（handoff，run 根本不断）；
  自重启续作用 `--self`（新增）。
- `--self` 与 `--force` 互斥（自重启预约必须走优雅 stop；要 force 就不是自重启
  续作意图，如实拒绝并指路）。

### 4.5 force/崩溃的事后恢复（有疤兜底，与 §5 共用）

force 强杀后今天只有 sweep 对账（run lost），**没有任何唤醒**。补一条：
sweep 修复过的会话（repaired 集合）若 member 可重建 → 发有疤恢复卡
（复用 node-resume 卡通道，文案如实「进程非正常退出，工具结果未知，先核对现状」）
+ 进入 §5 的启动 dispatch sweep（有 pending 则点火）。是否自动 resumeRun
（interrupted 可续）按 q-restart D9 有疤模式判定：force 边界不干净（可能悬空
tool_use）→ 先合成 outcome-unknown tool_result（q-restart §5.3）再续，或降级卡片。
本审计建议 P1 先做「卡 + dispatch 点火」，auto-resume 归 q-restart P2 统一实现。

## 5. 设计：inbox 重启唤醒修复

### 5.1 P1：启动 dispatch sweep（补 G5/G6/G7）

在启动恢复段（recoverPendingInputs 之后）加一次**有界**的主动投递扫描：

1. 重建 noticeDirty：枚举 registry 成员（不扫 inbox 目录，与 recoverPendingInputs
   同口径），凡有 unread 可直投条目（inputHead 非空）者点亮。
2. 对每个点亮成员调既有 `dispatchInbox`（不造新投递语义）。
3. **冷成员裁决**：canDispatchInbox 要求 live body；重启后除 main 外皆 gone。
   两个选项：
   - (推荐) 启动 sweep 特许 spawn：对「有 pending 可直投条目 + member 未关闭」的
     gone 成员，经 ensureExecutionUnit spawn 后再 dispatch。理由：启动恢复本就
     允许 spawn（recoverPendingInputs 经 admitInternal 起 body），「投递不 spawn」
     是 **live 期**的裁定，不该外推到恢复期。上限沿用 maxSessions=8 + 最早 ts
     优先，防「一开机所有 agent 一起跑」。
   - (保守) 只 dispatch 已 live 的成员（main），gone 成员留队列等人类/其它点火。
     缺口只补一半，但零 spawn 风暴风险。实现期可先保守后放开（配置闸）。
4. 预算/循环闸原样生效：dispatch 走 admitInternal，checkDelivery / hop / cycle /
   hardStop 全在（§5.4）。

### 5.2 续作笔记的通道裁决（补 G2，不改 quiet 语义）

`inbox insert` 的 quiet 语义（自述留档、不唤醒、永不执行）是刻意设计，**不改**。
自重启续作意图走 §4.2 件 1 的 continuation marker（持久、主动投递、startup:true
首轮输入）——它才是「重启后接着干」的一等通道。inbox 笔记降级为**补充材料**：
新 run 起跑后 notice hook 报 unread，模型自行 read（与今天用户手动点火后的行为
一致，只是点火不再靠人）。

给模型的指引（写进 `--self` 工具返回文本与 self-card/文档）：
「重启后续作意图写进 --self 的嘱托参数；inbox insert 只是备忘，不会唤醒你。」

### 5.3 agent 源孤儿输入的恢复（补 G3，单扫描扩判据）

force/崩溃后，被 held 的 agent 源 input 条目（有 session_id）成为孤儿
（held 只在内存）。今天它们永不重放。裁决：**在同一条 recoverPendingInputs
扫描内**把判据从 `source==='human'` 放宽为「human 源 ∪ (agent 源 ∧ 有 session_id
∧ 条目曾被 input 投递)」——不是第二条注入路径（I5），是同一条扫描的判据扩展。
安全性：
- 幂等由 reuse_message_id 保证（append 同 id 不重复，markConsumed 指向同一条）；
- 预算/循环闸在 admitInternal 内原样生效，0.55 事故的「报告唤醒循环」由
  cycle/hop/hardStop 闸拦（不是靠 source 过滤拦——source 过滤是粗筛，闸才是细筛）；
- quiet/wake 条目仍排除（无 session_id，语义边界不动）；
- 上限 8 会话不变，agent 源与 human 源共享预算，最早 ts 优先。
回滚兼容：判据放宽是行为扩展，无格式变化；旧代码读新盘面无影响。

### 5.4 防循环与诚实边界

- 启动 sweep 每进程只跑一次（startupRecoveryDone 同款幂等闸），不与 live 投递竞争
  （单消费者规则：只碰未 held 条目）。
- hardStop 闸住的 body：sweep 不投递（canDispatchInbox 已判），留队列等显式解闸
  ——「agent 投递不解闸」裁定不动。
- 续作 run 的 transcript 诚实：force/崩溃恢复走有疤卡（outcome unknown），
  不伪造「重启成功/工具已完成」；自重启 happy path（run 自然完成 + continuation）
  天然无疤，零注入（q-restart D9 同口径）。
- spawn 风暴护栏：maxSessions 上限 + 并发上限（沿用 node-resume 16 路读 / 4 路
  resume 的既有节奏）；sweep 失败不阻断启动（条目仍 unread，下次再试）。

## 6. 修复方案分期（每期独立可交付，行为验证归用户）

### P0：指路（零代码，文档/帮助文本）
- 平台代码更新用 `vessel gateway restart`（handoff，run 不断）；舰队冷重启
  （`vessel restart`）会断 run，--force 更是显式非正常退出。
- 自重启续作今天**没有**可靠链路（本审计结论）；临时办法 = 重启后人类发消息点火。
- 交付判据：用户按指路操作，平台更新不再出 run lost。

### P1：启动唤醒 sweep（补 G1 后半 / G5 / G6 / G7，最小闭环）
- §5.1 启动 dispatch sweep（先保守档：只 dispatch live 成员；配置闸放开 spawn）。
- §4.5 sweep-repaired 会话发有疤恢复卡（force/崩溃后至少「说得清」）。
- §5.3 agent 源孤儿输入单扫描扩判据。
- 交付判据：`vessel restart --force` 后，main 有 pending 可直投条目时**无需人类
  消息**自动起跑续作；无 pending 时至少收到有疤恢复卡（下次 run 注入）。

### P2：自重启三件套（§4，补 G2 / 编排者悖论）
- continuation marker（additive）+ `vessel restart --self` / RPC + detached 编排者
  （等待方向反转）+ 启动 continuation 投递（deliverStartupPrompt 跨进程版）。
- 与 q-restart P1/P2 对齐：quiesce 落地后 stop 段自动升级；auto-resume 共用
  q-restart 的 resumeRun 接线，不造第二套。
- 交付判据：main 在 run 内发起 `--self` → run 自然完成（无 run lost）→ 重启 →
  新身体以嘱托自动续跑，全程无人类输入；编排者被杀（模拟崩溃）→ 新进程有疤恢复，
  不永等。

### P3：打磨（归 q-restart P3 统一）
- async bash job registry 持久化 + adopt（编排者完成通知槽恢复）；
- 冷成员 spawn 放开档的现场调参；runs.list/get 相位字段；restart 事件留痕。

## 7. 风险与开放问题

| # | 风险 | 缓解 | 残余 |
|---|---|---|---|
| R1 | 启动 sweep 唤醒循环（0.55 事故重演） | 预算/cycle/hardStop 闸原样生效；sweep 每进程一次；hardStop 不解闸 | 闸本身的缺陷会同时影响 live 与恢复期（同源同险，不新增） |
| R2 | spawn 风暴（一开机全员起跑） | maxSessions=8 + 最早 ts 优先 + 保守档先行 | 正当大量 pending 时恢复延迟到下次启动（与今天 human 恢复同口径） |
| R3 | 编排者孤儿（崩溃/被杀） | pid 文件 + TTL + 新进程归属复核；无编排者 → 有疤恢复不永等 | 编排者死在 stop 与 start 之间 → 舰队停摆，需人类/下次启动发现（handoff marker 在盘上可查） |
| R4 | Windows detached spawn 的平台语义 | 实现期按平台裁决（WSL / 进程组 / 计划任务等价物）；I1 是硬不变式 | 平台差异需真机验证（归用户） |
| R5 | continuation 与 quiesce marker 双写竞态 | 同走 RunJournal 单写口 + ResumeMarkerRegistry；continuation 只在 run 终态后投递 | 预约后 run 被 cancel/failed → 投递前判终态种类，非 completed 降级有疤卡 |
| R6 | 判据放宽误投 quiet 留档 | session_id 语义边界不动（quiet/wake 无 session_id 天然排除） | 老条目缺 session_id 的 input 投递（若存在）仍不恢复——与今天一致，不更差 |
| R7 | --self 被当成 force 的替代滥用 | --self 与 --force 互斥；帮助文本明示意图差异 | 用户仍可选 force（裁定 #5 保留），事后走有疤恢复 |

开放问题（实现期裁决）：
1. `--self` 的编排者载体：独立 CLI 进程 vs 平台 supervisor 代编排（后者免 spawn
   平台差异，但平台自己也要被重启——需先 handoff 再编排，复杂度更高；倾向独立 CLI）。
2. 触发者 run 终态等待预算（缺省 120s）与模型收尾时长的现场调参。
3. 冷成员 spawn 放开档的缺省值（保守 vs 推荐）归用户行为验证。
4. continuation.prompt 的长度上限与 inbox 笔记的分工文案（API surface = prompt surface）。

## 8. 锚点索引（file:line 速查）

| 主题 | 锚点 |
|---|---|
| run lost 文本/对账 | src/session/session-liveness.ts:50, :109-281, :287-326, :332-392 |
| sweep 启动入口 | src/cli.ts:1033 |
| 租约判活（死 pid 快路径） | src/run/lease-service.ts:160-167 |
| fleet restart 编排 | src/cli/commands/fleet/restart-command.ts:53-206 |
| stopGateway force/优雅 | src/cli/commands/gateway/gateway-command.ts:1187-1215 / :1216-1283；terminateProcess :214-216 |
| node force 强杀/优雅受理 | src/gateway/node-supervisor.ts:679-708 / :459-484；terminateChild :506-530 |
| 停止方等死+进度 | src/gateway/stop-drain.ts:70-107 |
| 进程内 drain（interrupt+2s） | src/node/node-drain.ts:28, :141-268；src/gateway/shutdown-sequence.ts:45-57；src/runtime/bootstrap.ts:2282-2304 |
| 启动恢复（卡+重放，不续 run） | src/node/node-resume.ts:1-26；src/runtime/bootstrap.ts:1673-1756 |
| recoverPendingInputs 判据 | packages/agent/src/service.ts:3959-4064（:3985 session_id、:3986 human） |
| quiet/wake 语义边界 | packages/agent/src/service.ts:3227-3232；packages/agent/src/inbox.ts:1345-1350 |
| dispatchInbox / canDispatchInbox | packages/agent/src/service.ts:5311-5364 / :5270-5286；noticeDirty :954 |
| wakeDelivery（notify） | packages/agent/src/service.ts:5160-5261（self_notify :5176） |
| inbox notice hook（被动） | packages/agent/src/inbox.ts:1086-1166 |
| runtime notice hook（被动） | src/runtime/runtime-notice-hook.ts:189-251 |
| presence 不持久化 / member_stale | packages/agent/src/registry.ts:79-80；service.ts:4720, :2913-2914 |
| startup_prompt 投递（可复用） | packages/agent/src/service.ts:1566-1578；ROTATE_HANDOFF_INPUT_NAME :289 |
| ResumeAfterRestart 类型 | packages/core/src/types/session.ts:169-189 |
| bash WSL/detached/kill 树 | plugins/tools/basic-tools/src/index.ts:1202-1213, :1298-1334, :1337-1365 |
| async job 生命周期/exit 兜底 | plugins/tools/basic-tools/src/index.ts:1383-1392, :1526, :1548-1559 |
| q-restart 设计稿（未实现） | docs/dev/plans/graceful-restart-design.md（D6/D9/§3/§5/§6/§9 开放问题 2） |
| 平台 handoff（run 不断） | src/cli/commands/gateway/gateway-command.ts:3327-3341 |

## 9. 宪法合规声明

本审计纯文档：零代码改动；不引入测试/探针/临时进程；所有「交付判据」均为用户
行为验证项；只读查证生产 checkout 与 ~/.vessel（本次未触碰）；仅提交
design/q-runlost-audit 分支。