# 零停机 C / D 可行性评估（0.52 调研件）

- 分支：0.52-zd-research（基线 0dc20e22）。本单只评估与写文档，未改任何产品代码、未改 package.json、未跑 gates / build。
- 评估对象：C = Gateway 层 nginx 式 standby 轮换；D = node 拆「常驻 state daemon + 可替换 execution worker」。
- 不在评估范围（已定）：步骤 1（node external / gateway 不杀自己 spawn 的 node）与步骤 2（fence → 每 session 标记 → interrupt → ≤2s settle → exit → 重 spawn → 注入 resume 输入 + FIFO 重放，不续 run）。

## 0. 阅读约定（证据分级）

每条结论都标一类，三类不混：

- 【码】仓库代码或文档里直接看得到，附 文件:行。
- 【推】我基于代码的推断，未实测；可以用一句反证推翻。
- 【测】必须实测或跑 gates 才能定；本单不跑，只能给判据。

## 1. 结论先说

| 项 | 结论 | 一句理由 |
|---|---|---|
| C：Gateway standby 轮换 | **no-go**（作为独立项目） | C 的净收益 = 步骤 1 已经拿到的东西，外加把 8642 的「≤0.6s 不可达」压到「≤40ms」；这 0.6s 只在首屏 / 换节点 / Nodes 面板轮询时才被碰到，期望用户接触概率≈0，而成本 3–4 人日（C2，见 §3.4）且要改 pid / 实例锁的交接顺序。 |
| D：state daemon + execution worker | **no-go**（形态①），**no-go 但可回炉**（形态②） | 相对步骤 2 的增量只有「抹掉一次 1–2.5s 的重连提示」：正在跑的 run 依然必须中断后 resume（执行态是 JS 调用栈 + 工具流，不可迁移），所以 D 换不到「真零停机换 node 代码」，却要 10–18 人日（形态②）或 30–60 人日（形态①）。 |
| 只能做一件 | **都不做** | 若必须花预算：客户端抖动抑制（1 人日）> C-lite 预热交接（3 人日）> D（不做）。理由见 §3.3 与 §4.5：C 和 D 都是「最后 1–2 秒」，而 C 与 D 各自解决的那 1–2 秒，都可以用便宜得多的方式消掉或掩盖。 |

把各阶段的断点钉在同一张表里（同一事件的用户可见成本，单位秒，全部为【推】量级）：

| 事件 | 今天 | 步骤 1 后 | 步骤 2 后 | 再加 C | 再加 D |
|---|---|---|---|---|---|
| gateway 换代码 | node 被杀，等于一次 node 重启（run 中断 + 重连） | 只剩 8642 静态 / 平台 RPC 断点，约 0.2–0.6 | 同左 | 0.005–0.04 | 不适用（D 不覆盖 8642） |
| node 换代码 | 2–10（含 run 中断） | 2–10 | ≤2 settle + 1–2.5 重连提示，run 中断后 resume | 不适用（C 不覆盖 8644） | 0（连接不断）+ run 中断后 resume |
| 「真零停机换 node 代码」 | 不可达 | 不可达 | 不可达（已由「不续 run」承认） | 不可达 | 不可达 |

结论的可操作形态：**把「零停机」的目标改成「≤2.5s 可见断点，且不中断未开始的任务」**，这是步骤 1 + 步骤 2 的自然终态；C 与 D 都不改变这个终态的上限。

## 2. 事实层：谁持有什么

### 2.1 Gateway 进程（8642）持有的状态

| # | 状态 | 在哪 | gateway 重启后能否重建 | 依据 |
|---|---|---|---|---|
| 1 | HTTP 监听（8642） | 进程内 | 能（重启即重建，代价＝一次 bind） | packages/serve/src/platform/server.ts:44-48 |
| 2 | node registry 快照（id / name / api_url / auto_start / enabled） | nodes.json（盘），启动时读入 | 能 | packages/serve/src/platform/registry.ts:17-28；源头 nodes.json |
| 3 | last_seen（每 node 最近一次探活时间） | **内存 Map（唯一真正的内存状态）** | 不能，但只影响一个展示字段，下次探活即补 | packages/serve/src/platform/registry.ts:80 |
| 4 | 平台 token / principal | config.yaml（盘）+ 每请求判定 | 能 | packages/serve/src/platform/auth.ts |
| 5 | node 凭据（各 node 的 api token） | 各 node 的 config（盘），按请求解析 | 能 | packages/serve/src/platform/rpc.ts:17-28 与同文件 resolve 段（80-224） |
| 6 | 静态前端（WebUI dist） | dist 目录（盘），每请求 Bun.file 读 | 能 | packages/serve/src/gateway/static.ts:34 |
| 7 | 订阅者 / SSE 队列 | **不存在**：平台侧没有 SSE / WS 路由 | 无 | packages/serve/src/platform/server.ts:50-86 |
| 8 | 平台 RPC 的 stable seq | **不存在**：5 个方法全是请求 / 响应 | 无 | packages/serve/src/platform/rpc.ts:17-28 |
| 9 | supervisor 视图（infos / children） | 内存 + platform-children 清单（盘） | 能（靠 adopt） | src/gateway/node-supervisor.ts:138, 466-505 |
| 10 | 「谁 spawn 了这个子进程」 | platform-children[-instance].json（盘） | 能 | src/gateway/node-supervisor.ts:138 |
| 11 | 实例锁 / PID 文件 | platform[-instance].lock / platform[-instance].pid（盘） | 能 | src/gateway/pid.ts:35-55；src/gateway/instance-lock.ts |
| 12 | hub 子进程 | 独立进程 + hub.lock（盘），启动时 adopt | 能 | src/gateway-command.ts:2043-2110（hub 段）；node-supervisor 同构 adopt |

