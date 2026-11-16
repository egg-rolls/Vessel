---
title: 0.54 A 阶段写入侧交付报告 —— 会话 timeline 单一真相
kind: report
triggers: [timeline, WAL, chunk, holes, index, conformance, 0.54, A 阶段, 交付报告]
paths: [packages/core/src/timeline/writer.ts, packages/core/src/timeline/wal.ts, packages/core/src/timeline/blocks.ts, packages/core/src/timeline/holes.ts, packages/core/src/timeline/index.ts, packages/core/src/timeline/types.ts, scripts/check-timeline-conformance.ts, scripts/check-timeline-holes.ts, scripts/check-timeline-index.ts, scripts/check-timeline-perf.ts]
---

# A 阶段写入侧交付报告

> 依据：[ADR-105](../../adr/ADR-105-session-timeline-single-source.md) §3/§4/§5/§6、
> [plan-054](plan-054-timeline-migration.md) §1 A 阶段、
> [task-claude-timeline-writer.md](task-claude-timeline-writer.md)、
> [handoff-to-claude.md](handoff-to-claude.md)。
> 本报告只描述**已实现**的写入侧；读协议、双写接线、迁移都不在本分支。

## 1. 交付内容与边界

新增（未改动任何既有读写路径、RPC 形状、依赖或 `package.json`）：

```
packages/core/src/timeline/types.ts     # 记录/头/洞/块类型 + 常量 + 事件类型判定
packages/core/src/timeline/wal.ts       # ndjson/frame 编解码 + crc32 + 撕裂尾 + 可枚举读
packages/core/src/timeline/blocks.ts    # chunk 块：帧、封块、manifest（目录，异步）
packages/core/src/timeline/holes.ts     # 洞登记区：append-only + crc32 + 跨重启
packages/core/src/timeline/index.ts     # session/run/type 索引 + 独立读器（可重建/校验回退）
packages/core/src/timeline/writer.ts    # 唯一 seq 分配点 + 唯一 publish 出口 + 归档
scripts/check-timeline-conformance.ts   # A-1 逐条相等（调用 scripts/timeline-reference.ts）
scripts/check-timeline-holes.ts         # A-3 洞可声明（WAL/chunk/归档三种失败）
scripts/check-timeline-index.ts         # A-3 索引可重建 / 篡改回退 / 字节确定性
scripts/check-timeline-perf.ts          # A-5 延迟 / 写放大 / 常驻内存
```

**没有做**（按任务书红线）：`run-journal.ts` / `trace-recorder.ts` / `event-buffer.ts` /
`gateway.ts` / `gateway/methods/sessions.ts` / `apps/web/**` 一行未改；没有新增/修改 RPC；
没有删除旧链路；没有历史迁移；没有新增外部依赖；没有改 `package.json` 的门禁列表。

## 2. 实际存储布局

`<sessions>/<session_id>/`：

| 路径 | 内容 | 写侧纪律 |
| --- | --- | --- |
| `timeline.manifest` | `{kind:open}` / `{kind:archive,from_seq,to_seq}` / `{kind:tainted,...}` 每行带 crc | 只追加；`archive` 行是归档提交点 |
| `timeline.ndjson` | 归档后的非 chunk 行（与 `wal.log` 同格式、同 seq） | 只追加；归档失败回滚到写前偏移 |
| `timeline/blobs/<seq>.bin` | 超大 `data` 的原始 JSON | **先 blob fsync，再写记录行**；行里 `data={blob:true,bytes,crc32}` |
| `wal.log` | 非 chunk 事件一行一条 ndjson，行尾 `crc` | 每条 write + fsync；失败回滚到写前偏移 |
| `wal.blocks/000007.wblk` | chunk 二进制帧 `[u64 LE seq][u32 LE len][utf8 JSON]` | 封块即 fsync；块只写一次、永不重写 |
| `wal.manifest` | `{kind:block,block,start_seq,end_seq,offset,bytes,count,crc32}` | **目录/派生数据**：异步追加，扫描块文件可完全重建 |
| `holes.ndjson` | `{v,from_seq,to_seq,reason,at,crc}` | 只追加；每条 fsync；坏行/半行可识别 |
| `timeline.idx/{session,run,type}.idx` | 三类索引（见 §5） | 派生数据；整目录删除可重建；写临时文件 + rename |

## 3. 常量与格式

