---
title: 投影卡——让用户同时看到「模型看到的占位符」与原文（复用现有卡片能力）
kind: design
status: 待拍板
triggers:
  - 投影卡
  - 占位符与原文同时可见
  - 用户看到占位符
  - 模型看到占位符
  - C1h 披露行
  - 占位符可复制
  - 模型视角 原文视角
  - 双层卡片
  - 压缩后原文不见了
  - 工具结果被换掉
  - 卡片折叠吞掉投影信息
  - 双实现漂移 placeholder
  - archive_notice 归档卡
  - externalize 句柄卡
paths:
  - packages/core/src/context/cleared-tool-result.ts
  - packages/core/src/context/context-manager.ts
  - packages/core/src/session/project-messages.ts
  - packages/core/src/runtime/execution-unit.ts
  - packages/core/src/runtime/run-journal.ts
  - packages/core/src/types/session.ts
  - packages/serve/src/gateway/methods/sessions.ts
  - packages/serve/src/tool-events.ts
  - apps/web/src/gateway/types/sessions.ts
  - apps/web/src/domains/chat/tool-cards.ts
  - apps/web/src/domains/chat/ToolCard.tsx
  - apps/web/src/domains/chat/StreamCard.tsx
  - apps/web/src/domains/chat/env-notice.ts
  - apps/web/src/domains/chat/EnvCard.tsx
  - apps/web/src/domains/chat/history-tools.ts
  - apps/web/src/domains/chat/transcript-items.ts
  - apps/web/src/state/events.ts
  - apps/web/src/domains/chat/EventRow.tsx
---

# 投影卡：让用户同时看到「模型看到的占位符」与原文

> 用户口径（原话）：「所以 C1h 就是我们看到原文，模型看到占位符是吧，有没有一个好办法，可以让用户看到占位符也看到内容，因为用户看到的是模型看到的超集嘛，建议是复用我们的卡片能力，后续这个我们还会进行升级，卡片的显示等等。」
>
> 本文只出规格：**数据链路结论 + 交互 + 可升级字段 + 与 C1h 的关系 + 风险**。本轮不写前端实现。

## 0. 三句话结论

1. **「前端自己复刻 formatter」这条路不成立**（是正确性问题，不是成本问题）。占位文本的派生输入里有两项前端拿不到、或只能拿到残缺版：`exit code` / 行数所依赖的**原文**（`sessions.get` 对工具消息正文做 8 KiB 截断，`packages/serve/src/tool-events.ts:17`），以及 summary 的**脱敏**（`cleared-tool-result.ts:58` 的 `redactSummary`，先脱敏后截 60 码点）。更硬的一条：`formatClearedToolResult` **不幂等**——对已经是占位的正文再跑一遍，行数会算成 `1 lines`（实测，§1.4）。
2. **推荐：服务端一次渲染，UI 只搬运。** 在 `sessions.get` 的每条工具消息上加一个 additive 的 `projection` 对象，由 core 自己的 `formatClearedToolResult` 在**完整落盘消息上（切片之前）**渲染；原文不在 inline 时给 `readback` 句柄（走已经落地的 `sessions.events`）。这条路零漂移，且能解决「原文已经不在 messages 里」这个前端复刻根本无解的情形。
3. **卡片能力几乎全部可复用**：`StreamCard` 是现成的通用壳（折叠 / 标题栏 / `meta` / `actions` / header），`PayloadSection` 就是现成的「一段文本 + 折叠 + 按块加载 + 复制」，`SegmentedTabs` 就是现成的 `role=tablist` 双层切换，`EnvCard` / `NoticeRow` 就是现成的批量卡宿主。**唯一需要动的现有逻辑**是 `mergeEnvNoticeCards`（`env-notice.ts:226-238`）：它今天会把 `blocks` 整段丢掉。

---

## 1. 数据链路（结论先行）

### 1.1 占位文本是怎么来的（确定性派生的确切输入）

全部在 `packages/core/src/context/cleared-tool-result.ts`：

| 环节 | 位置 | 派生输入 | 前端拿得到吗 |
| --- | --- | --- | --- |
| 前后缀 | `:18`（前缀常量）、`:19-21`（`SUMMARY_MAX_CODE_POINTS = 60`） | 常量 | ✅ 常量 |
| 工具名 | `:91-111` `formatClearedToolResult`，其中 `:96` 按 `tool_call_id` 找 owning assistant 的 `tool_calls` | `messages` **全表**里那条 `assistant.tool_calls[].function.name` | ⚠️ 有，但窗口/截断后可能不在（§1.3 陷阱 3） |
| 首参摘要 | `:40-56` `summaryFromArguments` → `:99` `truncateCodePoints(redactSummary(...), 60)` | `function.arguments`（JSON 串）→ `JSON.parse` → 第一个字符串参数 → 脱敏 → 压平单行 → 截 60 **码点** | ⚠️ `arguments` 被截到 8 KiB 后带 `... [truncated]`，`JSON.parse` 失败 ⇒ summary 直接消失 |
| exit code | `:27` `EXIT_CODE_PATTERN`，用于 `:106-107` | **原文正文** | ❌ 正文被截断/被换成占位后拿不到 |
| 行数 | `:108` | **原文正文**的行数（末尾换行不留空行） | ❌ 同上 |
| 脱敏 | `:58` `redactSummary`（`createDefaultTraceRedactor()`） | trace redactor 规则集 | ❌ 前端没有这个模块，且规则随版本演进 |
| 幂等保护 | `:114` `isClearedToolResult`（只看正文的前缀/括号结构） | — | ✅ 有，但**不是每个调用点都用**（§1.4） |

派生**不含时间、不含随机数**——这一点成立（好消息）。但「确定性」只对**同一份完整原文 + 同一个 redactor 版本**成立；跨截断、跨窗口、跨 redactor 版本都不成立。

### 1.2 前端现在手里有什么（逐条证据）