**12 项里只有第 3 项是不可从盘重建的内存状态，且丢失后果＝一个展示字段暂时为空【码】。** 这是 C 的全部状态论据：C 的难点不在状态，在「谁占着 8642 这个端口」。

### 2.2 Node 进程（8644）持有的状态

| # | 状态 | 在哪 | 重启后能否重建 | 能否跨进程共享 | 依据 |
|---|---|---|---|---|---|
| 1 | activeRun（每个 body 正在跑的那一轮） | 内存 | **不能**（JS 调用栈 + 工具流） | 否 | packages/agent/src/runtime.ts:432-467 |
| 2 | pendingTools / pendingPermissions（等待审批的工具调用） | 内存 | 不能（只重建「曾经有过」的记录，不重建等待本身） | 否 | runtime.ts:432-467；packages/agent/src/service.ts:678-766 |
| 3 | 队列 / mailbox / 打断标记 | 内存（+ 持久收件箱） | 能（持久收件箱 + 恢复扫描） | 部分 | service.ts:690-697（恢复每进程幂等）；同文件 inbox 字段 |
| 4 | 18 个进程内 Map / Set + 2 个标志 | 内存 | 部分能 | 否 | service.ts:678-766（678-766 区间内 new Map / new Set 共 18 处） |
| 5 | MemberExecutionEntry（pluginHost / events / contextPolicy / 运行标志） | 内存 | 不能 | 否 | runtime.ts:432-467 |
| 6 | 会话锁 | 盘（O_EXCL 锁文件 + pid + host）+ 进程内 refcount | 能（按 pid 存活判陈旧） | **是** | src/session-lock.ts:255-344（取锁）、:164-167（陈旧判定） |
| 7 | 两级租约（binding / session，fencing token，TTL 30s、续 10s） | 盘 | 能 | **是** | docs/architecture/runtime-lifecycle.md:88-96 |
| 8 | run journal（单一写者，陈旧 fence 拒绝写） | 盘 | 能 | **是** | packages/core/src/runtime/run-journal.ts:1-40；runtime-lifecycle.md:92（stale_fence） |
| 9 | 会话事件日志 + 每会话持久 seq | 盘 | 能（尾部恢复 + 轮换写者重同步） | **是** | packages/core/src/session/session-event-log.ts:19-23 |
| 10 | 传输层 seq（SSE/WS 帧的 seq + 10000 条 ring） | 内存，进程启动从 1 起 | 不需要重建（客户端容忍回归） | 否 | packages/serve/src/event-buffer.ts:14-30；src/rpc/http-client.ts:361-366 |
| 11 | SSE / WS 订阅者集合 | 内存 | 否（客户端自己重连） | 否 | packages/serve/src/tenant-event-hub.ts:92-93 |
| 12 | body epoch（绑定代次） | 盘 + 内存 | 能（同 session 重启＝新 epoch 是既有语义） | 是 | service.ts:5290（epoch = 当前 primary epoch + 1）；service.ts:518（body.epoch 落盘） |
| 13 | agent-owner 回环控制面 | 内存 HTTP server + agent-owner.json（盘） | 能 | 否（同进程） | src/agent-owner-server.ts（启动于 onboarding / command 路径）；bootstrap.ts:1384 |
| 14 | Scheduler（同 ExecutionUnit 串行、跨 ExecutionUnit 并发） | 内存 | 能（从盘重建队列语义） | 否 | service.ts:6（不变量注释）；src/agent-service-wiring.ts:47,72 |
| 15 | hub 出站连接（node → hub，按 node_id 配对） | 内存 | 能（重连即接上；新的替换旧的） | 最新连接胜出 | src/hub/inbound-control.ts:200 |
| 16 | 插件 / MCP 子进程与服务句柄 | 内存 + 盘上插件配置 | 能（重新 spawn） | 否 | 5 个 reload scope：config / plugins / permission / tools / mcp（packages/serve/src/gateway/methods/admin.ts:20） |
| 17 | 配置快照（热更新作用域） | 内存，盘为源 | 能 | 否 | 同 16；src/gateway/reload.ts |
| 18 | 周期定时器（idle 临时 body 回收） | 内存 setInterval | 能 | 否 | src/agent-service-wiring.ts:460-470 |
| 19 | cron 定时器 | **不存在（全仓 0 命中）** | — | — | grep -rin cron src packages docs = 0 行 |

**表里前 18 项（第 19 行是排除项）真正不可重建的只有 1、2、5（以及 4 里挂在这些 entry 上的引用）——即「正在执行中的那一层」。** 持久层（锁、租约、journal、事件日志、持久 seq、epoch）已经全部在盘上，且已经有跨进程与轮换写者的语义。