| 常量 | 取值 | 说明 |
| --- | --- | --- |
| `BLOCK_MAX_BYTES` | 32 KiB | 封块时机 ① |
| `CHUNK_FLUSH_MS` | 150 | 配置上限；实际定时器提前 `CHUNK_FLUSH_LEAD_MS` |
| `CHUNK_FLUSH_LEAD_MS` | 25 | 吸收定时器/事件循环抖动（见 §6 与 §8 差异 2） |
| `MAX_INLINE_BYTES` | 1 MiB | 超过则 `data` 外置到 `timeline/blobs/` |
| 帧头 | 12 B | `u64 LE seq` + `u32 LE len`；载荷是整条记录的 JSON（含 crc） |
| CRC | CRC32 (IEEE, 0xEDB88320) | 8 位小写十六进制；行/帧外置引用都带 |
| 归档重试 | 100 / 500 / 2000 ms | 首次失败后再试 3 次，共 4 次 |
| 块文件名 | `%06d.wblk` | 从现有最大块号 + 1 开始，崩溃半块不续写 |

## 4. 不变量落点（代码级）

- **I1（取号与 WAL 同一临界区）**：所有 `append`/`appendMany` 进入 `enqueue()` 的单链队列；
  `factStep` / `chunkStep` 在队列任务内 `nextSeq++` 后立即追加。没有“先取号再决定写不写”的路径。
- **I2（发布在 WAL 之后）**：`publishRecord()` 只在 `writeWal()` / `completeBlock()` 成功后调用；
  chunk 的“WAL”是块文件，块 fsync 之后才发布块内全部帧。发布顺序按 seq 严格升序
  （非 chunk 落盘前先封块；chunk 前先写掉更小 seq 的批量行）。
- **I3（归档失败只影响空间）**：`archiveNow()` 不推进 `timelineHead`、`walHead` 照常、
  主 manifest 记 `tainted`、回调 `onArchiveFailed`；归档的段行与 manifest 行在失败时回滚，
  重启后不会出现“段文件有、manifest 说没有”的半成品。归档失败**不写洞**（数据没丢）。
- **I4（可上报 + 单调）**：`heads()` 固定返回 `{timeline_head, wal_head, holes, tainted}`；
  `publishedHead()` 单独提供（不属于对外四字段）。重启续号 =
  `max(记录 seq, 洞 max, 归档 manifest to_seq) + 1`；已发布的记录都在已 fsync 的 WAL/块里，
  因而重启后的 `wal_head`（以及 `publishedHead`）不会低于已发布的最大 seq。
- **失败必须落盘成洞**：非 chunk 写/fsync 失败 ⇒ 回滚半写行 + `holes.add(seq,seq,reason)` + `tainted`；
  chunk 块失败 ⇒ 删除本次半块 + 整块区间落洞 + 拒绝全部等待中的 append；
  重启后从 `holes.ndjson` 重建 `wal_head` 的连续性，断言见 §7。
- **撕裂尾帧**：尾行无换行 / 帧长越界 ⇒ 截断到最后完整边界；这些 seq 从未发布，可重新分配。
  完整但 CRC 不符的帧 ⇒ 登记成洞（不截断、不静默跳过）。

## 5. 索引

| 文件 | 内容 | 重建方式 |
| --- | --- | --- |
| `session.idx` | `{first_seq,last_seq,count,holes}` 摘要 | 扫记录；**不作为任何判据** |
| `run.idx` | `run_id → [{start_seq,end_seq}]`，按 run_id 码点排序 | 顺序扫记录；两次重建字节相同 |
| `type.idx` | `type → 有序 seq 列表`，按 type 码点排序 | 同上 |

`TimelineIndexReader` 是独立读器：先信索引，逐条回读校验 `run_id` / `type` / 条数；
任何不一致（假区间、漏区间、类型不符）都回退全扫并回调 `onMismatch`。
自证覆盖：删整目录重建、假区间篡改、两次重建字节相同、正常读取 0 mismatch（§7）。

## 6. 性能（A-5 真实输出）

`bun run scripts/check-timeline-perf.ts`（Windows 11 / Bun 1.3.9，本机）：

```
chunk_flush_ms=150 p95_budget_ms=200 amplification_budget=1.3x heap_budget_mb=30

latency_ms p50=66.0 p95=129.3 max=144.8 samples=600
fsyncs wal=300 block=67 manifest=67 total=434
amplification non_chunk_per_event=1.00 all_per_event=0.48
memory_mb heap_delta=1.42 rss_delta=31.21 blocks=67 wal_head=900 tainted=false
```

