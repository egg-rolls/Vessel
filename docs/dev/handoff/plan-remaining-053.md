# 0.53 未完成事项与 0.54 边界

> 状态：**0.53 已收口**（收口线 `0.53-closeout`，基线 `main @ c698471a`）。
> 本文件是 0.53 的**移交清单**：写清楚哪些已经闭合、哪些明确移交 0.54、还有哪件只能用户做。
> 不写进来就会被下个身体当成「遗漏」，所以顶部的「收口结论」是硬性快照，不改历史只追加。

## 0.53 收口结论

### 一、已闭合（每项都有门禁钉住，项数=该探针的断言数）

| 项 | 门禁 | 项数 |
|---|---|---|
| 上下文投射四模式声明与不可变/单调收紧（U1） | `check:projection-declaration` | 103 |
| 运行期接线：段起点冻结、passthrough 逐字节中立、未实现档 fail-open | `check:projection-modes` | 52 |
| `archive_notice` 纯追加归档卡 + `sessions.events` 按 `tool_call_id` 读回 | `check:archive-notice` | 45 |
| trim 卡分层（本轮新增 / 会话累计）与同载荷去重、占位幂等守卫 | `check:tool-result-clear` | 76 |
| C1g 按投射模式分档判定 | 本文件所在门禁 `check:append-only-context` | — |
| **C1h 按豁免事实判定**（声明 + 审计 + 集合逐条相等 + 每条确实是占位） | `check:append-only-context`（含 `C0b` 自检 10 例） | 23 项全过 |
| 磁盘回填两阶段（`sessions.events` + `events.list` 逐 run）与 fail-open | `check:replay-merge` / `check:replay-apply` | 12 / 76 |
| 回填链路静态门（逐方法接线 / 禁本地文件系统 / 禁裸 transport） | `check:replay-wiring` | A1 + 16 自检 |
| `sessions.events` 契约（空日志 / 排他游标 / 分页不重不漏 / 坏行降级） | `check:session-events` | 40 |
| peer 停下通知父会话（含注入落事件） | `check:peer-notice` | 68 |
| 通知可见性对等（生产者 scope ⊂ Web 词表） | `check:env-scope-parity` | 50 |
| 旧工具名换算（`ask_user` / `pii.reveal`）+ 注册期 fail-fast 校验 | `check:tool-name-aliases` | 67 |
| `agent list includeReleases` + `closed_at` / `close_reason` | `check:member-history` | 35 |

C1h 的「闭合」有两条证据，缺一不可：**门禁默认模式与 `--phase=1` 都是绿**（两者结论必须
相同，灰度机制已删除），且判据自带 `C0b` 自检证明「四真少一条就红」——不是靠白名单、
不是靠全局开关、不是「没输出所以绿」。

### 二、移交 0.54 的四项（**明确不做完，不是遗漏**）

1. **投影卡实现（PC-1 / PC-2 / PC-3）**
   规格已写死：`docs/dev/handoff/projection-card-spec.md`。三个实施块——
   - **PC-1**：投影 badge（层级 1，常驻可见：这条是占位、模型看到的是这句）；
   - **PC-2**：双层切换「模型视角 | 原文视角」（层级 2；原文靠 `sessions.events` 按
     `tool_call_id` 读回，U3 已把这个读回口做好）；
   - **PC-3**：批量汇总卡（层级 3）+ 折叠不得吞掉投影信息（§3.7 现有缺陷）。
   规格里已写死一条结论：**卡不能充当 C1h 的豁免凭据**（C1h 只认声明 + 审计 + 集合相等）。
2. **gap 协议 + 两侧计数**
   今天重连只传 cursor，服务端回 `hello(from_seq, latest_seq)` + 有界回放 + `gap`，
   **不回条数、不保证连续**；服务端跳段（预算窗口 / 环淘汰）与客户端静默吸收导致
   「截断不可见」。应有形态与验收口径见 `docs/dev/handoff/replay-gap-brief.md` §2.5 与
   `replay-gap-findings.md`：回放区间 `(cursor, head]` + 帧上
   `{from_seq, to_seq, count}`，客户端**先校验连续**再合并。