### 2.3 已经现成的跨进程原语（这是 D 的真正起点）

| 原语 | 语义 | 依据 |
|---|---|---|
| 会话锁 | O_EXCL 锁文件 + pid + host，按 pid 存活判陈旧；跨进程互斥本来就成立 | src/session-lock.ts:255-344, 164-167 |
| 两级租约 + fencing | token 单调递增；写事件日志 / run 记录带 fence，旧 token 被拒 | docs/architecture/runtime-lifecycle.md:88-96 |
| 持有者崩溃后接管 | TTL 30s 后过期，下一个 ExecutionUnit 取更高 fence 接管同一 Session，旧 holder 写入被拒 | runtime-lifecycle.md:94 |
| 持久 seq | 每会话 seq 落盘；写者轮换时检测文件变化并重同步 | session-event-log.ts:19-23 |
| epoch | 同 session 显式 restart 即新 epoch（不是旧 epoch + 1） | service.ts:5290 |
| 恢复幂等 | 恢复扫描每进程只扫一次，重复扫到 hold 条目自然跳过 | service.ts:690-697 |
| data lock | 支持 shared 模式 + .members/<pid>-<nonce>.json 每进程租约 | src/data-lock.ts:14, 559 |

⇒ **D 的「谁有权写」不需要重新发明**（这一点任务背景里给的假设偏悲观）。D 的工作量全在「运行态 + 传输面」。

### 2.4 与任务背景不一致的四处事实（必须先纠正）

① **没有 cron。** grep -rin cron 在 src / packages / docs 全仓 0 命中。节点当前的周期行为只有两个：idle 临时 body 回收（src/agent-service-wiring.ts:460-470）与 members sweep（间隔 = clamp(ttl/10, 60s, 15min)，docs/architecture/member-team.md:106）。所以「cron 重复触发」不是当前风险项；若将来引入 cron，它会立刻变成 D 的硬约束（见 §4.4-6）。

② **data_locked 不是排斥锁，两个 node 进程不会被它拦住。** 节点运行时不持有常驻写者锁（docs/architecture/topology.md:22「运行时不再取写者锁」）；.lock 只是写意图锁，只在迁移 / prune / eval 这类操作期间被 withDataLock 短暂持有（src/bootstrap.ts:1681）。⇒ 「重复 spawn node」的真正兜底不是锁，而是 **8644 端口 bind 失败**【推，第二个进程在 bind 失败前做了什么副作用需实测，见 §6-2】。

③ **gateway 进程里没有 node（代码已核）。** 三条互证：
   - 平台进程路径的注释写明「平台监听 + 每节点子进程监督；**不进入 bootstrap / serve 管线**」（src/cli.ts:315）。
   - gateway start 的收尾只有 supervisor.start + startHub；停止路径只有 supervisor.stop + platformGateway.stop（src/gateway-command.ts:2095-2110、2226-2230）。
   - 真正启动 node HTTP 服务的 startGateway 只出现在 legacy 分支（src/cli.ts:1323；cli.ts:156 注释「0.49：拆分模式的 Gateway 宿主在这里 fail-fast，--serve legacy 仍按旧行为」）。
   ⇒ docs/architecture/gateway.md:13 的「同进程双监听」是 0.49 现态，对 0.52 已过期（建议顺手修文档）。⇒ 步骤 1 与 C 的前提在当前代码下成立；在 legacy vessel --serve 形态下不成立（那里 gateway 重启＝node 重启，C 无解）。

④ **你的判断基本对，但量级要改。** 见 §3.3。

## 3. C：Gateway standby 轮换

### 3.1 两个 gateway 并存会撞什么（逐项）

| # | 撞点 | 事实 | 后果 | 致命？ |
|---|---|---|---|---|
| 1 | 端口 8642 | Bun.serve({ port, hostname })，单监听；全仓无 reusePort、无 fd 传递（grep reusePort / SO_REUSE / fd: 均 0 命中） | 第二个进程 bind 失败后退出（且它是在 bind 之前就已写过 pid / 取过锁，需要清理） | **是**（唯一硬阻塞） |
| 2 | nodes.json 双写 | 运行时不写；写者只有 CLI（src/gateway-nodes-command.ts:328, 369） | 无 | 否 |
| 3 | 重复 spawn node | adopt 先探活（src/gateway/node-supervisor.ts:466-505），判据＝gateway.pid 三元组 + health，**不校验「谁 spawn 的」**；adopt 最长等 2000ms、100ms 轮询（同文件 36-38） | 健康则 adopt，不重复 spawn；不健康则 spawn 第二个 node → 撞 8644 bind 失败退出；期间可能撞 data_locked（迁移 / prune） | 低（有窗口，见 §6-2） |
| 4 | gateway.pid / 实例锁 | 文件名按 kind + instance 分（src/gateway/pid.ts:35-55；src/gateway/instance-lock.ts 按 instance 加锁） | 不同 --instance 可并存，互不覆盖；但「谁是当前实例」需要新语义 | 否 |
| 5 | platform-children 清单 | 按 instance 分文件（node-supervisor.ts:138） | standby 的清单为空，其 stop() 不杀任何孩子；旧 gateway 的 stop() 会杀自己 spawn 的（见 §3.2 前置） | 否 |
| 6 | 平台 RPC 的 stable seq / SSE | 不存在（platform/rpc.ts:17-28；platform/server.ts:50-86） | 无 | 否 |
| 7 | 静态 dist | 每请求从盘读（static.ts:34） | 两个 gateway 读同一份文件；升级期会读到「新的半套 dist」，但两个 gateway 都解决不了版本一致性 | 否 |

