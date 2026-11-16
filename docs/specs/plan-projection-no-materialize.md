# 方案① 规格草稿：满投影不再把清集替换物化进 `SessionState`

> 状态：**草稿，未开单、未改代码**（2026-11-15）。用户已批「进 0.54、排在 B 阶段之前」，
> 排在**存量体检**（`docs/dev/reports/0.54/stock-audit.md`）数字出来之后开工。
> 依据：`docs/dev/handoff/projection-card-spec.md` §1.5（实测裁决）＋ `docs/dev/reports/0.54/proj-readback-15.md`。

## 1. 一句话

`SessionState.messages` 从今往后是**原文视图**（事实重建的结果），不再被写入清集替换后的占位文本；
占位只活在**请求视图**与**UI 的 `projection` 派生层**。

## 2. 现状链路（行号以 `39e80a1d` 为准）

`loadStoredHistory` 的**满投影**分支一条管道干两件事：

1. 事实重建：事件重放 + `message.compaction` 的 `kept` 裁尾 + `session.rewound` 截断；
2. 清集替换：命中 `cleared_tool_call_ids` 的 tool 结果换成 `formatClearedToolResult` 的占位
   （`packages/core/src/session/project-messages.ts:232-245`，`:242` 有 `isClearedToolResult` 护）。

产物经 `seedTransientContext`（`packages/core/src/runtime/execution-unit.ts:3123`、调用点 `:3058` / `:3106`）
塞进工作上下文，再由 `finalizeSessionState`（`:4247`）写回 `SessionState.messages` ⇒ **占位落盘、原文只剩事件日志**。

`projectMessages(events)` 在加载路径有**两个**调用点：增量分支 `:4092`、满投影分支 `:4116`。
签名目前是 `projectMessages(events: Iterable<ProjectableEvent>): Message[]`（`project-messages.ts:168`），**没有 options**。

## 3. 目标语义（写进类型注释，别只写在文档里）

| 载体 | 语义 | 允许出现占位正文吗 |
| --- | --- | --- |
| 事件日志 | 唯一事实源 | 否（原文在 `tool.call.completed`） |
| `SessionState.messages` | **原文视图**（事实重建的结果，可重建、可校验） | **不允许** |
| 请求视图（发给模型的 messages） | 模型视图（按当前清集替换） | 允许（应该） |
| `sessions.get.projection` / 投影卡 | 派生展示层 | 允许（派生，不落盘） |

## 4. 改法（纯减法，无新增请求开销）

1. `projectMessages(events, options?: { applyClearedReplacements?: boolean })`，**默认 `true`**（保持既有调用方语义不变）；
   `false` 时**跳过**第 2 步的清集替换，**保留** `kept` 裁尾与 `rewound` 截断（那些是事实）。
2. 加载路径两个调用点（`:4092`、`:4116`）改传 `{ applyClearedReplacements: false }`。
3. `derived_upto_seq` **照常推进**：它的语义是「事实已重建到 seq N」，与是否替换无关。
4. 请求视图**不动**：压缩/段起点的清集已经在请求构建侧应用（`execution-unit.ts:1067`、`:1226` 读
   `SessionState.cleared_tool_call_ids`，`context-manager.ts` 的 `planClearedToolResults` 算集合），
   这也是为什么压缩当轮的请求里一直是占位、而落盘一直是原文。
5. `SessionState.cleared_tool_call_ids` **照旧落盘**（它是"模型视图"的输入，不是"事实"的改写）。

## 5. 开工前必须逐一确认的读点（否则会把模型视图喂错）

用 `grep` 找所有「直接把 `SessionState.messages` / `workingContext.messages` 当 prompt 用」的地方，
逐条确认它们在**自己这一层**应用清集，而不是依赖落盘里已经是占位：

- 会话恢复后的**第一轮**请求（`seedTransientContext` 之后、压缩还没发生的窗口）；
- 子代理 / 分支会话的派生（若它们复制 `SessionState.messages`）；
- 摘要/卡片类功能（若从 `messages` 生成，占位消失后摘要会变长——要接受还是重新投影，要明确）；
- `sessions.get` 的 `capToolMessages`（这条**本来就该**看到原文，wire 的 `projection` 负责派生显示）。

> 每一个读点都要在探针里有对应用例，不许"读了一圈没找到就算没有"。

## 6. 断言（只许更严）

1. **满投影之后** `SessionState.messages` 里不存在任何 `isClearedToolResult(...)` 为真的 tool 消息（**结构判定**，
   不扫 `[cleared ` 文本——工具输出里本来就可能出现这串字）。
2. 同一场景改传 `{applyClearedReplacements: false}` 与 `true`，**消息条数与顺序必须完全一致**，只有占位正文处不同
   （证明只改了"替换"，没动"事实重建"）。
3. `rewound` 截断 + `kept` 裁尾在 `false` 下行为与 `true` **逐条相同**（防误伤事实）。
4. 「谁读都应用清集」的反向断言：构造一条已清集的历史，走恢复 → 第一轮请求里的工具结果**是占位**
   （证明模型视图没退化）。
5. 既有断言若断言「`messages` == 日志投影」，改成「== 日志投影**去掉清集替换**」——**逐条改，不许整段跳过**。

## 7. 不做什么（防范围失控）

- **不改** `holes` / `tainted` / manifest 任何冻结面；
- **不改** 0.85 的硬兜底压缩（丢最旧 + 摘要卡）——它是另一条链路；
- **不删** `derived_upto_seq`（那是 B 阶段的事；本单只让它"不再背负替换结果"）；
- **不做**存量修复（那是独立脚本，输入来自体检报告）。

## 8. 验收

- 真机：一条被压缩过的会话，压缩 → 重启 → `sessions.get` 的工具结果**仍是原文**；
- 同一条会话的**请求视图**里该结果**仍是占位**（两处都要贴证据，不许只贴一边）；
- `bun run gates` 全绿（每合入一次都要重跑）；
- 存量体检的数字作为本单的"前后对照"：改完之后新产生的会话，四象限里"可救"列不应再增长。

## 9. 与 B 阶段的顺序（为什么必须在前）

B 阶段要删 `derived_upto_seq`、删两阶段回填、删 `disk-replay.ts` / `replay-source.ts` / `replay-budget.ts`，
改的正是**同一条**恢复/投影链路。本单先让「写回的是原文」成为既定事实，B 阶段才有干净基线
（B-2 判据「`derived_upto_seq` 删除后投影输出不变」依赖它）。顺序反了 = 同一段代码改两遍。
