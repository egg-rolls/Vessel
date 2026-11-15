# 0.54 存量体检：真实会话里「工具结果正文已是 `[cleared …]` 占位」的规模、可救性、与撤回的相关性

- 分支：`0.54-stock-audit`（基线 `39e80a1d`）
- 装置：`scripts/probe-stock-audit.ts`（新增，只读探针；不属于 gates、不接 `package.json`）
- 被审对象：**真实数据目录** `C:/Users/Lirui/.vessel/data/sessions/`（255 个会话目录 / 476 MB）
- 观察时间：2026-11-15T12:45Z 那一趟（连跑三趟，占位相关四个数字全等；活会话的
  `messages_total` 一类计数在漂，见 §6.4）
- 只读：探针只调 `FileSessionStore.load()` / `SessionEventLog.read()` / `readIndex()` /
  `readdir` / `stat` / `open(…,'r')`；**不调 `FileSessionStore.list()`**（它内部 `ensureDir()`
  会 mkdir），不 append、不 `updateIndex`、不 touch。§6.3 有 A/B 快照实证。

## 0. 一句话结论

| 问题 | 数字 |
| --- | --- |
| 存量规模 | 255 个会话 / 45 058 条工具消息里，**971 条**正文是占位，集中在 **2 个会话**（其余 253 个会话 0 条） |
| 规格口径可救（有清集 ∧ 有全文） | **0 条** / **0 字节** |
| 按 `tool_call_id` 关联日志的真实可救上限 | **970 条** / **693 641 字节**（≈677 KiB） |
| 无清集但日志有全文 | **970 条**（另外 1 条两者都没有；清集对全部 971 条都缺失，见 §1） |
| 与撤回的相关性 | `placeholder > 0` 的 2 个会话里 **0 个** `rewound > 0`；全库 **0 条** `session.rewound` 事件 |
| 修复脚本值不值得写 | **按规格口径不用写**（可救 0 条）；**按 id 关联口径值得写、很便宜**（970 条 / 693 KB 一次性回收），但它救的是 2 个 11 月 11 日就已停更的历史会话，不是活数据 |

## 1. 四象限（有清集 × 有全文）

清集 = 日志里 `message.compaction.data.cleared_tool_call_ids`（规格口径）；全文 = 该
`tool_call_id` 的 `tool.call.completed.data.result`。

|                    | 有全文                | 无全文                 |
| ------------------ | --------------------- | ---------------------- |
| **有清集**         | **0**（`rescuable`）  | **0**（`unrescuable_no_original` 的一部分） |
| **无清集**         | **970**（`unrescuable_no_clearset` 的一部分） | **1**（`both_missing`） |

- 四格相加 = 971 = 占位总数（`placeholder_without_id` = 0，每条占位都带着 `tool_call_id`）。
- 规格给的两个字段是**单边谓词**：`unrescuable_no_clearset` = 971、`unrescuable_no_original` = 1，
  两者在「两者都没有」那 1 条上重叠，所以两个数加起来是 972 而不是 971；探针另给
  `both_missing` 让四格闭合。
- 加宽口径（`context.cleared_tool_result.tool_call_ids` 也算清集）仍然是 **0**：受污染的两个
  会话里一条 trim 审计事件都没有。

**结论段：** 占位在这份存量里是**极少数派**（971 / 45 058 = 2.2% 的工具消息，2 / 255 = 0.8%
的会话），而且这两个会话的壳文件最后写盘时间都是 **11 月 11 日**——都在
`5f142c97`（`refactor(core): 旧工具结果的占位替换搬到请求构建层，落盘历史一个字不改`,
2026-11-13 12:23:52 +0800）**之前**。按壳文件 mtime 切一刀：该提交之前落盘的 163 个壳里
971 条占位，之后的 **92 个壳里 0 条**。同一份存量里还有 10 个会话在壳里冻结了
**1960 个** `cleared_tool_call_ids`（最大一个 490 条），它们的 `messages` 里**一条占位都没有**
——「段起点冻结集合 + 请求层替换」这条 0.52 之后的路子，在真实数据上确实没有把占位写进落盘。

