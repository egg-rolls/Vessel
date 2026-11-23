---
title: un-acked 队列结案（0.54：它是空集，不是待实现）
kind: current
triggers: [un-acked 队列, 未确认队列, unacked, 未确认落盘, 已发布未落盘, 不遗漏判据, 双指针, timeline_head, wal_head, published_head, 发布早于 WAL, 洞, holes, 对账, 结案, 0.53 四问]
paths: [packages/core/src/timeline/writer.ts, packages/core/src/timeline/blocks.ts, packages/core/src/timeline/holes.ts, packages/core/src/timeline/types.ts, packages/serve/src/gateway/methods/sessions.ts, src/timeline-dual-write.ts, packages/config/src/defaults.ts]
---

# un-acked 队列结案（0.54：空集）

> 一句话：`unacked` 不是被实现，而是被**消灭**。0.54 的写入契约（[ADR-105](../adr/ADR-105-session-timeline-single-source.md) §3 I2「发布只能发生在 WAL 之后」）让「已发布但未落盘」不可能有元素，0.53 等式右半边那个没人能枚举的集合于是变成 `∅` ⇒ 不需要队列。将来任何「再加一层未确认队列」的提案，必须先反驳 §2。

## 1. 等式与两个指针

0.53 的验收等式（[session-replay.md](session-replay.md) §3，本仓当前形态）：

`UI.seq集 == disk(seq ≤ watermark).seq集 ∪ unacked.seq集`

0.54 退化为（形态见 ADR-105 §7）：

`UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)`

右半边两段**都在磁盘上、都可枚举**。指针定义（ADR-105 §3 定义段）与实现落点：

| 指针 | 语义 | 实现 |
| --- | --- | --- |
| `wal_head` | `[1..wal_head]` 每个 seq 要么可读、要么已被 `holes` 声明 | 恢复期 `contiguousHead(indexBuilder.seqs(), holes.list())`（`packages/core/src/timeline/writer.ts:444`）；写入期 `advanceWalHead`（`writer.ts:821-828`） |
| `timeline_head` | 已归档进 `timeline.ndjson` 的最大 seq | 唯一推进点 `archiveNow`（`writer.ts:873-916`）：右端 `to = walHead`（`:876`），成功才 `timelineHead = to`（`:915`） |
| `published_head` | 已对外发布过的最大 seq，**内部字段、不参与握手** | 字段 `writer.ts:229`，读数 `:343-345`，只增（`Math.max`，`:751`、`:767`） |

`timeline_head ≤ wal_head` 是不变式、不是巧合：恢复期取 `Math.min(maxArchived, walHead)`（`writer.ts:447`），归档期的右端就是当时的 `walHead`（`:876`）⇒ 归档只可能「落后」，不可能「超前」；归档失败时 `timelineHead` 冻结、`walHead` 照常（ADR-105 §3 I3）。读侧按同一口径校验（`packages/serve/src/gateway/methods/sessions.ts:822-832`）。

## 2. 为什么 `unacked` 是空集

| I2 的分条 | 落点 | 违反它等于什么 |
| --- | --- | --- |
| 单一分配点 | `nextSeq` 是 writer 私有字段（`writer.ts:226`），只在串行队列（`:373-374`）内自增：`factStep` `:575-576`、`chunkStep` `:601-602`、批量 `:678-679` | 出现第二个分配点 ⇒ 两套编号、seq 不可对账（ADR-105 §1 P1–P4 的原病） |
| 唯一发布点 | `publishRecord`（`writer.ts:830-839`）只有两个调用者：`acceptRecord`（`:748-754`，非 chunk）、`completeBlock`（`:757-772`，块内 chunk） | 绕过它发布 ⇒ 该 seq 没有 WAL 回执 ⇒ `UI` 集合无界 |
| fsync 之后才发布 | 非 chunk：`writeWal` 的 `await this.walHandle.sync()`（`writer.ts:721-745`，`:727`）返回后才 `acceptRecord`（`:590-596`）；chunk：`blocks.seal()` 的 `handle.sync()`（`packages/core/src/timeline/blocks.ts:182`）+ `fsyncDirectory`（`blocks.ts:189`）成功后才 `completeBlock` | 半写行被发布 ⇒ 「已发布、读不回」= 凭空多出一个 unacked 元素 |