**(a) `sessions.get` 返回什么。** 服务端 `packages/serve/src/gateway/methods/sessions.ts:1124` 一行：

```
messages: capToolMessages(all.slice(start, end)),
```

- `all` 来自持久化 store 的 `SessionState.messages`；`start/end` 是分页窗口（`message_limit` / `before`，客户端 wrapper 见 `apps/web/src/gateway/node/sessions.ts:142-152`）。
- `capToolMessages`（`packages/serve/src/tool-events.ts`，上限常量 `:17`）把工具消息 `content` 与 `function.arguments` 各截到 8 KiB，**截断是静默的**（字符串型直接把 `... [truncated]` 拼进正文，没有结构化标志位）。
- 返回体里**没有** `cleared_tool_call_ids`：`toSessionView`（`sessions.ts:730-800`）不输出 `SessionState.cleared_tool_call_ids`（`packages/core/src/types/session.ts:90`）。
- ⚠️ 而且这个字段是**段级**的、不是会话累计：`saveSessionState` 每段覆盖写，本段没决策就 `delete`（`execution-unit.ts:3733-3738`）；`normalizeClearedToolCallIds` 还会把空数组归一成 `undefined`（`cleared-tool-result.ts:124-129`，「没有决策」≠「全清」）。会话累计的唯一全量来源是事件里那个**不截断**的 `tool_call_ids` 数组。
- 返回体里**没有** events：`apps/web/src/gateway/types/sessions.ts` 的 `SessionDetail` 无 `events` 字段（全文只有 `:295 events_deleted`）。
- 但**有** `event_cursor`（`sessions.ts:1126-1129`，0.53 additive）和 `system_context`（同处，带 `hash`）——这两个是本卡 wire 形状的直接模板（§1.7）。

**(b) 事件流推了什么。**

| 事件 | 携带 | 落盘？ | 前端怎么处理 |
| --- | --- | --- | --- |
| `message.compaction` | `cleared_tool_call_ids`（**全量、不截断**，`execution-unit.ts:2698-2711`）、`report` | ✅ 落盘（`packages/core/src/runtime/run-journal.ts:54-63` 的 `NON_PERSISTED_EVENT_TYPES` 里没有它） | `apps/web/src/gateway/connection-handlers.ts:161-164`：只**整段重载历史**，`cleared_tool_call_ids` 用完即弃，store 不存 |
| `context.cleared_tool_result` | `model`、`cleared`、`kept`、`summary`（= 那条 trim 通知文本）、`tool_call_ids`（**全量**，`execution-unit.ts:833` 传的是 `fresh` 数组） | ✅ 落盘 | `apps/web/src/state/events.ts:461` → `kind:'notice'`，item 里带**完整 event**（`events.ts:469-474`）；但 notice 是 live-only，刷新后不复现（`docs/dev/handoff/refresh-gap-design.md:126-150`） |

**(c) `apps/web` 里哪个 store 存了它。**

- 消息侧：`apps/web/src/stores/sessionStore.ts`（`SessionDetail.messages`，`sessions.get` 的落点）——**唯一刷新后仍在**的来源。
- 工具卡构造：`apps/web/src/domains/chat/history-tools.ts:20` 的 `HistoryToolItem` 把 `args`（`assistant.tool_calls[].function.arguments` 原串）与 `output`（`tool` 消息正文）带给卡片；历史配对在 `transcript-items.ts:900-975`（`buildHistoryIndex`），渲染入口 `TranscriptWindow.tsx:486` `case 'tool' → <ToolCard>`（实时路径 `StreamItems.tsx:595`）。
- 事件侧：`apps/web/src/state/events.ts` 的 `items`（含 `notice`）**只活在内存缓冲**，刷新即失。
- 结论：`cleared_tool_call_ids` 这类投影事实，前端**没有任何 store 存它**。

### 1.3 所以「不新增存储就能重建」能不能成立？—— 不能（五个陷阱）

陷阱 1（截断）：`exit code` 与行数来自原文，而 `sessions.get` 给的正文最多 8 KiB（`tool-events.ts:17`）。一个 4000 行构建日志，前端只能算出约 200 行，模型看到的是 `[cleared bash: pnpm build -> exit 1, 4000 lines]`。

陷阱 2（脱敏版本）：summary 走 `redactSummary` → `createDefaultTraceRedactor()`（`cleared-tool-result.ts:58`），前端没有这个模块；即便照抄，规则集一变，历史会话的占位文本就"重算得不一样"。这正是 ADR-104 把「文本渲染」定在机制层的理由（`docs/adr/ADR-104-context-projection-policy.md:250`：`formatClearedToolResult` / `renderContextTrimNotice` / `renderProjectionArchiveNotice` 都在 core）。

陷阱 3（窗口边界）：`formatClearedToolResult` 要在消息全表里按 `tool_call_id` 找 owning assistant（`cleared-tool-result.ts:96`）。分页窗口可能把那条 assistant 切掉。实测（§1.4）证明：窗口里丢掉 owning assistant 后，占位退化为 `[cleared -> exit 2, 4 lines]`，比模型看到的少一段。

陷阱 4（原文可能已经不在 messages 里）：见 §1.5——决定性的一条。

陷阱 5（冻结集合是段级的，不能当"谁被投影过"的判据）：`SessionState.cleared_tool_call_ids` 每段覆盖写、本段没决策就 `delete`（`execution-unit.ts:3733-3738`），空数组还会归成 `undefined`（`cleared-tool-result.ts:124-129`）。所以**只看 id 集合会漏报**：一条早先被换成占位、正文已经落盘成 `[cleared ...]` 的条目，只要本段集合里没有它，就会被误判成"没被投影"。⇒ 判定必须**看正文**（`isClearedToolResult`），不能只看集合（§1.7 的两分支规则）。

### 1.4 实测（跑的是真模块，不是估）

用 `npx tsx` 直接调 `formatClearedToolResult`（原文含 `exit code: 2` 与 4 行）：

