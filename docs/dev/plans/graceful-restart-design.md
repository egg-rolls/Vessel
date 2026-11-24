# 优雅重启设计（graceful restart）

状态：设计稿（纯文档，不含实现）。分支 design/q-restart。
任务来源：用户提案三条 + main 设计意见六条（见 §0.2）。行为验证归用户；本设计不引入测试/探针/临时进程。

## 0. 摘要与决策

### 0.1 一句话

把「重启」从「带 2s 硬超时的停止」升级为独立意图：**restart = 保全 + 续跑**——先围栏拒新、等活跃 run  cooperative 地走到安全边界（quiesce）、落 resume 清单、退出换新代码、启动后 auto-resume 续跑；等待有界，超时**中止重启并精确上报阻塞者**（fail-safe：旧进程继续跑，绝不硬杀丢工作）。**stop = 终止**，维持现状 2s settle 不变。

### 0.2 用户提案与 main 意见的落点

| 来源 | 主张 | 本文落点 |
|---|---|---|
| 用户① | 优雅重启与停止区分开（不同意图） | §2 两模式状态机 |
| 用户② | 不要 2s 硬停；等事件停、记录需恢复会话清单、再停→换代码→启动→恢复 | §3 quiesce、§4 manifest、§5 auto-resume |
| 用户③ | 等太久则中止重启并报错「一直在等什么关闭」，交重启 agent 修复 | §6 有界等待+中止上报 |
| main-1 | restart≠stop；stop 用现 2s settle，restart 用 drain-to-quiesce | §2 |
| main-2 | quiesce = 活跃 run 到安全边界，不是「所有事件」；后台进程 durable/adopted 另处理 | §3.1、§3.4 |
| main-3 | 优雅等待化解「否决续 run」的幂等死结：停前静默 ⇒ 无在途工具需重放 | §5.1 |
| main-4 | auto-resume：恢复 transcript + 标记被打断工具 + 续跑 nudge（核对现状，不盲重放）；与早退 nudge 协同 | §5.2–5.4 |
| main-5 | 有界等待：超时不硬杀也不永挂——中止重启、保留旧代码、精确上报阻塞者 | §6 |
| main-6 | 可观测性：introspect 活跃 run/在途工具/drain 阻塞者，让 agent 看清「在等什么」 | §7 |

### 0.3 关键决策速览（细节见各节）

- D1：drain 双模式。`stop` 走现有 `beginDrain('shutdown')`（2s settle 三态）不动；新增 `restart` 模式 drain-to-quiesce，**不 interrupt**，cooperative 暂停。
- D2：安全边界 = 「无在途工具调用 + 无未落盘模型输出」的干净 checkpoint；run 自然完成是最优边界。在途 LLM 流可安全取消（推理无世界副作用，resume 重发请求），在途工具**必须等完**。
- D3：resume 清单沿用**每会话 marker**（SessionState 内、RunJournal 单写者）为权威真相，不新增中心化清单文件做第二真相源；drain 报告只是快照投影（§4）。
- D4：auto-resume 复用既有 `ExecutionUnit.resumeRun(record)`（0.3 durable，run_id 不变、transcript/usage/锚点全恢复）+ 既有恢复卡（runtime.notice，卡即 nudge）+ 既有 admission→clearMarker 收口。新增的只有：触发方式（marker 驱动而非人类输入驱动）、悬空 tool_use 合成 tool_result、续跑次数上限。
- D5：超时中止 = 撤围栏 + 不写 marker + 不 interrupt + 旧进程继续服务；RPC 返回 `restart_aborted` + 阻塞者快照（哪个会话/run/工具/已等多久）。重启 agent 据此修复（再等/取消阻塞 run/求助用户）。
- D6：marker 兼容优先：`reason` 保持 `'shutdown'` 闭联合不动，新增可选 `intent: 'stop' | 'restart'` 字段——旧代码读新 marker 安全降级为卡片路径（回滚安全，§4.3）。
- D7：后台 async bash job 不进 quiesce 判定（永不静默）；P1 记录进 manifest + 卡片告知，P3 做 job registry 持久化 + 新进程 adopt（§3.4）。
- D8：重启的「换代码」由 exit + respawn 天然完成；gateway 托管节点由 supervisor 按 restart marker + 专用退出码 respawn（复用 handoff marker 的既有模式，§2.4）。