## 2. Top 10「占位最多」的会话

只有 2 个会话有占位，Top 10 只填得出两行（其余 253 个会话为 0）：

| # | 会话（前 8 位） | 占位条数 | 工具消息总数 | 占位占比 | 可救（有全文） | 可救字节 | `compactions` | `rewound` |
| - | --------------- | -------- | ------------ | -------- | -------------- | -------- | ------------- | --------- |
| 1 | `main`          | 521      | 598          | 87.1%    | 520            | 347 589  | 1             | 0         |
| 2 | `43b62270`      | 450      | 502          | 89.6%    | 450            | 346 052  | 1             | 0         |

两个会话的形态一致：占位集中在**头部**，尾部保留最后一段原文（`main`：占位占 index 3–1274，
第一条原文在 1276；`43b62270`：占位 3–963，第一条原文在 965）——就是「保留最近 N 条原文、
更早的换占位」的形状。两条会话各自有 **1 条** `message.compaction` 事件，`kept` 分别是
1302 / 986，且**都没有** `cleared_tool_call_ids` 字段。

## 3. 相关性：撤回是不是「最常见的满投影入口」？

- `placeholder_tool_messages > 0` 的会话 = **2**；其中 `rewound > 0` = **0**（0%）。
- 全库 255 个会话、19.7 万条事件里 `session.rewound` = **0 条**；`message.compaction` = **3 条**
  （`main` / `43b62270` / `16d265ec` 各 1 条，**全部**没有 `cleared_tool_call_ids`）。

⇒ 在这份存量上**「撤回」连一次都没发生过**，谈不上「最常见入口」：这个假设既没被证实、
也没被否证——**样本量为 0**。真正在这两个受损会话里发生的是**旧的压缩就地改写**
（`5f142c97` 的提交信息原文：「原先在压缩时就地改正文，于是已经落盘、压缩后还活着的旧工具
结果被换成占位」，并带了实测 C1h：8 条已落盘且幸存的结果正文被改写）。落盘证据与之一致：

- 971 条占位的 `tool_call_id` 一个都不在任何清集里（Q1 = 0）；
- 两个受损会话**各只有 1 条** `message.compaction`，且都不带 id 集合；
- 两个壳都是旧格式（带 `started_at` / `run_id` / `completed_at`，无 `context_projection`），
  最后写盘 2026-11-11，早于修复提交 2 天。

## 4. 「修复脚本」值不值得写

- **按任务给的规格口径（清集 ∧ 全文）：不用写。** 可救 0 条、可回收 0 字节，写出来只会
  在 971 条上全部落到 `unrescuable_no_clearset` 分支。
- **按 `tool_call_id` 关联（不看清集）：值得写、成本极低**——占位消息**保留着 `tool_call_id`**
  （971/971），日志里 970 条能直接取回原文，合计 693 641 字节，逻辑就是一次
  `Map<tool_call_id, result>` 关联 + 一次 `save()`，不需要猜、不需要重新跑工具。
  但它**不紧急**：受害的是 2 个 11 月 11 日之后就没再跑过的历史会话；活数据（92 个在修复后
  落盘的壳 + 10 个冻结了清集的会话）**一条都没有受损**。
- 因此建议：**先不做脚本**，除非用户明确要回看这两个历史会话的原文；若要做，按 §4 第二段
  的 id 关联口径做，别按清集口径做（清集在这批数据上是空集）。

## 5. 边界与异常（不许静默丢弃的部分）

跳过/读不了的会话：**0 个**（`status` 分布 = `ok=255`；无 `shell_corrupt`、无
`shell_missing`、无 `shell_no_messages`）。逐类异常计数：