| 场景 | 结果 |
| --- | --- |
| 正常 | `[cleared bash: pnpm test --filter core -> exit 2, 4 lines]` |
| 对**已经是占位**的正文再跑一遍 | `[cleared bash: ... -> 1 lines]` ← **行数从 4 变 1，双实现必然踩** |
| 窗口里没有 owning assistant | `[cleared -> exit 2, 4 lines]` ← 少了工具名与 summary |

第二行是硬伤：**任何"再跑一遍"的实现（前端复刻、服务端二次投影、卡重算）都必须先 `isClearedToolResult` 护一道，否则历史会自降级**。`withClearedToolResults`（`context-manager.ts:362-378`）自己**也没有**这道护，它能安全只因调用点保证只对落盘原文跑一次；`projectMessages` 那边有护（`project-messages.ts:242`）。**同一件事两处实现、一处有护一处没有**——这本身就是"多实现必漂"的现成反例。

### 1.5 决定性发现：压缩之后，落盘里可能就是占位（原文不在 messages 里）

代码链路（每一步都可点开）：

1. `execution-unit.ts:3485-3492` 判定 `fullProjectionForReplacement`：尾部事件里出现 `message.compaction` **或 `session.rewound`** ⇒ 为真，并强制读全量日志。
2. 为真则历史走 `projectMessages(events)` 全投影（`execution-unit.ts:3560` 的增量分支为假 ⇒ 落到 `else`，`:3586`）。
3. `projectMessages` 把正文换掉：`packages/core/src/session/project-messages.ts:232-245` 对命中的 `tool_call_id` 调 `formatClearedToolResult`（注释 `:232-234`：「先按 cleared_tool_call_ids 把已构建消息里命中的 tool 结果换回确定性占位（与压缩时同一函数）」，`:242` 有 `isClearedToolResult` 护）。
4. `seedTransientContext` 把 `history.messages` **原样**塞进工作上下文（`execution-unit.ts:1916-1918`）。
5. `finalizeSessionState` 把 `workingContext.messages` **写回** `SessionState.messages`（`execution-unit.ts:3715`、`:3726`）。

⇒ 下一次 `sessions.get` 拿到的这条工具消息**就是占位文本**，原文只剩事件日志（`tool.call.completed` / `message.appended`）。

**张力声明（需实测确认，不许当既成事实）**：`scripts/check-append-only-context.ts:590-600` 断言「压缩后窗口（= 落盘 / `sessions.get` 的来源）里的旧工具结果仍是原文 —— 今天还成立，因为 V1 还没修」。按上面 5 步读，只有「缓存命中且 tail 里没有 compaction」的增量路径才成立；一旦走满投影（重启、缓存 miss、压缩后的下一轮）就会写回占位。两者不能同时为真。**建议 implementer 先跑一次复现**（3 步：造一条 cleared 工具结果 → 触发一次压缩 → 重启进程后 `sessions.get` 看正文）。无论测出哪一边，本规格都按**最坏情况**设计：**UI 不得假设 `messages[].content` 是原文。**

### 1.6 三条路对比

| | A：前端复刻 formatter | B：服务端渲染（推荐） | C：只做事件回填 |
| --- | --- | --- | --- |
| 正确性 | ❌ 截断/脱敏/窗口/幂等四个陷阱全会踩（§1.3、§1.4） | ✅ 只有一处实现，就是模型实际看到的那一处 | ⚠️ 能拿到「哪些 id 被清了」，拿不到「模型看到的那一字节」 |
| 覆盖「原文已不在 messages」 | ❌ 完全无解 | ✅ `original_available:'readback'` + 读回 | ⚠️ 只能读原文，不能读占位 |
| 漂移风险 | **高**（formatter 或 redactor 一改即错，历史会话全错） | **零**（与请求视图同一个函数，改了天然同步） | 中（事件 schema 演进） |
| 成本 | 前端约 200 行 + 移植 redactor + 单测 | 服务端 additive 字段 + core 一次纯函数调用 | 前端分页拉事件 + 跨事件合并 + 缓存 |
| 刷新后还在吗 | 在（消息侧） | 在（消息侧） | ❌ notice 类事件刷新即失（`refresh-gap-design.md:126-150`） |
| 复用现有卡 | 无新卡可复用 | 直接吃 `StreamCard` / `PayloadSection` / `SegmentedTabs` | 直接吃 `EnvCard` / `NoticeRow` |

**推荐 B**，并把 C 的那一半（读回）作为 B 的 `readback` 分支复用：`sessions.events` 在 0.53 **已经落地**（`sessions.ts:905-960`，返回原始 event、`data` 不裁剪；ADR-104 里「`sessions.events` 未实现」的说法已过时），只是 web 侧一行都还没调。

### 1.7 最小增量形状（B 路）

照搬 `system_context` 的既有套路（服务端派生、additive、带 `hash` 去重——`sessions.ts:267` 声明 port、`:773` 渲染、web 侧类型 `apps/web/src/gateway/types/sessions.ts:170-215`）：

