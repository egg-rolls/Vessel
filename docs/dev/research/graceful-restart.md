# 无痛重启（graceful / zero-downtime restart）调研

> 调研稿。基线 `fd6c0ce6`，分支 `0.52-restart-research`。**未改任何产品代码**。
> 标注约定：**[事实]** = 能指到代码行或公开文档；**[推断]** = 我的判断，没有直接证据；**[未证]** = 没查到，见末节。

---

## 一、结论先说

1. **「对 agent 无感」不是一个需求，是三个强度差 1~2 个数量级的需求**，必须先选档（判定标准见 §3）：
   - **a 档（run 不中断，进程内热升级）**：**不建议做，且在本仓不可达**。JS/Bun 没有「同一个 VM 内两份模块共存、对象运行状态不动」的能力；a 档的最小实现是把 agent 状态搬到常驻进程再做握手，等于重做架构。
   - **b 档（run 中断，checkpoint 续跑）**：原料已到位 —— checkpoint 记 `interrupted` 就能被 `runs.resume` 接回（`packages/serve/src/gateway/methods/runs.ts:293`，判据 `running | interrupted`）。缺的是「重启前后自动串起来」和「drain 时不要主动 cancel」。
   - **c 档（run 中断，任务不丢，重新投递）**：**0.53 已经实现了**。`AgentService.recoverPendingInputs()`（`packages/agent/src/service.ts:3114`）在启动时把「unread + 未 held + 有 `session_id` + human 源」的 inbox 条目重投，`src/bootstrap.ts:1347` 调用它。
   ⇒ **建议按 b + c 落地**，把「无感」定义为：*会话上下文不丢、任务不丢、用户不用手动 resume*；而不是「进程不重启」。
2. **用户的「RPC + inbox」方向与本仓已有结构同构**，所以不是新造一套，而是补三个缺口：
   (i) `drain` 增加「等终态」模式 —— 今天是**先 cancel 再等**（`packages/agent/src/service.ts:6326` `runtime.cancel`，5s 预算见 `src/bootstrap.ts:1418`）；
   (ii) 新增 `gateway.restart` RPC + `draining` 状态；
   (iii) 启动期把 `interrupted` 的 run 自动接回（inbox 重投已就位，**run 自动 resume 没有**）。
3. **拉起进程必须由进程外做**。本仓已有 supervisor 层级（platform → hub / node 子进程，`src/gateway/node-supervisor.ts`），但它「子进程崩了只标 down，不自动重启」；正确做法是给 supervisor 补 `restart(child)`，**RPC 只负责「进入 draining + 发起」**。理由：`execve` 会换掉 pid ⇒ `gateway.pid`、`platform.pid`、supervisor 的 `spawnedChildren` 记录、SSE 客户端游标全部失配；`process.execPath` 自 spawn 同样引出「谁是新进程的父」问题 [推断]。
4. **nginx 式「新老共存 + 连接交接」不建议做**：收益是「SSE 不断一条」，代价是同 `session_id`/同 `dataDir` 的双写者（与 `acquireSessionLock` 单写者约束直接冲突）+ seq 纪元对账。收支不成立（§5.3）。
5. **最小可行第一步**：`gateway.restart` RPC（admin 权限、立刻返回 `{ accepted, drain_deadline }`，不阻塞等重启）+ `draining` 状态（拒新 dispatch / 拒新 run）+ drain 等终态（默认 30s）+ 由现成的 `vessel gateway restart --daemon` 或 supervisor 完成停与起。**自动 resume 建议同批做，但只对「本次 drain 打断的 run」（打显式标记），不对任意历史 `interrupted` run 自动跑** —— 理由见 §6 风险 R10。

---

