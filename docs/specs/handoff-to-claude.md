---
title: 交给外部实现方的白话 handoff —— 0.54 会话 timeline 写入侧
kind: handoff
triggers: [handoff, claude, timeline, 写入侧, WAL, 0.54, 交接]
paths: [docs/dev/handoff/handoff-to-claude.md, docs/adr/ADR-105-session-timeline-single-source.md, docs/dev/handoff/task-claude-timeline-writer.md, scripts/timeline-reference.ts]
---

# 白话 handoff：请帮我们做「写入侧」

## 一句话

我们要把「会话事实」从**三份互相对不齐的日志**收敛成**每个会话一条追加型 timeline**；请你只做**写入侧**（把事件可靠地写进去、并且写上就能证明写全了），读协议由我们自己接。

---

## 一、我们现在为什么会陷在这里

一个会话今天的事实散在三处：

1. **会话事件日志**（`sessions/<id>/events.ndjson`）：会话级事件，seq 在会话内单调；
2. **run trace**（`data/events/<run_id>.jsonl`）：每个 run 一份，**seq 每 run 从 1 开始**；
3. **进程内存环**：最近的实时事件，seq 是**进程全局自增、重启归零**。

三套 seq 互不映射，于是我们只能拿「内容」当身份去重（`run_id|type|ts|payload 摘要`）。而这个方案被现实反复打脸：

- trace 落盘前会脱敏与摘要，同一件事在两份日志里 **payload 本来就不同**；
- 流式 chunk **两处磁盘都不写**，重启即永久丢；
- 刷新页面时前端只能拿到「消息投影 + 易失的环」，用户看到「十几个事件掉成 4 个」——这个现象我们**修了五次**，每次都在补某一跳，直到最后才发现根因是**前端从来没读过磁盘**（已补上），但结构性问题还在。

结论：**不是再补一跳，而是换掉这套多源模型。** 0.53 已经把能收的都收了（收口清单在内部），0.54 专门做这次手术，**不做历史兼容**：老会话只读冻结，新会话只走新链路。

---

## 二、目标模型（你要实现的那一半）

**每个会话一条 append-only timeline**，所有事件（**包括 chunk**）先写 WAL，再进 timeline，**每会话一个持久单调的 `timeline_seq`**。它就是这个会话的**唯一事实与唯一时序**；索引只是查询加速。

四条不变量——**任何一条被破坏，这个方案就没意义了**（细节见 `docs/adr/ADR-105-session-timeline-single-source.md` §3）：

1. **`timeline_seq` 在「写 WAL 那一刻」分配**，取号与追加在同一个临界区；不存在"先取号、再决定写不写"。
2. **发布只能发生在 WAL 之后**：`seq > wal_head` 的事件不得出现在任何对外通道。
3. **归档失败不影响正确性**，只影响空间回收（`timeline_head` 不前进、`wal_head` 照常、标 `tainted`）。
4. **`timeline_head` / `wal_head` / `holes` / `tainted` 必须可对外上报**；`published_head` 跨重启**不下降**。

还有两条我们后来补的硬要求：

- **写失败必须落盘成「可声明的洞」**：不是打条日志算完，要在同一会话的洞登记区追加 `{from_seq,to_seq,reason,at}`，永久计入 `holes`；断言形态是「模拟 fsync 失败 → **重启** → `holes` 必须包含该区间、`tainted=true`」。
- **撕裂尾帧**（半写、从未发布过）允许重新分配 seq；**已发布的绝不可**。这就是 `published_head` 单调要守的东西。

> 为什么这么较真：我们最终要能对外说一句话——「**UI 看到的事件 = timeline 里 seq ≤ timeline_head 的全部 ∪ WAL 里 timeline_head < seq ≤ wal_head 的全部**」。这句话成立的前提，就是上面这些顺序纪律。

---

## 三、你的边界（这条最重要）

**只做写入侧**。具体是新增一个独立子树，全是新文件：

```
packages/core/src/timeline/{writer,wal,blocks,holes,index,types}.ts
```

**不要做**（我们会自己接）：

- 不要改 `run-journal.ts` / `trace-recorder.ts` / `event-buffer.ts` / `gateway.ts` / `gateway/methods/sessions.ts` / `apps/web/**`；
- 不要动任何对外 RPC 的形状（双写接线由我们做）；
- 不要删旧链路任何代码；
- 不要做历史会话迁移；
- 不要引入新依赖（node 内置 + 仓库现有依赖即可）。

理由很直接：**写入侧可以独立自证，读协议不能**。读协议一改，全站观感与正确性都在上面，必须由我们用门禁一条条推。

---

## 四、建议的实现顺序