```ts
// sessions.ts:1124 附近：对 all（切片前）算一遍，再随消息一起下发
export interface ProjectionView {
  /** 取值域沿用 ADR-104 的闭集（ADR-104:156-157），不得在此自创枚举 */
  mode: 'passthrough' | 'placeholder' | 'externalize' | 'archive_notice';
  /** 与 messages[i].tool_call_id 相同，便于批量卡按 id 汇总 */
  tool_call_id: string;
  /** core 渲染好的、模型真正看到的那一字节。UI 只展示，禁止自行拼装 */
  placeholder_text: string;
  /** 与实时事件卡去重（照抄 system_context.hash 的做法） */
  placeholder_hash: string;
  /** 原始体量；拿不到就 null，不要写 0 */
  original_bytes: number | null;
  original_lines: number | null;
  /** inline=正文就是原文；inline_truncated=正文是原文前 8KiB；readback=正文已是占位，原文只在事件日志；gone=不可恢复 */
  original_available: 'inline' | 'inline_truncated' | 'readback' | 'gone';
  /** 需要跨源读取时给句柄，UI 不做推断 */
  readback?:
    | { kind: 'events'; tool_call_id: string; from_seq: number }
    | { kind: 'file'; path: string; offset?: number; length?: number }
    | { kind: 'handle'; handle_id: string };
  /** 冻结集合的来源事件 seq（审计锚点） */
  since_event_seq: number;
  /** ADR-104 D4 的声明 id；声明机制落地前恒为 null */
  declaration_id: string | null;
}

// SessionDetail.messages[i] += projection?: ProjectionView   // sparse：没有就是没被投影，UI 与今天完全一致
// SessionDetail += projection_summary?: {
//   total: number; bytes_saved: number; modes: Partial<Record<ProjectionView['mode'], number>>;
// }   // 整会话当前态（不是当前窗口）：由同一趟两分支判定累加得出，
//     // 因此包含「正文已是占位但 id 已不在冻结集合」的历史条目（§1.3 陷阱 5），别去扫事件日志凑这个数
```

三条实现约束（每条都能踩出 bug）：

1. **在切片之前算**（`all` 而非 `all.slice(start, end)`）。否则 §1.4 陷阱 3 会在服务端复现（窗口切掉 owning assistant ⇒ 工具名与 summary 丢失）。
2. **用两分支判定，别只信 id 集合**（§1.3 陷阱 5）：

```ts
for (const m of all) {                       // all = 落盘全量 messages
  if (m.role !== 'tool' || !m.tool_call_id) continue;
  const id = m.tool_call_id;

  // 分支 A：正文已经是占位 ⇒ 它就是模型现在看到的那一字节，原样搬，绝不重算
  if (isClearedToolResult(m.content)) {
    m.projection = {
      mode: 'placeholder',
      tool_call_id: id,
      placeholder_text: m.content,            // 逐字，别 trim、别补空格
      placeholder_hash: hash(m.content),
      original_bytes: bytesFromEventLog(id),  // 事件日志里该条结果的字节数；取不到 null
      original_lines: null,
      original_available: 'readback',
      readback: { kind: 'events', tool_call_id: id, from_seq: sinceSeq(id) },
      since_event_seq: sinceSeq(id),
      declaration_id: null,
    };
    continue;
  }

  // 分支 B：正文还是原文，但 id 在当前（段级）冻结集合里 ⇒ 现在就该显示占位
  if (clearedIds.has(id)) {
    const text = formatClearedToolResult(all, id, m.content);  // core 的同一个函数
    m.projection = {
      mode: 'placeholder', tool_call_id: id,
      placeholder_text: text, placeholder_hash: hash(text),
      original_bytes: byteLength(m.content),
      original_lines: m.content.split('\n').length,
      original_available: capped(id) ? 'inline_truncated' : 'inline',
      since_event_seq: sinceSeq(id),
      declaration_id: null,
    };
  }
}
```

**分支 A 不需要任何 id 集合**——它靠正文自证。这是本设计对"段级冻结集合会被清空"（陷阱 5）的免疫点：即便集合空了，落盘里的占位也能被认出来。
3. **不要新增 core 字段**。`ProjectionView` 是 wire-only 派生（跟 `system_context` / `context_usage` 同一层），core 的 `SessionState` 一个字节都不动。

读回动作：给 `sessions.events` 的 params 加一个可选 `tool_call_id?: string`（`sessions.ts:905-960` 现有 params 是 `from_seq` / `types` / `limit`），比新开一个 RPC 便宜，且天然带分页。

---

## 2. 现有卡片能力盘点（先盘点，再设计）

全部在 `apps/web/src/domains/chat/` 与 `apps/web/src/components/`，**没有一张新卡需要从零写**。

| # | 卡/组件 | 位置 | 可复用零件 | 本卡用到哪一层 |
| --- | --- | --- | --- | --- |
| 1 | `StreamCard` | `StreamCard.tsx:41`（props）/ `:70-146`（实现） | 折叠壳：`header`（`:106-115`，含 title + `meta`）、`<summary>`（`:141`）、`actions` 槽（`:142`，**在 summary 之外、折叠也可见**）、`footer`、`tone`、`entering` 入场只播一次、`defaultOpen`；不可折叠形态 `:117-126` | 全部三层 |
| 2 | `ToolCard` | `ToolCard.tsx:173-291` | `StreamCard` 预设：状态 glyph + 工具名 title（`:204-215`）、耗时 `meta`（`:216-221`）、`toolSummary` 摘要（`:187`）、错误摘要进 `actions`（`:223-230`，**折叠也可见的既有先例**）、三段 `PayloadSection`（`:241-255`）、debug meta（`:266-288`） | 层级 1 + 2 的宿主 |
| 3 | `PayloadSection` | `ToolCard.tsx:61-125` | 「一段文本」的完整能力：折叠按钮（`aria-expanded`/`aria-controls`，`:78-95`）、折叠态预览 + 「共 N 行」提示（`:87-94`）、展开后分块「加载更多」（`:101-112`）、`CopyButton`（`:96`）、debug 行列字节（`:118-122`）；预览常量 `tool-cards.ts:385-387`（`PREVIEW_LINES=20` / `PREVIEW_BYTES=8KiB` / `PAYLOAD_CHUNK_BYTES=200KiB`） | **层级 2 的两个面板本体** |
| 4 | `EnvCard` | `EnvCard.tsx:39-130` | `facts` 一行事实（声明 `:68`，进 summary `:97`）、`blocks` 原文块原样渲染（声明 `:70`，渲染 `:126`；注释 `:23`：「原文就是事实」）、`footnote`（`:60`）、`meta` 覆盖（`:96`） | 层级 3 批量卡的样式与 ADR 对齐 |
| 5 | `EnvNoticeCard` / `EnvNoticeBlock` | `env-notice.ts:83-103` / `:105-115` | 通知卡的数据形状、`ENV_NOTICE_DETAILS_MAX = 11`（`:117`）、`kept`/`droppedLines` 截断口径（`:209, :216`）、`mergeEnvNoticeCards`（`:226-238`）、`foldAdjacentEnvNotices`（`transcript-items.ts:2178`） | 层级 3 + §3.7 的缺陷 |
| 6 | `NoticeRow` | `EventRow.tsx:402-424` + `noticeView`（`:202-245`，`context.cleared_tool_result` 分支在 `:234`） | `role="status"` 标题 + `EventPayload` 展开体；现成的「一条通知 + 展开证据」 | 层级 3 的备用宿主 |
| 7 | `SegmentedTabs` | `packages/plugin-ui/src/Tabs.tsx:9-60` | `role="tablist"`（`:39`）+ 方向键 + `aria-selected` + `panelId`→`aria-controls`（`:52-54`）；`className` 可覆盖（默认 `mt-3.5`，卡内用 `mt-0` 压掉） | **层级 2 的切换器** |
| 8 | `CopyButton` + `copyText` | `components/CopyButton.tsx:8-18` + `components/ui/clipboard.ts:1-9` | 复制 + toast，`label` 进 aria-label | 层级 2 的两个复制按钮 |
| 9 | `PermissionCard` / `AskCard` | `PermissionCard.tsx:48`、`AskCard.tsx:44`、`:171` | `aria-labelledby` / `aria-expanded` 的审批卡范式 | 与 ADR-104 §8.5 的 C1h 披露行对齐用（不是本卡） |
| 10 | `HistoryToolItem` | `history-tools.ts:20` | 历史工具卡的**数据形状**（`args` / `output` / `callId` / `status`） | 层级 1 的数据挂点 |
| 11 | `ToolCardView` | `tool-cards.ts:7-31` | 卡片的统一视图形状（`args`/`result`/`callId`/`truncated`…） | 层级 1/2 的数据挂点 |

