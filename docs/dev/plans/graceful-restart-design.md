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

## 4. resume manifest 格式

### 4.1 权威真相 = 每会话 marker（D3，对 main「记录清单」的细化）

用户提案②要求「记录需恢复的会话清单」。本设计**不新增中心化清单文件**：现有 `resume_after_restart` marker 写在 SessionState 内、经 RunJournal 单写者落盘、崩溃安全、admission 后逐个清除——它本身就是分布式清单，且与恢复收口（clearMarker）天然一致。新增中心文件 = 第二真相源 = 清单与 marker 漂移的新故障面。

「清单」以两种**投影**形式存在（都不是真相源）：
1. drain 报告（内存/RPC，§7）：quiesce 完成时枚举所有已 arm 的 marker，供重启 agent 核对「这次重启欠了哪些会话」。
2. `node-restart.json`（supervisor 用，§2.4）：只含 pid/时间/TTL，不含会话清单——supervisor 不需要知道欠账，新进程扫 marker 即得。

### 4.2 marker 扩展（additive，D6）

```ts
interface ResumeAfterRestart {
  // —— 现有字段，语义不动 ——
  run_id: string;
  interrupted_at: number;
  reason: 'shutdown';            // 闭联合保持不动（回滚安全，见 §4.3）
  pending_input_ids: string[];
  background_stopped: boolean;   // P1 仍恒 false；P3 起有真实语义

  // —— 新增可选字段（旧代码忽略，新代码缺省降级）——
  intent?: 'stop' | 'restart';   // 缺省 'stop' = 现状卡片路径
  boundary?: {                   // restart 专属：暂停时的干净边界快照
    kind: 'tool_batch'           // 工具批完成、下一请求未发（§3.1 b）
        | 'llm_cancelled';       // 软截止后取消 LLM 流，回退上一干净边界
    in_flight_tools: [];         // 不变式：graceful 路径恒为空（§5.1）
    last_completed_tools?: Array<{ tool_name: string; call_id: string }>;
    paused_at_iteration: number; // resume 后 nudge 引用的进度锚
  };
  background_jobs?: Array<{      // P1：存活 job 清单（§3.4）
    job_id: string; pid: number; log_path: string; command_digest: string;
  }>;
  resume_attempts?: number;      // auto-resume 限次计数（§5.5），缺省 0
}
```

- `boundary.in_flight_tools` 类型上允许非空（为 forced/crash 路径留位），但 **graceful restart 的写入不变式是空数组**——armMarkers 前断言快照无在途工具，非空即说明 quiesce 判定有 bug，宁可 abort 也不写脏 marker。
- `resume_attempts` 由新进程在每次尝试 auto-resume 前经 RunJournal 递增（单写者，崩溃安全）；admission 成功 clearMarker 时自然归零。

### 4.3 回滚安全（为什么 reason 不动）

`reason` 是闭联合且旧解析器可能严格校验。若新增 `'restart'` 字面量，新代码写的 marker 在**回滚到旧代码**后可能被判非法 → 僵尸 marker → 会话恢复静默丢失。故 intent 走独立可选字段：旧代码读新 marker = 普通 shutdown marker → 卡片+输入重放（安全降级，只是不自动续跑）；新代码读旧 marker = intent 缺省 'stop' → 现状路径。双向兼容，无迁移。

### 4.4 写入时机与幂等

- restart：quiesced 之后、flush 之前 arm（现序列同位）；只给「暂停未终态」的 run 写。自然完成的 run 无 marker。
- 重复 restart（abort 后重试）：abort 不写 marker，无残留；quiesced 后 arm 失败（写盘错误）⇒ 整体 abort（fail-safe：宁可不出重启，不可无清单退出）。
- ResumeMarkerRegistry 的竞态防护（现成）原样适用：arm 与并发 clearMarker 互斥。

## 5. auto-resume 与工具安全

### 5.1 关键洞察的展开（main-3）：优雅等待如何化解幂等死结

