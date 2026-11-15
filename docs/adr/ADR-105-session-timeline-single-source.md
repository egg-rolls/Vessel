---
adr: 105
title: 会话 timeline 单一真相（append-only / 全局单调 timeline_seq / 块级 chunk / 单游标握手）
status: proposed
date: 2026-11-15
related: [032, 046, 047, 056, 089, 098, 104]
tags: [session, timeline, replay, wal, seq, storage, index, handshake, idempotency, migration]
---

## ADR-105：会话 timeline 单一真相（append-only / 全局单调 timeline_seq / 块级 chunk / 单游标握手）

- **状态**：proposed。
- **owner 裁定（已并入，不再讨论）**：
  1. **0.54.0 只做这一件事**：每个会话一条 **append-only timeline**，会话内**持久单调 `timeline_seq`**。
  2. **所有事件（含 `llm.stream.chunk`）先写 WAL，再进 timeline**：chunk 不再有"不落盘"的特权。
  3. **不做历史兼容**：旧会话（0.54 之前写下的 `events.ndjson` / `data/events/<run_id>.jsonl`）**只读冻结**，
     不迁移、不回填、不双格式读写。
  4. **允许重写写入链路 / 存储 / 索引**，接受高实现成本；**计划书必须把受影响功能逐一列出**
     （见 [plan-054-timeline-migration.md](../dev/handoff/plan-054-timeline-migration.md) §2）。
  5. 目标仍是三条：**可证明不漏**、**断线无洞**、**回放自洽**，外加**时序严格交错**（同一会话内所有
     事件按 `timeline_seq` 严格交错，不再有"trace 带的条目排在会话日志带之后"这种结构性失真）。
- **本轮范围**：只有本文档 + 迁移计划书 + `docs/adr/README.md` 一行索引。**不改任何代码**，
  不改 `scripts/check-*.ts`、`package.json`、`docs/architecture/message-invariants.md`、ADR-104。
  §11 的文件清单是实现轮的施工图。
- **本文与 ADR-104 的关系**：ADR-104 管"请求视图怎么从落盘历史导出"（投射四模式），本文管"落盘历史本身
  是什么"。**ADR-104 不重写、不 supersede**；它的 `sessions.events` 读回依赖（ADR-104 §2.3f）在 0.54 由
  `timeline.read` 承接（§6、§10 第 6 项）。

### 0. 先核实的事实（后面每条决策都建在这上面）

基线 `main c698471a`（2026-11-15）。三条边界今天**一条都不成立**（判据与实测见
[session-replay.md](../architecture/session-replay.md) §3、[replay-gap-findings.md](../dev/handoff/replay-gap-findings.md) §0）：

| 事实 | 证据位置 | 对本 ADR 的后果 |
| --- | --- | --- |
| 落盘是**三源**：`sessions/<id>/events.ndjson`（会话日志）、`data/events/<run_id>.jsonl`（run trace）、进程内环 | `session-event-log.ts:430-481`；`trace-recorder.ts:198-227`；`event-buffer.ts:47-63` | 必须合成一条；否则"哪个源是真相"永远答不上（§1） |
| 三套 seq 互不映射：会话内自增 / 每 run 从 1 / 进程内全局且重启归零 | `session-event-log.ts:451-452`；`trace-recorder.ts:352`；`event-buffer.ts:49`（`nextSeq = 1`） | 跨源只能按内容 id 去重（`disk-replay.ts:38-46`），于是有了押后（`disk-replay.ts:116-123`）与两阶段回填 |
| `llm.stream.chunk` **两处磁盘都不落** | `run-journal.ts:55-66`（`NON_PERSISTED_EVENT_TYPES`）→ `:118-128` 走 `publishRaw` 早退；trace 侧实测 `files_with_chunk=0`（findings §1d） | 在飞正文只在环里；重启即永久丢弃。本文把 chunk 变成一等公民（§4） |
| 广播**不看落盘结果**：落盘失败也照样 `publishRaw` | `run-journal.ts:281-289`（成功与失败两个分支都 `publish`） | "UI 里有、磁盘里没有"是**设计允许**的 ⇒ 集合不可枚举；§3 I2 把它反过来 |
| 回放是"环的连续后缀"，预算会跳段 | `gateway.ts:1286-1325`（`tailReplayWindow`）、`:1365-1389`（`planReplay`）、`replay-budget.ts:174-178` | `gap` 同时表示"环淘汰"与"预算跳过"（`gateway.ts:1393-1403`），两种原因协议上不可分 ⇒ §6 删掉 `gap` |
| `hello` 只报 `{from_seq, latest_seq}`，**没有条数** | `gateway/frames.ts:88-99`；发送点 `gateway.ts:1410`、`:1417` | 客户端无法核对"该收多少"；§6 加 `{start_seq, end_seq, count, timeline_head, wal_head}` |
| 前端刷新走两阶段磁盘回填（session 日志 + 逐 run trace），跨源去重靠内容 id，会押后 | `apps/web/src/gateway/replay-source.ts:47-49`、`:318`、`:358-368`；`disk-replay.ts:179-265` | 这是给"三源"打的补丁；单源之后**整层可以删掉**（计划书 B 阶段，净减行为判据） |
| 投影水位 `derived_upto_seq` 只在四处推进（初始保存 / checkpoint / 终态 / 手动压缩） | `run-journal.ts:204-209`；实测 `derived=4 < last_seq=366`（findings §1） | "刷新只剩 4 条"是**投影水位**的必然结果；§2 D2 把投影降级为纯读侧视图 |
| 出站帧补 `session_id` 是事后拼的（订阅过滤依赖它） | `gateway.ts:1246-1254`（`broadcastEvent`）、`:1227-1239`（`sendEventToWs`） | 单源之后归属写进记录、不再出站补齐（§4 记录 schema 带 `session_id`） |
| 已有"event = 副作用"的幂等实践，但只覆盖进程内 + 单点 | `gateway.ts:675-705`（`asyncAnswerDeliveries` 进程级 WeakMap）、`:687-693`（`answer.delivered_at` 落盘兜底） | 只能算半个；§8 把它推广成统一幂等键 |