两条现成的硬约束（照抄，别违反）：

- `StreamCard.tsx:19-20`：「`summary` 里不得再放可点元素」⇒ **投影 badge 只能放 `meta`（纯文本 span）**；任何可点控件（切换器、复制、读回）必须去 `actions`（`:142`，在 summary 外、始终可见）或卡体里。
- 刷新缺口（`docs/dev/handoff/refresh-gap-design.md:126-150`）：从事件派生出来的东西刷新后会消失 ⇒ **投影卡的载荷必须挂在消息上**（`sessions.get`），不能只靠 `context.cleared_tool_result` 的 notice。

---

## 3. 交互规格

### 3.1 三层结构（一次说清）

```
工具卡（现有 ToolCard，+projection）
├─ meta 槽：〔badge〕模型看到：占位          ← 层级 1，常驻、纯文本、折叠也在
└─ 卡体首段（只有 projection 存在时出现）
   ├─ SegmentedTabs： 原文视角 | 模型视角    ← 层级 2（放 actions 槽或卡体首行）
   └─ 两个 PayloadSection，各自有 CopyButton
批量卡（现有 EnvCard/NoticeRow 样式，锚在消息侧）
└─ 「本会话有 N 条被投影，省了 X」+ 可展开条目清单   ← 层级 3
```

### 3.2 层级 1：投影 badge（常驻可见）

- 位置：`StreamCard` 的 `meta` 槽，紧挨现有耗时（`ToolCard.tsx:216-221`）。**不进 `summary`**（那里不许放可点元素，`StreamCard.tsx:19-20`），**不能靠 hover**（用户口径明确）。折叠态下 `meta` 仍渲染（`StreamCard.tsx:141`），正好满足「折叠也要看得见」。
- 文案（zh-CN，与 ADR-104 §8.5 的 C1h 披露行同一语义，`docs/adr/ADR-104-context-projection-policy.md:849-857`）：
  - `placeholder`：`模型看到：占位`（长解释走元素 `title` 属性，不做弹出层）
  - `externalize`：`模型看到：句柄`
  - `archive_notice` / `passthrough`：**不出 badge**（ADR-104:854：这两个不进 C1h 披露）
- 语义：纯展示元素，**不是 button**，无 tabindex，不进 tab 序列；不是状态变化，不挂 `aria-live`。
- 词表复用：现有 trim 通知已经在说「已换占位符」（`apps/web/src/i18n/messages/zh-CN.ts:1171`，en `:1222`）⇒ 新增 key 一律用 `chat.projection.*` 前缀，别另造一套说法。

### 3.3 层级 2：双层切换（模型视角 | 原文视角）

- 控件：`SegmentedTabs`（`Tabs.tsx:9-60`），两个 tab：`original` / `model`；必须给 `panelId`（`aria-controls`，`:52-54`），面板 `id={panelId}` + `aria-labelledby`。
- 两个面板都是 `PayloadSection`（`ToolCard.tsx:61`），零新渲染逻辑：
  - 原文视角：`label={t('chat.projection.original')}`、值为原文、复制文案「复制原文」。
  - 模型视角：`label={t('chat.projection.modelView')}`、值为 `projection.placeholder_text`、`defaultOpen=false`、复制文案「复制模型看到的文本」。
- 面板内容按 `original_available` 决定：

| `original_available` | 原文视角面板 | 默认 tab | badge |
| --- | --- | --- | --- |
| `inline` | 正文（完整） | **原文** | 模型看到：占位 |
| `inline_truncated` | 正文 + 一行 warn：「已截到前 8 KiB，共 {original_bytes} B」+「读回完整原文」 | **原文** | 同上 |
| `readback` | 「原文不在消息里」+ 元信息（工具名 / 字节数 / 发生 seq）+「从事件日志读回」 | **模型视角** | 同上 |
| `gone` | 「原文已不可恢复」+ 元信息，无按钮 | **模型视角** | 模型看到：占位（danger tone） |

