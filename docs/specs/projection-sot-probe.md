---
title: 压缩后落盘的到底是原文还是占位——projection-sot 探针实测（0.53）
kind: measurement
triggers:
  - 压缩之后 sessions.get 读回来的是占位
  - 占位写进落盘
  - SessionState 缓存缺失 全投影
  - projectMessages 把正文换成占位
  - formatClearedToolResult 不幂等
  - 13 lines 变 1 lines
  - 真机旧样本 89.6% 87.1% 占位
  - C1g 请求视图改写 0 条 空转
  - 投影卡 original_available
  - 落盘是原文还是占位 实测
paths:
  - scripts/probe-projection-sot.ts
  - packages/core/src/session/project-messages.ts
  - packages/core/src/context/cleared-tool-result.ts
  - packages/core/src/context/context-manager.ts
  - packages/core/src/runtime/execution-unit.ts
  - packages/serve/src/tool-events.ts
  - scripts/check-append-only-context.ts
  - docs/dev/handoff/projection-card-spec.md
---

# 压缩后落盘的到底是原文还是占位（实测）

> 探针：`scripts/probe-projection-sot.ts`（只读，不属于 gates，不接 package.json）。
> 探针 commit：`d44e5485`（本分支 `0.53-proj-repro`）；本文所有数字都是 **2026-11-15 在
> `/mnt/d/Application/APP/Vessel/worktrees/proj-repro` 重跑** 出来的，不是从旧记录抄的。
> 本文只写实测；没有跑过的一律标「未验证」。

## 0. 一句话

**今天代码的正常路径：落盘是原文，占位只活在请求视图里。** 唯一能把占位写进
`SessionState.messages` 的通路是「缓存缺失 / 尾部被替换事件顶掉 ⇒ `projectMessages` 全投影」，
它占 E2 那一场的 **2/27 = 7.4%**。真机扫到的 89.6% / 87.1% 那两个会话，**最后一次写盘都早于
`5f142c97`**（= 旧版本行为），不能拿来当「今天的错误率」。

## 1. 样本来源（两类，必须分开看）

### 1.1 构造样本（`--construct`，A–E 五场，隔离在 `os.tmpdir()`）

- 真实 `FileSessionStore`（file backend）+ 真实 `ExecutionUnit` + 真实工具执行（`probe_echo`
  返回 13 行 ~931B 的确定性文本，足以触发 5% 清理预算）+ `SessionEventLog`。
- 隔离证据（探针自己的输出行）：
  `[construct] 隔离 data 目录：C:\Users\Lirui\AppData\Local\Temp\vessel-projection-sot-5u8Xth（默认 data 目录未触碰）`
- 五场各测什么（探针 `SCENARIOS` 注释 + 实测）：

| 场 | 构造 | 用来分辨 |
| --- | --- | --- |
| A | run1 → 手动 `compactContext` → 重建 EU（≈ 换进程）→ run2 | 压缩后再跑 run，落盘会不会变占位 |
| B | 同 A，但 run2 之前删掉 `state json` | 缓存缺失 ⇒ 全投影（该段无 cleared ids） |
| C | 自动压缩（`maxTokens=1500` / 阈值 0.3）在段起点触发，连跑 3 个 EU | 段起点清理只影响请求侧？ |
| D | C 的 cleared 集合 + 删 state 缓存 → run3 | 全投影 + 非空 cleared 集合 |
| E | **决定性**：压缩事件带 cleared ids → 删缓存 → run3 用**大预算**（`maxTokens=200000`，段起点清理集合为空） | 请求/落盘里若出现占位，只可能来自全投影 |

### 1.2 真机只读扫描（`--data-dir`）

- 命令：`bun run scripts/probe-projection-sot.ts --data-dir "C:/Users/Lirui/.vessel/data"`
  （只读，不跑 run，不写 data 目录）。
- 结果行：`[real] 扫描 state 文件=229 有 compaction 的会话=3 其中压缩后又跑过 run=3`
  —— **229**，不是派单里写的 225（多出来的是停机后新增的 state 文件，本次这就是实际读数）。
