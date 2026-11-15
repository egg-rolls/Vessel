---
title: 0.54 迁移计划书：会话 timeline 单一真相（A/B/C 三阶段、受影响 9 项、回退）
kind: plan
status: 待施工
date: 2026-11-15
base_commit: c698471a
decided_by: ADR-105
triggers:
  - 0.54 迁移计划
  - timeline 迁移
  - A/B/C 三阶段
  - 双写校验
  - 切读回退
  - 旧会话只读冻结
  - 两阶段回填删除
  - 代码行数净减少
paths: [packages/core/src/session/timeline-writer.ts, packages/core/src/runtime/run-journal.ts, packages/serve/src/gateway.ts, packages/serve/src/event-buffer.ts, apps/web/src/state/disk-replay.ts, apps/web/src/gateway/replay-source.ts, apps/web/src/state/event-store.ts]
---

# 0.54 迁移计划书：会话 timeline 单一真相

> 决策依据 = [ADR-105](../../adr/ADR-105-session-timeline-single-source.md)。本文只回答"怎么搬、每步怎么算过、
> 卡住怎么退"，不重述 ADR 的决策。**本轮不写实现**：下面是施工图 + 判据。
>
> 基线 `main c698471a`（2026-11-15）。三个事实先摆在最前面，因为它们决定分期顺序：
> ① 今天有**三份**持久/半持久的源（会话日志、run trace、进程内环），同一事件在三处的 `seq` 完全不同
> （`session-event-log.ts:451-452`、`trace-recorder.ts:352`、`event-buffer.ts:49`）；
> ② `llm.stream.chunk` **两处磁盘都没有**（`run-journal.ts:55-66`、findings §1d）；
> ③ 前端已经为"三源"打了一整层补丁（`apps/web/src/gateway/replay-source.ts` 两阶段 +
> `apps/web/src/state/disk-replay.ts` 负数带 + 押后 + 内容 id 去重），这层是**要被删掉的**，不是要修的。

## 1. A / B / C 三阶段与可执行判据

原则：**先证明新的对（A），再证明旧的可以走（B），最后把旧的锁死（C）**。每阶段只允许一个方向可逆。

### A 阶段：双写 + 逐条相等采样（新链路只写不读）

| 项 | 内容 |
| --- | --- |
| 做什么 | 新 `timelineWriter` 与旧 `SessionEventLog` / `FileTraceRecorder` **同时写**；读路径、协议、UI **一个字节都不改**（`sessions.events` / `events.list` / `events.subscribe` 全部照旧） |
| 覆盖什么 | 事件全集（含 chunk）、归档、索引、`holes`、两指针上报（I4 只在 `sessions.get` 加**新技术字段**，旧字段不动） |
| 判据 A-1 | `check-timeline-dualwrite`：对 12 个真实会话夹具 + 3 个合成夹具（chunk 洪水 / 中断归档 / 磁盘坏块），逐条比较 `(type, run_id, ts, sha256(data))` 序列**完全相等**；差集**只允许**等于 chunk 集合（旧链路无 chunk，断言 `diff == {llm.stream.chunk}` 逐条相等，不是"包含"） |
| 判据 A-2 | 采样校验器常开：`timeline.verify_sample_rate`（默认 `0.01`，夹具 `1.0`），比中不一致 ⇒ 发 `timeline.divergence{seq, field, old, new}`（**不阻断**、**不落 timeline 自身**） |
| 判据 A-3 | I1–I4 四条各有一条行为断言：I1「同一临界区取号+写」用 spy 断言调用序；I2「无 in-flight 泄漏」用注入的慢 fsync 断言 `publish` 之前 `wal_head` 已覆盖该 seq；I3「归档失败不影响读」注入失败后断言 §7 A3；I4「两指针上报」断言 `timeline_head ≤ wal_head` 且两指针只在 `sessions.get` / hello / read 页出现 |
| 判据 A-4 | §7 A1–A8 全绿（`check-timeline-equality`），其中 A6（严格交错）在 A 阶段用**离线夹具**验，不进 UI |
| 判据 A-5 | 性能门槛（写清数字，避免"感觉还行"）：chunk 发布延迟 P95 ≤ `chunk_flush_ms + 50ms`；单事件写放大 ≤ 旧链路 1.3×（`fsync` 次数 / 事件）；RSS 增量 ≤ 30 MB（对照 `event-buffer.ts:44` 的 5 万条环） |
| 退出门槛 | A-1/A-2/A-3/A-4 全绿 **且** 线上连续 **24 小时** `timeline.divergence` = 0（按 holder 的采样率折算：≈ 每小时 3.6 万事件 × 1% ≈ 360 次比对/小时，0 不一致） |
| 失败处置 | A-1 红 ⇒ 修新链路，**不许**放宽差集白名单；A-5 不达 ⇒ 调 `BLOCK_MAX_BYTES` / `chunk_flush_ms`，**不许**改 I2 |