**违反 I2 = 写者 invariant 破了，不是 UI 的问题，也不是「需要一层队列兜住」。** 这是 ADR-105 §9 R6 把它写成拒绝项的原因：旁路一次，本文等式永久失效。

## 3. 结案 0.53 的四问

| 问题 | 答案 | 理由（可指） |
| --- | --- | --- |
| 队列里存什么 | **不需要存** | WAL 自带身份：非 chunk 一行一条 `{v,seq,session_id,run_id,ts,type,data}`（ADR-105 §4），chunk 是块内二进制帧（`blocks.ts`）。`seq` 在入 WAL 那一刻分配（ADR-105 §3 I1） |
| 谁持有 | **不需要第二个持有者** | 持有者是会话目录：`wal.log` / `wal.blocks` / `wal.manifest` / `timeline.ndjson` / `holes.ndjson`（`packages/core/src/timeline/types.ts:22-42` 的 `TIMELINE_LAYOUT`）。进程内存只留四个数字（`writer.ts:226-229`） |
| 重启怎么恢复 | **不需要恢复队列** | `open()` 扫段 + 块 + WAL + holes 重建（`writer.ts:384-456`）：`nextSeq = max(knownMax, holes.maxSeq()) + 1`（`:443`）、`walHead = contiguousHead(...)`（`:444`）、`published = walHead`（`:445`）、`timelineHead = min(maxArchived, walHead)`（`:447`）；恢复出的空洞补声明（`:437-440`） |
| 客户端该不该读 | **不该读，也读不到** | 握手只报 `{start_seq, end_seq, count, timeline_head, wal_head}`（ADR-105 §6 的**契约形态**；今天的 `hello` 还只有 `{from_seq, latest_seq}` —— 见 §6 生效范围），客户端只持一个游标 `client_timeline_seq` |

客户端那条要写死：集合对不上**只有两种解释** —— ① 写者**声明**的 `holes`（坏行 / 坏帧 / 缺失块，登记后永久保留、不自动修；登记路径 `writer.ts:842-869`，append-only 文件 `packages/core/src/timeline/holes.ts:7-13`、落盘名 `holes.ndjson`（`types.ts:36`））；② 客户端自己算错。**没有第三种「还没 ack」。**

## 4. 已知边界（契约，不是缺陷）

- chunk 的**未持久化段只在内存里（活动块缓冲，未进任何磁盘），进程重启即失**：活动块在 `ChunkBlockStore` 的内存 pending 里（`writer.ts:617`），直到封块（`writer.ts:774-785` → `blocks.ts:150-197`）才 fsync。
- `chunk_flush_ms` 默认 **150**（`packages/config/src/defaults.ts:217`；写入侧常量 `types.ts` 的 `CHUNK_FLUSH_MS` / `CHUNK_FLUSH_MS_MAX`（上限 1000），定时器提前 `CHUNK_FLUSH_LEAD_MS` = 25 ms 触发，`writer.ts` 的 `scheduleIdleFlush`）⇒ 最坏约 150 ms 的窗口里，那段正文只在内存。
- 但那段**还没有 seq、还没有发布**：`chunkStep` 分配 seq 后先进块，块 fsync 后 `completeBlock` 才发布（`writer.ts:600-624`、`:757-772`）。所以它**不在等式里**，也**不构成「UI 丢了一条」**。
- 因此写清：**这不是「un-acked 队列」，这是「还没进入事实源」。** 反过来，凡已发布的 chunk 一定已在磁盘 —— 这就是「延迟上界 = 150 ms」而不是「已发布可丢」的原因。

## 5. 机器断言（A5 两条当年的探针；脚本已按宪法删除）

> 2026-11-16 起 `scripts/check-*.ts` 全部删除，下表只是**历史存档**：说明这几条不变量当年被
> 哪些断言钉住过。现在它们**没有自动断言**，改到 timeline 写入 / 归档路径时人工核对。

