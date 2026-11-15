---
title: 给外部实现方（Claude）的 A 阶段写入侧任务书 —— 会话 timeline 单一真相
kind: task-brief
triggers: [timeline, timeline_seq, WAL, 写入侧, A 阶段, 外部实现, Claude, 卡块, manifest, 索引重建]
paths: [docs/dev/handoff/task-claude-timeline-writer.md, docs/adr/ADR-105-session-timeline-single-source.md, docs/dev/handoff/plan-054-timeline-migration.md]
---

# A 阶段（只做写入侧）：会话 timeline 单一真相

> 规格以 `docs/adr/ADR-105-session-timeline-single-source.md` 为准；本文件只划**边界、交付物、自证要求**。
> 读协议（B 阶段）**不在本任务内**，由内部用门禁逐条推进。

## 一、你要实现的（且只实现这些）

新增一个**独立子树**，不改动任何既有读写路径：

```
packages/core/src/timeline/
  writer.ts        # 取号 + 追加 WAL 的唯一临界区；publish 唯一出口
  wal.ts           # ndjson 行写 + crc32；块文件写入
  blocks.ts        # chunk 块格式：帧头 (8B seq + 4B len)、块切换、manifest 条目
  holes.ts         # 洞登记区：append-only、crc32、跨重启可读
  index.ts         # session/run/type 三类索引，可重建
  types.ts         # 接口与存储布局常量
```

四条不变量（ADR-105 §3，违反即不合格）：

- **I1**：`timeline_seq` 在**写 WAL 那一刻**分配；取号与追加在同一临界区；不存在"先取号再决定写不写"。
- **I2**：`publish` 只能发生在 WAL `fsync` 之后；`seq > wal_head` 的事件不得出现在任何对外通道。
- **I3**：归档（主 timeline）失败只影响空间回收；`timeline_head` 不前进、`wal_head` 照常、标 `tainted`。
- **I4**：`timeline_head` / `wal_head` / `holes` / `tainted` **必须可对外上报**（字段形状见 ADR §6）；`published_head` 跨重启**不下降**。

补充两条本轮新增（ADR 已更新）：

- **失败必须落盘成可声明的洞**：append 失败 ⇒ 在洞登记区追加 `{from_seq, to_seq, reason, at}`，永久计入 `holes`；**只在内存或日志里记不合格**。
- **撕裂尾帧**（半写、从未发布）允许重分配 seq；已发布的绝不可。

## 二、明确不做（红线）

1. **不改** `run-journal.ts` / `trace-recorder.ts` / `event-buffer.ts` / `gateway.ts` / `sessions.ts` / `apps/web/**`——双写接线由内部做。
2. **不动**读协议：不新增/不修改任何对外 RPC 形状。
3. **不删**旧链路任何代码。
4. 不做历史会话迁移。
5. 不引入新外部依赖（只允许 node 内置 + 现有仓库依赖）。

## 三、必须交的三份自证（缺一不算交付）

1. **逐条相等采样工具** `scripts/check-timeline-conformance.ts`：对 N 个真实会话/run（本机 data 目录只读），把 timeline 归一化成 `(run_id, type, ts, payload)` 序列，与「会话日志 ∪ run trace」的同样归一化序列做**多重集相等**（允许声明为不可持久类的排除项，且该名单必须为空或逐条说明）。
   输出：`runs=… events=… missing=0 extra=0`。
2. **洞可声明**：模拟 WAL `fsync` 失败 → **重启** → `holes` 必含该区间、`tainted=true`；附脚本与真实输出。
3. **索引可重建**：删除索引目录 → 重建 → 同一查询结果逐条相等；附脚本与真实输出。

## 四、性能门槛（A 阶段判据 A-5，达不到就调参数，不许改 I2）

- chunk 发布延迟 **P95 ≤ `chunk_flush_ms + 50ms`**（默认 `chunk_flush_ms = 150`）；
- 单事件写放大 **≤ 旧链路 1.3×**（按 fsync 次数 / 事件计）；
- 常驻内存增量 **≤ 30 MB**（对照现有 5 万条环）。

## 五、存储布局（实现可微调，但必须写进提交说明）

```
<sessions>/<session_id>/timeline.ndjson     # 非 chunk 事件，一行一条，crc32 尾校验
<sessions>/<session_id>/wal.blocks/000007.wblk  # chunk 块（二进制帧，封块即 fsync）
<sessions>/<session_id>/timeline.idx/       # 索引（session/run/type），可重建
<sessions>/<session_id>/holes.ndjson        # 洞登记区，append-only
```