| 异常类 | 条数 | 说明 |
| --- | --- | --- |
| `partial_tail`（日志末行无换行） | 0 | 255 个 `events.ndjson` 全部以换行结尾 |
| `seq_gaps`（`max_seq − 实测条数`） | 0 | 没有中间丢行 / 坏行 |
| `index_missing` | 0 | 255 个会话都有 `index.json` |
| `index_count_mismatch` | **7** | 全是**正在被别的进程追加**的活会话：`index.event_count` 落后实测（`26b70d4b` / `90b62303` / `f40e16df` 停在 `5`，`276a0d3c` 383 vs 539、`24f7d2b5` 346 vs 357、`d813eaea` 1134 vs 1183、`16d265ec` 2482 vs 2483）。不影响本审计口径（探针不靠 index 判定），但说明 **index 是缓存、不能当计数源** |
| `started_only`（占位 id 只有 `tool.call.started`） | **1** | `main` 的 `call_00_29xu7bqs05ku2w18g92vv5pq`：日志里只有 started，没有 completed / failed（`derived_upto_seq` 已越过该点）⇒ 日志缺了这条正文，不是探针漏读 |
| `failed_only`（只有 `tool.call.failed`） | 0 | 规格只认 `tool.call.completed`；这条分支存在但是空的 |
| `no_trace`（连 started 都没有） | 0 | — |
| `placeholder_without_id` | 0 | 占位消息全部带 `tool_call_id` |

**数据目录是活的**（这是本次最需要说清的边界）：

- 探针跑的时候目录里有 **255** 个会话；开工第一次 `ls` 是 **254** 个 —— 观察期间多了一个
  （别的进程正在建会话）。
- 静置 25 秒（**探针一次都没跑**）：`26b70d4b` / `276a0d3c` / `90b62303` 的 `events.ndjson`
  各长了 30.7 KB / 18.7 KB / 17.1 KB ⇒ 有活进程在追加，不是探针写的。
- 每次探针跑完都做 A/B 快照（`size + mtime_ns`，510 个文件）：**壳文件（`*.json`）0 变动**，
  只有 5 个活会话的 `events.ndjson` 在长。审计口径只读壳文件 + 事件里的清集/全文，
  所以「971」这个数是稳的（两次跑输出逐字节相同），漂移的只有 `events_total` 一类计数。

## 6. 真跑过的命令与输出

### 6.1 环境

```
$ cd /mnt/d/Application/APP/Vessel/worktrees/stock-audit && pwd && git status --short --branch && git log --oneline -1
/mnt/d/Application/APP/Vessel/worktrees/stock-audit
## 0.54-stock-audit
39e80a1d docs(spec): §4.2.1 读回的三种语义（inline_truncated 尾巴 / readback 原文 / gone），badge 不改词表，§3.5 批量卡本轮不做
```

worktree 原来没有 `node_modules`，按纪律先装：`cd apps/web && bun install`（root 也跑了一次
`bun install`），`bun run typecheck` 通过（`tsc --noEmit && tsc -p examples --noEmit`）。

> 一个坑：这台机器上 **bash 是 WSL、bun 是 Windows 版**（`Bun v1.3.9 (Windows x64 baseline)`）。
> 探针第一次按 WSL 路径跑，直接 `ENOENT`：
>
> ```
> $ bun scripts/probe-stock-audit.ts --sessions /mnt/c/Users/Lirui/.vessel/data/sessions
> ENOENT: no such file or directory, scandir '/mnt/c/Users/Lirui/.vessel/data/sessions'
> ```
>
> 必须传 Windows 路径 `C:/Users/Lirui/.vessel/data/sessions`。

### 6.2 探针（每会话一行 JSON 到 stdout，聚合到 stderr）

```
$ bun scripts/probe-stock-audit.ts --sessions C:/Users/Lirui/.vessel/data/sessions > /tmp/stock-audit.jsonl 2> /tmp/stock-audit.agg.txt
#aggregate
会话目录 = 255
status 分布 = ok=255
messages_total = 89686
tool_messages = 45058
placeholder_tool_messages = 971
占位 > 0 的会话 = 2
  其中 rewound > 0 = 0
  其中 compactions > 0 = 2
四象限 Q1 有清集+有全文（rescuable） = 0
四象限 Q2 无清集+有全文 = 970
四象限 Q3 有清集+无全文 = 0
四象限 Q4 两者都无 = 1
rescuable_wide（清集加宽口径）= 0
salvageable（只按 tool_call_id）= 970
recoverable_bytes = 0
salvageable_bytes = 693641
rewound 事件总数 = 0
message.compaction 总数 = 3
壳里冻结的 cleared_tool_call_ids 总数 = 1960
有冻结集合的会话 = 10
异常：partial_tail = 0
异常：seq_gaps = 0
异常：index_missing = 0
异常：index_count_mismatch = 7
异常：started_only = 1
异常：failed_only = 0
异常：no_trace = 0
异常：placeholder_without_id = 0
#top10
  main 521 / 598
  43b62270-c285-43b3-8e91-e214d3a1bdc7 450 / 502
```