## 1. 现状分析（代码锚点）

### 1.1 停止路径：2s 硬超时，不等长工具

- `src/node-drain.ts:28` `NODE_DRAIN_SETTLE_MS = 2000`；`:15` 注释明确「不 await 任何模型流/长工具/后台进程，预算 2s 超时就走」。
- 序列：`beginFence`（拒新 run）→ `armMarkers`（写 resume_after_restart）→ `interrupt('shutdown')` → `settle`（≤2s，10ms 轮询）→ `flushStateWrites`。settle 三态 `idle / settled / timeout`。
- 后果：长工具（bash 同步可达分钟级）与长模型流被 abort 切断；工具副作用可能已发生但结果未落盘 → transcript 出现悬空 tool_use；run 终态 checkpoint 落 `interrupted`（`execution-unit.ts:5973` failureCheckpointStatus：shutdown→interrupted 可 resume，user→cancelled）。
- 触发面：`src/bootstrap.ts:2209+` SIGTERM 幂等 drain；`src/node-command.ts:306` `node stop` 先 RPC 请在途 drain 再杀，10s 兜底强杀（`node.drain.skipped`）。

### 1.2 恢复路径：会话恢复 + 输入重放，但不续 run

- `src/node-resume.ts:16` 明确「不续 run、不重放工具调用（已否决）」——当年否决理由是**在途工具重放的幂等性**：hard-kill 后不知道工具做没做完，盲目重放可能重复副作用。
- 现序列：扫 marker（16 路并发 load）→ 发恢复卡（`runtime.notice` EnvCard，i18n，去重键 run_id+interrupted_at，卡指令模型「先核对现状再继续」）→ FIFO 重放待处理人类输入 → await admission（10s 预算）→ `clearMarker`（经 RunJournal）。headless 僵尸 marker（no_member + 不可恢复）清理。
- `ResumeAfterRestart`（`packages/core/src/types/session.ts:165`）：`run_id / interrupted_at / reason:'shutdown'（闭联合）/ pending_input_ids / background_stopped`（S1a 恒 false）。注释：gateway restart 不写 marker（handoff 已合并）。

### 1.3 已有的可复用资产（本设计的地基）

| 资产 | 锚点 | 对本设计的意义 |
|---|---|---|
| 平台层 handoff | `src/gateway/handoff.ts`（0.52）：`gateway restart` 缺省保留 node/hub 子进程，marker 文件 + TTL 120s + adopt 判据 | **平台代码更新已不打断 run**；缺口只剩「node 自身代码更新」。restart marker + respawn 直接复用此模式 |
| `resumeRun(record)` | `execution-unit.ts:3416`（0.3 durable）：status∈{running,interrupted} 可续；run_id 不变；transcript/usage/iteration/锚点/压缩段全恢复；不注入新用户消息 | auto-resume 的执行引擎**已存在**，缺的只是 marker 驱动的自动触发 |
| `--resume-run` CLI | `src/cli-args.ts:802`、`src/cli.ts:737` | 手动续跑已可用，是 auto-resume 的行为参照与兜底 |
| 恢复卡 + admission + clearMarker | `node-resume.ts` | auto-resume 的收口机制原样复用（卡先于续跑 run 的首个请求注入） |
| 空响应 nudge | `tool-calling-loop.ts`（q-empty-response）：经 `message.injected` 通道注入，用户可见、resume 可重建，限次缺省 2 | 续跑 nudge 走同一注入通道与限次模式（§5.4） |
| 工具引擎 host/worker 分流 | `src/tools-engine/worker.ts:78`：async bash 只在 host 编排（jobs map/通知槽） | 后台 job 是 host 资产，quiesce 与 adopt 的责任边界清晰（§3.4） |
| gateway.reload 热更 | `src/gateway-reload-wiring.ts`、`hot-apply-appliers.ts`；不可热更 scope 报 `requires_restart` | 减少重启需求的前置闸门；`requires_restart` 是 restart 的自然触发点 |