### B 阶段：切读 + 删三源补丁（要求**代码行数净减少**）

| 项 | 内容 |
| --- | --- |
| 做什么 | ① 读路径切到 timeline（`sessions.events` / `events.list` / `events.subscribe` / `sessions.get.messages`）；② **删掉**两阶段回填、内容 id 去重、押后、负数带、回放预算；③ 旧链路从"同时写"改成"停止写"（先停 trace，再停会话日志）；④ ADR-104 的读回通道（`sessions.events`）在同一 commit 换源 |
| 判据 B-1（净减少，硬） | `git diff --numstat <B-base>..<B-head> -- packages apps` 汇总后 **`deletions ≥ insertions`**；且以下文件/符号**零引用**（`grep -rn` 命中 0，注释里的提及由门禁白名单逐条登记并附原因）：`disk-replay.ts`（整文件删除）、`replay-source.ts` 的两个 `fetch*Segment` + `stableEventId`（整文件删除）、`replay-budget.ts`（整文件删除）、`beginBackfill` / `endBackfill`（`event-store.ts:823`、`:839`）、`tsCeiling` / `deferred`（`disk-replay.ts:123`、`:140`）、`MAX_BACKFILL_PAGES`（`subscription.ts:81`）、`NON_PERSISTED_EVENT_TYPES`（`run-journal.ts:55`） |
| 判据 B-2 | 读结果等价：同一批夹具上，B 阶段新读路径的输出与 A 阶段旧读路径的输出**逐字节相同**（事件体除 `seq` 数值来源外）；`derived_upto_seq` 删除后投影输出不变（ADR-105 D2） |
| 判据 B-3 | 单游标握手四条校验的回归：`check-timeline-equality` A7（篡改游标三种构造）全绿；`timeline_gap_reported` 在 UI 可见（截图/快照断言，不做"人工看"） |
| 判据 B-4 | 破坏性变更登记：`events.list` 的 `seq` 语义变化（per-run → `timeline_seq`）写进 CHANGELOG + 版本号 minor（0.54.0）；`trace.prune` 返回 `not_supported` 的回归用例进 `check-rpc-behavior` |
| 退出门槛 | B-1/B-2/B-3/B-4 全绿；线上 48 小时无 `timeline_gap_reported` 且无 `timeline.index_mismatch` |
| 失败处置 | 见 §3 第 2 条（开关回退：`timeline.read_from = 'legacy'`） |

### C 阶段：旧日志降为只读导出 + 静态门锁死

| 项 | 内容 |
| --- | --- |
| 做什么 | ① 旧格式会话（无 `timeline.manifest`）进入**只读冻结**；② `data/events/<run_id>.jsonl` 停止写入、不再读（`events.list` 早已换源）；③ 新增静态门禁把"回退到旧源"这件事**在编译期挡住**；④ 保留导出命令 |
| 判据 C-1 | `check-legacy-readonly`：a) `SessionEventLog.append` / `FileTraceRecorder.append` 的调用点为 **0**；b) 全仓对 `events.ndjson` / `data/events` 的**写入**字符串命中 0（只读读取点进 allowlist，每项须写"原因 + 计划删除的 minor"）；c) 旧格式会话调 `after_timeline_seq` 订阅必须返回 `session_frozen_readonly`（行为断言） |
| 判据 C-2 | `check-timeline-write-contract`（静态）：`timeline_seq` 的**分配**只出现在 `timeline-writer.ts`；`publish(` 在写者之外不可达（`timelineWriter` 是唯一 publish 出口）；`timeline.idx` 字符串只出现在写者与门禁里；`timeline.chunk_flush_ms` 只从配置层读 |
| 判据 C-3 | 回退通道关闭也不致死锁：`timeline.read_from` 在 C 阶段被移除（配置项删除 + 启动时若旧配置存在 ⇒ 启动报错 `timeline_read_from_removed`，**fail loud**，不静默忽略） |
| 判据 C-4 | 导出可用：`vessel session export --legacy <id>` 对 5 个真实旧会话产出可解析 ndjson（`check-legacy-export` 断言行数 == `event_count`，24 小时内被调用一次算通过） |
| 判据 C-5 | 文档同步：`docs/architecture/session-replay.md` 重写为单源口径（**110 行上限**，删旧章才能加新章）；`event-log-policy.md` 更新落盘口径；ADR-105 状态 `proposed → accepted` |