## 二、本仓现状（代码事实）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| CLI 重启 | `vessel gateway restart` = stop + start | `src/cli-args.ts:1788`，实现 `src/gateway-command.ts:1593` |
| 守护进程拉起 | `startGatewayDaemon()`：`Bun.spawn` 子进程 + log 文件 + lock/pid | `src/gateway/daemon.ts:150` |
| 进程层级 | platform（supervisor）→ hub 子进程 + node 子进程；readiness 靠 `/health` + 落盘 pid 记录；**崩溃只标 down，不自动重启** | `src/gateway/node-supervisor.ts` |
| pid / lock 命名 | node 角色：`gateway.pid` / `gateway-<instance>.lock`；hub 另有自己的 lock | `src/gateway/pid.ts:35`、`:55` |
| gateway 关闭 | 只退订、关连接；**不再清队列、不中断 active run、不等终态**（0.27 起执行生命周期归 app） | `packages/serve/src/gateway.ts:3405-3406` |
| app 级 drain | `drain({timeoutMs})`：**主动 `runtime.cancel` 在途轮次**，最多等 5s；注释写明「队列里的后续消息随进程退出丢弃」 | `packages/agent/src/service.ts:6305`、`:6326`、`:6349`；调用点 `src/bootstrap.ts:1418` |
| run 续跑 RPC | `runs.resume` 已存在，接受 `running` 或 `interrupted` 的 checkpoint | `packages/serve/src/gateway/methods/runs.ts:293` |
| run 续跑入口 | `vessel resume` 手动 CLI（列 interrupted 再 resume），**不在启动期自动跑** | `src/resume-command.ts`；`src/bootstrap.ts:1429` 起 `startResume` |
| 崩溃对账 | 另一进程读心跳判活，写者死了补 `run.failed(process_lost)`、把 session 标中断、把 durable checkpoint 标 `interrupted`；注释明确「与优雅 shutdown 的 interrupted checkpoint 语义对齐」 | `src/session-liveness.ts:48` 附近 |
| inbox 重投 | 启动期 `recoverPendingInputs()`：unread + 未 held + 有 `session_id` + **human 源**，最多 8 个 session；重投复用条目自己的 id 保证幂等 | `packages/agent/src/service.ts:3114`、`src/bootstrap.ts:1347` |
| inbox 持久语义 | 「重启恢复的唯一判据 = 有 `session_id`」；`held` 只存在内存，崩溃即全部失效 | `packages/agent/src/inbox.ts:223`、`:311` |
| 既有硬约束 | **禁止给「带 `session_id` 的 input 条目」加第二条自动注入路径**（防重复执行） | `packages/agent/src/service.ts:3114` 附近设计约束 |
| agent 级 restart（≠ 进程重启） | `sessions.restart`（write）：同 session 原地换 binding，epoch+1；在途 run 时返回 `run_in_progress` 冲突 | `packages/serve/src/gateway/methods/sessions.ts:1160`，实现 `packages/agent/src/service.ts:5136` |
| 配置热载 | `gateway.reload`，结果 `{ reloaded, requires_restart }` | `packages/serve/src/gateway/methods/admin.ts:60` |
| 危险动作人工批准 | 策略有 `defaultDecision: allow / ask` 与 `neverAutoApprove`（默认 `['agent.close']`），配 `permission.respond` | `packages/core/src/runtime/permission-policy.ts` |
| 待批准请求存活期 | `pendingPermissions` 是**进程内 Map** ⇒ 进程重启即丢 | `packages/agent/src/service.ts`（`pendingPermissions` 字段） |
| SSE 回放 | 单 subscription 一个队列（不可两消费者）；ring 上限 10000 条，replay 预算 1–4MiB | `packages/serve/src/gateway.ts:435-470` |

两条**由现状直接推出的结论**（不必再查）：
- 今天的「优雅关闭」= *取消在途 + 丢队列 + 留 interrupted checkpoint*，之后靠人手动 `vessel resume`。**离「无感」差的是策略，不是机制。**
- 已有 `sessions.restart` 比进程重启低一档：换 body、换 epoch、保留 transcript，**进程不重启**。所以「给 agent 一个 `restart` 工具」这句话至少指三个不同的东西（§3 表），必须先对齐词义，否则会做出「用户以为重启了进程、实际只换了 binding」的工具。

---

## 三、三档「无感」的判定标准

判定一个实现属于哪档，只看两个问题：**进程是否换了？在途工具调用是否被重放？**

| 档 | 定义 | 进程换 | 在途工具调用 | 用户可感知 | 本仓可达性 |
| --- | --- | --- | --- | --- | --- |
| **a** | run 不中断，进程内交接（热升级） | 否 | 不受影响（同一状态机继续跑） | 完全无感 | **不可达**（无热代码替换）；近似做法只能降级成 b |
| **b** | run 中断，但**上下文 + 在途工具调用**不丢，重启后从 journal 续跑 | 是 | **必须可重放/幂等**，否则不能算 b | 几乎无感（一次工具重试） | **可达**：checkpoint 已存 tool 调用记录 + `runs.resume` 已存在；缺自动串接 |
| **c** | run 中断，**任务不丢**，重启后重新投递，agent 重新接手 | 是 | **不重放**，由模型重做 | 有感（会重新想一遍） | **已实现**（`recoverPendingInputs`），只覆盖 human 源 + 8 session 上限 |