当年否决「续 run + 重放工具」的死结：hard-kill 后在途工具的副作用状态未知（文件写了一半？命令执行了没有？），重放可能重复副作用，不重放可能丢工作——两头不安全，所以只发卡片让人类/模型自己核对。

drain-to-quiesce 把死结**从根上拆掉**：停之前等到「无在途工具」的干净边界（§3.1），于是：
- 已完成的工具：结果已落盘在 transcript 里，resume 后模型**看得见**，不需要重放；
- 未开始的工具：还没发生副作用，resume 后模型正常发起，不是「重放」是「首放」；
- 在途工具：**不存在**（quiesce 不变式）。

所以 graceful-wait + auto-resume 的安全性 ≠ hard-kill + replay 的安全性——前者根本没有 replay。这就是「restart 可以续 run 而 stop 不续」的正当性来源：不是 stop 不配续，是 stop 的 hard-kill 边界不干净，续跑仍须走卡片核对路径（现状保留）。

### 5.2 auto-resume 序列（复用既有引擎，D4）

新进程 startup，`node-resume` 扫 marker 后按 intent 分流：

```
intent='stop'（缺省）: 现状路径不动（卡片 → 输入重放 → admission → clearMarker）
intent='restart':
  1. announce()          恢复卡照发（runtime.notice EnvCard，去重键不变）
                         卡文案增补：边界快照 + 「你的 run 将自动续跑」+ 后台 job 清单
  2. 前置校验            RunRecord.status ∈ {running, interrupted}（resumeRun 既有门槛）
                         member 已关闭/退役 → 走既有 no_member 僵尸清理，不续
                         resume_attempts ≥ 上限 → 降级卡片路径（§5.5）
  3. resume_attempts++   经 RunJournal 落盘（先递增再续，崩溃也计数）
  4. resumeRun(record)   既有入口：run_id 不变，transcript/usage/锚点/压缩段全恢复
  5. 卡先于首个请求      announce 的 notice 注入机制保证恢复卡进入续跑 run 的首个
                         LLM 请求上下文（卡即 nudge，§5.4）
  6. admission → clearMarker   既有收口原样复用
```

- 顺序裁决：**先卡后续**。卡是「核对现状」指令的载体，必须在模型续跑决策之前可见；既有 announce→下一请求注入的时序天然满足（续跑 run 就是「下一请求」）。
- 并发：多会话 auto-resume 沿用扫描的有界并发模式，但续跑是重操作，缺省并发上限 4（可配）；每会话 lease 由 resumeRun 自取（现成）。
- 失败收口：resumeRun 抛错（run_not_resumable/empty checkpoint/lease 冲突）⇒ 不 crash 启动流程，降级为卡片路径 + 如实报错入卡（「自动续跑失败：<原因>，请手动继续或 --resume-run」）。fail-safe 贯穿。

### 5.3 悬空 tool_use 的合成收口（crash/forced 兜底）

graceful 路径不变式保证无悬空 tool_use；但两条兜底路径仍可能产生：
(a) 旧 marker（intent 缺省）被新代码尝试续跑；(b) 进程在 quiesce 后、flush 前崩溃。

规则：resume 加载 transcript 后，对每个无配对 tool_result 的 tool_use 合成一条 tool_result：

```
[tool interrupted by node restart — outcome unknown.
 Verify side effects (files/processes/remote state) before retrying. Do not assume it completed.]
```

- 这是**标记**不是重放（main-4）：给 provider 一个合法的配对（Anthropic 系要求 tool_use 必有 tool_result），给模型一个诚实的「状态未知」信号，模型按卡指令核对后自行决定重试。
- 合成事件经 journal 落盘（可审计、resume 可重建），打 `synthetic: true` 标，UI 如实显示「重启打断，结果未知」。
- 绝不合成「成功」或「失败」——两者都是伪造事实。

### 5.4 续跑 nudge 与早退 nudge 的协同（main-4）