## 2. 受影响功能清单（逐项验收；这 9 项是"迁移会打到人"的全部）

格式：**今天依赖什么 → 迁移后靠什么 → 验收断言**。每项的断言都进 `check-transcript-cards` /
`check-timeline-equality` 的对应用例，不允许只写在文档里。

| # | 功能 | 今天依赖什么（可指到代码/实测） | 迁移后靠什么 | 验收断言 |
| --- | --- | --- | --- | --- |
| 1 | **环境信息卡**（`prompt.system_context`） | 事件由 `execution-unit.ts:3428` 发；`sessions.ts:82` 说明读的是同一条事件；前端 `transcript-items.ts:311` 解析。**disk-only 且易被环淘汰**（findings §1b），刷新后只能靠两阶段回填 | timeline 上的普通事件，单游标回放即到 | ① 卡片的 `seq` = timeline 中**最后一条** `prompt.system_context` 的 seq；② 刷新前后 payload 的 `hash`（`execution-unit.ts:394`）相等；③ 断线 3 次后仍只有 1 张卡（不重复） |
| 2 | **trim 卡 / 归档卡** | `execution-unit.ts:1086-1087` `appendNotice(renderContextTrimNotice(...))`；卡是**消息**，随 `saveSessionState` 落盘，可见性取决于投影水位 `derived_upto_seq`（`run-journal.ts:204-209`）⇒ 运行中刷新就丢（实测 `derived=4`） | 卡 = timeline 上的 `notice` 事件 + 投影 `project(timeline, upto=timeline_head)`，**与写侧水位无关** | ① 卡数量 = timeline 中该会话的 notice 事件数（ADR-104 `renderProjectionArchiveNotice` 计入同一类）；② 运行中刷新后卡片集合与刷新前**逐条**相同；③ 卡内 `tool_call_id` 集合与对应 `context.cleared_tool_result` 事件的集合相等 |
| 3 | **工具卡与参数摘要** | `tool.call.started` / `completed` 按 `tool:<callId>` 合并；参数摘要随 payload；跨源去重靠内容 id（`replay-source.ts:220`）⇒ 同毫秒同类型靠 payload 摘要才不被吞 | 单一有序流，`tool:<callId>` 只做**渲染分组键**，不再承担去重 | ① 每个 `tool_call_id` 恰好 1 张卡；② `started.seq < completed.seq`（严格交错 A6 的实例）；③ 同一批事件重复回放 3 次，卡片多重集不变（幂等） |
| 4 | **usage / KPI / 成本** | `metrics.ts:159-178` 从 `llm.response.usage` 累加；重启后只能靠 trace 重算（`events.list` 逐 run） | 扫 timeline 的 `run` 索引汇总，`metrics.get` 的 `source` 明确区分 `live`（进程内累加）与 `timeline`（事后重算） | ① 同一会话 `usage.total_tokens` 两条路径**完全相等**；② 重放一次 timeline 后 KPI 不变（幂等）；③ 跨重启后 `timeline` 源的数值等于重启前 `live` 的最终值（差 0） |
| 5 | **观测页 / Run 详情** | `events.list` 读 `data/events/<run_id>.jsonl`（per-run seq，`observability.ts:34-39`；`useRunTrace.ts:32`）；`trace.prune` 删该文件 | `events.list` 同 RPC 名、换源为 timeline 的 run 索引；`seq` 变成 `timeline_seq`（**破坏性**）；`trace.prune` → `not_supported` | ① `events.list(run_id)` 的 seq 集合 = timeline 中该 run 的 seq 集合（逐条）；② 同一 run 的事件在 Run 详情与聊天时间线里**顺序相同**（今天 `disk-replay.ts:33-36` 承认做不到）；③ `trace.prune` 调用后无任何文件被删（回归） |
| 6 | **ask 卡片 / 权限卡** | 事件 `ask.user.requested` / `tool.permission.request`；`run-journal.ts:72-76` 明确它们"必须落盘"；settle 在 `interactions-registry.ts:611`、`:724`、`:776` 走事件流，幂等只在进程内 | 事件 + `effect_key = (session, timeline_seq, 'ask.settle')`，settle 幂等置位；卡片来自 timeline | ① 同一 `timeline_seq` 的 ask 事件重放 3 次 ⇒ 卡片 1 张、settle 1 次、`answer.delivered_at` 不变；② 双 gateway 装配下仍 settle 1 次；③ 权限卡 `requestId` 与 `permission-policy.ts:246` 的 `waitFor` 配对不重不发 |
| 7 | **成员历史 / 团队时间线** | 每会话各自 seq + 易失 hub seq；跨会话只能按 `ts` 排（`disk-replay.ts:33-36`） | 排序键 **`(ts, session_id, timeline_seq)`**（ADR-105 §10 第 1 项）；子 agent 事件只在子会话（同节第 2 项） | ① 排序键唯一（构造同 `ts` 跨会话事件不产生歧义顺序）；② 同一输入重放两次，顺序逐条相同；③ 团队视图里不会把子 agent 事件挂到父会话（归属断言） |
| 8 | **PII 审计** | `pii.reveal.audit` 由 `pii/reveal.ts:34`、`:170-181` 发出（审计体**无真值**，只有 `«pii:…»` 占位）；`apps/web/src/state/event-visibility.ts:271` 有专门可见性档；**外发无幂等键** | 审计事件带 `effect_key`，外发 payload 带 `timeline_seq`；`on_unsure = retry` | ① 重放同一段 timeline 不产生第二条审计记录（下游按 `timeline_seq` 收敛后计数不变）；② 审计事件 `handle` 仍是 `«pii:…»` 占位、**不含真值**（沿用 `reveal.ts:170-181` 的既有形状断言）；③ 断线重连后审计条数 = 实际 reveal 次数（不重复、不缺） |
| 9 | **频道投递**（`agent send` / ask 答案投放 / 外发渠道） | 进程级 `WeakMap` 单飞（`gateway.ts:675-705`）+ `answer.delivered_at` 落盘（`:687-693`），**跨进程不成立**；渠道状态见 `gateway.ts:2603-2613` | outbox：`intent → 投递（下游用 `timeline_seq` 去重）→ done`；`on_unsure = retry` | ① 双 gateway 装配 + 重放 ⇒ 只投一次（把 0.52 单飞用例扩展成"重放后仍然只投一次"）；② `intent` 无 `done` 时重启 ⇒ 重投 1 次且下游计数不变；③ 投递失败不影响 timeline 可读性（fail-open 断言） |