- 只有 3 个会话同时满足「有 `message.compaction`」+「压缩后还跑过 run」，才是本问题的样本。

### 1.3 读路径的限制（必须写在结论前面）

探针想走真 `sessions.get` handler，但脚本直跑解析不了裸包名
`@vessel-agent/core`，退回同一取数口径：
`[diag] sessions.get handler 直调不可用，改用 capToolMessages(state.messages)：ResolveMessage: Cannot find module '@vessel-agent/core' ...`，
`[real] 读路径 = capToolMessages(SessionState.messages)`。
`capToolMessages` 就是 handler 里那三行（doc 已核，`packages/serve/src/tool-events.ts`），
所以「读回来是什么」的结论不变；**但「handler 本身有没有额外改写」未验证**。

## 2. 四问结论

### a. 今天代码的正常路径：压缩后落盘 **0% 占位**（15/15 原文 × 5 场）

关键输出（逐字）：

```text
--- A2: 压缩后再跑一次 run（state 命中缓存） (session=probe-sessio) ---
  SessionState.messages=25  工具消息=15  原文=15  占位=0 (0%)  其他=0
  SessionState.cleared_tool_call_ids=0  sessions.get 视图里占位=0  最近一次请求里占位=0

--- C1: 自动压缩（run2 段起点）+ run2 落盘 (session=probe-sessio) ---
  SessionState.messages=26  工具消息=15  原文=15  占位=0 (0%)  其他=0
  SessionState.cleared_tool_call_ids=2  sessions.get 视图里占位=0  最近一次请求里占位=2

--- C2: run3 之后（上一段已压缩） (session=probe-sessio) ---
  SessionState.messages=26  工具消息=15  原文=15  占位=0 (0%)  其他=0
  SessionState.cleared_tool_call_ids=2  sessions.get 视图里占位=0  最近一次请求里占位=2

--- D1: 自动压缩 + run2 落盘（缓存命中） (session=probe-sessio) ---
  SessionState.messages=26  工具消息=15  原文=15  占位=0 (0%)  其他=0
  SessionState.cleared_tool_call_ids=2  sessions.get 视图里占位=0  最近一次请求里占位=2

--- E1: 自动压缩产生 cleared ids（run2 落盘，缓存命中） (session=probe-sessio) ---
  SessionState.messages=26  工具消息=15  原文=15  占位=0 (0%)  其他=0
  SessionState.cleared_tool_call_ids=2  sessions.get 视图里占位=0  最近一次请求里占位=2
```

读法（三个字段必须一起看，缺一个就会误判）：

- `占位=0 (0%)`：`SessionState.messages`（= 落盘 = `sessions.get` 取数来源）里工具消息**全是原文**。
  A2/C1/C2/D1/E1 五场各 15/15 ⇒ 合计 **75/75 原文，0 占位**。
- `sessions.get 视图里占位=0`：读路径没把正文换成占位（读侧不做投影）。
- `最近一次请求里占位=2`：占位**只**出现在真正发给模型的请求里（C1/C2/D1/E1 各 2 条，
  A2 为 0，因为 A 是手动压缩、该段没有清理决策）。
- 真机再补一例（今天代码写的）：`real:16d265ec-...` → `工具消息=222  原文=222  占位=0 (0%)`，
  而该会话 `SessionState.cleared_tool_call_ids=212`。**212 条冻结的清理决策，落盘一条没动**。

### b. 唯一写占位进落盘的通路：缓存缺失 ⇒ `projectMessages` 全投影（2/27 = 7.4%）

代码位置（读，不是猜）：`packages/core/src/runtime/execution-unit.ts:3466-3491` 判
`needFullProjection = cached === undefined || typeof derived !== 'number'`，另外尾部出现
`message.compaction` / `session.rewound` 时置 `fullProjectionForReplacement`；两者任一命中
就走 `:3585-3595` 的 `projectMessages(events)` 直接返回；`projectMessages` 在
`packages/core/src/session/project-messages.ts:232-245` 按 `cleared_tool_call_ids` 把正文换成
`formatClearedToolResult(...)`。这段结果被 journal 当 `SessionState.messages` 落盘。