净结果：**技术阻塞只有 1 个（8642 单监听）+ 1 个软问题（adopt 失败时的重复 spawn 窗口）**。任务背景里担心的 nodes.json 双写、seq、SSE 在平台侧全都不成立。

**§4.6 的双实例语义（C 的第二个约束，很多人会漏）**：

- 同一 dataDir、不同 --instance：**契约明确允许**——「不同实例各有 PID/锁，不新增全局拒绝」（src/gateway-command.ts:1740-1741，注释标 CONTRACT §4.6 FROZEN r4；src/gateway/pid.ts:52 同款注释）。
- 同一 dataDir、**隐式节点**（nodes.json 缺失，节点与平台共用 dataDir）：新实例启动直接 fail-fast，报 implicit_node_conflict（src/gateway-command.ts:2010-2042）。⇒ 隐式单节点用户没有 C 的入口。
- 同一 dataDir、显式 registry（nodes.json 有 ≥1 条）：能起来，但注释把它归为「未支持形态」（同段 2012-2014）。⇒ C 要么被算作「支持一个未支持形态」，要么改 §4.6（FROZEN r4）。
- 另一个 dataDir：需要一个 nodes.json 副本，且要重新处理 hub 归属（standby 可能再起一个 hub）⇒ 换了一种风险，不更便宜。

⇒ C 的真实前提是：**nodes.json 有显式节点 + 接受「未支持形态」或改冻结契约**。这一条比端口本身更麻烦。

另有一条前置：C 只在步骤 1 之后才有意义——旧 gateway 退出的路径会杀自己 spawn 的 node（src/gateway/node-supervisor.ts 的 stop 段；SIGINT / SIGTERM 走 supervisor.stop()，src/gateway-command.ts 的信号段）。**C 不含这一步，C 就是「换个姿势重启 gateway 顺带杀掉 node」**，收益为负。

### 3.2 最小可行形态（三个候选，只有 C2 值得）

**C1 前置极小反代（nginx 式）**：常驻 8642 的是 60–150 行的 Bun 进程，upstream 指向 gen-N gateway；切换＝改一个指针。
- 代价：多一个必须长期存活、几乎不能出 bug 的进程（它的升级又成为新的断点）；平台 RPC 多一跳【推】0.2–1ms。
- **关键判断**：平台侧没有 SSE / WS（platform/server.ts:50-86），没有长连接要 drain，所以反代唯一的价值就是把「5–40ms 的拒绝窗口」降成 0。为了把「本来几乎不可能被碰到的 5–40ms」清零，新增一个必须长期存活、且自身升级又会变成新断点的进程，不成立 ⇒ C1 是过度工程。

**C2 预热交接（warm handoff，推荐）**：新 gateway 进程先完成 config 加载、registry 读入、pid / 锁交接准备，闸在「不 bind」；收到信号后：旧进程 graceful stop（现在 platform/server.ts:171-177 是 stop(true) 强制断连，要改成 stop(false)）→ 关监听 → 新进程立即 Bun.serve 同一端口。
- 窗口 = 关监听 → 重新 bind【推】5–40ms（同机 bind + 内核排队）。
- 需新增：① gateway start 的「预热但不 bind」阶段 + 交接信号（本机 unix socket 或 stdin 行）；② stop 路径改 graceful + 明确顺序；③ 实例锁 / pid 的交接顺序（旧释放 → 新取；中间两次文件写，需容忍 100ms 级观测抖动）；④ CLI status 仍读同一个 instance 名；⑤ **预热进程在交接前不得持有 platform[-instance].lock**（旧进程还在时它一旦取锁就会被 §4.6 判冲突），并且交接失败要能回滚（旧进程继续服务）。这一条是 C2 里最容易做错的地方。
- 代码量【推】200–300 行。

**C3 原地换代码（execve / 复用监听 fd / Bun server.reload）**：仓库里 Bun.serve 只有 port 选项，没有 fd 传递、没有 reload（0 命中）；docs/dev/research/graceful-restart.md:19 已论证 execve 会换 pid，使 gateway.pid / platform.pid / spawnedChildren / 客户端游标全部失配。⇒ **不可行，别再试**。

### 3.3 收益上限：核验「只有平台 RPC / 静态资源 1–2 秒」

**你的方向对，两个量要改：1–2 秒是高估；另外你漏掉了一个更小的真实成本面。**

对的部分：

- 平台 RPC 只有 5 个只读方法（nodes.list / nodes.get / nodes.credentials / whoami / health.get，packages/serve/src/platform/rpc.ts:17-28），没有事件流、没有 seq。
- 页面起来后数据面直连 node：node URL 来自 platform.nodes.list 的 api_url（apps/web/src/gateway/url.ts:4-8），健康检查打的是 **node** 的 health.get（apps/web/src/gateway/NodeProvider.tsx），SSE / WS 也是 node 的。⇒ gateway 停机期间，已加载的页面聊天完全不受影响。