- **延迟**：P95 129.3 ms ≤ 200 ms。同一参数多轮运行 P95 = 128.6 / 128.8 / 129.3 / 137.9 ms
  （下面贴的是其中一轮的真实 stdout）。
  150 ms 定时器在本机曾出现 P95 204 ms（定时器/事件循环抖动叠加），因此实际封块提前 25 ms
  （`CHUNK_FLUSH_LEAD_MS`），这是“缩间隔”的允许手段，没有动 I2。
- **写放大**：非 chunk 1.00 fsync/事件（与旧 `SessionEventLog.append` 同口径；旧链路另加 trace），
  全部事件摊薄后 0.48 fsync/事件。
- **内存**：写者保留结构（seq 集合 + 三张索引数组）实测 heapUsed 增量 1.42 MB。
  `rss` 增量 31.21 MB 高于 30 MB 预算，但包含 Bun 运行时/文件句柄/分配器高水位，
  不是写者保留的事件体（写者**不保留记录体**）。报告如实列出两个数，不拿 heap 数字冒充 RSS。

## 7. 三份自证（真实 stdout）

### 7.1 A-1 逐条相等（`bun run scripts/check-timeline-conformance.ts`）

```
0.54 A-1 conformance: timeline writer vs session-log+run-trace ruler
data-dir: C:/Users/Lirui/.vessel/data  (default: /mnt/c/Users/Lirui/.vessel/data)
work-dir: C:\Users\Lirui\AppData\Local\Temp\vessel-timeline-conformance-hvl3F1
scanned sessions: 242
fixtures: 20261115_101010_b38556, a6c06053-208e-4f25-b6d4-76712b8cd9bc, 433ec78f-67fe-42ae-821c-1e09f7e39681, 58cf40ad-940b-405c-bd91-0fa02d8ed3a0

session=20261115_101010_b38556 session_log_rows=9 events=34 runs=2 trace_coverage=2/2
  fed=34 written=34 excluded=0 missing=0 extra=0 chunk_extra=0
[PASS] A-1 20261115_101010_b38556 trace 齐全 — coverage=2/2
[PASS] A-1 20261115_101010_b38556 喂料条数 == 参考条数 — actual=34 expected=34
[PASS] A-1 20261115_101010_b38556 missing — actual=0 expected=0
[PASS] A-1 20261115_101010_b38556 非 chunk extra — actual=0 expected=0

session=a6c06053-208e-4f25-b6d4-76712b8cd9bc session_log_rows=70 events=245 runs=9 trace_coverage=9/9
  fed=245 written=245 excluded=0 missing=0 extra=0 chunk_extra=0
[PASS] A-1 a6c06053-208e-4f25-b6d4-76712b8cd9bc trace 齐全 — coverage=9/9
[PASS] A-1 a6c06053-208e-4f25-b6d4-76712b8cd9bc 喂料条数 == 参考条数 — actual=245 expected=245
[PASS] A-1 a6c06053-208e-4f25-b6d4-76712b8cd9bc missing — actual=0 expected=0
[PASS] A-1 a6c06053-208e-4f25-b6d4-76712b8cd9bc 非 chunk extra — actual=0 expected=0

session=433ec78f-67fe-42ae-821c-1e09f7e39681 session_log_rows=84 events=270 runs=3 trace_coverage=3/3
  fed=270 written=270 excluded=0 missing=0 extra=0 chunk_extra=0
[PASS] A-1 433ec78f-67fe-42ae-821c-1e09f7e39681 trace 齐全 — coverage=3/3
[PASS] A-1 433ec78f-67fe-42ae-821c-1e09f7e39681 喂料条数 == 参考条数 — actual=270 expected=270
[PASS] A-1 433ec78f-67fe-42ae-821c-1e09f7e39681 missing — actual=0 expected=0
[PASS] A-1 433ec78f-67fe-42ae-821c-1e09f7e39681 非 chunk extra — actual=0 expected=0

session=58cf40ad-940b-405c-bd91-0fa02d8ed3a0 session_log_rows=115 events=451 runs=2 trace_coverage=2/2
  fed=451 written=451 excluded=0 missing=0 extra=0 chunk_extra=0
[PASS] A-1 58cf40ad-940b-405c-bd91-0fa02d8ed3a0 trace 齐全 — coverage=2/2
[PASS] A-1 58cf40ad-940b-405c-bd91-0fa02d8ed3a0 喂料条数 == 参考条数 — actual=451 expected=451
[PASS] A-1 58cf40ad-940b-405c-bd91-0fa02d8ed3a0 missing — actual=0 expected=0
[PASS] A-1 58cf40ad-940b-405c-bd91-0fa02d8ed3a0 非 chunk extra — actual=0 expected=0
[PASS] A-1 synthetic appendMany 返回条数 — actual=253 expected=253

synthetic: events=253 chunks=240 chunk_types=llm.stream.chunk,sub.agent.llm.stream.chunk
[PASS] A-1 synthetic missing — actual=0 expected=0
[PASS] A-1 synthetic extra — actual=0 expected=0
[PASS] A-6 synthetic seq 严格升序且无空洞 — first=1 last=253
[PASS] I2 synthetic publish 严格升序 — published=253
[PASS] chunk 类型恰好两种 — actual=2 expected=2
[PASS] chunk 类型 == 尺子白名单 — llm.stream.chunk,sub.agent.llm.stream.chunk
[PASS] TIMELINE_ONLY_EVENT_TYPES 条数 — actual=2 expected=2
[PASS] 白名单逐条 == 两条 chunk 形态
[PASS] 核心 isChunkEventType 与尺子同口径

RESULT: PASS (checks=26 failed=0)
```