### 1. 问题

一句话：**"此刻的事实"要靠三源三 seq 现场拼，而拼法是猜的。**

| # | 症状（可指到代码） | 根因 |
| --- | --- | --- |
| P1 | 跨源去重只能按内容 id `run_id\|type\|ts\|payload 摘要`；同毫秒同类型的两条不同事件要靠 payload 摘要才不被吞（`disk-replay.ts:38-46`；`replay-source.ts:220`） | 三套 seq 无映射 ⇒ 没有可比的身份 |
| P2 | 押后机制：晚于"环里最新 ts"的回填事件**不并入**，等实时帧或下一次回填（`disk-replay.ts:116-123`、`:235-238`） | 没有全局顺序 ⇒ 只能拿 `ts` 当顺序代理 |
| P3 | 两阶段回填：阶段一 `sessions.events`（会话 seq）、阶段二逐 run `events.list`（per-run seq），两个游标不能混（`replay-source.ts:47-49`、`:350-368`） | 一份历史被劈成两半，各自有各自的编号 |
| P4 | 时序失真：`context.changed` 这类 trace-only 事件在同一 run 内排到正文**之后**（`disk-replay.ts:33-36` 自述） | 用"负数带"偏移把三个 seq 空间硬塞进一个升序数组，顺序是结构性的猜 |
| P5 | chunk 不落盘（`run-journal.ts:55-66`）⇒ 在飞正文只存在于环，刷新/重启即永久丢 | chunk 被当成"噪声"而不是事实 |
| P6 | `gap` 一个区间背两种成因（`gateway.ts:1393-1403`），`onGap` 静默（findings §4） | 协议不给"该收多少"，客户端无从发现洞 |
| P7 | "刷新只剩 4 条"：投影水位 `derived_upto_seq=4`（`run-journal.ts:204-209`） | 写侧水位被读侧当成覆盖证明 |

三条边界（`session-replay.md` §3）在本文里各自被一条不变量消掉：`U` 不可枚举 → §3 I2（发布必须在 WAL 之后）；
水位非全局单调 → §2 D1（`timeline_seq`）；两侧无计数 → §6（`count`）。

### 2. 决策

#### D1：一条 timeline，一个 seq —— `timeline_seq`

- **作用域**：**会话内**。跨会话不可比（跨会话顺序见 §10 第 1 项）。
- **性质**：持久、单调增、**已发布的 seq 永不复用**、**不因 run / 子 agent / 进程重启重新开始**。
- **唯一分配点**：`packages/core/src/session/timeline-writer.ts`（新，唯一写者）内的**单个计数器**，
  与"追加 WAL"在同一个临界区（§3 I1）。**没有任何其它模块可以造 seq**（门禁见 §11）。
- **取代什么**：`SessionEventLog.append` 的 `state.assignedSeq`（`session-event-log.ts:451-452`）、
  `FileTraceRecorder` 的 per-run `state.lastSeq`（`trace-recorder.ts:352`）、
  `SeqEventBuffer.nextSeq`（`event-buffer.ts:49`）三处**全部退役**。环退到 D3 的地位。

#### D2：append-only，事件只在尾部追加；投影是**纯读侧视图**

- timeline 只追加，不改写、不删除（删除会话 = 删目录，与今天 `deleteSession` 同口径）。
- `SessionState.messages` 与 `index.json` 的 `derived_upto_seq` **不再是事实**：投影 =
  `fold(timeline[1..seq])` 的纯函数结果，可缓存、可丢弃、可重建。写侧不得再"因为投影推进到某个 seq
  而宣布覆盖"（今天 `run-journal.ts:204-209` 正是这么做的，见 P7）。
- 落地判据：`sessions.get.messages` 的来源在 B 阶段改为 `project(timeline, upto=timeline_head)`；
  缓存字段改名 `projection_cache_seq`，删掉它之后**产出逐字节不变**（计划书 B 阶段判据）。

#### D3：索引可重建；环降级为 cache

- **索引**（§5）是派生数据：删掉、损坏、造一个假的，都不改变任何读结果（只有变慢）。
- **进程内环**（`event-buffer.ts`）降级为"已广播帧的发送缓存"：可以整块丢掉、可以在任意时刻为空，
  **不参与任何"事实"判定**。今天它是唯一回放源（`gateway.ts:1365-1389` 只问 `hub.since`），这正是
  `session-replay.md` §4 说的"职责颠倒"——本条把它正过来。

#### D4：旧会话只读冻结，**不做迁移**

- 判据：会话目录里**没有 `timeline.manifest`** ⇒ 旧格式 ⇒ **只读**。写路径在唯一写者入口
  （`timelineWriter.open`）抛 `session_frozen_readonly`；读路径保留今天的两条（`sessions.events` 读
  `events.ndjson`、`events.list` 读 `data/events/<run_id>.jsonl`），**代码不动**。
- **不做**：不写转换脚本、不双格式读写、不做懒迁移（首次打开时静默转格式会让"同一会话两份历史"成为可能，
  那是把 §1 的三源换成四源）。
- **退役时间表**：只读读路径保留到 **0.55.0**；0.55 内由 `check-legacy-readonly` 的 allowlist 逐项删除
  （计划书 §3 第 3 条）。长期保留的只有导出：`vessel session export --legacy <id>`（一次性转 ndjson 给人看），
  它**不是**读路径，不参与任何 RPC。