### 1.4 缺口归纳

1. restart 与 stop 共用一条 drain 路径，意图混淆：想「保全+续跑」的操作拿到了「2s 硬切」。
2. 被打断的 run 不自动续：恢复卡+输入重放只恢复「会话可说话」，不恢复「任务在跑」；无新人类输入时任务停摆。
3. 悬空 tool_use 无合成收口：hard-kill 后 transcript 里 tool_use 无配对 tool_result，续跑时 provider 侧非法/模型侧误判。
4. 等待无界问题不存在（因为根本不等），但「等什么、等多久、谁阻塞」完全不可观测。
5. node 自身代码更新没有 supervised respawn 路径（gateway handoff 只保 node 不停 node，反过来「要停 node 换新代码再拉起」没有协议）。

## 2. restart ≠ stop：意图与状态机

### 2.1 意图矩阵

| 维度 | stop（终止） | restart（保全+续跑） |
|---|---|---|
| 用户意图 | 让它停下来 | 换新代码继续干 |
| 新工作 | 拒（围栏） | 拒（围栏，durable inbox 排队不丢） |
| 活跃 run | interrupt('shutdown')，≤2s settle | **不 interrupt**；cooperative 走到安全边界 |
| 在途工具 | 不等（abort 收口） | 等完（有界；超时中止整个重启） |
| 在途 LLM 流 | 不等 | 软截止后取消（安全：无世界副作用） |
| marker | reason='shutdown'（现状） | reason='shutdown' + intent='restart'（D6） |
| 启动后 | 恢复卡 + 输入重放，**不续 run** | 恢复卡 + **auto-resume 续 run** + 输入并入 |
| 超时行为 | 2s 到点就走（现三态） | 中止重启、撤围栏、旧进程继续跑、上报阻塞者 |
| 后台 job | 现状（不 await） | 记录进 manifest；P3 adopt |

### 2.2 stop 状态机（现状，不改）

```
idle → fencing → armed → interrupted → settling(≤2s) → flushed → exit
                                  settle ∈ {idle, settled, timeout}
```

### 2.3 restart 状态机（新增）

```
idle
 → fencing            拒新 run（gateway_restarting）；人类/agent 输入进 durable inbox
 → quiescing          置 restartRequested 旗标；run 在迭代边界 cooperative 暂停
    ├─ 每个 run：当前工具批做完+结果落盘 → checkpoint(interrupted, 干净边界) → 退出循环
    ├─ 在途 LLM 流：软截止前等完；软截止后 cancel（丢弃部分响应，resume 重发）
    └─ 全部 run 静默（含自然完成）→ quiesced
 → manifest           每会话 marker 落盘（intent='restart' + 边界快照）；drain 报告投影
 → flushed            flushStateWrites（现成）
 → exiting            写 node-restart marker（supervisor 用）→ 专用退出码 exit
 → [supervisor respawn 新代码] → 新进程 startup
 → resuming           扫 marker → 恢复卡 → resumeRun 续跑 → admission → clearMarker

任意 quiescing 阶段硬截止到期：
 → aborting           清 restartRequested 旗标（已暂停的 run 由续跑 nudge 就地唤醒或等下次输入）
 → unfenced           撤围栏，durable inbox 照常投递
 → aborted            RPC 返回 restart_aborted + 阻塞者快照；旧进程继续服务
```

要点：
- **abort 不是 stop**。中止重启后系统回到「重启前」：没写 marker、没 interrupt、run 没丢。已在边界暂停的 run 是干净 checkpoint，可被 `--resume-run` / 下次 auto-resume / 新输入唤醒——暂停本身无害。
- 并发裁决：同一进程同时只允许一个 drain。stop 请求压过进行中的 restart（终止意图优先，restart drain 立即转 abort 再走 stop）；restart 撞 restart 返回同一 in-flight promise；restart 撞 stop 返回 conflict。
- `node.restart.cancel` RPC：在 hard deadline 前主动中止（等价提前触发 aborting），给重启 agent 一个不用干等的操纵杆。