决定性场景 E2 的输出（逐字）：

```text
  [diag] 删缓存后 store.load() = null（全投影路径）
  [diag:E-全投影] projectMessages(events) → 消息 24 / 工具 15 / 占位 2
    proj 占位 call_10: "[cleared probe_echo -> 13 lines]"
    proj 占位 call_11: "[cleared probe_echo -> 13 lines]"
  run(E-run3) -> "E-run3 完成"
  [diag:E-run3 种子] 请求数=5 首个请求工具消息=15 其中占位=5

--- E2: 删缓存 + 不压缩的 run3（占位只可能来自全投影） (session=probe-sessio) ---
  SessionState.messages=44  工具消息=27  原文=25  占位=2 (7.4%)  其他=0
  SessionState.cleared_tool_call_ids=3  sessions.get 视图里占位=2  最近一次请求里占位=5
   [placeholder] call_10 raw=944B persisted=32B
   [placeholder] call_11 raw=944B persisted=32B
```

- **2/27 = 7.4%**：删缓存那次 run 之后，新落盘的 27 条工具消息里 2 条是占位（`call_10`/`call_11`，
  944B 缩成 32B）。
- 归因很干净：run3 用 `maxTokens=200000`，段起点清理集合**不可能**新增占位；这两条只能来自
  `projectMessages` 全投影。
- 请求里 5 条占位 = 3（本段冻结集合，`cleared_tool_call_ids=3`）+ 2（种子里已经是占位的）
  —— 后半句是**推断**（按 `withClearedToolResults` 只改集合命中的口径推），未单独实测。
- 对照组 B2/D2（同样删缓存，但该段没有 cleared 集合）：
  `--- B2: 删 state 缓存（全投影路径）后再跑一次 run --- / 工具消息=15  原文=15  占位=0 (0%)`
  ⇒ 全投影本身不产生占位；**是「非空 cleared 集合 + 全投影」这个组合产生的**。

### c. 真机旧样本 89.6% / 87.1% 是旧版本行为，不代表今天

| 会话 | mtime（`ls -l`） | 工具消息 | 占位 | `cleared_tool_call_ids` |
| --- | --- | --- | --- | --- |
| `43b62270-c285-43b3-8e91-e214d3a1bdc7` | 2026-11-11 00:11 | 502 | 450（**89.6%**） | 0 |
| `main` | 2026-11-11 10:17 | 598 | 521（**87.1%**） | 0 |
| `16d265ec-2d6d-44ea-8e81-5f2ea30c4731` | 2026-11-15 10:04 | 222 | 0（0%） | 212 |

- 探针逐条比对行：`SessionState.messages=1082  工具消息=502  原文=52  占位=450 (89.6%)  其他=0`、
  `SessionState.messages=1485  工具消息=597  原文=77  占位=520 (87.1%)  其他=0`。
- 按正文前缀另算一遍（`main` 会话共 598 条工具消息、521 条 `[cleared ` 开头 = 87.1%）：两个口径
  同值。差的那 1 条是其 `tool_call_id` 在事件里找不到 `tool.call.completed`（逐条比对跳过），
  不是统计错误。
- 版本分界：`5f142c97`（2026-11-13 12:23:52，`refactor(core): 旧工具结果的占位替换搬到请求构建层，
  落盘历史一个字不改`）。两个高占位样本的 mtime **都早于**它。
- 反向证据更硬：`16d265ec`（mtime 2026-11-15 10:04，晚于修复）带 **212 条** cleared ids，
  落盘占位仍是 **0**。⇒ 至少在「缓存命中」的正常路径上，今天代码不会把占位写进去。
- 需要说清的边界：mtime 只证明「最后一次写盘发生在旧代码上」，不证明占位就是那一刻写的。
  真正的因果是「mtime 早于 `5f142c97`」+「晚于它的样本 0 占位」两条一起。**「今天代码绝不写占位」
  不成立**——b 的 7.4% 就是反例。

### d. `formatClearedToolResult` **不幂等**：`13 lines` → `1 lines`