- 通道复用：续跑指令走 `message.injected` 通道（q-empty-response 同款）——用户可见、resume 可重建、非 live 窗口私有消息。恢复卡（EnvCard）是用户侧投影，nudge 是模型侧指令，**同源同文案**，避免「卡说一套、模型收到另一套」。
- 文案骨架（i18n，遵循现恢复卡风格）：节点已换新代码重启；你的 run 在 <边界描述> 处干净暂停（iteration N，最后完成工具 X）；**先核对现状再继续**——已完成的工作不要重做；后台 job 清单见卡；若发现状态与 transcript 不符，以现实为准并说明。
- 与空响应 nudge 的叠加限次：续跑后若模型空响应早退，既有 nudge 机制照常兜底（缺省 2 次）；两类 nudge 各自计数互不挤占，但共享「限次防死循环」原则。
- `llm_cancelled` 边界的特化文案：明示「上一请求被取消、响应未落盘，本次为重发」，模型不会误以为丢了已完成的工作。

### 5.5 续跑限次与崩溃循环防护

- 每 run `resume_attempts` 上限缺省 3（可配）。达到上限 ⇒ 永久降级该 marker 为卡片路径（不再自动续），卡文案如实说明「已尝试 N 次自动续跑未成功」。
- 崩溃循环场景：新代码有 bug → 续跑即崩 → marker 未 clear、attempts 已递增 → 下次启动再试 → 3 次后停手。旧代码回滚后 marker 仍可被卡片路径救起（§4.3）。
- 启动期全局护栏：若上一进程在 resuming 阶段崩溃（restart marker 仍在 + 无任何 admission 记录），新进程可配置 `auto_resume=false` 启动一次（运维逃生门），只发卡片。

### 5.6 待处理人类输入的并入

- restart 会话的 pending 输入**不再独立重放成新 run**（避免与续跑 run 抢单 run 守卫）：输入留在 durable inbox，由续跑 run 经既有 inbox→run 消费路径在迭代边界拾取；`recoverPendingInputs` 对「已 auto-resume 的会话」跳过重放。
- 时序保证：输入在围栏期排队（不丢），续跑 run 启动后消费——比重放更晚但更有序（模型先看到卡+续跑上下文，再看到新输入）。
- 集成校验点（实现期核对，非本设计断言）：inbox 消费是否覆盖「run 进行中」的投递；若不覆盖，退化为「续跑 run 终态后再重放」，仍跳过并发重放。

## 6. 有界等待与超时中止上报协议

### 6.1 预算与双截止

| 参数 | 缺省 | 语义 |
|---|---|---|
| `node.restart.quiesce_timeout_ms` | 120_000（2min） | 硬截止：到点仍未 quiesce ⇒ **中止重启**（不是硬杀） |
| 软截止 | 硬截止 × 50% | 到点开始 cancel 在途 LLM 流（§3.3），工具仍等 |
| RPC 入参 `timeout_ms` | 覆盖配置 | 重启 agent 可按现场情况加长（如明知有长构建） |
| `node.restart.cancel` | — | 硬截止前主动中止（§2.3） |

- 缺省 2min 的依据：覆盖绝大多数同步工具（bash 缺省 120s 超时）+ 一轮模型流；长于它的通常是 async job（已排除）或异常卡死——后者正是「中止+上报」要抓的对象。
- 预算耗尽的三种结局只有两种合法：**quiesced → 继续重启**；**aborted → 旧进程继续跑**。不存在第三种「超时硬杀」——那会把 fail-safe 变 fail-deadly（丢工作），违背用户提案③的本意（报错让 agent 修，而不是替 agent 做破坏性决定）。

### 6.2 abort 序列（fail-safe 不变式）

```
aborting:
  1. 清所有 EU 的 restartRequested 旗标
  2. 已暂停在干净边界的 run：不唤醒也不丢弃——checkpoint 完好，
     可被新输入 / --resume-run / 下次 restart 续起（暂停无害）
  3. 不写任何 marker（armMarkers 从未执行）
  4. unfence：撤围栏，durable inbox 排队消息照常投递
  5. 不 exit、不写 node-restart.json、supervisor 无感
aborted:
  RPC 返回错误（§6.3）；进程回到正常服务态
```