#### D5：不做"第二事实源"的移植——`run trace` 并进 timeline

`data/events/<run_id>.jsonl` 的内容（`hook.*` / `context.changed` / `run.checkpoint` / `runtime.notice` 等
trace-only 类型，findings §1d）在 0.54 起**写进同一个会话 timeline**（run 只是事件的属性，不是文件边界）。
`FileTraceRecorder` 退役；`events.list` 这个 RPC **名字保留、语义换源**：改为查 timeline 的 run 索引
（`timeline.idx/run.idx`），入参 `run_id` 不变，返回的 `seq` 变成 `timeline_seq`（**破坏性变更**，计划书
§1 B 阶段与 CHANGELOG 一并落地）。理由：观测页与 Run 详情按 run 看是合理视图，但"按 run 一个文件"是
P3 / P4 的来源。

### 3. 写入契约（不变量，四条；全部可断言）

> 定义（先对齐词）：
> - **WAL** = 会话目录下的写前日志，是"已持久、可枚举"的边界；**timeline** = WAL 归档后的主存储段。
> - `wal_head` = 满足「`[1..wal_head]` 中每个 seq **要么**在 timeline/WAL 里可读、**要么**在 `holes` 里被声明」
>   的最大 seq。`timeline_head` = 已归档进 timeline 段文件的最大 seq。恒有 `timeline_head ≤ wal_head`。
> - `assigned_head` = 写者已分配的最大 seq，**内部字段，不对外、不参与任何握手**。

#### I1 **seq 在写 WAL 的那一刻分配**

- 唯一路径：`timelineWriter.append(record)` 内部「取号 → 追加 WAL」在同一临界区完成；非 chunk 事件追加一条
  ndjson 行，chunk 事件追加一条**块内二进制帧**（帧头 8 字节 seq + 4 字节 len；块文件即 chunk 的 WAL 本体）。
  不存在"先取号、再决定写不写"的路径，因此**没有"号在飞、内容未定"的中间态**能被外部看到。
- 失败语义：`append` 抛错 ⇒ 该 seq **作废但不回收**（写者把 `assigned_head` 推进过去），调用方拿到
  `timeline_write_failed`，**事件被丢弃**；今天"落盘失败仍广播"的行为（`run-journal.ts:281-289`）**取消**。
- 重启续号：`next = max(timeline.manifest.end_seq, wal.manifest.end_seq, 最后一个有效 WAL 帧的 seq) + 1`。
  撕裂尾帧被截断（沿用 `truncatePartialTail` 口径）；**这些 seq 从未被发布，重新分配不违反"不复用"**——
  "不复用"的准确判据是 **`published_head` 单调**：任一次握手/帧返回过的最大 seq，之后不再出现更小的新 seq
  （断言见 §7 A5）。

#### I2 **发布只能发生在 WAL 之后**

- `publish(event)` 的**唯一调用点**在写者内部，且必须在 WAL fsync 返回之后（`wal_head` 已覆盖该 seq）。
  任何 `seq > wal_head` 的事件**不得**出现在：WS 帧、SSE 帧、`events.subscribe` 结果、`sessions.get`、
  `sessions.events` / `timeline.read` 的任何一页里。
- 直接后果（写清，别当副作用）：chunk 的实时性由**封块策略**决定，不由"发布提前"决定。封块触发条件
  （全部在这条不变量之内）：① 活动块 ≥ `BLOCK_MAX_BYTES`（32 KiB）；② 有非 chunk 事件要落盘
  （**严格交错优先**：先封块再写该行）；③ 空闲 `CHUNK_FLUSH_MS = 150`（上限 1000，配置键
  `timeline.chunk_flush_ms`）；④ run 终态 / `flush()` / 进程退出。⇒ chunk 发布延迟上界 = 150 ms
  （或一次工具事件的间隔）；嫌慢只能调小 ②③ 的参数，**不得旁路 WAL**（门禁
  `check-timeline-publish-after-wal`）。
- 为什么这是"未归档集合可枚举"的前提：UI 见过的每个 seq 都 ≤ `wal_head`，所以 UI 的集合恒等于
  `timeline ∪ WAL` 的子集，两边都能枚举（§7）。今天反过来（先广播、失败也广播）⇒ 集合无界。

#### I3 **主 timeline 归档失败不影响正确性，只影响空间回收**

- 归档 = 把已持久 WAL 段搬进 timeline 段文件（chunk 块**只搬 manifest 指针，不重写字节**）。归档是后台任务，
  不在写路径上。
- 失败语义（写者必须写死的四步）：① 重试 3 次（间隔 100 / 500 / 2000 ms）；② 仍失败 ⇒ **不推进
  `timeline_head`**，`wal_head` 照常前进，事件照常可读；③ 记
  `timeline.archive_failed{from_seq,to_seq,error}`（走 Notifications，**不写进 timeline 自身**，避免递归）；
  ④ 磁盘满 / IO 错持续 ⇒ 会话标 `tainted`，`sessions.get` 里带上，UI 显示污点条，**不阻断渲染**。
  （`tainted` 是**派生值**：失败后保留到**成功归档一次**为止，复位口径与 `tainted_cleared` 行见 §11.1。）