```text
--- 幂等性 ---
  原文   : "RAWTOOL#01 这是第 1 条工具结果的原文\n  line 1: rawwww…" … (931B)
  第一次 : "[cleared probe_echo -> 13 lines]"
  第二次 : "[cleared probe_echo -> 1 lines]"
  isClearedToolResult(once)=true  once===twice? false
  差异起点 index=24
    once : …"[cleared probe_echo -> 13 lines]"
    twice: …"[cleared probe_echo -> 1 lines]"
```

- 差异点在**行数**：`cleared-tool-result.ts:108` 用 `originalContent.split('\n').length` 数行，
  而占位文本自己只有 1 行 ⇒ 二次格式化必然退化成 `1 lines`。
- 今天没爆是因为两道闸：`projectMessages:242` 有 `isClearedToolResult` 守卫，
  `execution-unit.ts:3205` 的请求侧替换只替换集合里命中的、且上游已有判定；但
  `withClearedToolResults`（`context-manager.ts:362-380`）**自己没有守卫**（对入参直接重排），
  任何把「已是占位」的正文再喂它一次的新调用点都会踩到（0.53 修复单里已记）。

## 3. 对投影卡的建议（可直接落到 `original_available`）

- **默认值：`original_available = true`**。今天的落盘就是原文，占位只是请求视图；UI 不能因为
  「模型看到占位」就说原文不可用（`sessions.get` 拿到的就是原文）。
- **只有一种情况标 `original_available = false`**：该段发生过「全投影重建」（b 那条路径：
  `SessionState` 缓存缺失，或尾部被 `message.compaction` / `session.rewound` 顶掉）
  **且该 `tool_call_id` 在 `cleared_tool_call_ids` 里**。判定必须**看正文**
  （`isClearedToolResult(content)`），不能只看集合——集合是段级覆盖写的，旧占位会「不在集合里」。
  （与 `docs/dev/handoff/projection-card-spec.md` §1.7 两分支规则一致。）
- 旧会话（c 的样本）落盘里已经是占位、原文只剩 `events.ndjson` 的 `tool.call.completed` ⇒
  这类条目**只能**从事件日志回填原文；投影卡不要假设 `messages[].content` 是原文。
- 客户端**不要**自己复刻 `formatClearedToolResult`：不幂等（d）+ 正文 8 KiB 截断
  （`packages/serve/src/tool-events.ts:17`）⇒ 双实现必然漂移。

## 4. 两条附带发现

### 4.1 `check-append-only-context.ts:637-660` 的 C1g 只读裸 `MemoryWorkingContext`（绿，但盲区在投影路径）

- `runClearingProbe()`（`:605`）自己 `new MemoryWorkingContext({maxTokens:2000})` 灌消息、`compact(true)`，
  判据是 `stored = context.messages`（`:637`）里的工具结果是否仍是原文（`:646-660`）。
- 这条路径**不经过** seed / `projectMessages` / journal 落盘，所以它测的是「压缩函数本身会不会
  就地改写正文」，**不是**「`sessions.get` 读回来的正文」。b 的 7.4% 就在这个盲区里：C1g 全绿
  与「全投影会把占位写进落盘」可以同时成立（本次实测正是如此）。
- 结论：C1g 绿 ≠ 落盘无占位。要么另加一条走 `projectMessages` + `FileSessionStore` 的判据
  （本探针 E2 那三行就是最小骨架），要么在 C1g 的 `ok(...)` 文案里写清它只覆盖压缩函数。

### 4.2 同文件 `:665-673` 的「请求视图改写 0 条」判据是**空转的**

```text
--- check-append-only-context C1g:665 复核（withClearedToolResults 第二实参） ---
  planClearedToolResults(messages, 2000) 点名 11 条
  withClearedToolResults(messages, <ids>)   改写 11 条  ← 真实请求视图口径
  withClearedToolResults(messages, 2000)    改写 0 条  ← C1g:665 实际调用
```