两个受损会话的完整行（stdout 原样，`/tmp/stock-audit.jsonl` 里 grep 出来的）：

```
{"session":"main","status":"ok","messages_total":1485,"tool_messages":598,"placeholder_without_id":0,"placeholder_tool_messages":521,"rescuable":0,"unrescuable_no_clearset":521,"unrescuable_no_original":1,"both_missing":1,"rescuable_wide":0,"salvageable":520,"rewound":0,"compactions":1,"recoverable_bytes":0,"salvageable_bytes":347589,"clearset_ids_compaction":0,"clearset_ids_trim_events":0,"shell_frozen_clearset_ids":0,"events_total":3774,"max_seq":3774,"derived_upto_seq":3773,"anomalies":{"partial_tail":0,"seq_gaps":0,"index_missing":0,"index_count_mismatch":0,"started_only":1,"failed_only":0,"no_trace":0}}
{"session":"43b62270-c285-43b3-8e91-e214d3a1bdc7","status":"ok","messages_total":1082,"tool_messages":502,"placeholder_without_id":0,"placeholder_tool_messages":450,"rescuable":0,"unrescuable_no_clearset":450,"unrescuable_no_original":0,"both_missing":0,"rescuable_wide":0,"salvageable":450,"rewound":0,"compactions":1,"recoverable_bytes":0,"salvageable_bytes":346052,"clearset_ids_compaction":0,"clearset_ids_trim_events":0,"shell_frozen_clearset_ids":0,"events_total":3276,"max_seq":3276,"derived_upto_seq":3276,"anomalies":{"partial_tail":0,"seq_gaps":0,"index_missing":0,"index_count_mismatch":0,"started_only":0,"failed_only":0,"no_trace":0}}
```

### 6.3 只读实证（A/B 快照 + 静置对照）

```
# 探针跑前：510 个文件（255 个 *.json + 255 个 events.ndjson）的 (size, mtime_ns)
# 探针跑后对比：
changed total 5 | changed 壳文件(*.json) 0
   ('24f7d2b5-…/events.ndjson', 786354, 801339)
   ('26b70d4b-…/events.ndjson', 537158, 540955)
   ('90b62303-…/events.ndjson', 991652, 998491)
   ('d813eaea-…/events.ndjson', 2004522, 2027178)
   ('f40e16df-…/events.ndjson', 604077, 607599)

# 静置 25 秒、探针一次都没跑，证明上面那 5 个是别的进程在写：
探针未运行，静置 25 秒…
CHANGED   ./26b70d4b-…/events.ndjson 353609 -> 384325
CHANGED   ./276a0d3c-…/events.ndjson 569372 -> 588031
CHANGED   ./90b62303-…/events.ndjson 846907 -> 864004
unchanged ./f40e16df-…/events.ndjson 502703 -> 502703
unchanged ./main.json 1599433 -> 1599433
unchanged ./43b62270-…json 1370183 -> 1370183
```

把窗口拉到整个作业期间（约 40 分钟，跑了 4 趟探针 + 若干 `ls`/python 读取），用**开工第一张
快照**（765 个文件）再比一次：变过 `size`/`mtime` 的文件 **12 个**，其中壳文件 **6 个**——

```
./24f7d2b5-….json   ./276a0d3c-….json   ./d813eaea-….json     ← 壳
./24f7d2b5-…/events.ndjson  ./26b70d4b-…/events.ndjson  …
./24f7d2b5-…/index.json     ./276a0d3c-…/index.json    ./d813eaea-…/index.json
```