- 反向也写死：归档**只**影响"磁盘占用"与"读放大"，不影响 seq 连续、`wal_head` 推进、UI 渲染、验收等式
  （§7 的右半边就是给这种情形留的）。今天没有这个区分（`run-journal.ts:296-321` 落盘失败只报一次日志 +
  一条 `session.log.failed`，随后当成没事），所以"磁盘缺、环有"是沉默的。

  **失败必须落盘成可声明的洞**（2026-11-16 补，断言见 §7 A5）：
  - append 失败后，写者在**同一会话的洞登记区**（与 timeline 同目录、append-only、crc32 校验）追加一条
    `{from_seq, to_seq, reason, at}`，该区间永久计入 `holes`，**不得只在内存或日志里记**；
  - 断言形态：模拟 WAL fsync 失败 → **重启后** `sessions.get.event_cursor.holes` 必含该区间、
    `tainted === true`、UI 出污点条；只做内存标记不算通过；
  - 唯一例外：**撕裂尾帧**（最后一条半写、从未发布）允许重分配 seq，因为任何客户端都没见过它；
    判据是 `published_head` 单调（见 I4）。

#### I4 **`timeline_head` 与 `wal_head` 两个指针必须可对外上报**

- 两指针出现在三处，字段名固定：`sessions.get` 的 `event_cursor`（今天有 `last_seq` / `derived_upto_seq`，
  `sessions.ts:141-142`）→ 改为 `{timeline_head, wal_head, holes, tainted}`；握手 `hello`（§6）；
  `timeline.read` 的每页。
- 恒等式与单调性（断言见 §7）：`0 ≤ timeline_head ≤ wal_head`；同一会话内两指针**只增不减**；重启后第一帧的
  `wal_head` **不小于**重启前最后对外报出的 `wal_head`（否则就是丢数据，必须报 `holes`）。
- **`published_head` 单调（2026-11-16 补，具名断言）**：`published_head` = 已对外发布过的最大 seq，
  跨重启必须**不下降**；任何回退 ⇒ A5 断言 FAIL，且该回退区间必须出现在 `holes` 里。
  这条与 I1 的"作废不回收"配对：**未发布的尾部可重分配，已发布的绝不可**。
- 为什么"必须可上报"而不是内部指标：验收等式（§7）两边都要**对外可枚举**，客户端才能自己核对；今天客户端
  能拿到的唯一水位是易失的 hub seq（`event-store.ts:379-380`）。

### 4. 存储格式

会话目录（`<sessions_dir>/<session_id>/`）：

```
timeline.manifest            # 主 manifest（ndjson 行，只追加）
timeline/seg-000001.tseg     # 归档段（默认 8 MiB 或一个 run 边界，先到者为准）
timeline/blocks/000042.blk   # chunk 块（8–32 KiB 二进制帧，只写一次，永不重写）
wal.log                      # WAL：非 chunk 事件一行一条（ndjson）
wal.blocks/000007.wblk       # WAL 的 chunk 块（二进制帧，封块即 fsync）
wal.manifest                 # WAL 的块目录：[seq 起, 止] + 字节偏移 + 条数 + crc32
timeline.idx/run.idx         # run 索引（可重建，§5）
timeline.idx/type.idx        # type 索引（可重建，§5）
```

| 对象 | 粒度 | 一条是什么 | 为什么这样 |
| --- | --- | --- | --- |
| 非 chunk 事件 | **一事件一行**（ndjson） | `{v,seq,session_id,run_id,ts,type,data,fencing_token?}` | 与今天 `SessionEventRecord` 同形（`session-event-log.ts:453-462`），`data` 仍是原样对象 ⇒ 现有解析不用改 |
| **chunk** | **块级**（8–32 KiB/块） | 块内 = 紧凑二进制帧 `[u64 seq][u32 len][utf8 payload]`；manifest 记 `{block, start_seq, end_seq, offset, bytes, count, crc32}` | 一条 chunk 一行 ndjson 实测 ~200 B 编码开销（findings §1d：一次长 run 上千条），块级摊到 12 B/帧；**同时**满足"chunk 有 seq 且可枚举" |
| chunk 的重放 | 按块解码 | 读到覆盖该 seq 的 manifest 条目就解码该块 | 严格交错：块只包**连续**的 chunk seq（封块条件 ② 保证），`(seq → 位置)` 仍是单值映射 |
| 超大事件 | 单条 `data` > `MAX_INLINE_BYTES`（1 MiB） | 外置成 `timeline/blobs/<seq>.bin`，行里留 `{blob:true,bytes,crc32}` | 今天出站缓冲 8 MiB 就断连（`gateway.ts:475`、`:1159` "slow_consumer"）说明大 payload 真实存在；外置让它不影响读顺序 |
| 归属 | **写进记录** | `session_id` 是记录字段，不再出站补齐 | 今天靠 `resolveEventSession` 事后补（`gateway.ts:970-1006`），补不出来的事件"发不出去"；写进记录后归属是事实 |
| 校验 | 每行/每帧 crc32 + 每段尾部汇总 | 读时坏行按"洞"处理（§6 `holes`） | 损坏必须**可声明**，不能像今天 bad-line 容错读（findings §2）那样静默跳过 |

### 5. 索引

三类，全部**可重建**、全部**不是事实源**：

| 索引 | 内容 | 谁用 | 重建 | 成为第二事实源的禁止方式 |
| --- | --- | --- | --- | --- |
| **session** | 不另立文件（timeline 天然按会话分目录）；`timeline.idx/session.idx` 只存 `{first_seq,last_seq,count,holes}` 摘要 | `sessions.list` 的体积/条数展示、握手 | 扫段头 | 与段不一致 ⇒ **以段为准**并重写索引（不报错、不阻断）；摘要**不得**被任何断言当判据 |
| **run** | `run_id → [{start_seq,end_seq}]`（通常 1 段；resume / 分段会有多段） | `events.list`（换源后）、Run 详情、usage/KPI 按 run 汇总 | 顺序扫段 | 读路径必须对返回区间**逐条校验记录的 `run_id`**；不一致 ⇒ 走全扫并记 `timeline.index_mismatch` |
| **type** | `type → 有序 seq 列表`（或按段的位置区间） | `types` 前缀过滤（`gateway.ts:1607`）、PII 审计检索、`context.changed` 折叠 | 顺序扫段 | 同上：命中后必须回读记录核对 `type` |