封块触发：① 块达 `BLOCK_MAX_BYTES`(32 KiB)；② **非 chunk 事件先封块再写该行**（保证严格交错）；③ 空闲 `chunk_flush_ms`；④ run 终态 / `flush()` / 进程退出。

## 六、交付方式

- 分支 `0.54-timeline-writer`，**只 commit 不 push**；
- commit message 写清：存储布局、常量取值、三份自证的真实输出摘要；
- 附带 `docs/dev/handoff/timeline-writer-report.md`：设计取舍、与 ADR 的差异（若有，逐条列）、未完成项；
- 内部会跑 `bun run typecheck` + 全量 gates 复核，然后由内部接线双写。

## 七、报送格式（内部 reviewer 会按这个核对）

1. `git log --oneline -1` + `git status --short`；
2. 三份自证脚本的真实 stdout（不是转述）；
3. 性能三数字；
4. 「与 ADR 的差异」清单（没有就写"无"）。

---

## 八、关于「逐条相等」怎么做（2026-11-16 实测修正，必读）

我们已把「尺子」实现好并接进门禁：`scripts/timeline-reference.ts` + `scripts/check-timeline-reference.ts`（34 项自检，`bun run check:timeline-reference`）。
**你必须调用它，不许自己实现比较逻辑**（否则就是拿自己的秤称自己的货）：

```ts
import { loadSessionReference, multisetDiff, refEventFromRaw, isTimelineOnlyType } from '../scripts/timeline-reference';
```

### 8.1 三处与你原本预期不同的事实（都有实测证据）

1. **跨源不能用「四段内容 id」**：trace 落盘前会过 `redact()` + `summarizeLlmRequestEvent()`，
   同一逻辑事件在两份旧源里 payload **本来就不同**（实测：`llm.request` 全部不等——trace 丢 `tools`/`messages`、多 `last_message`；`llm.response` 部分丢 `reasoning`）。
   ⇒ 旧源侧的身份是 **`(run_id, type, ts)` 三段 + 重数（multiplicity）**：逐键取 `max(会话日志条数, trace 条数)`，相等取会话日志侧。
   这不是放宽：同一毫秒同型的两条仍然都保留（不塌成 1），只是不再拿 payload 区分。
   **但你自己 timeline 的内部身份仍然是 `timeline_seq`**，与这条无关。
2. **「旧源没有、timeline 会有」的类型不是空集，恰好两条**：
   `llm.stream.chunk` 与 `*.llm.stream.chunk`（子 agent 形态）。实测本机 242 份 `events.ndjson` + 1217 个 trace 文件，chunk 事件数 **0**。
   你的 A-1 差集白名单必须**恰好等于**这两条（多一条或写成「包含」都不合格）。
   **不在此列**（必须两边同样排除）：`trace.*`、`replay.*`（recorder 自激防护行）、`trace.overflow`（记账行，非会话事实）、`session.deleted`（目录已删，两边都留不下）。
3. **`run_id` 是重载的**：会话级事件的 `run_id == session_id`（`session.created` / `agent.spawned` / `agent.message.queued` / `agent.retired` / `agent.closed`），对应 trace 文件是 `events/<session_id>.jsonl`（242 个会话里 236 个真有）。
   ⇒ **不能**把 `run_id == session_id` 当伪 run 剔掉，否则整个 `agent.*` 家族静默消失。

### 8.2 夹具选择（否则你会看到"新链路多写了几百条"的假差异）

必须选 **trace 齐全** 的会话：本机 `main` 会话 122 个 run 只有 12 个 trace 文件——拿它当夹具，`trace_only` 那 300–500 条会全部看起来像"timeline 多写了"。
用 `--sessions` 指定；报告里必须写明每个夹具的 `events=N runs=M` 与 trace 覆盖率。

### 8.3 你的 conformance 脚本判据

```
ref  = await loadSessionReference(sessionId, { dataDir })
mine = <你的 timeline 归一化成 RefEvent[]>
diff = multisetDiff(ref, mine)
extraFiltered  = diff.extra.filter(e => !isTimelineOnlyType(e.type))   // 只允许 chunk 类
合格 = diff.missing.length === 0 && extraFiltered.length === 0
```
并打印 `missing` / `extra`（含被 `isTimelineOnlyType` 剔掉的条数），以及夹具的 trace 覆盖率。