不变式：**abort 后的系统状态 ≡ 重启请求前的状态 + 若干干净暂停的 run + 一段排队后投递的输入**。零工作丢失、零副作用伪造、零代码切换。

### 6.3 中止上报协议（「一直在等什么关闭」）

RPC 错误载荷（稳定契约，供重启 agent 程序化消费）：

```jsonc
{
  "error": "restart_aborted",
  "reason": "quiesce_timeout",          // | "cancelled"（主动 cancel）| "arm_failed"
  "waited_ms": 120000,
  "budget_ms": 120000,
  "blockers": [                          // 精确到「哪个 run/工具/会话」
    {
      "session_id": "…", "run_id": "…",
      "agent_id": "…", "agent_name": "q-restart",
      "phase": "tool_executing",         // §3.1 相位
      "current_tool": {
        "name": "bash", "call_id": "…",
        "started_at_ms": 1730000000000,
        "elapsed_ms": 118000,
        "args_digest": "npm run build …"  // 截断摘要，不泄全量参数
      },
      "since_ms": 118000
    }
  ],
  "paused_clean": ["run_id…"],           // 已干净暂停的 run（无害，供核对）
  "hint": "等待超时：上述工具仍在执行。可加长 timeout_ms 重试、runs.cancel 阻塞 run、或求助用户。旧进程未受影响。"
}
```

- 重启 agent 的修复决策树（写进 RPC hint 与 CLI 输出）：
  1. blocker 是**正当长任务**（构建/下载）⇒ 加长 `timeout_ms` 重试，或等它自然完成后重试；
  2. blocker 是**卡死工具**（elapsed 远超该工具正常时长）⇒ `runs.cancel` 该 run（用户级取消，走既有 cancelled 语义），再重试 restart；
  3. 判断不了 ⇒ 上报用户（ask），**绝不**自行升级为强杀。
- CLI `vessel node restart --json` 原样输出该载荷；人类模式渲染阻塞者表格（会话/agent/工具/已等多久）。
- 事件留痕：`node.restart.requested / quiesced / aborted` 进事件日志（§7），abort 的 blockers 快照随事件落盘——事后可审计「当时在等什么」。

### 6.4 与 stop 的超时语义对照（防混淆）

| | stop（现状） | restart（本设计） |
|---|---|---|
| 超时含义 | 「等够了，走」——进程退出 | 「等不到，不重启」——进程留下 |
| 超时后工作 | 可能丢在途工具结果（marker+卡片兜底） | 零丢失 |
| 超时后代码 | 旧进程已死 | 旧代码继续服务 |
| 谁负责修复 | 下次启动的恢复卡 | 发起重启的 agent（当场） |

## 7. 重启可观测性接口

### 7.1 新增 RPC

| 方法 | 入参 | 返回 | 用途 |
|---|---|---|---|
| `node.restart` | `{ timeout_ms?, reason? }` | 成功：`{ quiesced_ms, paused_runs[], completed_runs[], background_jobs[] }`；失败：§6.3 载荷 | 发起优雅重启（agent 可调用） |
| `node.restart.cancel` | `{}` | `{ aborted: true, waited_ms }` | 主动中止进行中的 drain |
| `node.drain.status` | `{}` | 见 §7.2 | **只读** introspect：当前 drain 相位 + 逐 run 阻塞者快照；无 drain 时返回活跃 run 概览 |

权限：`node.restart` / `cancel` 与现 `node stop` 同级（node 管理权限）；`node.drain.status` 与 `runs.get` 同级（只读观测）。

### 7.2 `node.drain.status` 快照格式