- 切换器状态是**每张卡独立的 `useState`**（不写 store、不持久化）：它是阅读姿态，不是偏好；跨卡记忆会让人误判「所有卡都显示的是原文」。

### 3.4 复制

两个独立按钮，文案必须一眼分清：

| 按钮 | 复制内容 | i18n key | 语义 |
| --- | --- | --- | --- |
| 复制模型看到的文本 | `projection.placeholder_text`（**逐字**，含 `[cleared ` 前缀与 `]`） | `chat.projection.copyModel` | 让你能把它粘进别处，重现同一份输入 |
| 复制原文 | 原文（完整或已加载部分） | `chat.projection.copyOriginal` | 现有 `PayloadSection` 的默认复制 |

约束：`placeholder_text` 只读自 wire，**前端不许 trim / 补空格 / 本地化**——它不是 UI 字符串，是一段要逐字还原的模型输入。

### 3.5 层级 3：批量汇总卡

- 宿主：`EnvCard`（`EnvCard.tsx:39`）。选它而不是 `NoticeRow`：它自带 `facts`（标题数字）+ `blocks`（清单块）+ `footnote`（审计锚点），是 0.52 打磨过的「一眼看事实、展开看证据」范式（`EnvCard.tsx:68-70, 96-97, 126`）。
- 标题（`facts`）：`模型看到占位 {total} 条 · 省 {bytes_saved}`。数字来自 `SessionDetail.projection_summary`（整会话口径，不是当前窗口）。
- 展开体：条目清单，每行 `工具名 · {original_bytes}B · since seq`，行尾两个动作：`跳转`（锚到那张工具卡）+ `复制模型看到的文本`。
- 上限：复用 `ENV_NOTICE_DETAILS_MAX = 11` + `droppedLines`（`env-notice.ts:117, 216`）——别发明第二个上限。
- 位置：**锚在消息侧**（第一张被投影的工具卡之前），不是锚在 `context.cleared_tool_result` 事件上（那个刷新就没了，§2 约束二）。

### 3.6 默认展示哪层（拍板）

**默认 `原文视角`，`模型视角`一键可达，badge 常驻。**

理由（按重要性）：
1. 用户口径就是「超集」——原文是基线，占位是**增量信息**；把基线藏起来等于用一次点击换一次「内容还在不在」的焦虑。
2. 压缩前后视觉连续：压缩不该让卡片突然从「有内容」变成「一句占位」。突然变化正是 C1h 要防的那种惊讶。
3. 反向风险更大：默认占位会让人以为内容被永久删了，直接去翻日志/文件（`PayloadSection` 的 20 行预览就是为「先看一眼」设计的）。
4. 例外（§3.3 表）：`readback` / `gone` 时原文面板本来就是空的，硬按「原文默认」会得到空面板 ⇒ 这时自动落到 `模型视角`，并在 badge 上写明原因。

### 3.7 折叠 / 合并不能吞掉投影信息（现有缺陷）

- **现有行为**：相邻通知卡会合并，`mergeEnvNoticeCards`（`env-notice.ts:226-238`）只保留 `lines` 的前 11 条，**返回对象里没有 `blocks`** —— 也就是说，今天任何塞进 `blocks` 的「原文块」，一旦相邻卡合并就消失。
- ⇒ 投影信息**不能只放 `blocks`**。硬性要求：合并必须保留 `projectionCount`（可求和）+ 首条 `since_event_seq`（审计锚点），badge 从合并后的卡上算。
- 修法（additive，不动现有 fixture 语义）：`EnvNoticeCard` 增 `projectionCount?: number`；`mergeEnvNoticeCards` 里 `projectionCount: (head.projectionCount ?? 0) + (next.projectionCount ?? 0)`；`blocks` 允许累加（拼接 + 各自 label 前缀）。
- 更简单的保险：**投影 badge 挂在工具卡上（层级 1）**，而工具卡不参与任何通知合并 ⇒ 即使批量卡被合并、被截断，每一条被投影的工具结果**各自**仍带着自己的 badge。**层级 1 是 3.7 的最终兜底。**

### 3.8 无障碍与键盘

- badge：纯文本 + `title`，无 tabindex；不挂 `aria-live`。
- 切换器：`SegmentedTabs` 自带 `role=tablist` + 方向键 + roving tabindex（`Tabs.tsx:39-60`），**不要自己写第二套**。
- 面板：`role="tabpanel"` + `id={panelId}` + `aria-labelledby`，切换时焦点不移动（不是 dialog）。
- `PayloadSection` 的折叠按钮已经是 `aria-expanded` + `aria-controls`（`ToolCard.tsx:78-95`）——双层切换下面再叠一层折叠是允许的（语义不同：视野切换 vs 文本展开）。
- 键盘路径：`Tab → 卡标题 → 切换器（←/→）→ 面板内折叠 → 复制`，任何一步都不需要鼠标。
- 动效：不新增动画，沿用 `entering`（一次性入场）。

### 3.9 与 `verbosity` 的契约

`apps/web/src/domains/chat/chat-visibility.ts`：`verbosity: minimal` 会**整卡隐藏**工具卡 ⇒ 投影卡跟着消失，不额外补偿（minimal 的语义就是「别给我看工具细节」）。

但必须守住一条：**不要在 minimal 下单独塞一条「N 条被投影」横幅**——那会把 minimal 变成「只显示坏消息」的界面，而且 `scripts/check-chat-visibility.ts` 用 fixture 逐项比对可见性，新增 item 类型必须同步 fixture。**本轮禁改 `scripts/**` ⇒ 列为实施前置任务**（§7.1）。

---

## 4. 可升级性：把投影抽成通用能力

用户已说明「后续这个我们还会进行升级，卡片的显示等等」。所以数据形状必须**一次定好、按模式扩展**，而不是为 `placeholder` 写死。

### 4.1 模式矩阵（复用点）