**断言（进 A 阶段门禁 `check-timeline-index`）**：

1. 删掉 `timeline.idx/` 整目录 ⇒ 所有读 RPC 返回**逐字节相同**的结果（只有耗时变长）。
2. 把 `run.idx` 写入一条假区间 ⇒ 读结果不变（走校验回退），且发出 `timeline.index_mismatch`。
3. `rebuild` 两次 ⇒ 索引文件字节相同（确定性，无时间戳/哈希顺序抖动）。
4. 全仓唯一写索引的位置 = `timelineWriter`（静态断言：`timeline.idx` 字符串只允许出现在该模块与门禁里）。

### 6. 握手协议

**客户端只持有一个游标**：`client_timeline_seq`（客户端内存 + 本地持久化；刷新**不**清零，
与今天"每次刷新 `since: 0`"相反，`connection-handlers.ts:95`、`:265`）。

```
→ events.subscribe { session_id, after_timeline_seq: N }     // 参数名固定；since 在时间线订阅上被拒
← hello {
    kind: 'timeline.hello',
    start_seq: N+1, end_seq: wal_head,
    count: (end_seq - start_seq + 1) - Σ|holes ∩ [start_seq,end_seq]|,
    timeline_head, wal_head,
    holes: [{from_seq,to_seq}]?, tainted?: true,
    reset?: true                                            // 只有两种：N > wal_head，或会话被冻结后重开
  }
← 帧序列：seq 严格升序，每条 {seq, type, run_id, ts, data}    // 分页时每页自带同样的头部
← 分页：继续要 after_timeline_seq = 上一页末 seq（每页 ≤ 500 条 / ≤ 8 MiB；保留字节上限，删掉"结构优先"裁剪）
```

**客户端校验（四条，全部硬）**：

1. 首条 `seq === start_seq`（若 `start_seq` 落在 `holes` 内，则首条 = 该洞之后第一个非洞 seq）；
2. 末条 `seq === end_seq`（有下一页时：本页末条 = 下一页 `start_seq - 1`，跨洞按声明跳）；
3. 实收条数 `=== count`；
4. 收到的 seq 集合 ⊎ 声明洞 = 闭区间 `[start_seq, end_seq]`，无重复。
   任一条不成立 ⇒ **不合并**、报 `timeline_gap_reported{expected, received}`、重拉该区间。
   今天相反：`push` 只丢 `seq <= lastSeq`（`event-store.ts:501`），洞与重复被静默吸收。

**`gap` 帧删除**。今天它把两种成因压进一个区间（`gateway.ts:1393-1403`），且 `onGap` 明确"静默处理、
页面感知不到截断"（findings §4）。0.54 起：

- 缺帧**只可能**因为 `holes`（磁盘/写入故障），或客户端自己算错。
- `holes` 是**声明**不是猜：由写者在归档/读取时对坏行、坏帧、缺失块**登记**（落 `timeline.manifest`，
  永久保留，不自动修复）。
- **污点标记但不阻断渲染**：UI 显示"该会话有一段事件已损坏/不可读（seq a..b）"，其余照常渲染，
  握手仍以 `wal_head` 为右端。

### 7. 验收等式（可执行形态）

> **UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)**

两边都能枚举：左 = 客户端本地事件集合（`EventStore.entries` 里 seq > 0 的那部分）；右 = 服务端两段目录。

可执行断言（`scripts/check-timeline-equality.ts`，构造夹具，不做线上采样）：

| # | 断言 |
| --- | --- |
| A1 | 夹具会话跑「写入 → 断开 → 重连 → 拉全量」：`seqSet(UI) === seqSet(timeline ∪ WAL)`，且逐条 `(type, run_id, ts, sha256(data))` 相等 |
| A2 | 归档并行进行（**两种"一半"都要造**：① 归档落后于写入的窗口 `timeline_head < wal_head`；② 归档写段中途 fsync 失败/进程崩溃）⇒ A1 仍成立，且**段文件里不得留重复行**（不许靠读侧去重掩盖半成品） |
| A3 | 注入归档失败（I3）⇒ A1 仍成立，且 `timeline_head` 停在旧值、`wal_head` 已前进 |
| A4 | 注入磁盘坏块 ⇒ `holes` 恰好覆盖坏区间；**等式要按两种读法都断言**：`seqSet(UI_重连后) ⊎ holes` = 闭区间 `[1..wal_head]`，且 `UI_曾收到 \ 可读 = holes`（对称差）。原文「`seqSet(UI) ⊎ holes === seqSet(timeline ∪ WAL)`」在「UI 已见过坏块前那条」的读法下不成立——那条既在 UI 又在 holes。UI 不空白 |
| A5 | **`published_head` 单调**：重启前后对比 `wal_head` 不下降；任一次握手返回过的最大 seq 之后不出现"更小的新 seq" |
| A6 | **严格交错**：夹具造 chunk / `tool.call.*` / `context.changed` 交织，断言 UI 的 seq 序列**严格升序且无空洞**（今天 `disk-replay.ts:33-36` 承认做不到） |
| A7 | `count` 校验：把客户端游标篡改成 +1 / -1 / 落在洞内三种构造，客户端必须拒绝合并并报 `timeline_gap_reported` |
| A8 | **分两半**：①（已实现，回归另一半）读路径 `sessions.events` / `events.list` 的结果与今天**逐字节相同**、写者打开旧目录抛 `session_frozen_readonly`、冻结层碰过之后旧文件一字节不变；②（**属 C 阶段，未实现**）`after_timeline_seq` 订阅返回 `session_frozen_readonly` —— 今天该错误只在写者打开时抛（`timeline/writer.ts:386-391`），订阅路径不认识 timeline |