1. **先写 WAL + 取号**（把 I1/I2 做对，其余都能后补）；
2. **chunk 块格式**：8B seq + 4B len 的帧，`BLOCK_MAX_BYTES = 32 KiB` 封块；封块时机四条——块满 / **非 chunk 事件先封块再写该行**（保证严格交错）/ 空闲 `chunk_flush_ms = 150` / run 终态与 `flush()`；
3. **洞登记区**（`holes.ndjson`，append-only + crc32，跨重启可读）；
4. **索引**：session / run / type 三类，**必须能重建**（删目录重建后查询逐条相等）；
5. **自证工具**（见下）；
6. 自测性能（见门槛）。

存储布局我们给的参考（可微调，但要写进提交说明）：

```
<sessions>/<sid>/timeline.ndjson      # 非 chunk 事件，一行一条，尾部 crc32
<sessions>/<sid>/wal.blocks/000007.wblk  # chunk 块（二进制帧，封块即 fsync）
<sessions>/<sid>/timeline.idx/        # 索引，可重建
<sessions>/<sid>/holes.ndjson         # 洞登记区
```

---

## 五、必须交的三份自证（缺一不算交付）

我们要的不是"跑通了"，是"能证明没漏"。所以：

1. **逐条相等**：对真实会话，把你的 timeline 归一化成事件多重集，与「会话事件日志 ∪ run trace」的归一化多重集比较，`missing = 0`、`extra = 0`（除了下面说的 chunk 例外）。
2. **洞可声明**：模拟 WAL fsync 失败 → 重启 → `holes` 必含该区间、`tainted = true`。
3. **索引可重建**：删索引目录 → 重建 → 同一查询结果逐条相等。

**尺子我们已经写好并接进门禁**，请直接调用，**不要自己实现比较逻辑**（否则就是拿你自己的秤称自己的货）：

```ts
import {
  loadSessionReference, multisetDiff, refEventFromRaw, isTimelineOnlyType,
} from '../scripts/timeline-reference';
```

合格判据：

```
ref  = await loadSessionReference(sessionId, { dataDir })
diff = multisetDiff(ref, mine)
合格 = diff.missing.length === 0
    && diff.extra.filter(e => !isTimelineOnlyType(e.type)).length === 0
```

### 用这把尺子时，有四件事已经被实测否掉了（别重走一遍）

1. **不要用「payload 摘要」做跨源身份**。trace 侧 payload 经过脱敏与摘要，`llm.request` 全部不等、`llm.response` 部分不等。旧源侧的身份是 **`(run_id, type, ts)` + 重数**（同毫秒同型两条都保留，不塌成 1）。你自己的 timeline 内部身份仍是 `timeline_seq`，与此无关。
2. **chunk 是唯一允许"新链路多出来"的类别**，且**恰好两条**：`llm.stream.chunk` 与 `*.llm.stream.chunk`。实测本机 242 份会话日志 + 1217 个 trace 文件里 chunk 事件数 = 0。你的白名单**必须恰好等于这两条**——多一条、或写成"包含"，都不合格。必须两边同样排除的还有：`trace.*`、`replay.*`、`trace.overflow`、`session.deleted`。
3. **`run_id` 是重载的**：会话级事件的 `run_id` 等于 `session_id`（`session.created`、`agent.spawned/queued/retired/closed`），对应 trace 文件是 `events/<session_id>.jsonl`。**不能**把 `run_id == session_id` 当伪 run 剔掉，否则整个 `agent.*` 家族会静默消失。
4. **选夹具要选 trace 齐全的会话**。本机 `main` 会话 122 个 run 只有 12 个 trace 文件——拿它当夹具，几百条 trace-only 会全部看起来像"你多写了"。报告里请写清每个夹具的 `events=N runs=M` 与 trace 覆盖率。

---

## 六、性能门槛（达不到就调参数，**不许改 I2**）

- chunk 发布延迟 **P95 ≤ `chunk_flush_ms` + 50ms**（默认 150ms，即 ≤200ms）；
- 单事件写放大 **≤ 旧链路 1.3 倍**（按 fsync 次数 / 事件计）；
- 常驻内存增量 **≤ 30 MB**（对照现有 5 万条环）。

如果为了性能想"先发布、后落盘"，请**不要做**——那正是这个方案要消灭的东西。要降延迟只能缩块、缩间隔。

---

## 七、交付方式

- 分支 `0.54-timeline-writer`，**只 commit 不 push**；
- commit message 写清：存储布局、常量取值、三份自证的真实输出摘要；
- 附 `docs/dev/handoff/timeline-writer-report.md`：设计取舍、**与 ADR 的差异（逐条列，没有就写"无"）**、未完成项；
- 回报格式：`git log -1` + `git status --short` + 三份自证的**真实 stdout**（不是转述）+ 性能三数字 + 差异清单。

---

## 八、如果你觉得 ADR 有问题

**照你说的做会更好、但违背不变量**的那种选择，请**不要**默默改：
写进「与 ADR 的差异」清单，说明你认为哪里该改、代价与收益。我们会裁决——因为不变量是"可证明不漏"的地基，动它必须有人签字。

反过来，**存储布局、常量取值、内部函数划分**这些你觉得更合理的，直接按你的判断做，只要在提交说明里写清。