`mode` 的取值域**照抄 ADR-104 的闭集**（`docs/adr/ADR-104-context-projection-policy.md:156-157`）：`'passthrough' | 'placeholder' | 'externalize' | 'archive_notice'`。**不要在卡里自创枚举**（如 `truncate` / `redacted`）——ADR 明确「新增模式必须先改本 ADR」，卡自创会让两侧词表分叉。截断与脱敏不是 projection mode：它们是读路径裁剪（`capToolMessages`）与落盘前 guardrail，用 `original_available` 表达就够。

| mode | 本轮 | 卡形态 | 复用本卡的哪一层 | 语义（ADR-104） |
| --- | --- | --- | --- | --- |
| `placeholder` | ✅ 现实现 | 单条双层卡 + badge | 层级 1+2+3 全用 | `:152`：替换正文，消费 C1h 豁免 |
| `archive_notice` | 代码就绪、白名单未启 | **批量清单卡**（条目 = id + 工具名 + 字节 + 读回位置，**不含正文**） | 层级 3（`EnvCard` + 清单块） | `:153, :178`：卡本身不替换正文；正文靠读回 |
| `externalize` | ❌ 未实现 | 单条双层卡（「占位」= 句柄引用） | 层级 1+2（同一套面板，`placeholder_text` = 句柄文本） | `:154`：与 placeholder 同为「消费 C1h 披露」类 |
| `passthrough` | ✅ 逃生门 | **不出卡、不出 badge** | — | `:151`：逐字一致，不消费豁免；`:854` 明确不显示披露 |

### 4.2 字段到模式的映射

| 字段 | `placeholder` | `archive_notice` | `externalize` | 备注 |
| --- | --- | --- | --- | --- |
| `mode` | ✅ | ✅ | ✅ | 闭集 |
| `placeholder_text` | 模型实际看到的那一字节 | —（卡就是消息，没有「另一层」） | 句柄文本 | 卡只展示，不拼装 |
| `original_bytes` / `original_lines` | ✅ | ✅（`:178` 的 `bytes`） | ✅ | 拿不到写 `null` |
| `original_available` | `inline` / `inline_truncated` / `readback` / `gone` | 恒 `readback` | `readback` | 决定默认 tab（§3.3） |
| `readback` | `{kind:'events', …}` | `{kind:'file', …}` | `{kind:'handle', …}` | **必须可判别**，UI 不猜 |
| `declaration_id` | ✅（D4 条件②） | — | ✅ | 声明机制未落地前恒 `null` |

`readback` 用可判别联合（discriminated union）而不是 `{kind, ...any}`：三种来源的 UI 动作完全不同（拉事件 / 按偏移读文件 / 解句柄），一个 `any` 会把「不支持」变成运行时惊喜。

### 4.3 组件层的通用化（三个零件，不做四个）

```
ProjectionBadge({ view })            → 纯文本 chip，按 mode 选 key（§3.2）
ProjectionPanes({ view, original })  → SegmentedTabs + 两个 PayloadSection（§3.3）
ProjectionList({ entries })          → 清单（层级 3 的展开体），条目可带 readback 动作
```

三个零件都不认识「tool」这个概念——只认识 `ProjectionView`。所以 `archive_notice` 的归档卡只需换 `ProjectionList` 的数据源，`externalize` 的句柄卡只需在 `ProjectionPanes` 里换 `placeholder_text` 的来源。**工具卡只是这三个零件的第一个宿主，不是它们的定义域。**

---

## 5. 与 C1h 的关系：这张卡能不能充当「有可见记录的显式豁免」？

**结论：不能。卡是豁免的「可见面」，不是「判据」。**

### 5.1 为什么不能

ADR-104 要求四真同时成立（`docs/adr/ADR-104-context-projection-policy.md:287-300`）：① `mode ∈ {placeholder}`；② `declaration_id` 存在；③ 审计里有 `cleared_tool_call_ids` 且审计的 `declaration_id` 等于声明的；④ 请求视图由 core 从声明 + 冻结计划纯函数渲染。

对照本 worktree 的代码实况：

| D4 条件 | 代码里有吗 | 证据 |
| --- | --- | --- |
| ① `context_projection.mode` | ❌ **0 命中** | `grep -rni "context_projection" --include=*.ts --include=*.tsx .` → 0 行（全仓库，含 `src/`、`packages/`、`apps/`） |
| ② `declaration_id` | ❌ **0 命中** | 同上（`declaration_id` 亦 0） |
| ③ `cleared_tool_call_ids` | ✅ 有（但是**段级**） | `packages/core/src/types/session.ts:90`；写入 `execution-unit.ts:3733-3738`；两个后端都持久化 |
| ③ 审计的 `declaration_id` 对齐 | ❌ 审计类型不存在 | `context_projection_audit` 0 命中 |
| ④ `isProjectionExempt` | ❌ **0 命中** | 逐字 grep 无 |

> ⚠️ 一条要回给 main 的事实：ADR-104 §6 的字段表把 `SessionState.context_projection_audit` 标为「**已实现**」（`:519`），但本 worktree（`0.53-proj-card`，基于 main `d669aa36`）代码里 `context_projection` / `declaration_id` / `isProjectionExempt` **一处都没有**。要么实现落在别的分支，要么 ADR 的「已实现」是超前登记。**投影卡的 `declaration_id` 字段因此本轮只能恒为 `null`。**

更根本的一条：即便四真齐备，条件④是**服务端纯函数**性质，UI 永远无法证明它。若把「卡存在 ⇒ 放行」写进判定，就凭空造出「UI 有 ⇒ 放行」的旁路——ADR-104:298-300 明确豁免的唯一落点是 `isProjectionExempt(session, audit)`，运行时与门禁共用。卡不是 durable 事实，durable 事实是 `SessionState` + 事件日志。

### 5.2 卡能做的三件事