要改的部分：

- **1–2s 不是代码推出来的数。** 8642 是纯静态 + 5 个只读方法 + 无长连接，启动成本只有 bun 进程 boot + 读 nodes.json + bind【推 0.2–0.6s，见 §6-3】；CLI 侧的就绪判定粒度也只有 100ms（src/gateway/daemon.ts:80-81，DEFAULT_WAIT_MS 15000ms、POLL_MS 100ms）。所以「1–2s」是体感值，不是结构值。
- **真正的成本是「窗口内恰好发生的动作」**，一共三类：① 首屏 / 刷新（static 由 8642 提供）；② 换节点（nodes.list + nodes.credentials 的引导链，apps/web/src/bootstrap 段 64-67）；③ Nodes 面板轮询 nodes.list（NodePanelView + useResource）。窗口外的页面完全不受影响。
- **收益上限＝每次 gateway 升级最多 1 次「≤0.6s 的刷新失败窗口」**【推】，期望用户接触概率≈0（升级是低频动作，刷新发生在 0.6s 窗口内的联合概率极小）。C2 把它压到 5–40ms ⇒ **增量收益≈0**。

一句话：C 的收益上限不是「1–2 秒」，是「≤0.6 秒且几乎不可能被碰到」。

### 3.4 人日

| 形态 | 人日 | 拆解 |
|---|---|---|
| C2 预热交接（推荐，也是唯二可行） | **3–4** | 1 天改 bind / stop 顺序；1–2 天交接信号与锁 / pid 顺序；0.5 天 CLI status 与文档；0.5 天手工回归（需真机跑 gates，本单未跑） |
| C1 极小反代 | 4–6 | 新进程 150 行 + 归属与状态文件 + CLI / status + 文档 |
| C3 原地换代码 | 不可行 | — |
| 文档 / 契约闸门附加 | 0.5–1 | 103 篇 ADR、32 个 check-* 脚本；gateway 生命周期 / pid 相关检查要跟着改 |

**C 的结论：no-go。** 3–4 人日 换「≤0.6s 且几乎碰不到的窗口 → 5–40ms」，性价比不成立；若某天真要做，做 C2，不要做 C1。

## 4. D：node 拆「常驻 state daemon + 可替换 execution worker」

先把 D 能拿到的东西定义清楚，否则两种形态会争论在错的地方：**D 唯一可能多拿到的，是「8644 的监听与事件流不断」**。正在跑的 run 一定断（执行态不可迁移），这一点任务背景已经用「不续 run」承认了。

### 4.1 形态①：daemon 持锁 + journal + 事件序；worker 无状态跑 loop

- **daemon 持有**：8644 监听 + 认证 + 事件扇出（seq / ring / hello / gap / replay）+ 租约与 journal 的写权 + hub 出站 + agent-owner 回环。
- **worker 持有**：AgentService 执行循环 + 插件子进程。
- **保住的不变量**：传输面不中断（客户端不重连、不重放）、传输 seq 连续、单一事件扇出点、hub 配对稳定、agent-owner 契约不变。
- **破掉的不变量**：
  - journal / 事件日志的「写者＝执行者」被打破。事件是每 token 一条，改由 daemon 代写＝把热路径变成 IPC 热路径【推，p99 影响需实测】。
  - pendingPermissions 的双向映射要跨进程重建：客户端连的是 daemon，回答要转给新 worker，中断窗口里的回答必须可重放。
  - 插件 / MCP 子进程归 worker ⇒ 换 worker 时所有工具会话断开，工具调用状态要重建。
  - 执行态仍丢 ⇒ 仍要走步骤 2 的「标记 → interrupt → settle → resume」。
- **人日**：**30–60**。主要成本在「事件热路径跨进程 + 双向审批映射 + 插件生命周期」。

### 4.2 形态②：daemon 不碰执行，worker 持 session 并从 daemon journal 恢复

- **daemon 持有**：8644 监听 + 认证 + 事件扇出 + 「会话 → worker」路由表 + 租约校验。**不持有执行态、不写 journal、不写事件日志。**
- **worker 持有**：会话全套（AgentService + 会话锁 + journal 写 + 事件日志写 + 插件子进程）。
- **为什么这个形态便宜**：持久 seq 已经是权威（session-event-log.ts:19-23），所以 daemon 不需要重新分配 seq，只需要转发 worker 给的 seq 并持有 ring 供重放；会话锁与租约已经在盘上（session-lock.ts:255-344、runtime-lifecycle.md:88-96），跨进程互斥和对陈旧持有者的接管是既有语义；恢复扫描每进程幂等（service.ts:690-697），新 worker 接管同一会话是既有路径。
- **破掉的不变量**：
  - worker 与会话的基数需要定（1:1 还是 1:N）。现在「同 ExecutionUnit 串行、跨 ExecutionUnit 并发」由进程内 Scheduler 保证（service.ts:6）——拆进程后这条要用「每 worker 一个队列」重述，否则同一会话可能被两个 worker 同时执行。
  - worker 崩溃时，它写的最后几条事件与 daemon 已转发给客户端的帧可能不一致 ⇒ 需要「daemon 只转发已落盘事件」或「客户端重对齐」二选一。
  - 正在跑的 run 仍丢。