```jsonc
{
  "drain": null | {
    "mode": "stop" | "restart",
    "phase": "fencing" | "quiescing" | "manifest" | "flushing" | "exiting" | "aborting",
    "started_at_ms": …, "elapsed_ms": …, "budget_ms": …, "soft_deadline_ms": …
  },
  "runs": [                       // 活跃 run 全量（drain 与否都可查）
    {
      "session_id": "…", "run_id": "…", "agent_name": "…",
      "phase": "llm_streaming" | "tool_executing" | "between_calls" | "checkpointing",
      "iteration": 12,
      "in_flight_tools": [ { "name": "bash", "call_id": "…", "elapsed_ms": …, "args_digest": "…" } ],
      "restart_paused": false     // 已干净暂停的 run 标 true
    }
  ],
  "background_jobs": [ { "job_id": "…", "pid": …, "log_path": "…", "session_id": "…" } ]
}
```

- 数据源唯一：EU 的 `activeRunSnapshot()` 扩展（§3.2）——drain 判定、abort 上报、status RPC 三者**共用同一快照函数**，杜绝「观测说的和判定用的不一致」。
- 重启 agent 的标准工作流：`node.restart` 发起 → 阻塞/长等待时轮询 `node.drain.status` 看「在等什么」→ 超时拿到 §6.3 载荷 → 按决策树修复。观测不是装饰，是修复闭环的输入。

### 7.3 既有接口扩展与事件

- `runs.list` / `runs.get`：增补 `phase` 与 `in_flight_tools` 字段（additive），让「哪个 run 卡在哪个工具」不依赖 drain 上下文也可查。
- 事件日志新增：`node.restart.requested`（含 budget）、`node.restart.quiesced`（含 paused/completed 清单）、`node.restart.aborted`（含 blockers 快照）、`run.restart_paused`（run 级，干净边界落 checkpoint 时）。全部走既有 journal/事件通道，无新存储。
- 用户侧可见性：restart 发起时向受影响会话发一张「节点即将重启换新代码，正在等待你的任务到达安全点」环境卡（与恢复卡同族同源）；abort 时补一张「重启已中止，原因+阻塞者」——用户不用猜节点为什么还没重启。
- CLI：`vessel node restart [--timeout 120s] [--json] [--no-wait]`；`--no-wait` 发起即返回，agent 用 `node.drain.status` 跟进（长等待不占 CLI 连接）。

## 8. 分期

每期独立可交付、独立可验证（行为验证归用户）；后一期不依赖前一期的未决项。

### P1：意图分离 + drain-to-quiesce + 中止协议 + 观测（安全重启，卡片恢复）

- node-drain 增 `restart` 模式：fence → 旗标 → quiesce 判定（§3.3）→ armMarkers(intent='restart') → flush → exit。
- tool-calling-loop 迭代边界 cooperative 暂停钩子（§3.2）；EU `requestRestartPause()` + `activeRunSnapshot()` 扩展相位/在途工具。
- 双截止 + abort 序列 + `restart_aborted` 载荷（§6）；`node.restart` / `node.restart.cancel` / `node.drain.status` RPC（§7）。
- respawn 最小路径：node-restart marker + 专用退出码 + supervisor respawn（§2.4）；独立 node 由 CLI 包装。
- marker additive 字段（intent/boundary/background_jobs，§4.2）。
- **恢复仍走卡片+输入重放**（不续 run）——但边界干净，卡片能如实说「你的 run 停在工具 X 完成后」。
- 交付判据（用户验证）：长工具执行中发起 restart ⇒ 等完再重启；卡死工具 ⇒ 超时中止、旧进程无恙、载荷点名阻塞者。

### P2：auto-resume（续跑）

- node-resume 按 intent 分流；`resumeRun(record)` 接线（§5.2）；先卡后续时序。
- 悬空 tool_use 合成 tool_result（§5.3，兜底路径）；续跑 nudge 文案与注入（§5.4）。
- `resume_attempts` 限次 + 崩溃循环护栏（§5.5）；pending 输入并入续跑 run（§5.6）。
- 交付判据：restart 后无新人类输入，被打断的任务自动继续且不重做已完成工作；新代码崩溃 3 次后降级卡片。