三条关键提醒：

1. **b 档的真正门槛不是「有没有 checkpoint」，而是「在途工具调用能不能安全重放」。** 读类工具（read/grep）随便重放；写类（edit/write/bash/inbox claim）重放可能造成二次副作用。Claude Code 在这一点上明确选择了退让：*上次进程结束时仍在跑的工具调用，resume 时不会被重跑*（[事实]，见 §4 表）。所以**同行主流其实停在 c 档**，b 档只在自带幂等的窄工具集上成立。**[推断]**：本仓若宣称 b 档，必须先给工具打「可重放 / 不可重放」标签，否则是假承诺。
2. **c 档的语义边界**：任务不丢 ≠ 成果不丢。进程死时写到一半的文件、未 `flush` 的 checkpoint 尾部，都可能丢。这正是 `session-liveness.ts` 存在的理由（另一个进程补对账）。
3. **对 agent 无感 ≠ 对用户无感 ≠ 对客户端无感**。SSE 断线、seq 纪元切换是**客户端**问题，跟 agent 侧三档正交，但它是「无痛」体验里最容易翻车的一环（§6 R3）。

---

## 四、同行做法表

| # | 做法 | 强度 | 依赖什么 | 对我们的启发 | 来源 |
| --- | --- | --- | --- | --- | --- |
| 1 | **nginx `SIGHUP` reload**：master 按新配置起新 worker，老 worker 处理完现存连接后退出 | a（对单请求） | master 常驻 + 每连接一个 worker；**没有跨请求的状态** | 「老 worker 自己决定何时退」= 我们的 drain 应该「等终态」而不是「cancel」 | http://nginx.org/en/docs/control.html |
| 2 | **nginx `USR2` binary upgrade**：master 把 pid 改名 `.oldbin`，起新 master + 新二进制；`WINCH` 让老 worker 优雅退；`QUIT` 收老 master | a | 新老进程共享监听端口、状态全在文件/共享内存外 | 双进程共存要求「状态零共享」；我们的 session/run 状态在内存 ⇒ 不满足前提 | 同上 |
| 3 | **systemd socket activation**：监听 socket 归 unit 所有，服务重启期间 socket 仍接连接，起来后 `sd_listen_fds` 拿 fd | c（新请求排队，不丢） | 服务由 systemd 拉起 + 传 fd | 我们的等价物不是 socket，是 **inbox**：重启期间进的消息落盘，起来后重投 | https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html |
| 4 | **systemd `Type=notify-reload`**：reload 指令发出后服务 `RELOADING=1`，就绪后 `READY=1`，systemd 才算完成 | — | sd_notify 通道 | 这正是用户要的「RPC 有 ack」：`gateway.restart` 应该返回「已接受 + 期限」，完成信号走事件流而不是 RPC 同步返回 | https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html |
| 5 | **Erlang/OTP 热代码升级**：同一 VM 里「当前版本 + 旧版本」两份代码可共存，旧版本只在第三次加载时才 purge；进程状态不动，靠 `code_change` 迁移 | **a 的极限** | 语言/runtime 支持代码替换 + 显式状态迁移回调 | 唯一的真正 a 档；说明 a 档是 runtime 能力而非工程努力 ⇒ JS 侧不必硬凑 | https://www.erlang.org/doc/system/code_loading.html |
| 6 | **k8s rolling update**：`maxSurge`/`maxUnavailable`（默认 25%）滚动；readiness 过了才接流量；`terminationGracePeriodSeconds`（默认 30s）+ `preStop` 给优雅退出时间 | c（单请求），配合持久队列可到 c（任务） | 多副本 + 无状态（或外部状态） | ① 默认 30s 这个数字可以照抄；② 「先不接新活、再等旧活」是通用套路 | https://kubernetes.io/docs/concepts/workloads/controllers/deployment/ ，https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/ |
| 7 | **pm2 cluster `reload`**：逐个 worker 重启并等 ready，超时则退化成硬 `restart`；要求应用自己处理 SIGINT 做优雅退出 | a/c | cluster 模式共享端口 | 「超时就硬来」是可接受的产品策略 ⇒ drain 超时不必纠结，直接标 `interrupted` 继续 | https://pm2.keymetrics.io/docs/usage/cluster-mode/ |
| 8 | **`SO_REUSEPORT` 端口继承**：多个 socket 同绑一个端口，内核分发新连接；要求**所有** socket 都设该选项，关闭的 socket 会丢掉已排队的连接，且不保证公平 | 基础设施 | 应用能控制 listen 选项 | 若我们要做 nginx 式共存，这是唯一可用的端口共享方式；但 Bun 文档未提及该选项（§7） | https://man7.org/linux/man-pages/man7/socket.7.html |
| 9 | **Claude Code 会话持久**：transcript 落 JSONL，`--resume [sessionId]` / `--continue`；**上次进程结束时仍在跑的工具调用，resume 后不会重跑**；后台任务在恢复时降级成「笔记」；server 停了可以恢复会话、`attach` 运行中的会话 | **c** | 只有 transcript，不持久在执行中的调用栈 | 我们的定位同类产品：**别承诺 b 档，先把 c 档做圆**（会话恢复 + 任务重投 + 客户端对账） | https://code.claude.com/docs/en/sessions.md ；https://code.claude.com/docs/en/remote-control.md |
| 10 | **aider**：`--restore-chat-history` 只在启动时把历史读回来，没有在途状态 | c（更弱，近似只保上下文） | markdown 历史文件 | 最低档对照：只有上下文、没有任务语义 | https://aider.chat/docs/config/options.html |
| 11 | **OpenHands**：conversation 是服务端对象，有 pause/resume 端点；等人确认是**一等事件**（`confirmation_policy` + `respond_to_confirmation` 事件，端点 `POST .../pause`、`.../resume`、`.../alive`） | b/c | 服务端 conversation 状态机 | 这条最像我们要做的：**「等人批准」本身要能被持久化、被重启穿越**；我们今天的 `pendingPermissions` 是内存 Map | https://docs.openhands.dev/sdk/guides/convo-pause-and-resume ；https://docs.openhands.dev/sdk/guides/agent-server/api-reference/conversations/pause-conversation |
| 12 | **OpenAI Codex CLI** | [未证] | — | 只证实了仓库在 docs/ 下用独立页面维护 CLI 文档，approval 模式细节没抓到 | 见 §7 |