- `:665` 是 `withClearedToolResults(stored, maxTokens)`——把 `maxTokens`（number）当第二个实参传。
- 该函数签名（`context-manager.ts:362-370`）第二个参数是 `readonly string[] | number`，
  并且**明确规定**「传数字（旧的 token 预算签名）= 这一段还没有决策 ⇒ 一条都不清」：
  `if (!Array.isArray(cleared) || cleared.length === 0) return [...messages];`
- ⇒ `rewrittenInView` 恒为 0，`:667-673` 的 `pending` 永不触发，`:683-687` 的
  「请求视图改写 0 条」**永远印出来**。这条断言今天等于没检查（不是「检查了通过」，是「没检查」）。
- 修法（二选一，**本次不改探针**，按派单只记录）：① 改成传 ids
  （`withClearedToolResults(stored, planClearedToolResults(stored, maxTokens))`，实测会改写 11 条，
  判据恢复语义）；② 认为它已被 `scripts/check-request-append-only.ts` 的 R1/R4 完全覆盖 ⇒ 删掉
  这条，连 `ok(...)` 里的「请求视图改写 0 条」文案一起删。**别留着让它继续印一句话骗人。**
- 附注：这条判据不清，`check-request-append-only.ts` 的 R1/R4 也**未在本次验证**是否真的覆盖同一形状
  （未跑）。

## 5. 未验证 / 不要引用成事实

- **真实 provider 的行为**：没有对 OpenAI 兼容 / Anthropic 端点发过请求；「占位进请求会被 400」
  是本仓约束的推论，不是本次实测。
- **崩溃/重启路径**：b 的触发条件是「`cached === undefined` 或 `derived_upto_seq` 非数字」，
  生产里可能由「进程重启 + state 落盘滞后」命中（**推断**）。本次只用**删 state json** 模拟，
  真实重启时序未跑。
- **`fullProjectionForReplacement`（尾部出现 compaction/rewound）单独命中**时会不会写占位：
  C2 实测是 0 占位（缓存命中、tail 里已无新 compaction），但「压缩那一轮读盘时 tail 带 compaction」
  这个时刻没有单独构造样本，未验证。
- **`sessions.get` handler 的额外改写**：见 §1.3，走的是同口径回退。
- 探针 `--construct` 每次 run 后固定等 400ms，且 `sessionStateOf` 最长轮询 2s 等 state 落盘；
  更慢的机器上是否会读到未落盘状态，未调。

## 6. 复现（三条命令，逐字）

```bash
bun run scripts/probe-projection-sot.ts --construct
bun run scripts/probe-projection-sot.ts --idempotency
bun run scripts/probe-projection-sot.ts --data-dir "C:/Users/Lirui/.vessel/data"   # 只读
```

`--construct` 会把隔离目录路径打在首行（`%TEMP%\vessel-projection-sot-*`），events.ndjson 与
state json 留在那里供人工复核；默认 data 目录未触碰。

### 附录：`--construct` 的事件侧佐证（逐字）

```text
[construct:A] events.ndjson: tool.call.completed=24（正文与造样本原文逐字相同 24，不同 0） message.compaction=1 每个 compaction 的 cleared_tool_call_ids 条数=[2]
[construct:B] events.ndjson: tool.call.completed=24（正文与造样本原文逐字相同 24，不同 0） message.compaction=1 每个 compaction 的 cleared_tool_call_ids 条数=[2]
[construct:C] events.ndjson: tool.call.completed=36（正文与造样本原文逐字相同 36，不同 0） message.compaction=2 每个 compaction 的 cleared_tool_call_ids 条数=[11,14]
[construct:D] events.ndjson: tool.call.completed=36（正文与造样本原文逐字相同 36，不同 0） message.compaction=2 每个 compaction 的 cleared_tool_call_ids 条数=[11,12]
[construct:E] events.ndjson: tool.call.completed=36（正文与造样本原文逐字相同 36，不同 0） message.compaction=1 每个 compaction 的 cleared_tool_call_ids 条数=[11]
```

⇒ 「事件日志里的原文永远是原文」这条前提成立（各场 0 条不同），所以「原文只在事件里」的回填
方案（投影卡）有可靠数据源。