### 2.4 换代码与 respawn（D8）

- 触发面：`vessel node restart`（CLI）/ `node.restart`（RPC，供 agent 调用）/ gateway `requires_restart` 提示后的显式操作。**不自动重启**——热更失败只报 requires_restart，由 agent/人决定。
- gateway 托管节点：CLI/RPC 写 `<dataDir>/node-restart[-<instance>].json`（pid、requested_at、TTL，仿 `platform-handoff.json`）→ 旧 node 优雅退出（专用退出码，如 75）→ supervisor 见 marker+退出码 ⇒ 用**磁盘上的新代码**按原 argv/env respawn → 新 node 走 resuming。marker 读后即删；非 restart 退出先删残留 marker（防陈旧 marker 把真停变假停——handoff.ts 同款裁决）。
- 独立 node（无 supervisor）：CLI 包装器负责 wait-exit + respawn；无包装器时 `node.restart` 拒绝并提示用 `node stop` + 手动启动（fail-closed，不承诺做不到的事）。
- 与 gateway handoff 的关系：`gateway restart`（平台层）继续保 node 不动；`node restart`（节点层）才走本设计。两层正交，可组合（先 gateway restart 换平台代码，再逐 node restart 换节点代码）。

## 3. drain-to-quiesce：quiesce 判定

### 3.1 定义：等「活跃 run 到安全边界」，不是等「所有事件」

用户提案②的「等待所有事件停止」需要精确化（main-2）：node 上永远有不会停的事件——watcher、心跳、durable inbox 轮询、后台 async job。等「所有事件」= 永挂。quiesce 的判定对象**只有活跃 run**：

> **定义（quiesce）**：进程内所有活跃 run 均处于「安全边界」——
> (a) 已到终态（completed/failed/cancelled，自然完成是最优解）；或
> (b) 已 cooperative 暂停于干净 checkpoint：**无在途工具调用、无未落盘的模型输出**，下一动作（发 LLM 请求）尚未开始。
>
> 后台进程、watcher、心跳、inbox 轮询**不在判定集内**（§3.4 另处理）。

run 级相位与处置：

| run 相位 | 含义 | restart drain 处置 | 安全性论证 |
|---|---|---|---|
| `llm_streaming` | 等模型响应（含流式） | 软截止前等完；软截止后 cancel，丢弃部分响应 | LLM 推理是只读请求，无世界副作用；损失 = 一次部分请求的 token 成本；resume 重发同一请求 |
| `tool_executing` | 工具调用在途（副作用可能发生中） | **必须等完**（结果落盘后才算边界） | 杀在途工具 = 副作用状态未知 + 结果丢失 = 当年否决续 run 的死结本身 |
| `between_calls` | 工具批已完成、结果已落盘、下一请求未发 | 即刻在此暂停（这就是安全边界） | checkpoint 干净，resume 从下一请求继续，零重放 |
| `checkpointing` | 正在写 journal/SessionState | 等写完（毫秒级） | 写一半的 checkpoint 不可续 |
| `idle` | 无活跃 run | 已静默 | — |

### 3.2 cooperative 暂停的实现钩子（不 interrupt）

- 在 `tool-calling-loop` 的**既有迭代边界**（空响应 nudge 检查所在的同一位置）加一个 `restartRequested` 旗标检查：旗标置位 且 当前工具批全部完成且结果已落盘 ⇒ 走正常收口路径落 checkpoint（status=`interrupted`，复用 `failureCheckpointStatus` 的 shutdown 语义），退出循环。**不是 abort**：不触发 AbortSignal、不产生悬空 tool_use、不丢部分响应。
- 旗标经 EU 暴露（`requestRestartPause()`），node-drain 的 restart 模式对每个活跃 EU 置位；`activeRunSnapshot()` 扩展为携带相位与在途工具信息（§7 复用同一快照）。
- 未 drain 时零开销：一次布尔检查挂在既有边界上，不新增轮询、不新增事件。
- 长模型流的软截止取消走**既有** `interrupt` 的 signal 通道但 reason 区分（`restart_llm_cancel`）：只 cancel 当前 LLM 请求、checkpoint 回退到上一干净边界（部分响应不落盘）。这与 stop 的 interrupt('shutdown') 不同——后者切断一切。
- 自然完成优先：若 run 在预算内自己跑完，drain 不暂停它，marker 也不写（无欠账）。quiesce 判定对「已终态」与「已暂停」一视同仁。