1. **可见记录**：把人能读的「模型看到的不是这份」摆在眼前。这正是 C1h 的实质要求（变形必须在用户侧可见），也是 ADR-104:849「整张卡最重要的一行」的同一条原则——只是从审批时刻（§8.5 的权限卡）延伸到事后（transcript）每一个条目。
2. **免费的一致性 oracle**：卡上的 `placeholder_text` 与 `withClearedToolResults` 真正喂给模型的那段**同一个来源**，天然逐字相等；哪天有人把它改回「前端复刻」，立刻不等。这条可以固化成一条 check 断言（本轮禁改 `scripts/**`，列为 follow-up）。
3. **审计链的最后一跳**：`declaration_id` 上 wire 之后，卡能显示「是哪条声明导致我现在看到占位」，用户不必去翻 JSON。

### 5.3 对 C1h 红绿的影响

**零影响。** C1h 今天 pending 的原因是「落盘 = 原文，请求 = 占位」（`scripts/check-append-only-context.ts:505-590`，V1 未修）。投影卡不写落盘、不改请求视图，所以它既不能让 C1h 变绿，也不会让它变红。**别拿这张卡去"修" C1h**——它修的是「用户看不见变形」这个可用性问题，不是「请求与落盘不一致」这个不变量问题。

---

## 6. 未做 / 风险（已知边界）

1. **大原文渲染性能**。`PayloadSection` 已有 20 行 / 8 KiB 折叠预览 + 200 KiB 分块「加载更多」（`tool-cards.ts:385-387`，`ToolCard.tsx:87-112`），所以**不要一次性把 MB 级原文塞进 DOM**。硬要求：**未激活的面板不 mount**（`SegmentedTabs` 只渲染 active panel；别为了"切换不闪"把两个都渲染出来）。原文面板只在用户切到「原文视角」时才 mount。
2. **剪贴板体积**。`copyText`（`components/ui/clipboard.ts:1-9`）**没有体积上限**，`navigator.clipboard.writeText` 在主线程序列化。建议：`original_bytes > 4 MB` 时按钮文案带提示（「复制原文（N MB，可能较慢）」），失败要有 toast 而不是静默；`placeholder_text` 永远很小（≲120 码点），不设限。
3. **占位文本长度对 UI 的影响**。构造上最长约：`[cleared ` + 工具名 + `: ` + 60 码点 summary + ` -> exit -2147483648, 123456 lines]`。`meta` 槽放不下时要 `ellipsis`，但**别把 `-> exit N` 截掉**——那是唯一有信息量的尾巴。因此 badge 只显示「模型看到：占位」几个字，全文放面板里。
4. **码点是码点、字节是字节**。summary 截的是 60 **码点**（`cleared-tool-result.ts:21, 99`），`original_bytes` 是 **UTF-8 字节**。两个数同卡出现时必须各自带单位，别混着说「60」。
5. **`readback` 可能变死链**。`original_available` 是**请求时快照**；事件日志/执行记录被清理后，读回会失败。要求：读回失败必须明确降级 UI（「原文已被清理」），不许静默空白。
6. **`projection_summary` 的性能**。整会话口径要扫全量 messages，而 `sessions.get` 是热路径。缓解：只统计被投影的条目（本来就是 sparse），一次遍历算完，别在渲染层二次扫。
7. **没做的**：core 的 `context_projection` / 审计 / `isProjectionExempt`（§5.1，全部 0 命中）；`archive_notice` / `externalize` 的落地；ADR-104 §8.5 那张**审批卡**（本规格只对齐它的文案与「不得折叠」条款，不实现它）；`scripts/**` 的一切改动。

---

## 7. 验收标准与实施前置

### 7.1 实施前置（缺一条就别开工）

- [ ] **实测 §1.5 的张力**：造一条 cleared 工具结果 → 触发一次压缩 → **重启进程**后看 `sessions.get` 该条正文是原文还是 `[cleared `。这决定 `original_available` 的默认分支与 §3.3 的默认 tab。3 步复现，别猜。
- [ ] **拍板 §1.7 的 wire 字段**（`projection` / `projection_summary`），并确认 `declaration_id` 本轮恒 `null`。
- [ ] 确认 `capToolMessages` 的 8 KiB 截断怎么在 wire 上表达（当前是静默拼 `... [truncated]`，`original_available:'inline_truncated'` 需要服务端判定后下发）。
- [ ] 实现 PR 里同步 `scripts/check-chat-visibility.ts` 的 fixture（本轮禁改 `scripts/**`）。

### 7.2 可判定的验收

1. 「复制模型看到的文本」写进剪贴板的内容 === `projection.placeholder_text` === core `formatClearedToolResult` 的输出，**三者逐字**（含 `[cleared ` 前缀、空格、`->`）。
2. 折叠态能看到 badge：DOM 断言 badge 位于 `<summary>` 的 `meta` 槽内，且 `<summary>` 内**没有**新增 `<button>` / `[tabindex]`（`StreamCard.tsx:19-20` 的约束）。
3. 刷新后投影卡仍在（不依赖 live notice）——关掉事件流重载页面即可验。
4. `verbosity: minimal` 下投影卡随工具卡一起消失，且页面没有多出独立横幅。
5. 相邻通知卡合并（`mergeEnvNoticeCards`）后 badge 与 `projectionCount` 仍在（回归 §3.7 的缺陷）。
6. 键盘路径完整：Tab 到切换器、←/→ 切 tab、`aria-selected` 与 `tabpanel` 的 `aria-labelledby` 正确；badge 不进 tab 序列。
7. `original_available: 'gone'` 时原文面板无按钮、默认落在「模型视角」、badge 带 danger tone。
8. `mode: 'passthrough'` 的条目**不出 badge、不出切换器**（回归 §4.1）。

---

## 8. 一句话给 reviewer

这张卡的价值不在「多一个开关」，而在**把「用户看到的」与「模型看到的」并列摆在同一张卡上、且二者都来自同一个渲染函数**。做到这一点，双实现漂移这个架构级隐患就不可能发生；做不到这一点（前端复刻 formatter），卡本身就是新的 bug 源。