| 断言 | 当年位置 | 断言名 |
| --- | --- | --- |
| `published_head` 跨重启不下降 | `check-timeline-holes` | `A5 published_head 跨重启不下降` |
| 重启后 `timeline_head` / `wal_head` 不回退（纯磁盘口径） | `check-timeline-archive` | `② 重启后（无 writer，纯磁盘口径）timeline_head 不回退`、`② 重启后 wal_head 也不回退` |
| 归档不移动发布游标 | `check-timeline-archive` | `① published_head 不变（归档不改发布游标）` |
| 发布严格升序 + seq 无空洞（合成夹具） | `check-timeline-conformance` | `I2 synthetic publish 严格升序`、`A-6 synthetic seq 严格升序且无空洞` |
| 写失败落成可声明的洞、重启仍在 | `check-timeline-holes` | `I3 失败区间已登记成洞`、`I3 重启后洞仍在` |

这些脚本当年都在 `gates` 链里（`check:timeline-conformance` / `-holes` / `-index` / `-dualwrite` / `-archive`）；
`gates` 条目本身也随宪法删除了。

**从未实现的断言**（ADR-105 §7 / §11 点名）：`check-timeline-equality`（A1–A8 等式套餐）、
`check-timeline-publish-after-wal`、`check-timeline-write-contract`。

## 6. 生效范围（2026-11-16 更新：B 阶段已完成，本文等式已是运行时事实）

| 契约 | 今天的实际 |
| --- | --- |
| UI 帧的 seq 一定 ≤ `wal_head` | **端到端已接线**：装配层 `TimelineWriter.open` 传了 `publish`（`src/timeline-dual-write.ts:919-929`），旧链路广播**降级为发送缓冲**（fsync 之后才放行）；「未发布尾部」由 `published_head` 显式表达 |
| 握手报 `{start_seq,end_seq,count,timeline_head,wal_head,published_head}` | **已落地**（`packages/serve/src/protocol.ts:145-181`）：`end_seq=wal_head` 是**可读性**事实，`min(end_seq, published_head)` 是**推送**事实，两者绝不合并 |
| `sessions.get.event_cursor` 四字段 | **已落地** `{timeline_head, wal_head, holes, tainted}` + `published_head`（`packages/serve/src/gateway/methods/sessions.ts`） |
| timeline 双写开 | **默认开**（`packages/config/src/defaults.ts:216` `dualWrite: true`，理由见 `:202` 注释）——只有显式写 `dual_write: false` 的安装才退回旧链路；整条链（写者 → 操作 → 单游标读 → 按段续拉）已可用 |
| 前端读路径 | **只剩一条**：单游标 `client_timeline_seq` + 单区间回填 + **按段续拉** + 四条校验 + 污点条（`apps/web/src/gateway/timeline-protocol.ts`、`state/event-store.ts`）；`disk-replay.ts` / `replay-source.ts` **已删除** |

**一句话**：本文等式（`UI == timeline(≤timeline_head) ∪ WAL(≤wal_head)`，其中只有 `published_head` 以内的会被推送）
对 timeline 链路已**端到端成立**。仍成立的前提是「写者内部 fsync 之后才 publish」这条不变量——
它**没有自动断言兜底**（`check-timeline-publish-after-wal` 从未实现，脚本已按宪法删除）：
改到 timeline 写入 / 发布路径时按 §5 的人工核对口径逐条核对。

## 7. 一句话结论

`unacked` 不是被实现，而是被**消灭**：WAL 本身就是那个队列（磁盘、带 seq、重启可恢复、两端指针能对账），再在内存里造一个影子队列 = 同一链路上第二份会过期的副本。将来任何「再加一层未确认队列」的提案，先反驳 §2 —— 要么引入第二个发布点、要么引入第二个 seq 分配点，两者已被 ADR-105 §9 R6 / R7 拒绝。

## 8. 相关

- 判据与三边界（0.53 形态）：[session-replay.md](session-replay.md) §3
- 决策与不变量：[ADR-105](../adr/ADR-105-session-timeline-single-source.md) §3（I1–I4）、§6（握手）、§7（A1–A8）
- 阶段与回退：迁移分 A/B/C 三阶段、可回退；施工单随实现轮维护，不进本仓