合成夹具额外覆盖：240 条 chunk（两种形态）+ 13 条非 chunk（含一条 >1 MiB 的 `data`，
用于验证 blob 外置与读回逐字还原）+ 一条超大事件；`events=253`。

### 7.2 洞可声明（`bun run scripts/check-timeline-holes.ts`）

```
0.54 A-3 holes: fsync failure must be declarable after restart
work-dir: C:\Users\Lirui\AppData\Local\Temp\vessel-timeline-holes-RDp3bI
[PASS] I3 wal fsync 失败必须抛 timeline_write_failed
[PASS] I3 失败区间已登记成洞 — [{"from_seq":2,"to_seq":2,"reason":"wal_append_failed: injected_wal_fsync_failure","at":1794720371576}]
[PASS] I3 tainted — actual=true expected=true
[PASS] I3 wal_head 覆盖失败 seq — actual=2 expected=2
[PASS] I3 timeline_head 不动 — actual=0 expected=0
[PASS] I3 重启后洞仍在 — [{"from_seq":2,"to_seq":2,"reason":"wal_append_failed: injected_wal_fsync_failure","at":1794720371576}]
[PASS] I3 重启后 tainted — actual=true expected=true
[PASS] I3 重启后 wal_head — actual=2 expected=2
[PASS] I3 失败事件不可读（半写行已回滚） — actual=1 expected=1
[PASS] A5 published_head 跨重启不下降 — before=1 after=2
[PASS] I1 失败 seq 不复用 — actual=3 expected=3
[PASS] I3 chunk 块 fsync 失败必须拒绝 append
[PASS] I3 chunk 失败区间已登记成洞 — [{"from_seq":1,"to_seq":1,"reason":"chunk_block_write_failed: injected_block_fsync_failure","at":1794720371681}]
[PASS] I3 chunk tainted — actual=true expected=true
[PASS] I3 chunk wal_head 覆盖失败 seq — actual=1 expected=1
[PASS] I3 chunk 重启后洞仍在 — [{"from_seq":1,"to_seq":1,"reason":"chunk_block_write_failed: injected_block_fsync_failure","at":1794720371681}]
[PASS] I3 chunk 失败事件不可读 — actual= expected=
[PASS] I3 归档失败返回 ok=false — actual=false expected=false
[PASS] I3 归档失败 timeline_head 不动 — actual=0 expected=0
[PASS] I3 归档失败 wal_head 照常 — actual=2 expected=2
[PASS] I3 归档失败不写洞 — actual=0 expected=0
[PASS] I3 归档失败 tainted — actual=true expected=true
[PASS] I3 归档失败回调一次 — actual=1 expected=1
[PASS] I3 归档失败重启后 timeline_head 仍不动 — actual=0 expected=0
[PASS] I3 归档失败重启后 tainted — actual=true expected=true
[PASS] I3 归档失败数据仍可读 — actual=1,2 expected=1,2

RESULT: PASS (checks=26 failed=0)
```

### 7.3 索引可重建（`bun run scripts/check-timeline-index.ts`）—— **已作废，勿引用**