**表里最该抄的三条**：nginx 的「等老活自己退」、k8s 的「先摘流量再等 grace period」、OpenHands 的「待确认也是一等持久对象」。

---

## 五、三套方案

### 5.1 S1：最小可行（"兼容式优雅重启"，2~3 天）

**目标**：把「先 cancel 再等」改成「等终态，超时才 cancel」，并让重启可被 RPC 触发。**不做跨进程交接**。

改动面（只列必要的）：
1. `gateway.restart` RPC：`permission: admin`；结果 `{ accepted: true, drain_deadline, epoch_hint }`，**立刻返回**，不等重启完成。
2. 新状态 `draining`：`agents.dispatch` / `runs.start` 在 draining 下一律拒（返回可重试错误），但 inbox 写入照收（这正是 c 档的兜底来源）。
3. `drain({ mode: 'wait' })`：不再立刻 `runtime.cancel`；每 500ms 采样在途 run，全部终态或到 deadline 才返回；到 deadline 才走今天的 cancel 路径并标 `interrupted`。
4. 退出前 `flushSnapshot()` + 把「本次 drain 打断的 run」写进一个显式标记文件（供启动期精确 resume）。
5. 拉起：沿用 `vessel gateway restart --daemon`；**RPC 不负责 spawn**，只负责「退到可以被重启的干净状态」，由 CLI/supervisor 完成（§5.4）。

**验收判据**：drain 期间到来的 human 消息在重启后自动被跑起来；日志里 `recover_done` 的条数 = drain 期间入队条数；`gateway.pid` 无残留。

### 5.2 S2：推荐形态（S1 + 自动续跑 + 可批准的工具面）