> **清单外但必须同步的两项**（容易被漏，写在这里防丢）：**`sessions.get.messages` 的投影**（第 2 项依赖它，
> 见 ADR-105 D2）与**压缩摘要卡**（ADR-085 的 chunked summary，走同一条 notice 通道，验收并入第 2 项）。

## 3. 风险与回退

### 3.1 双写期间不一致怎么发现（A 阶段）

| 层 | 手段 | 阈值/动作 |
| --- | --- | --- |
| 逐条 | `timeline.verify_sample_rate = 0.01`（夹具 1.0）比对 `(type, run_id, ts, sha256(data))` | 不一致 ⇒ `timeline.divergence` 事件（**不进 timeline 自身**，避免递归） |
| 汇总 | 每小时聚合一次 `divergence_rate` 与 `diff_types` | 任何非 chunk 差异 ⇒ **阻断进 B**；chunk 差异 ⇒ 允许（旧链路本来没有 chunk） |
| 门禁 | `check-timeline-dualwrite` 在 CI 上对夹具做 100% 比对 | 红即不许合 |
| 人可读 | `vessel timeline diff <session>` 只读命令：把旧日志与新 timeline 的差集打成表 | 只在开发/排查用，**不接任何 RPC** |

### 3.2 切读后如何回退（B 阶段）