- **人日**：**10–18**。拆解：传输面（8644 常驻 + 转发）3–4；有序事件跨进程通道 4–6；接管与重放 2–3；契约 / 文档 / 回归 2–3。

### 4.3 不变量矩阵

| 不变量 | 形态① | 形态② | 依据 |
|---|---|---|---|
| 同一 session 单写者 | 保住 | 保住 | O_EXCL 建锁 + pid 存活判定（session-lock.ts:255-344） |
| journal 单一写者 | **破**（需代写或双写） | 保住（worker 自己写） | run-journal.ts:1-40 |
| 事件 seq 单调 | 保住（daemon 分配） | 保住（持久 seq 权威） | session-event-log.ts:19-23 |
| 传输 seq 不回归 | 保住 | 保住 | event-buffer.ts:14-30；客户端本来就容忍回归（http-client.ts:361-366） |
| SSE / WS 不中断 | 保住 | 保住 | 前提：daemon 是唯一监听者 |
| 正在跑的 run 不中断 | **破** | **破** | 执行态不可迁移 |
| 插件 / MCP 生命周期一致 | **破**（换 worker 断全部工具会话） | 保住（插件随会话走） | 5 个 reload scope（admin.ts:20） |
| hub 单一配对 | 保住 | 保住 | 最新连接替换旧的（src/hub/inbound-control.ts:200） |
| data_locked 竞态 | **恶化**（daemon 与 worker 都可能拿写意图锁） | 不恶化 | data-lock 只有 shared 租约（data-lock.ts:14, 559；topology.md:22） |
| 会话串行（同 ExecutionUnit） | 保住 | **需要重新表述** | service.ts:6 的 Scheduler 假设是进程内的 |

### 4.4 风险矩阵（区分「设计能解」与「代价大到不值得」）

| # | 风险 | 事实 | 判定 |
|---|---|---|---|
| 1 | 双写者（journal / 事件日志） | 现在写者＝执行者；fence 已能拒绝陈旧写（runtime-lifecycle.md:92） | **形态②：设计能解（保住单写者）。形态①：代价大到不值得**（每次 append 一次跨进程）。⇒ 砍掉形态① |
| 2 | acquireSessionLock 语义 | O_EXCL 建锁 + 读 owner 判 pid 存活，活着就抛 SessionLockedError（src/session-lock.ts:255-344）；refcount 只服务同 pid 重入（:102, 260-266） | **跨进程互斥本来就有，拆进程不会破坏它**——这一条比我最初预期的好。真正要解决的是「接管时机」：同机只看 pid 是否存活（:164-167），所以新 worker 必须等旧 pid 真的消失才能拿到锁；另外同机 pid 复用会让陈旧锁永不可回收（isPidAlive 恒真），这是今天就存在的隐患，D 会让它从边角变成常态路径。⇒ 设计能解，成本小：接管前确认旧 pid 消失 + 用 fence 兜住写 |
| 3 | 事件 seq 纪元 | 传输 seq 每进程从 1（event-buffer.ts:14-30）；客户端在 latest_seq < last_seq 时 from=0 重对齐（http-client.ts:361-366） | **已经买单**（契约冻结，客户端本来就容忍）。真正的约束只有一条：必须写死「持久 seq 与传输 seq 的关系」，否则重放错位。⇒ 设计能解，成本＝文档＋回归 |
| 4 | SSE 单消费者 / 单扇出点 | tenant-event-hub 一租户多 sink（tenant-event-hub.ts:92-93）；WS 语义冻结（ADR-051 决策 6） | 不阻塞，但 daemon 变成「必须比 worker 更稳」的新组件；它的 bug 面直接等于全部客户端。⇒ 设计能解，代价＝把 daemon 做得极薄 |
| 5 | 插件生命周期 | MCP 子进程随执行进程（现在父死子活需要显式处理） | 形态②保住；形态①破。⇒ 形态①再扣一分 |
| 6 | cron 重复触发 | **当前不存在**（全仓 0 命中，§2.4-①） | 不是风险。若引入 cron，必须带「单 leader」约束，否则会成为 D 的硬阻塞 |
| 7 | data_locked 竞态 | 只有迁移 / prune / eval 的瞬时排他（bootstrap.ts:1681）；运行时无常驻写者锁（topology.md:22） | 设计能解：worker 启动前检查 daemon 就绪 + 把迁移收到 daemon。⇒ 低成本 |
| 8 | hub 配对脑裂 | 最新连接替换旧的（inbound-control.ts:200） | 设计能解：hub 连接归 daemon（形态②本来就如此） |

分类收敛：

- **设计能解、代价可接受**：2（接管次序 + pid 复用）、3（写文档）、4（做薄）、7、8。
- **设计能解、代价大**：5（仅形态①）、会话串行重述（仅形态②）。
- **直接砍**：形态① 的 journal 代写。

### 4.5 收益：相对步骤 2 的增量

步骤 2 之后，一次 node 代码升级的用户可见成本只有三块：