### 3.3 判定算法（node-drain restart 模式）

```
beginDrain('restart'):
  fence()                          # 现成 beginFence
  for eu in activeEUs: eu.requestRestartPause()
  loop (poll 10ms，与现 settle 同节奏):
    snapshot = 所有 EU 的 run 相位快照
    if 全部 ∈ {idle, 终态, between_calls 已暂停}: → quiesced
    if now > softDeadline: 对 llm_streaming 的 run 发 restart_llm_cancel
    if now > hardDeadline: → abort（§6，不写 marker、不 flush 退出）
  quiesced:
    armMarkers(intent='restart', 边界快照)   # 只给「暂停未终态」的 run 写
    flushStateWrites()
    → exiting（§2.4）
```

- 软截止（softDeadline）缺省 = hardDeadline 的 50%：前半程尽量让模型流自然收完（响应完整落盘，resume 无需重发），后半程才动用「取消 LLM 流」这个安全但浪费 token 的手段。
- 工具批内多个并行工具调用：等**整批**完成（批是 checkpoint 的原子单位，半批 = 悬空 tool_use）。
- 暂停后到 armMarkers 之间 run 不会复活：围栏已拒新输入，迭代边界旗标仍置位；durable inbox 的新消息只排队不触发 run。

### 3.4 后台进程：不在 quiesce 判定内（D7）

- async bash job 是 host 编排的资产（`tools-engine/worker.ts:78`：jobs map/通知槽在 host）。job 可能跑几小时，等它 = 永挂，故**排除**。
- P1（记录+告知）：drain 时把存活 job 清单（job_id、pid、log 路径、所属会话）写进该会话 marker 的 `background_jobs` 字段；恢复卡如实告知「后台 job X 未被等待，日志在 <path>，请核对状态」——模型按卡指令「先核对现状」自行读 log/查 pid。job 的 stdout 本就落盘（启动时返回 log path），**工作产出不因重启丢失**；丢的只是「完成通知槽」。
- 进程归属：node 退出时 host 不主动杀 job 子进程（现状即不 await 不杀）；job 成为孤儿但继续跑、继续写 log。P1 卡片明示这一点。
- P3（adopt）：job registry 持久化（`<dataDir>/background-jobs.json`：job_id/pid/log_path/session_id/command/started_at）→ 新进程启动时按 pid 存活 + 启动时间三元组校验后 adopt（重挂等待/轮询 log 尾 + 完成标记文件），恢复完成通知槽。校验失败（pid 复用/已死）⇒ 标记 `background_stopped` 如实入卡。此模式与 gateway.pid adopt 判据同构。
- `background_stopped` 字段从「S1a 恒 false」变为有真实语义（P3）；P1 用 `background_jobs` 清单替代布尔猜测。

### 3.5 与现 settle 三态的关系

stop 模式三态（idle/settled/timeout）原样保留。restart 模式是**另一条判定**（quiesced/aborted 二态 + 相位快照），不复用 2s 预算、不复用「超时就走」语义——restart 的超时语义是「超时就**不重启**」（§6），方向相反。两模式共享 fence/arm/flush 机件，分叉在 settle 策略。

## 4. resume manifest 格式（第3步填充）

## 5. auto-resume 与工具安全（第3步填充）

## 6. 有界等待与超时中止上报协议（第4步填充）

## 7. 重启可观测性接口（第4步填充）

## 8. 分期（第5步填充）

## 9. 风险与开放问题（第5步填充）