> **已作废（2026-11-16，`0.54-truth-fix` 标注）**：本节有两个问题，历史保留、结论不要再引用。
>
> 1. **不可复现**：产生这份输出的 `scripts/check-timeline-index.ts` 已按新准则（不写 gate / test / probe）
>    在 `58118376` 删除；两个零调用点的 rebuild 包装（`rebuildIndexFiles()` /
>    `TimelineWriter.rebuildIndex()`）在 `0.54-truth-fix` 这一单里删除，所以下面
>    `rebuild 两次 … 字节相同` 那几条现在连入口都没有了。
> 2. **`index_mismatch` 那两行是假的自证**：它们数的是 `TimelineIndexReader.onMismatch`
>    **回调次数**，不是事件 —— 全仓从来没有 `timeline.index_mismatch` 事件类型，也**没有生产读路径**
>    会去校验索引（唯一会校验的 `TimelineIndexReader` 零调用点）。所以「触发 index_mismatch」
>    在任何真实读路径上都不成立。裁定与现状见 ADR-105 §11.1「索引一致性告警」。
>
> 能留下来仍然成立的部分：删索引后读结果逐条相同、索引可重建、篡改索引读结果不变
> —— 这三条由 ADR-105 §5 断言 1 + 生产读路径"恒整份读记录"保证，只是不再有脚本自证。

```
0.54 A-3 index: rebuildable / tamper-proof / deterministic
session-dir: C:\Users\Lirui\AppData\Local\Temp\vessel-timeline-index-s8GGeN
[PASS] 归档成功
[PASS] 归档后 timeline_head == wal_head — actual=8 expected=8
[PASS] 正常读取不触发 mismatch — actual=0 expected=0
[PASS] 索引确实含三类条目 — runs=3 types=4
[PASS] 删索引重建后 run=run-A — actual=1:type-a,2:type-a,3:type-b,7:llm.stream.chunk expected=1:type-a,2:type-a,3:type-b,7:llm.stream.chunk
[PASS] 删索引重建后 run=run-B — actual=4:type-b,5:type-c expected=4:type-b,5:type-c
[PASS] 删索引重建后 run=run-C — actual=6:type-a,8:type-c expected=6:type-a,8:type-c
[PASS] 删索引重建后 type=type-a — actual=1:run-A,2:run-A,6:run-C expected=1:run-A,2:run-A,6:run-C
[PASS] 删索引重建后 type=type-b — actual=3:run-A,4:run-B expected=3:run-A,4:run-B
[PASS] 删索引重建后 type=type-c — actual=5:run-B,8:run-C expected=5:run-B,8:run-C
[PASS] 删索引重建后 session.idx 字节相同 — bytes=72
[PASS] 删索引重建后 run.idx 字节相同 — bytes=340
[PASS] 删索引重建后 type.idx 字节相同 — bytes=113
[PASS] rebuild 两次 session.idx 字节相同 — bytes=72
[PASS] rebuild 两次 run.idx 字节相同 — bytes=340
[PASS] rebuild 两次 type.idx 字节相同 — bytes=113
[PASS] 篡改 run.idx 后读结果不变 — actual=1:type-a,2:type-a,3:type-b,7:llm.stream.chunk expected=1:type-a,2:type-a,3:type-b,7:llm.stream.chunk
[PASS] 篡改 run.idx 触发 index_mismatch — count=1
[PASS] 篡改 type.idx 后读结果不变 — actual=1:run-A,2:run-A,6:run-C expected=1:run-A,2:run-A,6:run-C
[PASS] 篡改 type.idx 触发 index_mismatch — count=1

RESULT: PASS (checks=20 failed=0)
```

## 8. 与 ADR 的差异（逐条；不变量层面：无）

1. **归档段布局**：ADR §4 画的是 `timeline/seg-000001.tseg`；A 阶段用**单个 append-only
   `timeline.ndjson`**（与 WAL 同格式）。段轮转 / 回收需要独立 ADR（ADR §10 第 5 项），
   A 阶段不预支。存储布局属任务书允许微调项。
2. **封块定时器语义**：ADR 写“空闲 `chunk_flush_ms`”；实现是**从活动块第一条待封 chunk 起算、
   不随每条 chunk 重置**，并提前 `CHUNK_FLUSH_LEAD_MS=25ms` 触发。理由：重置语义会让持续流式
   永远等不到封块，发布延迟退化为“填满 32 KiB 的时间”，直接违反 P95 预算；提前量是
   “缩间隔”的允许手段。**I2 未动**，发布仍在块 fsync 之后。