1. 连接断开 → 1s 起退避重连 → hello → 从 0 重对齐 → 重拉快照（ADR-051 决策 6 冻结的语义）。
2. UI 显示「重连中」（琥珀点 + 提示）。
3. 在跑的 run 被中断后 resume（已定）。

| | 步骤 2 | + 形态② | 增量 |
|---|---|---|---|
| ① 重连与重对齐 | 1–2.5s【推】 | 0 | −1–2.5s |
| ② 「重连中」提示 | 出现 | 不出现 | 一个视觉状态 |
| ③ run 中断后 resume | 有 | 有 | 0 |
| 「真零停机换 node 代码」 | 不可达 | **仍不可达** | 0 |

**结论：D 的增量就是一块 1–2.5 秒的可见重连提示，行为与步骤 2 相同，成本 10–18 人日（形态②）/ 30–60（形态①）。它既不是 0.5 秒，也不是真零停机。** 任务背景里问的「真零停机换 node 代码还是只把断点从 2–10 秒降到 0.5 秒」——答案是后者都不成立：2–10 秒那一段已经被步骤 2 吃掉了，D 只吃最后 1–2.5 秒。

另有一条便宜的中间形态：**把 C2 的手法搬到 8644（daemon 只做监听 + 事件扇出 + 转发，worker 仍是完整 node）**，8–12 人日。它和形态②的差别是「不做会话路由，只做传输面接管」，收益与形态②几乎相同（仍消掉 ①②，③ 不变），代价低 2–6 人日，但长期维护成本高（每个 node RPC 都要过一层转发，无法只透传语义）。

### 4.6 工作量与人日依据

依据（全部【码】可核）：

- 状态持有面合计约 18.2k 行（7 个文件相加）：packages/agent/src/service.ts 6862、packages/serve/src/gateway.ts 3448、packages/agent/src/runtime.ts 2100、src/bootstrap.ts 2003、src/gateway-command.ts 2305、src/gateway/node-supervisor.ts 840、src/agent-owner-server.ts 669。
- node RPC 方法模块 15 个（packages/serve/src/gateway/methods/）；平台侧 5 个（不受影响）。
- 热更新作用域 5 个（admin.ts:20），D 之后每个作用域都要回答「归 daemon 还是 worker」。
- 闸门：103 篇 ADR、32 个 check-* 脚本、12 个 *.test.ts（几乎无既有单测覆盖 ⇒ 回归测试要从零写）。
- 契约：事件流语义冻结（ADR-051 决策 6）；错误码集合冻结（docs/architecture/gateway-rpc.md:87）。⇒ 需 ADR 修订 + 文档闸门，不是纯代码工作。
- 数据迁移：**不需要**（锁 / 租约 / journal / 持久 seq / epoch 都已在盘上）。

| 方案 | 人日 | 边界 |
|---|---|---|
| 形态① | 30–60 | 含热路径跨进程 + 双向审批 + 插件重挂 |
| 形态② | 10–18 | 传输面 3–4 / 有序事件通道 4–6 / 接管重放 2–3 / 契约文档回归 2–3 |
| 中间形态（只搬传输面） | 8–12 | 不做会话路由，RPC 全转发 |
| （前置）C2 预热交接 | 3–4 | 同一套「端口交接 + graceful stop」手法，可当作 D 的技术预演 |

### 4.7 替代方案：把「最后 1–2.5 秒」用 1 人日买掉（不是 D，但吃掉 D 的收益）

D 的增量（§4.5）只有一件事：消掉一次 1–2.5s 的「重连中」提示。同一件事有一个约 1 人日的做法：

- **客户端抖动抑制（1 人日）**：SSE / WS 断开后，在 2s 内视为瞬时抖动，不切换 UI 状态、不显示提示；超过 2s 才进入重连态。阈值建议取 2s，与步骤 2 的 ≤2s settle 对齐；超过阈值仍如实显示，避免掩盖真实故障。改点已定位到 4 处：连接状态机到 UI 的映射（apps/web/src/app/connection-label.ts:10-11）、顶栏琥珀点（apps/web/src/app/AppBar.tsx:108）、底栏（apps/web/src/app/BottomNav.tsx:43-44）、系统提示（apps/web/src/app/shellNoticeItems.ts:48-49，带第 N 次计数）。【推：真实改点还要动连接状态机本身，未逐行核】
- **代价**：这是「掩盖」而不是「消除」——真实故障在前 2s 内不可见。是否可接受属于产品判断，不是技术判断。
- **与 C / D 的关系**：它吃掉 D 在 ②（重连提示）上的全部收益，以及 C 在「刷新失败」上的部分收益（页面不会自己重试，所以吃不到 ①）；它不影响 ③（run 中断后 resume），D 也不影响 ③。
- **叠加顺序建议**（若真要投入）：先做 1 人日抖动抑制 → 观察一周真实断点数据（正好是 §5-① 需要的证据）→ 只有当数据说「中位数 ≥1s 且 ≥1 次/周」时才谈 C2 或 D。

这三档的真实差价：抖动抑制 1 人日买到「看不见」，C2 3–4 人日买到「刷新也不失败」，D 形态② 10–18 人日买到「连接真的不断」。**用户能感知到的差别只有第一档和后面两档之间。**

## 5. 高风险高收益判据：什么证据能把 D 从 no-go 改成 go