在 S1 之上加三件：
1. **工具面 `restart`**（非插件，核心工具表里注册）：`neverAutoApprove` 追加 `'restart'`（与 `agent.close` 同级），批准走现成的 `permission.respond`；工具内部就是调 `gateway.restart` RPC。**注意**：工具在执行中被自己重启 = 工具调用的响应永远回不来，所以工具必须返回「已接受，重启将在本 turn 收尾后发生」这类语义，或者把 drain 触发点放在 turn 边界（[推断]，这是最容易做错的地方，见 §6 R6）。
2. **启动期自动 resume**：只 resume「有 drain 标记」的 run（S1 第 4 步写入），走现成 `runs.resume`，复用 `recoverPendingInputs` 的幂等 id。**不碰任意历史 interrupted run**。
3. **客户端对账**：SSE 重连后客户端必须拿 `epoch` 与新 seq 基线做对比，发现纪元变化就整体 drop 缓存重拉（今天 hub 重启后 UI 卡在「正在思考」就是缺这一步）。

### 5.3 S3：nginx 式新老共存（不建议，但记录判定）

判定逐项（这也是任务要求的那张清单）：

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 端口 | **不可行**。需要 `SO_REUSEPORT` 或 fd 传递（`sd_listen_fds`）；Bun 文档未提及 `reusePort` [未证]，且我们也没做 fd 传递 | man7 socket.7；bun docs |
| lock 文件 | **直接冲突**。`gateway.pid` / `gateway-<instance>.lock` 是单写者语义，两个进程会互相判 `stale`/抢锁 | `src/gateway/pid.ts:35,55` |
| SSE | **更糟**。单 subscription 一个队列、不可两消费者；老进程的 ring 在新进程里不存在，客户端连到哪个进程决定了它看到什么 | `packages/serve/src/gateway.ts:435-470` |
| seq 纪元 | **必须引入纪元对账**，否则新老交替瞬间客户端游标会被当成「落后很多」而触发大回放 | 同上 + 已知 hub 重启事故 |
| 会话/run 状态 | 内存态（`activeRuns`、`pendingPermissions`、inbox `held`）无法交接 | `packages/agent/src/service.ts`；`inbox.ts:311` |

⇒ **决定性理由**：S3 的全部收益是「一条 SSE 不断」，而代价是双写者 + 纪元对账 + 端口难题。**不划算，别做。**

### 5.4 时序图（S2，符号画）

```
用户/UI            agent(工具层)        gateway(RPC+状态机)      AgentService(run/inbox)      进程外(supervisor/CLI)
   │                    │                      │                        │                          │
   │ ①批准 restart ──────────────────────────► │                        │                          │
   │                    │ ②restart() ─────────► │                        │                          │
   │                    │◄─ accepted+deadline ─ │ (立刻返回，不阻塞)      │                          │
   │                    │                      │ ③ state=draining        │                          │
   │                    │                      │   拒新 dispatch/runs.start ──►│                    │
   │                    │                      │ ④ drain(mode=wait,30s) ─► │ 等在途 run 到终态        │
   │                    │                      │                        │ 超时→cancel+标 interrupted│
   │                    │                      │ ⑤ 写 drain 标记 + flush ─► │                          │
   │                    │                      │ ⑥ 关 SSE / 退订（客户端开始重连退避）              │
   │                    │                      │ ⑦ 进程退出（exit 0）──────────────────────────────►│ ⑧ 识别正常退出
   │                    │                      │                        │                          │ ⑨ 重新 spawn
   │                    │                      │ ⑩ 新进程启动 → /health ready ───────────────────►  │
   │                    │                      │ ⑪ 读 drain 标记 → runs.resume（仅标记的）           │
   │                    │                      │ ⑫ recoverPendingInputs()（drain 期间入队的 human 消息）
   │                    │                      │ ⑬ 广播 agent.restarted / 新 epoch ──► 客户端对账重连
   │◄───────────────── ⑭ UI 从「正在思考」恢复为真实状态（epoch 变了就整体重拉）
```

**必须由 RPC 做**（进程内、有状态）：③ 状态置位、④ drain 等终态、⑤ 落盘与标记、⑥ 关连接、⑬ 广播事件。
**必须由进程外做**：⑦ 之后的退出、⑧ 判活、⑨ 重新 spawn、⑩ readiness 判定。**RPC 绝不能自己 spawn/exec**：pid 一变，`gateway.pid`、supervisor 的 `spawnedChildren`、父进程关系全错，且新进程会继承一个「已经死了的调用栈」的期望。