**失败时的处置（写死）**：A1–A6 任一红 ⇒ **禁止进 C 阶段**（计划书 §1）；A7 红 ⇒ 客户端校验实现回退到
"全量重拉 + 报错可见"，不得静默。

### 8. 重放幂等要求（**必须单列：这是最容易漏的一节**）

单源 + 可重放 ⇒ "事件即副作用"的消费者会被**事实重放**触发第二次。所有这类消费者必须带**幂等键**，
键的形状固定：`(session_id, timeline_seq, effect_kind)`，落盘位置 = 会话目录 `effects.ndjson`（只追加）。

| 消费者 | 今天的幂等依据 | 迁移后必须改成 | `on_unsure`（执行前写 intent、执行后写 done，缺 done） |
| --- | --- | --- | --- |
| **频道投递**（`agent send` / ask 答案投放） | 进程级 `WeakMap` 单飞（`gateway.ts:675-705`）+ `answer.delivered_at` 落盘（`:687-693`）——**跨进程不成立**（两个 gateway 装配各投一次正是它要解决的问题） | outbox：`intent(effect_key)` → 投递（下游用 `timeline_seq` 去重）→ `done(effect_key)` | `retry`：重投并带上 `timeline_seq`，由下游去重 |
| **ask / 权限卡交互** | `interactions-registry` 在事件流上去重（`interactions-registry.ts:611`、`:724`、`:776`），进程内 | `settle(effect_key)` 幂等置位；同一 `timeline_seq` 的 ask 事件重放 N 次只 settle 1 次 | `drop`：已 settle 的状态就是答案，重复 settle 只会覆盖 |
| **通知**（`runtime.notice` → 用户可见提示） | 无（今天就可能重复，只靠 UI 折叠） | `notify(effect_key)` 去重；UI 侧同一 `effect_key` 只渲染一条 | `drop`：通知是提示性的，宁缺不重 |
| **PII 审计外发**（`pii.reveal.audit`，`pii/reveal.ts:34`、`:170`） | 无 | `audit(effect_key)`；外发 payload 带 `timeline_seq` 供下游去重 | `retry`：审计宁可重复不可丢，重复由下游按 `timeline_seq` 收敛 |

硬条款：

1. **幂等键不得由消费者自己造**（不许用 `ts`、不许用局部 `requestId` 当全局键）；`effect_key` 只由写者在
   发布时附加到事件信封上。
2. 幂等表（`effects.ndjson`）**不是事实源**：删掉它 ⇒ 重放可能重复一次（已知降级），但**不得**导致
   "重放后时间线内容变化"。它只影响副作用，不影响 §7 等式。
3. 每个消费者必须在类型上声明 `on_unsure: 'retry' | 'drop' | 'report'`，缺省不允许编译通过
   （`EffectConsumer` 接口必填字段）。**禁止**默认 `retry`——投递类重试必须显式写出下游幂等键。

### 9. 拒绝项（写死，不留讨论空间）

| # | 拒绝的事 | 为什么（可指到今天的证据） |
| --- | --- | --- |
| R1 | **不引入第二条事实源**：不得保留 `data/events/<run_id>.jsonl` 作为并行真相，不得"timeline 读失败就回退读旧 trace" | findings §1d 实测"不存在单一磁盘超集"（session 日志缺 trace-only、trace 缺 chunk）⇒ 两条源必然长期不一致 |
| R2 | **不让任何读侧派生成为审计依据**：`derived_upto_seq` / 投影缓存 / 索引摘要 / 客户端内容 id 去重，都不得作为"覆盖到哪"的结论 | P7 就是这么来的（`run-journal.ts:204-209`） |
| R3 | **不把 chunk 一行一条**：chunk 只能块级（二进制帧 + manifest 区间） | 一行一条 ndjson 的编码开销会把 chunk 洪水变回"环被挤爆"的同一问题 |
| R4 | **不保留 `gap` 的混合语义**：协议上不得再有"可能是淘汰、可能是预算跳过"的区间 | `gateway.ts:1393-1403` |
| R5 | **不做旧会话迁移、不做双格式读写**（owner 裁定） | 迁移会让"同一会话两份历史"合法化 |
| R6 | **不允许"发布早于 WAL"**（包括为了流式延迟而旁路） | I2 的全部价值在这里；旁路一次，§7 等式永久失效 |
| R7 | **不允许新增第二套 seq**（"run 内序号""hub 序号"只能是被 `timeline_seq` 排序的**视图**） | §1 P1–P4 的根因就是多套编号 |

### 10. 前置条件与未解（不许写成已决）