- 开关：`timeline.read_from = 'timeline' | 'legacy'`（**进程级**配置，默认 `'timeline'`；`legacy` 只在 B 阶段存在）。
  - 位置：`packages/serve` 的装配层读取一次（**不在 core 里读环境变量**，沿 ADR-104 D7 的理由：core 是库，
    同一份代码在不同机器判定不同会让门禁无法逐例注入）。
  - 切到 `legacy` 后：`sessions.events` / `events.list` / 订阅回放**全部走旧读路径**，但**双写仍在**
    （A 阶段的写路径不拆），因此来回切**不丢数据**。
  - 退出：C 阶段删除该配置键；启动时若检测到旧配置值 ⇒ **启动失败** `timeline_read_from_removed`
    （fail loud，不静默忽略——静默忽略会让人以为切回了旧源）。
- 回退不需要数据操作：`timeline_head` / `wal_head` 只增不减（ADR-105 I4），切回去只是**不再读新源**。
- 已在 timeline 里、旧路径没有的事件（chunk 全集）：回退期间**看不到**，这是已知降级，UI 上不显示
  "该会话有新事件"的假象（`tainted` 不带这个语义）。**回退窗口上限 48 小时**，超时必须前进或回滚版本。

### 3.3 旧会话冻结的读路径保留多久

| 项 | 保留到 | 谁负责删 | 怎么保证没忘 |
| --- | --- | --- | --- |
| `sessions.events` 的旧（`events.ndjson`）分支 | **0.55.0** | 0.55 的 C 阶段后续单 | `check-legacy-readonly` 的 allowlist 每条带 `expires_in: '0.55.0'`，到期未删 ⇒ 门禁 FAIL |
| `events.list` 的旧（`data/events/*.jsonl`）分支 | **0.55.0** | 同上 | 同上 |
| 旧数据文件本身 | **不删**（迁移不删数据） | 用户自己 `vessel data prune --legacy` | 只读命令，不进 RPC |
| `vessel session export --legacy` | **长期** | 无 | 它有独立门禁 `check-legacy-export` |

### 3.4 其余风险（逐条给动作，不给"注意"）

| 风险 | 动作 |
| --- | --- |
| chunk 发布延迟影响体感 | 先调 `chunk_flush_ms`（250 → 100）；仍不行 ⇒ 只能缩块，**不得**旁路 WAL（ADR-105 R6） |
| 归档任务与写路径抢 IO | 归档单写者串行 + 每次最多搬 1 段；写路径 `fsync` 优先级更高（同进程内的调度由写者串行队列保证） |
| 索引损坏 | 索引是派生数据（ADR-105 D3）：坏 ⇒ 重建 + `timeline.index_mismatch`，**不影响读结果** |
| 旧会话误写 | 唯一写者入口判 `timeline.manifest` 存在性，缺 ⇒ `session_frozen_readonly`；门禁 C-1 覆盖 |
| 团队视图仍不全会话间全序 | 明确**不承诺**（ADR-105 §10 第 1 项）；排序键写进 `sessions.list` 的返回值文档，UI 不得自行按 `ts` 排 |

## 4. 任务拆分建议（每单一个人 / 一个目标 / 一条可执行验收）

> 禁止"一个人做完整件事"。下面 9 单按依赖排序，A 阶段 4 单、B 阶段 3 单、C 阶段 2 单。

### A 阶段