---

## 六、风险与未解问题

| 编号 | 风险 | 会发生什么 | 建议处置 |
| --- | --- | --- | --- |
| **R1** | **drain 超时** | 有 run 永远到不了终态（模型生成慢 / 工具卡住 / 等批准） | 到 deadline 后 cancel 并标 `interrupted`（与 pm2「超时退化成硬重启」同策略）；**不要强杀**，强杀会丢掉 checkpoint 尾部，只剩别的进程去补 `process_lost` |
| **R2** | **等批准中的 run 被重启** | `pendingPermissions` 是内存 Map ⇒ 批准请求消失，模型侧看到 abort | 要么 drain 期间对「等批准的 run」直接超时不再等（因为它可能要等很久），要么把待批准请求落盘（OpenHands 的做法）。**短期选前者，并在文档里承认这个洞** |
| **R3** | **SSE 断开 + seq 纪元切换** | 客户端重连拿到的 seq 是新一轮从 0 开始的：要么被判「落后很多」触发大回放，要么被当成「已最新」而永远停在旧的「正在思考」 | restart 后广播可对账的 `epoch`（今天 `agent.restarted` 已有雏形）；客户端见 epoch 变就整体 drop 缓存重拉，不试图增量 |
| **R4** | **锁文件残留** | 进程被 SIGKILL / 重启风暴时会留下 `gateway.pid`、`gateway-<instance>.lock`；今天靠「`running` / `degraded` / `starting` 拒启，`stale` 才条件清理」，判活逻辑一旦误判就卡死 | 重启路径必须先「正常退出」并清理；给 `--force` 留一个显式人工出口，不做自动清 |
| **R5** | **重启风暴 / 连点两次** | 第二次 `gateway.restart` 在 draining 中到达 | draining 状态下的 restart 必须**幂等**：返回 `{ accepted: false, reason: 'already_draining', deadline }`；退出前 5s 内拒绝新 restart |
| **R6** | **工具语义自噬** | agent 调 `restart` 工具，进程在工具返回前就死了 ⇒ 工具调用永远挂起，模型等一个不存在的响应 | 两条路：(a) 工具只「登记重启意图」，在 turn 边界由 runtime 执行；(b) 工具同步返回「已接受」再异步重启。**必须选 (a) 或 (b) 之一并在工具描述里写清**，这是本方案唯一真正需要产品决策的点 |
| **R7** | **权限口径** | 谁能调这个工具/RPC | RPC 侧 `admin`（与 `gateway.reload` 一致）；工具侧进 `neverAutoApprove`（与 `agent.close` 同档），并且**默认不暴露给子 agent**——子 agent 不该有重启全家的能力 |
| **R8** | **多实例 `--instance`** | `restart` 在哪个实例上执行；`--instance` 下 pid/lock 各自独立 | RPC 带上 target instance，缺省「调用方所在实例」；`vessel gateway restart --all` 才做全量，与 hub 一起重启是最重的一档（hub 重启 ⇒ ring 空 + 纪元变 ⇒ 所有 node 的客户端都要重连） |
| **R9** | **爆炸半径分档** | 重启 node vs 重启 hub vs 重启 platform 是三件不同的事 | 默认只重启 node（会话与 run 都归 node）；hub 重启要额外走「纪元公告」，并且明确告诉用户所有 UI 会闪一下 |
| **R10** | **自动 resume 误触发** | 启动期把任意历史 `interrupted` run 都拉起来，用户会看到「自己没让它跑的任务在跑」 | 只 resume「带 drain 标记」的；历史残留仍然走 `vessel resume` 手动路径 |

**未解的产品问题（需要 main 拍）**：`restart` 到底重启什么？（a）agent binding（今天 `sessions.restart`/`rotate` 已能做）；（b）node 进程；（c）整个 gateway 含 hub。三个词同一个名字，用户预期却完全不同（§7 我按「默认 b」写的方案）。

---

## 七、还没查到的点（[未证]）