| # | 事项 | 现状 | 卡在哪 / 谁定 |
| --- | --- | --- | --- |
| 1 | **跨会话顺序** | 会话内 seq 跨会话不可比；团队视图/成员历史今天只能按 `ts` 排（`disk-replay.ts:33-36`） | 决定：**团队视图排序键 = `(ts, session_id, timeline_seq)`**（复合、稳定，但**不**声称会话间全序）；真正的跨会话全序（节点级单调）属 0.55+，需要 platform 层决策，本文不预支 |
| 2 | **子 agent 事件的归属** | 子 agent 是独立会话（独立目录）；子 agent 事件进父会话还是自己会话，今天无逐条核对（`session-replay.md` §7 第 5 项 = 待核实） | 决定：**子 agent 事件只进子会话 timeline**，父会话只记 `agent.*` 生命周期事件（与今天 `agent.post`/`subscribe` 的边界一致）；"团队一条时间线"用第 1 项的复合排序在**读侧**拼，不给子会话另造 seq |
| 3 | **磁盘损坏检测手段** | 今天只有 `truncatePartialTail` + 读时 bad-line 容错（findings §2），**没有**主动校验 | 0.54 只做**被动声明**（crc32 + `holes`），不做定期 scrub；scrub 的调度、代价、告警阈值列为 0.55 事项（需实测 IO 预算） |
| 4 | **块大小 / flush 间隔的取值** | 32 KiB / 150 ms 是本文取值 | 需 A 阶段实测：chunk 发布延迟 P95、块数、fsync 次数、RSS。若影响体感，先调 `timeline.chunk_flush_ms`，**不**改 I2 |
| 5 | **`trace.prune` 的归宿** | 今天删 `data/events/<run_id>.jsonl`（`observability.ts` 的 `trace.prune`） | 0.54 起返回 `not_supported`（旧 trace 只读、不删）；timeline 归档段的回收需要**独立 ADR**——本文不授权任何 timeline 删除 |
| 6 | **ADR-104 读回通道** | ADR-104 §2.3f 的 `sessions.events` 读回，在 0.54 由 `timeline.read`（同 RPC 名 `sessions.events`，换源）承接 | 实现顺序：B 阶段切读时**同一 commit** 落地，否则 `archive_notice` 会在切读窗口里"指向不存在的路径" |

### 11. 影响面（实现轮施工图；本轮不动）

| 层 | 文件 | 动作 |
| --- | --- | --- |
| 写者 | `packages/core/src/session/timeline-writer.ts`（新，**唯一 seq 分配点 + 唯一 publish 点**）、`timeline-codec.ts`（新，块帧编解码）、`timeline-manifest.ts`（新） | D1 / §3 / §4 |
| 写者接线 | `packages/core/src/runtime/run-journal.ts`（`appendFact` / `appendObserved` / `enqueuePersistedEvent` 改走 `timelineWriter`；`NON_PERSISTED_EVENT_TYPES` 删除）、`session/session-event-log.ts`（写路径退役、只留只读）、`observability/trace-recorder.ts`（退役） | §3 I2、D5 |
| 服务/协议 | `packages/serve/src/event-buffer.ts`（降级为发送缓存）、`gateway.ts`（`planReplay` / `tailReplayWindow` / `gapFrame` / `helloFrame` / `broadcastEvent` 的归属补齐）、`gateway/frames.ts`（`timeline.hello`）、`replay-budget.ts`（退役） | §6 |
| 服务/方法 | `gateway/methods/sessions.ts`（`event_cursor` → `{timeline_head,wal_head,holes,tainted}`；`sessions.events` 换源）、`gateway/methods/observability.ts`（`events.list` 换源、`trace.prune` 下线） | §5、§10 第 5 项 |
| 读侧（Web） | `apps/web/src/state/event-store.ts`（单游标 + 四条校验）、`gateway/subscription.ts`（去掉 6 页回填）、`state/disk-replay.ts`（**删除**）、`gateway/replay-source.ts`（**删除**两阶段） | §6 |
| 投影 | `session/project-messages.ts`（`project(timeline, upto)`）、`SessionState.derived_upto_seq` → `projection_cache_seq` | D2 |
| 副作用 | `packages/serve/src/gateway.ts`（answer 投放）、`interactions-registry.ts`、`packages/core/src/pii/reveal.ts`、频道/通知装配 | §8 |
| 门禁 | 新增 `check-timeline-write-contract`（I1/I2/I3/I4：静态 + 行为）、`check-timeline-index`、`check-timeline-equality`（A1–A8）、`check-effects-idempotent`、`check-legacy-readonly`、`check-timeline-publish-after-wal` | §5、§7、§8 |
| 文档 | `docs/architecture/session-replay.md`（重写为单源口径；110 行上限，需同时删旧章）、`docs/architecture/event-log-policy.md`、本 ADR 状态 | 实现轮同步；本轮不动 |

### 11.1 实现漂移更正（2026-11-15 实测，路径/门禁以本节为准）

- **写者真实路径**是 `packages/core/src/timeline/writer.ts`（不是 `session/timeline-writer.ts`），同目录
  `blocks.ts`（块帧编解码 + `seal()` fsync）/ `holes.ts` / `wal.ts` / `types.ts`（`TIMELINE_LAYOUT` 等常量）/ `index.ts`；
  `timeline-codec.ts`、`timeline-manifest.ts` 没有单独存在，职责并入上述文件。
- **洞的落盘位置**：独立 append-only 文件 `holes.ndjson`（`timeline/types.ts:36`、`holes.ts:7-13`），
  **不是**写进 `timeline.manifest`（§6 的措辞按实现读，两个位置都有效）。
- **§5 / §7 点名的三个门禁尚未实现**：`check-timeline-equality`、`check-timeline-publish-after-wal`、
  `check-timeline-write-contract`。现有 timeline 门禁只有 reference / conformance / holes / index / dualwrite / archive / perf。
  A5 两条的**真实探针**落在 `scripts/check-timeline-holes.ts:85-89`（`published_head` 跨重启不下降）与
  `scripts/check-timeline-archive.ts:353-358`（重启后 `timeline_head` / `wal_head` 不回退）。
- **脚本名更正**：`scripts/check-timeline-dualwrite.ts`（不是 `check-timeline-dual-write.ts`）。
- **归档是「复制」不是「搬移」**：0.54 不删 WAL（§10 第 5 项明确「本文不授权任何 timeline 删除」），
  所以 `wal.log` **恒覆盖 `1..wal_head`**，`timeline.ndjson` **恒是前缀 `1..timeline_head`**。
  §4/§6 若读成"归档后从 WAL 移除"，以本行为准（`check-timeline-equality` A2 有对应断言）。