要我把 D（只会是形态②）改判为 go，需要同时满足 ①+②+③；④⑤ 是让它站得住的补充证据。

① **实测出「可见断点」的量级与频率。** 用现有步骤 2 的实现在真机测：node 重启后客户端从断到重对齐的耗时中位数，以及被用户实际感知的次数。判据：中位数 ≥1s，且 ≥1 次/周。若中位数 <1s 或 <1 次/周，D 的收益上限就是一个几乎无人观测的窗口，判 no-go 不变。

② **一个不能靠放宽客户端满足的产品要求。** 存在明确验收条件「连接不得出现重连状态」（演示、审计、长任务看板等），且这个要求**不能**用「把 ≤2s 抖动视为瞬时、不显示重连提示」满足。若后者可接受，1 人日的客户端抑制方案就吃掉了 D 的全部收益。

③ **一个热路径证明。** 原型测出「事件 append + 扇出」在拆进程后的 p99 增量 <5ms。若做不到，形态① 的 journal 代写必须放弃，只剩形态②——这条其实是我把形态① 判死的原因，需要实测数字背书。

④ **一个稳定性论证。** daemon 的代码变更频率 ≤ node 的 1/5，且 daemon 与 worker 是不同生命周期的进程（有独立升级路径）。否则只是把断点从 worker 搬到 daemon。

⑤ **一个成本对照。** 能用数字说明「形态② 10–18 人日」比「客户端抑制 1 人日 + C2 3–4 人日」多买到的东西（目前看只多买到 1–2.5s 的可见提示被彻底消除 vs 被掩盖）。

**需要 owner 拍板的单个决策**：接受「≤2.5s 可见断点」为终态并把 C / D 从路线图移除（改投 1 人日的客户端抖动抑制 + 可选的 3–4 人日 C2），还是投 10–18 人日把最后这 1–2.5 秒做掉。**其他问题我都能自己定，只有这一个不能。**

## 6. 还没查到的点

1. **bun 是否支持 reusePort / 监听 fd 交接**：仓库 0 命中（grep reusePort / SO_REUSE / fd: 全空）。30 分钟真机实测可定。若支持，C2 的窗口可到 0，C 的性价比略升——但 D 的结论不变（D 的瓶颈不是端口，而是执行态不可迁移）。这是唯一可能改动 C 结论的外部未知。
2. **第二个 node 进程在 8644 bind 失败之前会做哪些副作用**（迁移、恢复扫描、插件 spawn 的先后顺序未逐行核）。它决定 C §3.1-3 的「重复 spawn」风险等级：如果副作用只有读盘 + 抢瞬时 data lock，风险是低；如果它会先跑恢复扫描或启插件，风险要上调到中。
3. **node 进程 boot 到可服务的实测耗时**：本单不跑 build / gates（worktree 无 node_modules），步骤 2 的「2–10s」与 C 的「≤0.6s」都是推断值。可用的只有代码里的上限常量：spawn 后就绪等待 20s（src/gateway/node-supervisor.ts:34）、健康探针超时 1s（同文件 37）、adopt 等 2s（38）——都是上限，不是实测。这条同时是 §5-① 的前置数据。
4. **WebUI 对平台 RPC 的轮询面未穷举**：我只核了 NodeProvider / ConnectionProvider / NodePanelView / useResource / url.ts / bootstrap 段，apps/web/src/gateway 下还有 32 个文件没逐个看，可能还有别的周期性 platform 调用（若有，C 的收益上限略升）。
5. **TUI 的 workspace 来源未逐行核**：只确认 packages/tui/src 里不出现 8642 / platform 字样（⇒ TUI 直连 node，gateway 停机不影响 TUI 的会话面）。
6. **多进程下 lease-service 的 reclaim 与 .members 清理行为未实测**：语义读起来是对的（TTL 30s / 续 10s / 高 fence 接管），但没有两进程实测证据。
7. **~~gateway 是否同进程托管 node~~（已核）**：三条代码证据表明 0.52 的 gateway start 不进入 serve 管线（src/cli.ts:315、src/gateway-command.ts:2226-2230、src/cli.ts:156），docs/architecture/gateway.md:13 已过期。仍未核的一点：legacy vessel --serve 是否还有真实用户（若有，那批用户下 C 与步骤 1 都无解，需在路线图里显式排除）。
8. **客户端在「端口短暂未监听」时的浏览器层行为未实测**：fetch 无自动重试，页面刷新会直接失败；已有页面不受影响。这条决定 C2 实测窗口的可观测性。

## 附录 A：本单的边界

- 未改产品代码、未改 package.json、未跑 gates / build / bun install。
- 未联网。
- 所有【推】结论都写成了可被一句实测推翻的形式；所有【测】都给了判据。
- 与本仓既有调研 docs/dev/research/graceful-restart.md 的关系：那份文档的 §5.3 把「同 dataDir 并存」判死，论据主要是 node 的会话锁 / seq / 双写者——对 **node 进程**成立；本单评估的 **gateway 进程**不适用同一结论（gateway 没有会话锁、没有 seq、没有 SSE，见 §2.1），所以 C 的结论必须重算，C 的新结论是「不是被状态判死，而是被收益判死」。