1. **OpenAI Codex CLI 的 approval 模式**：`docs/config.md` 只外链，`developers.openai.com/codex/*` 用 curl 抓到空 body（JS 渲染），`raw.githubusercontent.com` 在本机持续超时。⇒ Codex 是否有 `resume`、approval 是否有 `never/on-request/on-failure` 三档，**我没有任何一手证据，不敢写进表**。要补的话建议用浏览器或 `gh api` 拉仓库原文。
2. **Bun 是否暴露 `SO_REUSEPORT`**：Bun 的 HTTP 文档（docs/runtime/http/server.mdx）里 `reusePort` 出现 0 次。**「文档没写」不等于「不支持」**，但这足以否决 S3 的可行性论证——要做 S3 必须先写 20 行探针验证。
3. **Erlang 在真实滚动发布里的用法**（`release_handler` 与 `code_change` 的实际约束），只读了 code_loading 一页，没看 OTP `release_handler` 的两版本限制细节。
4. **Durable execution 路线未做**：Temporal / Restate 这类「把 in-flight 状态做成事件溯源、重启即重放」的方案，是 b 档的工业级答案；本仓已有 `events/<run_id>.jsonl`，理论上可以走「事件重放式 resume」，但我没验证 `runs.resume` 到底是「从 checkpoint 快照继续」还是「重放事件」，这决定 b 档的真实上限。**这是我认为最值得补的一查。**
5. **Vessel web 客户端的现有重连策略**（退避、游标、是否已有 epoch 概念）没读前端代码，只在事件定义里见到 `sessions.restarted`（`epoch+1`）与 `agent.restarting/agent.restarted`。R3 的建议因此偏保守。
6. **`inbox` 里 `source=agent`（agent 之间 / 团队消息）在重启后要不要重投**：`recoverPendingInputs` 今天只认 `human` 源，这是刻意的还是待办，我没找到决策记录。

---

## 八、附：只读探针（不改任何东西，仅供验证 S1/S2 的前后差异）

只读：不写、不删、不 kill；只打印判定所需的四组事实。放在文档里，不落 `scripts/`（避免触碰产品脚本目录）。

```bash
#!/usr/bin/env bash
# vessel restart probe (read-only). usage: bash probe-restart.sh
set -u
D="${VESSEL_DATA_HOME:-$HOME/.vessel/data}"

echo "== 1. pid / lock =="
for f in "$D/gateway.pid" "$D/platform.pid" "$D"/gateway-*.lock; do
  [ -e "$f" ] && { echo "--- $f"; cat "$f"; echo; }
done
echo "-- 进程存活："
pgrep -af "vessel" | head -20

echo "== 2. 在途 run（非终态）="
# 只读 runs/*.json，按 status 分组计数
grep -l '"status"' "$D"/runs/*.json 2>/dev/null | wc -l | sed 's/^/run 文件数: /'
grep -ho '"status": *"[a-z_]*"' "$D"/runs/*.json 2>/dev/null | sort | uniq -c

echo "== 3. 事件流尾部（看 seq 是否连续 / 是否有 process_lost）=="
ls -t "$D"/events/*.jsonl 2>/dev/null | head -3 | while read -r e; do
  echo "--- $e"; tail -3 "$e"
done

echo "== 4. inbox 里「有 session_id 且未读」的条目（= 重启后可重投的候选）=="
# 需要知道 inbox 实际落盘位置才能断言；此处只做存在性探测
find "$D" -maxdepth 2 -iname '*inbox*' -type f 2>/dev/null | head -10
```

**注意**：第 4 段的路径是我**没验证**的（`inbox.ts` 的持久化文件位置未确认，见 §7.6 的邻域问题）。跑之前先把 `find` 那行单独跑一遍，确认落盘位置再谈「重投候选」的计数口径。

---

## 九、落地顺序（建议给排期的版本）

1. **P0（判定性验证，半天）**：用 §8 探针在一台跑着 agent 的机器上采样，确认「非终态 run 数 / inbox 落盘位置 / seq 是否连续」三件事 —— 这决定 S1 的验收判据能不能写。
2. **P1（2~3 天）**：`gateway.restart` RPC + `draining` 状态 + `drain(mode='wait')` + drain 标记文件。
3. **P2（1~2 天）**：启动期「按标记自动 resume」+ epoch 广播 + 客户端对账。
4. **P3（1 天）**：`restart` 工具（`neverAutoApprove`，turn 边界触发，R6 选 (a)）。
5. **不做**：a 档、S3 共存、`SO_REUSEPORT`。