这 6 个壳**全部**属于「日志正在被追加」的那 5 个活会话（它们的 `events.ndjson` 与
`index.json` 同步在变、冻结清集从 1960 涨到 1972 个 id）⇒ 是**产品自己在写**，不是探针。
反过来：**249/255 个壳在整段窗口里一个字节没动**，包括本次受损的 `main.json` 与
`43b62270-….json`。§5 里「971 这个数为什么稳」与这里对得上：审计对象（壳）只有活会话在变，
而活会话里 0 条占位。

### 6.4 多趟输出的一致性（哪些数字稳、哪些在漂）

连跑两趟（间隔几十秒）的聚合**逐字节相同**：

```
$ diff /tmp/stock-audit.agg.txt /tmp/stock-audit.agg2.txt
$ echo $?
0
```

再往后跑第三趟（活会话又长了），只有「随活进程生长」的计数漂了，**占位相关的四个数字
一个没动**：

```
$ diff /tmp/stock-audit.agg.txt /tmp/stock-audit.agg3.txt
4,5c4,5
< messages_total = 89686
< tool_messages = 45058
---
> messages_total = 89789
> tool_messages = 45109
20c20
< 壳里冻结的 cleared_tool_call_ids 总数 = 1960
---
> 壳里冻结的 cleared_tool_call_ids 总数 = 1972
25c25
< 异常：index_count_mismatch = 7
---
> 异常：index_count_mismatch = 6
```

三趟里 `placeholder_tool_messages = 971`、`rescuable = 0`、`salvageable = 970`、
`salvageable_bytes = 693641` 全等；§0/§1/§2 的结论不随观察时刻变化。本文正文里的
`messages_total = 89686` / `tool_messages = 45058` / 冻结 1960 个 id / `index_count_mismatch = 7`
是**第一趟（12:45Z）那一刻的快照**，读的时候请按「活会话还在长」来理解。

### 6.5 修复提交与受损会话的时间关系

```
$ git log -1 --format='%h %ci %s' 5f142c97
5f142c97 2026-11-13 12:23:52 +0800 refactor(core): 旧工具结果的占位替换搬到请求构建层，落盘历史一个字不改
```

按「壳文件 mtime 早于/晚于该提交」切片：

```
壳在 cut 之前: 163 占位合计 971 其中受污染会话 [('43b62270', 450), ('main', 521)]
壳在 cut 之后: 92  占位合计 0   其中受污染会话 []
     43b62270 2026-11-11T00:11:41 450
     main     2026-11-11T10:17:47 521
```

## 7. 疑点 / 留给下一手

1. **规格给的「清集」在这份数据上是空集。** `message.compaction.cleared_tool_call_ids` 全库 0 条
   （3 条 `message.compaction` 都没有这个字段）。真正的清集在别处：`context.cleared_tool_result`
   的 `tool_call_ids`（68 条事件）+ `SessionState.cleared_tool_call_ids`（10 个壳、1960 个 id）。
   建议把「清集」的规格口径改成这两处之一，否则任何按清集写的脚本都会 0 命中。
2. **`session.rewound` 全库 0 条**：撤回功能在这份存量上等于没被用过。想验证「撤回是最常见
   满投影入口」，只能靠造数据（见 `0.54-proj-readback` 的 A4 段），真存量证不了。
3. **1 条占位拿不回原文**（`main` 的 `call_00_29xu7bqs05ku2w18g92vv5pq`）：日志里只有
   `tool.call.started`。可能是 run 被取消/崩溃在 append 前，也可能是日志截断；仅凭现有数据
   分不出这两种，探针按「无迹」单列，不猜。
4. **7 个会话的 `index.event_count` 落后实测**，其中 3 个恒为 `5`（像是索引写失败后没再更新）。
   与本任务无关，但 `index.json` 被当计数源的地方要小心。
5. **审计口径只看壳文件**。若某个会话的壳是「干净重启走增量」的状态（`derived_upto_seq` 覆盖到
   尾部），壳里的正文与请求视图会不一致（`0.54-proj-readback` §1.4 实测过同一 id 两种正文）。
   本次统计的是**落盘哪一份**，不是模型看见哪一份——两者不是同一件事，别混用。