- **「未发布尾部」是等式里真实存在的一小段（2026-11-15 实测，`pub-i2`）**：在 `beforeSync('wal')` 里 `exit(9)` 时，
  那条**未 fsync 的帧可能以完整行留在页缓存并存活** ⇒ 重开后 `wal_head` 会跨过它、它也可读，
  但它**从未被发布**；而 `publishedHead` 在 open 时被设为 `wal_head`，所以之后也不会再发。
  ⇒ 「UI 见过的集合」= `timeline ∖ {该 seq}`。**`timeline.hello` 必须增报 `published_head`**，
  客户端据此把 `published_head < wal_head` 的那一小段当作「允许不被推送」的尾部，**不得据此报 gap**。
  §7 的等式与 `check-timeline-equality` 的 A1 读法需按这一条核对（A1 目前用"重连拉全量"，不受影响，但 A7 的 `count` 校验必须区分这段）。
- **两个协议字段也仍缺（不只是门禁缺）**：`timeline.hello` 的四字段（`count/start_seq/end_seq/timeline_head/wal_head`）
  与 `events.subscribe{after_timeline_seq}` 都未落地（`gateway/frames.ts:88-99`、`gateway.ts:1606-1622`），
  全仓 `.ts` 里 `timeline_gap_reported` **0 处**。⇒ `check-timeline-equality` 的 **A7** 与 **A8②** 会报 `NOT_IMPLEMENTED`，
  这是**协议没实现**，不是门禁写错。A7/A8② 落地属 C 阶段；届时把该门禁从默认模式切到 `--strict` 并进 gates。
- **I2 端到端尚未生效（最重要）**：写者内部确实是「fsync 之后才发布」，但装配层
  `src/timeline-dual-write.ts:369-373` **没有给 `TimelineWriter.open` 传 `publish`**，UI 仍由旧链路广播
  （`packages/core/src/runtime/run-journal.ts:131`、`:334`），而旧链路是「**先发布、后双写 timeline**」（`:335-347`）。
  ⇒ 「任何 `seq > wal_head` 的事件不得出现」今天只在写者内部成立，端到端要等 B 阶段切发布点。
  验收时把它当已生效的运行时事实，会验出**假红**。完整范围见
  [unacked-queue-closure.md](../architecture/unacked-queue-closure.md) §6「生效范围（契约 ≠ 现状）」。
- **`tainted` 改为派生值 + manifest 新增 `tainted_cleared` 行（2026-11-16，A 阶段后续单）**：
  旧读法把 `tainted` 定义成「**出现过任何** `kind:'tainted'` 行」，一次瞬时归档失败就永久钉死会话、
  重启也清不掉（而 `tainted` 是 `sessions.get.event_cursor` 里唯一的健康信号）。现在的口径：
  - `timeline.manifest` 新增 **additive** 行 `{v:1, kind:'tainted_cleared', reason, from_seq, to_seq, at}`
    （`packages/core/src/timeline/writer.ts#clearTaintAfterArchive`）；已有行一个字不改；
  - 会话级 `tainted` = 「`holes.ndjson` 非空」**或**「**物理写入顺序**上最后一条状态声明
    （`tainted` / `tainted_cleared`）的值」——**last-wins，严禁按 `at` 排序**（时钟回退会把顺序搞反，
    读侧从后往前扫，`writer.ts#lastTaintedState`）；
  - 清退时机 = `archiveNow()` **成功推进** `timeline_head` 之后，且**当前无存活洞**；连续多次失败后
    成功一次**只**追加一条 `tainted_cleared`；行里的 `from_seq/to_seq` 只作**审计**、不参与会话级判定
    （本版**不做**区间级 `tainted`）；历史 `tainted` 行全部保留；
  - 门禁：`scripts/check-timeline-tainted.ts`（①–⑧ + 时钟回退补充，共 6 个场景 76 条）。
- **迁移事实（写死，别当实现细节）**：存量会话没有 trailing `tainted_cleared` 行 ⇒ **升级后第一次
  健康归档之前仍是 `tainted = true`，不会自动洗白**。这是可接受的保守姿态（安全方向）。旧 reader
  对未知 `kind` 返回 `undefined` ⇒ 忽略新行并保守判 `true`，既不抛错也不截断文件；装配层
  `src/timeline-dual-write.ts#readHeadsOnDisk` 就是这种读者（磁盘口径仍是 true，进程内与重启后由
  写入侧 last-wins 收口）。
- **`holes` 的退役 / 修复生命周期仍不在本单**：洞只增不减 ⇒ 有过真丢失的会话 `tainted` **恒为 true**、
  永远不写 `tainted_cleared`（这是保守语义，不是漏洞；`check-timeline-holes` 的基线依赖它）。

### 12. 关联

- 判据与三边界（今天的形态）：[session-replay.md](../architecture/session-replay.md) §3
- 0.53 悬空项「un-acked 队列」的结案（0.54：空集，不是实现）：[unacked-queue-closure.md](../architecture/unacked-queue-closure.md)
- 真机实测与三源差集：[replay-gap-findings.md](../dev/handoff/replay-gap-findings.md) §0 / §1b / §1d
- 迁移计划（A/B/C、受影响 9 项、回退）：[plan-054-timeline-migration.md](../dev/handoff/plan-054-timeline-migration.md)
- 投射与读回依赖（不重写）：[ADR-104](ADR-104-context-projection-policy.md) §2.3f
- 落盘口径相关：[ADR-032](ADR-032-event-replay-file-event-store.md)、[ADR-046](ADR-046-file-first-storage.md)、
  [ADR-047](ADR-047-trace-first-observability.md)、[ADR-056](ADR-056-persistence-durability-and-corruption.md)