| 单 | 范围 | 交付 | 验收（可执行） |
| --- | --- | --- | --- |
| **A1 codec + 存储格式** | `timeline-writer.ts` 的非 chunk 路径（ndjson 行、manifest、`blobs/` 外置、crc32）；`timeline-codec.ts` 的空壳 | 写者能 append 非 chunk 事件并 fsync；`sessions.get` 暴露 `{timeline_head, wal_head}` 技术字段 | 单测：I1（同临界区取号+写）、I4（两指针单调、`timeline_head ≤ wal_head`）；`check-timeline-write-contract` 静态部分绿 |
| **A2 chunk 块级** | 块帧编解码、封块四条件、`BLOCK_MAX_BYTES` / `chunk_flush_ms`、chunk 从 `NON_PERSISTED_EVENT_TYPES` 移出 | chunk 落盘 + 可枚举 + 发布在 fsync 后 | 单测：I2（慢 fsync 注入下无 in-flight 泄漏）、§7 A6（严格交错离线夹具）；性能：延迟 P95 达标 |
| **A3 归档 + holes + 索引** | 归档任务（只搬 manifest 指针）、`holes` 登记、三类索引 + rebuild | 归档/索引/洞三条可测 | `check-timeline-index` 四项断言；§7 A2 / A3 / A4 绿 |
| **A4 双写比对 + 观测** | 旧路径保持不动，新链路并行写；`verify_sample_rate` 比对器；`timeline diff` 只读命令 | A-1/A-2 门禁 + 线上采样可用 | `check-timeline-dualwrite` 全绿；24 小时 0 divergence（**进 B 的放行票**） |

### B 阶段

| 单 | 范围 | 交付 | 验收（可执行） |
| --- | --- | --- | --- |
| **B1 服务端切读 + 协议** | `sessions.events` / `events.list` / `events.subscribe` 换源；`timeline.hello`（`{start_seq,end_seq,count,timeline_head,wal_head,holes}`）；删 `gap` 帧；`read_from` 开关 | 协议可握手、可校验 | `check-timeline-equality` A1/A5/A7/A8；`events.list` seq 语义变更用例 |
| **B2 Web 切读 + 删三源补丁** | 单游标 + 四条校验；**删除** `disk-replay.ts` / `replay-source.ts` / `replay-budget.ts`、`beginBackfill`/`endBackfill`、`MAX_BACKFILL_PAGES` | 前端只剩一条读路径 | **B-1 净减少判据**（`deletions ≥ insertions` + 六个符号零引用）；A7 篡改用例；UI 污点条快照 |
| **B3 投影纯读侧 + ADR-104 读回** | `project(timeline, upto)`；`derived_upto_seq` → `projection_cache_seq`（删掉产出不变）；`sessions.events` 读回同一 commit 换源 | 投影不依赖写侧水位 | §2 第 2 项三条断言；删缓存字段后投影逐字节相同；ADR-104 `archive_notice` 读回探针绿 |

### C 阶段

| 单 | 范围 | 交付 | 验收（可执行） |
| --- | --- | --- | --- |
| **C1 冻结 + 静态门** | 旧格式只读（`session_frozen_readonly`）；旧写入点清零；`check-legacy-readonly` / `check-timeline-publish-after-wal`；`read_from` 删除 + 启动报错 | 回退通道关闭、旧源锁死 | C-1 a/b/c、C-2、C-3 全绿 |
| **C2 导出 + 文档收尾** | `vessel session export --legacy`；`session-replay.md` 重写（110 行内）；`event-log-policy.md`；ADR-105 `accepted` | 文档与代码同口径 | C-4、C-5；`bun run scripts/check-docs.ts` 绿 |

### 不作为一单交付的（避免"一个人干完"）

- 迁移与"清理旧数据文件"**不同单**：C 阶段不删任何旧数据（§3.3）。
- "团队视图跨会话全序"**不在 0.54**（ADR-105 §10 第 1 项），不塞进 B2。
- "磁盘 scrub / timeline 归档段回收"需要独立 ADR（ADR-105 §10 第 3、5 项），不塞进 A3。

## 5. 本轮边界

- 本文档 + ADR-105 + `docs/adr/README.md` 一行索引是**唯一改动**；未改任何代码、`scripts/check-*.ts`、
  `package.json`、`docs/architecture/message-invariants.md`、ADR-104。
- 文中所有 `文件:行号` 均以 `main c698471a` 为准；实现轮若代码前移，按符号名重新定位（行号会漂）。
- 待核实项已在 ADR-105 §10 显式标注（子 agent 事件归属的逐条核对、跨会话全序、scrub），
  本文不为它们预设结论。