### P3：后台 job adopt + 运维打磨

- job registry 持久化 + 启动 adopt（pid/启动时间三元组校验，§3.4）；`background_stopped` 真实语义；完成通知槽恢复。
- `auto_resume=false` 逃生门配置化；`runs.list/get` 相位字段；restart 环境卡（发起/中止两张）。
- gateway 层编排（可选）：`gateway restart --nodes` 逐节点滚动 restart（复用 P1 单机协议，节点间串行+观测）。

### P4（展望，不在本设计承诺内）

- 热更 scope 扩大（减少 restart 需求）；跨节点 manifest 汇总视图；restart 预算按工具类型自适应。

## 9. 风险与开放问题

| # | 风险 | 缓解 | 残余 |
|---|---|---|---|
| R1 | 长工具超预算 ⇒ 重启反复中止 | 观测+决策树（§6.3）：加长预算/取消阻塞 run/求助用户；fail-safe 不丢工作 | 正当超长任务（>2min 构建）需 agent 主动加长 timeout；缺省值可配 |
| R2 | cooperative 钩子改动 tool-calling-loop 热路径 | 旗标检查挂既有迭代边界（nudge 同位），未 drain 零开销；不改工具执行语义 | 边界判定 bug 可能产生脏 checkpoint ⇒ armMarkers 前「在途工具必须为空」断言兜底（§4.2） |
| R3 | 新代码 bug ⇒ auto-resume 崩溃循环 | attempts 限次 3 + 降级卡片 + 回滚兼容（§4.3/5.5） | 3 次崩溃的 token/时间成本；逃生门可关 auto-resume |
| R4 | 围栏期新输入排队，长 quiesce 期间用户感觉「节点不理人」 | 预算有界（缺省 2min）+ 发起环境卡明示「在等什么」+ abort 即撤围栏 | 排队延迟最长 = 预算；durable inbox 保证不丢 |
| R5 | 悬空 tool_use 合成被模型误读为「工具失败」 | 文案明示 outcome unknown + 核对指令（§5.3）；graceful 路径根本无悬空 | 模型仍可能误判——与现状卡片路径同等风险，不更差 |
| R6 | supervisor respawn 与 handoff marker 交互（平台/节点两层重启叠加） | 两 marker 独立文件、独立 TTL、读后即删；非 restart 退出先删残留（handoff 同款裁决） | 组合场景（gateway restart 同时 node restart）需实现期明确互斥：平台 handoff 期间拒绝 node respawn 竞争 |
| R7 | abort 后「干净暂停的 run」无人唤醒（无新输入时任务停摆） | 暂停 run 可被下次 restart/新输入/--resume-run 续起；观测接口标 restart_paused 供 agent 发现 | P1 阶段（无 auto-resume）abort 后暂停 run 需 agent 显式续；P2 起下次 restart 自动收 |
| R8 | inbox 消费与续跑 run 的时序集成（§5.6 校验点） | 退化方案已备（终态后重放）；实现期核对既有 inbox→run 路径 | 若两条路径都不覆盖，需补「run 内投递」——列为 P2 前置核查项 |

### 开放问题（实现期裁决，不阻塞设计）

1. 专用退出码取值（75 是候选，需避开既有退出码表）与 supervisor 判据的精确写法。
2. `node.restart` 的权限粒度：是否允许 agent 重启**自己所在**节点（自举悖论：重启发起者自己也被 drain）——倾向允许（发起者收 abort/成功载荷的通道在围栏期仍可读，RPC 响应先于 exit），但需实现期验证响应投递时序。
3. 软截止比例（50%）与缺省预算（2min）的现场调参——归用户行为验证。
4. 多 EU（tenant + members）快照聚合的归属路由：沿用 node-resume 既有 member 路由，不新造。

### 宪法合规声明

本设计纯文档：不引入测试/探针/临时进程；所有「交付判据」均为用户行为验证项；不改代码、不碰主 checkout；仅提交 design/q-restart 分支。