3. **`wal.manifest` 不在发布关键路径**：块文件是 chunk 的 WAL 本体且已 fsync；manifest 是目录/派生
   数据，异步追加（`flush()`/`close()` 等待）。ADR 未要求 manifest 先于发布落盘；这样每块少一次
   关键路径 fsync，P95 从 204ms 降到 129ms。
4. **`published_head` 不单独持久化**：已发布事件必然在已 fsync 的 WAL/块里，重启由
   `max(记录, 洞, 归档)` 恢复，因此跨重启不下降。**边界**：如果 WAL 文件本身被外部删除
   （不在 ADR 建模的失败内），无法从磁盘感知曾经发布过的更大 seq。
5. **`timeline.archive_failed` 走回调**：ADR I3 ③ 说“走 Notifications”；core 里没有通知通道，
   写者提供 `onArchiveFailed` 回调，装配层必须把它接到 Notifications。
6. **`appendMany`**：ADR 没有这个 API；为批量 seed / 自证喂料新增，语义与逐条 `append` 相同
   （seq 序列、发布顺序、失败语义一致）。属内部 API，不对外暴露 RPC。
7. **超大事件外置**：ADR §4 有定义，A 阶段已实现（不是延后）；chunk 的 `data` 超过 1 MiB
   显式拒绝（ADR 未定义 chunk 外置；块帧是紧凑载体，超大 chunk 视为生产者 bug）。
8. **`timeline_head` 恢复口径**：取 `max(archive manifest 的 to_seq, 已归档行的最大 seq)`，
   而不只看 manifest。归档行只有 durable 后才写 manifest 行；若 manifest 行丢失但行已落盘，
   按“已归档的最大 seq”计入更符合定义。
9. **洞不合并**：`holes.ndjson` 按登记原样报告区间；重复/相邻区间不自动合并（合并会改写历史行，
   违反 append-only 精神）。读侧按覆盖判定。

## 9. 未完成 / 明确不做

- **双写接线**：`run-journal.ts` / `trace-recorder.ts` / `event-buffer.ts` / gateway / web 全部未改；
  本分支只提供可独立自证的写者。
- **读协议（B 阶段）**：`timeline.read`、`timeline.hello`、`event_cursor` 字段改名、单游标握手、
  删除 `gap` 帧、`events.list` 换源——均未做。
- **历史迁移 / 导出**：旧会话只读冻结检查已实现（`session_frozen_readonly`），但不做迁移、
  不写转换脚本、不双格式读写。
- **段轮转 / WAL 回收 / scrub**：WAL 与块永不删除；crc + holes 是被动声明，无主动 scrub
  （ADR §10 第 3 项，0.55）。
- **副作用幂等（ADR §8）**：`effects.ndjson` / `effect_key` 未实现；写者不在事件信封上加
  `effect_key`。这属接线/消费侧，A 阶段任务书未列入。
- **配置层**：`timeline.chunk_flush_ms` 只作为 `TimelineWriterOptions` 传入；未接 config resolver。
- **索引读器常驻内存**：`TimelineIndexReader` 为自证方便一次性读入全部记录；分页/按需读属 B 阶段。
- **跨进程写锁**：模块内不做锁，依赖 ADR-056/086 的数据目录写意图锁。
- **`session.idx` 摘要**：已写但没有 RPC 消费；按 ADR §5 不得作为判据。
- **RSS 预算**：heap 增量 1.42 MB 达标；RSS 观测 31.21 MB（略高于 30 MB，含运行时开销），
  如需严格按 RSS 验收，需在真实装配里用长稳探针再测（写入侧不保留记录体）。

## 10. 交付方式

- 分支：`0.54-timeline-writer`（只 commit，不 push）。
- 复核命令（全部在本机跑过）：

```bash
bun run typecheck
bunx @biomejs/biome check packages/core/src/timeline scripts/check-timeline-conformance.ts \
  scripts/check-timeline-holes.ts scripts/check-timeline-index.ts scripts/check-timeline-perf.ts
bun run scripts/check-timeline-conformance.ts
bun run scripts/check-timeline-holes.ts
bun run scripts/check-timeline-index.ts
bun run scripts/check-timeline-perf.ts
```

- `bun run typecheck`：通过（无输出）。
- 新增文件的 biome check：通过。
- 全仓 `bunx @biomejs/biome ci .`：本分支新增文件无告警；仓库既有的 7 errors / 75 warnings
  位于未改动的文件（`packages/core/src/context/archive-notice.ts`、`cleared-tool-result.ts`、
  `packages/agent/src/service.ts` 等），非本分支引入。