3. **un-acked 队列**
   「已发生、尚未被磁盘确认」的事件今天无法枚举（服务端 `lastPersistedSeq` 只到已 flush
   水位，前端没有该概念），于是验收等式
   `UI.seq集 == disk(seq ≤ watermark) ∪ unacked` 的右半边是悬空的。
   **0.54 的口径是直接消灭这个概念**（timeline 迁移后不再需要「环 vs 磁盘」两套）；
   如果 0.54 没按这个口径做，就必须补一个「入环前先入队、磁盘 ack 才出队」的队列。
4. **AB-1 三模式对比**（在线实验，**需要预算批准**）
   离线折算已完成：`docs/dev/handoff/cache-ab-cost-model.md`（645 段净赚 36:1、临界折扣
   `r* = 2.68%`、冻结不变式值 +82.2，而「每请求重算集合」反事实是 −72.37）。
   AB-1 原本是 A=passthrough / B=placeholder 两模式 usage 重放；0.53 落了 `archive_notice`
   之后应扩成**三模式对比**。判定阈值已先写死在文档里，不许事后改。

### 三、仍需用户做的一件：真机刷新验证

代码侧已闭合（两阶段回填 + fail-open + 触顶可见），但**只有真机能验**：

1. 用新代码重启 gateway/node（旧进程里的代码不算）；
2. 打开一个**长 run** 的会话，运行中刷新几次（重连同理）；
3. 看 `EventStore#diskBackfill`（Web 控制台可读）的六个字段：
   - `attempts`（刷了几次）、
   - `merged`（并回多少条）、
   - `duplicates`（因「环 / live 已有同一内容 id」丢掉几条）、
   - `deferred`（晚于环里最新一条而押后几条 —— 归实时流，**不是丢**）、
   - `truncated`（页数上限先到几条，有洞风险）、
   - `stage1HitCap`（阶段一是否触顶；true 且 run 数 > 3 ⇒ 早于最近 3 个 run 的事件本次
     根本没被请求）。
   辅助位：`alreadyMerged` / `outOfRange` / `evicted` / `stage1Pages` / `stage2RunsRequested` /
   `stage2RunsFetched` / `stage1CapWarn` / `lastError`。
4. 判定：`merged > 0` 且刷新后屏幕上「正文 / 工具卡 / 内部行」不再缺段；
   `truncated` 或 `stage1HitCap` 为真时应当**有 warn / toast**（静默即为缺陷）。

### 四、已知边界三条（**不阻塞 0.53，由 0.54 timeline 迁移兼并**）

1. **chunk 不落盘**：`llm.stream.chunk` 磁盘两处都没有（session 日志与 run trace 都没有），
   运行中的流式正文只能从环拿，重启即永久丢；两阶段回填只能保证「结构骨架 + 已完成正文」。
2. **三套 seq 无映射**：session 全局 / run per-run / hub 进程全局，互不映射；跨源只能按
   **内容 id** 去重（`run_id|type|ts|payload` 摘要），不能按 seq，`events.list` 必须逐 run 作用域。
3. **trace-only 不交错**：`context.changed` / `hook.*` / `run.checkpoint` / `runtime.notice`
   只在 run trace（`data/events/<run_id>.jsonl`），不在 session 日志；要补它们必须逐 run 拉，
   不能用一个 `since_seq` 跨 run（否则正好切错段）。

## 附：证据与设计文档索引

- 投射：`docs/adr/ADR-104-context-projection-policy.md`、`projection-card-spec.md`、
  `projection-sot-probe.md`
- 回放：`refresh-gap-design.md`、`replay-gap-brief.md`、`replay-gap-findings.md`、
  `chunk-loss-measurement.md`
- 占位与体积：`measure-tool-result-clear.md`、`cache-ab-cost-model.md`
- 工具名：`tool-name-legality.md`
