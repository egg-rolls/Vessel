# 上下文口径不一致审查与统一方案（q-context-debug）

> 任务书：用户报告「系统提示阈值（runtime `context_window` 通知）与 rotate 工具判断
> （`context_ratio`）不一致，UI 又是第三个数」。用户裁定：审查 + 统一一个数值/口径。
> 本单**零代码改动**，只调研 + 设计。分支 `design/q-context-debug`（基于 redblue-dev b939f4ce）。
>
> **TL;DR**：三处消费侧其实早已共用同一个写侧（`ExecutionUnit.currentContextTokens`），
> 不一致的根因在**写侧自己**：每个 run 的第一次压力预警走了「整窗上界估算」兜底，
> 而整窗包含本段**已被冻结占位集合替换掉的工具结果全文**；请求路径（`llm.request` /
> provider 实测 / rotate / UI）用的是占位替换后的**请求视图**。同一函数、不同时刻、
> 不同输入population ⇒ 通知 55%、rotate/UI 38%。已用生产会话时间线数据实锤（§2.1）。
> 统一方案 = 让写侧兜底也走请求视图（§3），消费侧零改动。

---

## 1. 三处计量源（file:line）

### 1.1 runtime `context_window` 通知（系统提示阈值）

发射点：`packages/core/src/runtime/execution-unit.ts:4552` `publishContextPressureWarning()`

- 取数：`execution-unit.ts:4558` `const used = this.currentContextTokens(execution)`；
  分母 `max = workingContext.maxTokens`（4554-4555）。
- 阈值：`CONTEXT_PRESSURE_WARN_RATIO = 0.5`（`execution-unit.ts:198`）；
  每 run 每 key 只发一次（`warnedLimitKeys`，4568-4569；run 起点清空，2755）。
- 调用时机：`packages/core/src/runtime/tool-calling-loop.ts:385` —— **每轮迭代顶部、
  请求组装之前**（run 的第一次迭代时本段还没有任何请求视图，见 §2.2）。
- 输出两份：`context.pressure` 事件（4575-4589，**落盘事实**）+ 尾部消息
  `[runtime] context_window: ${used}/${max} (${percent}%) — Use agent(rotate)…`
  （4591-4598，经 `addContext` 进模型上下文）。
- 计量函数链：
  - `currentContextTokens`（`execution-unit.ts:1709-1711`）= `correctedContextTokens(nextRequestTokens)`；
  - `nextRequestTokens`（`execution-unit.ts:1698-1706`）：
    - 有请求视图（`state.requestView`）⇒ `view.tokens + estimateMessagesTokensUpperBound(其后追加的消息)`（增量口径）；
    - **无请求视图 ⇒ `estimateMessagesTokensUpperBound(整窗 messages)`（1702，兜底）**；
  - `correctedContextTokens`（`execution-unit.ts:1680-1686`）：×锚点比值（无锚点 ×`NO_ANCHOR_SAFETY_MARGIN=1.15`，
    `packages/core/src/context/request-view.ts:100`），再以 provider 上次回报压地板（只升不降）。
- 账本生命周期：`accounting()`（`execution-unit.ts:1518-1526`）以 **`workingContext` 对象**为键
  （WeakMap）；而成员宿主 **每个 run 新建窗口**（`packages/agent/src/runtime.ts:1195-1207`
  `contextFactory: () => new RoleAwareContext(new MemoryWorkingContext(...))`，注释明言
  「WorkingContext 是 per-Run 实例」）⇒ **每个 run 起点 `requestView` 必为 undefined**。

### 1.2 rotate 工具的 `context_ratio`

判断源：`packages/agent/src/tool.ts:662` `const ratio = service.contextRatio(callerSession)`

- `packages/agent/src/service.ts:7149-7152`：直接委托 `runtime.contextRatio`，无二次估算。
- 端口实现分两层（`src/agent/agent-service-wiring.ts:421-429`）：
  1. **实时层**（0.52，`src/session/context-ratio-source.ts`）：订阅父事件流
     （`options.parentEvents.subscribe`，wiring:428），只搬运三个事件的现成数字：
     - `context.changed.token_count`（source.ts:105-108）← 写侧 `execution-unit.ts:5413`
       `token_count: this.currentContextTokens(execution)`（每条消息进上下文都发）；
     - `context.pressure.used/max`（source.ts:110-113）← 写侧 4575-4589；
     - `prompt.system_context.context_max`（source.ts:115-118，只取分母）。
     比值 = 最近 `used` ÷ 最近 `max`（source.ts:89-97），百分比 `Math.round`（127-132）。
  2. **兜底层**：`withLiveContextRatio`（source.ts:151-164）实时值缺失时回落宿主
     `packages/agent/src/runtime.ts:1431-1433` `contextRatio = runtime.lastContextRatio`
     ← run **结束**时写入（`execution-unit.ts:2778-2782`，同样是 `currentContextTokens/max`）。
- 用途：**仅信息性**。`tool.ts:669-677` 按同一个 50% 线生成 warning 文案
  （≥50%「recommended」/ <50%「usually unnecessary」）；真正的批准/拒绝走人类审批
  （`tool.ts:684-757`），未批准一律返回 `code:'rotate_not_needed'`（tool.ts:770-776）——
  **该码与 ratio 高低无关**（见 §2.4）。

### 1.3 用户 UI（Web 会话上下文展示）

渲染：`apps/web/src/domains/chat/ComposerChrome.tsx:126-140` `ComposerUsageMeter`
（圆环 + `formatTokenCount` 紧凑格式 `380K`，数据 `usage.used/max`）。

取数（`apps/web/src/domains/chat/useChatTranscript.ts:177-240`）：**live 优先、落盘兜底**：

1. **live**：`agents.tree` 主节点 `context_used/context_max`（运行中 5s 轮询）。
   服务端链路：
   - `packages/serve/src/gateway.ts:2355-2360`：hub 脱敏/摘要后事件 → `agentRegistry.ingest`；
   - `packages/serve/src/agents-registry.ts:216-233` `ingestContext`：
     `context.pressure` 取 `used/max`，`context.changed` 取 `token_count`（**与 rotate 实时层同一套字段**）；
   - `packages/serve/src/gateway/methods/agents.ts:118-119, 184-185`：透出 `context_used/context_max`。
   - 摘要化不丢数：`packages/core/src/events/summarize-event.ts:103-104` 保留 `token_count`。
2. **落盘**：`sessions.get.context_usage`（`packages/serve/src/gateway/methods/sessions.ts:1428+`，
   尾水位缓存）← `src/session/context-usage.ts:272+` `createContextUsageSource`：
   事件日志尾窗**新→旧**取第一条可用数字（`context.pressure.used` → `context.changed.token_count`
   → `llm.request.estimated_tokens` → `llm.response.usage.prompt_tokens`，见模块头表格与 291-300 行注释）。
   注意 `context.changed` **不落盘**（`packages/core/src/timeline/types.ts:341,353` 非事实类型），
   落盘主力是 `llm.request.estimated_tokens`（写侧 `execution-unit.ts:3876`，= 请求视图估算 `contextUsed`）。

### 1.4 附：另外两个相关口径（非本次三处，但统一方案需覆盖/说明）

- **TUI `/context` 与状态栏**：`packages/tui/src/commands/context-command.ts:61-90`
  `estimateContextUsage` 用**老口径 `estimateTokens`**（ASCII 0.25 / CJK 0.5 token/字符，乐观估算），
  与 runtime 上界口径**不同源**（`packages/tui/src/repl/status-metrics.ts:17-21` 复用同一函数）。
  这是第四套口径，系统性偏低，列入后续单（§3.5）。
- **窗口侧 `WorkingContext.tokenCount`**（`packages/core/src/context/context-manager.ts:1236-1245`）：
  整窗上界估算 × 系数（锚点或 1.15），再取 `realTokens` 地板。它**只用于压缩判据**
  （`shouldCompact`，context-manager.ts:1551；`RoleAwareContext.autoCompactAsync`，
  `packages/agent/src/runtime.ts:210-219`），不直接进三处显示。整窗 ≥ 请求视图是**有意保守**
  （窗口拿不到 runtime 侧冻结的占位集合），0.56 ctx-drop 已加「仅边距推动的压缩」拦截
  （`execution-unit.ts:1346-1351` `compactionWouldBeMarginOnly`）与锚点转发修复
  （`packages/agent/src/runtime.ts:228-236` `RoleAwareContext.setContextAnchor`）。语义差异保留并文档化（§3.6）。

### 1.5 数据流总览

```
                    ExecutionUnit（唯一写侧）
                    currentContextTokens(execution)
                    = corrected(nextRequestTokens)
        ┌───────────────┬──────────────────┬─────────────────────┐
        ▼               ▼                  ▼                     ▼
 context.changed    context.pressure   llm.request          endExecution
 .token_count       .used/.max         .estimated_tokens    .lastContextRatio
 (5413, 不落盘)     (4575, 落盘)       (3876, 落盘)         (2778, 内存)
        │               │                  │                     │
        ├───────┬───────┤                  │                     │
        ▼       ▼       ▼                  ▼                     ▼
   rotate实时层  serve注册表  (新→旧尾窗)  sessions.get        rotate兜底
   (source.ts)  (registry)  context-usage.ts  .context_usage   (runtime.ts:1431)
        │           │                        │
        ▼           ▼                        ▼
     rotate文案   agents.tree context_used   Web 落盘兜底
                    │                        │
                    └────────┬───────────────┘
                             ▼
                     Web ComposerUsageMeter（live优先）
```

**结论：消费侧没有第二套计算**（TUI 除外）。0.52（afacc7bc）与 0.55 P0（677ff808）
两轮修复已把「各算各的」收敛成「只搬写侧的数」。剩下的不一致在写侧内部（§2）。

---

## 2. 不一致根因（真实数据实锤）

### 2.1 事故回放（生产会话时间线，只读取证）

会话：main 前身体 `f6484abd-26e3-4e49-8f36-4ccbf3c903fc`
（`~/.vessel/data/sessions/…/timeline.ndjson`，生产 v2.0.0 = main fb44a979，
含 0.52/0.55 P0/0.56 全部修复）。窗口上限 `max = 1,000,000`。

| ts（ms） | 事件 | 关键数字 |
|---|---|---|
| 1795593723680 | `run.started` + `context.cleared_tool_result` | **cleared=564**, added=7（本段冻结占位 564 条工具结果） |
| 1795593723902 | `context.pressure`（=通知的数） | **used=551,250（55.1%）** |
| 1795593724049 | `llm.request`（请求视图估算） | **estimated_tokens=380,817**, message_count=1461 |
| 1795593762816 | `llm.response`（provider 实测） | **prompt_tokens=380,851** |
| 1795593762819→1795593882841 | `agent(rotate)` 调用→结果 | **context_ratio=0.382954（38%）**，reason=`approval_timeout` |
| 同期 | 用户 UI | **≈380K**（agents.tree / sessions.get 同源） |

压力预警与请求估算**同一轮迭代、相隔 147ms**，差 **170,433 token（≈17 个百分点）**。
provider 实测与请求估算几乎逐字吻合（380,851 vs 380,817，锚点比值≈1.0）——
**请求视图口径是准的，通知的数是虚高的**。

且这是**系统性**的：该时间窗内每个 run 起点都复现（pressure.used 542,663 / 544,561 /
551,250 / 557,490 / 557,519 / 560,693 / 561,766，对应请求估算 377,890→392,040）。
任务书里的「65% vs 38%」是同一机制在占位体积更大的会话上的表现。

### 2.2 机制：run 起点兜底忽略冻结占位集合（主因）

时序链（全部 file:line 见 §1.1）：

1. 成员宿主每 run 新建 `RoleAwareContext`（runtime.ts:1195-1207）⇒
   `accounting()` 以窗口对象为键（execution-unit.ts:1518-1526）⇒ 新 run 账本空白，
   `requestView = undefined`。
2. 段起点顺序：`adoptStoredAnchor`（3012）→ `compactAtSegmentStart`（3022，内部
   `freezeSegmentProjection` 冻结占位集合，1865-1870）→ `runToolCallingLoop`（3140）。
   **冻结集合在第一次压力预警之前就已存在**。
3. 循环第一轮顶部（tool-calling-loop.ts:385）发压力预警 ⇒ `nextRequestTokens` 走
   **1702 行兜底：`estimateMessagesTokensUpperBound(整窗)`** —— 整窗含 564 条工具结果
   **全文**（append-only，历史不改写），而这些全文在本段**每一次请求**里都会被
   `withClearedToolResults` 换成小占位符。
4. 请求组装（3789-3799）：`buildRequestMessages`（5223-5272）应用冻结集合
   （5232-5237）⇒ `estimateRequestViewTokens`（含 tools/图片）⇒ `contextUsed` ⇒
   `llm.request.estimated_tokens`（3876）。这才是 provider 真正看到的体积。
5. 第一条请求之后 `requestView` 有值（3795-3798），后续 `context.changed`（5413）走
   增量路径 ≈ 请求口径 ⇒ rotate 实时层与 serve 注册表搬到的都是 ≈38%。
6. **通知（run 起点整窗）与 rotate/UI（请求视图）从此各说各话**，且通知每 run 重发一次
   （`warnedLimitKeys` 按 run 重置），用户反复看到「55% 该 rotate 了」而批准卡说
   「38% 通常不必」。

一句话：**合同 1（`request-view.ts` 模块头「显示 = 下一次请求视图的估算」）在 run
起点兜底路径上没有兑现**——兜底估的是「整窗」而不是「下一次请求视图」，两者之差 =
本段冻结占位集合替换掉的工具结果全文（本例 ≈170K）。

### 2.3 次因：增量路径的 population 错位

`nextRequestTokens`（1703-1705）：`messages.slice(view.messageCount)` ——
`messages` 是**工作窗口**（含被 normalize 丢弃的孤儿 tool 消息），而 `view.messageCount`
是**请求视图**条数（`buildRequestMessages` 的 `normalizeMessages` 会丢弃无配对 tool 消息，
5273+；system 覆盖也可能改形）。两个 population 条数不等时，切片偏移错位 ⇒
把已在视图里的消息再估一遍（偏高）或漏估。实测证据：事故段请求条数 1452→1437
（跨 run 窗口只增不减，请求视图反而变短）。量级小于主因，但同属「兜底/增量与请求路径
不同 population」这一根因家族，一并修（§3.2）。

### 2.4 rotate「拒绝」语义澄清（不是 ratio 闸）

事故结果原文：`{"status":"failed","code":"rotate_not_needed","reason":"approval_timeout",
"timeout_ms":120000,"context_ratio":0.382954,…}`。

- rotate **没有** ratio 阈值闸：ratio 只进 warning 文案与批准卡（tool.ts:669-677, 706）。
- 拒绝来自人类审批链路：本次是 **120s 无人应答超时**（tool.ts:733-752），不是「38% 太低不批」。
- 但 `code:'rotate_not_needed'` 这个码名把「超时/无人通道/人拒绝」全装在一起，配合
  「38% < 50% 线」的文案，让调用方（main）合理误读成「工具审查认为不需要 rotate」。
  与通知的「55% 建议 rotate」并排 ⇒ 用户看到的「系统提示要 rotate 但工具说不需要」。
- 口径统一后文案自然一致；码名语义问题单列建议（§3.6）。

### 2.5 为什么 UI 有时也会跳到 55%（潜在第三处打架）

`context.pressure` 是**落盘事实**且比上一条 `llm.request` 新：
- serve 注册表 `ingestContext`（agents-registry.ts:221-226）见 pressure 就用它的 `used/max` 覆盖；
- `sessions.get` 尾窗**新→旧**取值（context-usage.ts:291-300）也会先命中 pressure。

⇒ 每个 run 起点到第一条请求落盘之间（通常几百 ms～数秒），UI 的环也会短暂显示 55%，
随后回落到 38%。用户截到 380K 是稳态值。**修好写侧兜底，这一处连带消失**——
这正是「单一真相源」方案的价值：三处消费侧一行不用改。

### 2.6 历史脉络（为什么修了两轮还有残留）

| 轮次 | 提交 | 修了什么 | 没修什么 |
|---|---|---|---|
| 0.52 | afacc7bc | rotate 读 run 末旧值/unknown ⇒ 实时搬运界面事件 | 当时 `context.changed.token_count` 还是窗口 `tokenCount`（整窗上界） |
| 0.55 P0 | 677ff808 | 写侧统一为 `currentContextTokens`（请求视图+锚点+地板），修「67% vs 实际 105%」 | **run 起点 `requestView=undefined` 的整窗兜底**未应用冻结占位集合；增量切片 population 错位 |
| 0.56 ctx-drop | （锚点转发/边距拦截） | 窗口拿不到锚点 ⇒ ×1.15 高报推动误压缩 | 压缩判据仍用整窗（有意保守，语义不同，保留） |

本单事故 = 0.55 P0 的残留盲区：**占位机制（0.52 V1/0.53）与计数口径（0.55 P0）
在 run 起点没有会师**。

---

## 3. 统一方案（single source of truth）

### 3.0 总判断：真相源**已经存在**，缺的是它对自己合同的兑现

0.52/0.55 P0 之后，架构上已是单一写侧：`currentContextTokens` 一个函数产出
`context.changed.token_count` / `context.pressure.used` / `llm.request.estimated_tokens` /
`prompt.system_context.estimated_tokens` / `lastContextRatio` 五个读数，rotate/UI/TUI-web
全部只搬运（§1.5）。**不需要新建真相源，需要修写侧兜底路径的输入 population**，
让它任何时刻估的都是「下一次请求视图」，与请求路径逐字同源。消费侧零改动。

### 3.1 P1（核心）：run 起点兜底应用冻结占位集合

位置：`packages/core/src/runtime/execution-unit.ts:1698-1706` `nextRequestTokens`。

现状（1702）：`view === undefined ⇒ estimateMessagesTokensUpperBound(整窗)`。
改为：兜底也走本段冻结的投射——

```text
view === undefined 时：
  frozen = segmentClearPlans.get(workingContext) ?? []
  projected = frozen.length > 0 ? withClearedToolResults(messages, frozen) : messages
  return estimateMessagesTokensUpperBound(projected)
```

要点：

- **复用请求路径的同一个函数、同一份冻结集合**（`withClearedToolResults` +
  `segmentClearPlans`，与 `buildRequestMessages` 5232-5237 完全一致）⇒ 无第二套投射逻辑，
  不会漂移。冻结集合在段起点（1865-1870）先于第一次压力预警存在，时序安全。
- `passthrough` / `archive_notice` 模式冻结集合为 `[]`（1870）⇒ 行为与今天逐字相同，
  只有 `placeholder` 模式（本事故模式）的数变小（变准）。
- 合同 5（只许高报）不破：占位后的估算仍是「下一次请求」的上界（新追加消息不在冻结集合，
  按全文估，正确）；tools/图片在兜底路径依旧不计（与今天一致，1694-1696 注释已声明），
  发送前闸（3800）每请求重算并补上，安全边界不动。
- 段起点压缩后 `requestView = undefined`（1325）的兜底同样受益。
- 备选（不推荐）：段起点用 `buildRequestMessages` 实建一次视图并 seed `requestView`。
  更精确（含 normalize/tools），但要在段起点提前拿 tool schema 与 system prompt，
  多一次整窗扫描，且与首次请求重复构建——收益不抵复杂度。P1 最小改法已消除主因（170K 级），
  normalize 丢条的残差是条数级（每条 4 token 开销 + 孤儿消息正文，方向偏高、合法）。

### 3.2 P2：增量切片按源 population 计数

位置：`execution-unit.ts:297`（`requestView` 形状）+ `3795-3798`（写入）+ `1703-1705`（切片）。

- `requestView` 增加 `sourceMessageCount`（构建请求视图时**工作窗口**的条数）；
- 增量路径改 `messages.slice(view.sourceMessageCount)`，不再拿请求视图条数切工作窗口。
- 消除 §2.3 的错位（normalize 丢孤儿 tool 消息时请求视图条数 < 窗口条数 ⇒ 重复估算）。
- 形状是内存态（不落盘、不进事件），无冻结契约风险。

### 3.3 P3：消费侧零改动（证据清单）

| 消费侧 | 为什么自动对齐 |
|---|---|
| runtime 通知 | 就是写侧本身（4558） |
| `context.pressure` 事件 → serve 注册表 → agents.tree → UI live | 搬 `used/max`（registry:221-226），源头变准即准 |
| `sessions.get.context_usage` → UI 落盘兜底 | 新→旧命中 pressure/llm.request，两者同源后不再互相打架（§2.5 的 UI 跳变连带消失） |
| rotate 实时层 | 搬 `context.changed.token_count`（source.ts:105-108），同源 |
| rotate 兜底（lastContextRatio） | run 末同一函数（2778-2782），同源 |
| 批准卡 / warning 文案 | 读同一个 ratio（tool.ts:662-677），百分比取整口径已一致（Math.round） |

### 3.4 P4（后续单）：TUI 口径归队

`packages/tui/src/commands/context-command.ts:90` 与 `repl/status-metrics.ts:20` 的
`estimateContextUsage` 仍用老 `estimateTokens`（乐观口径，系统性偏低，与 web/runtime 不同源）。
建议改读同一份账本（会话状态/事件里的现成读数），或至少换用
`estimateMessagesTokensUpperBound` + 锚点。TUI 是独立表面、不在本次三处之列，单列跟进。

### 3.5 P5：文档漂移清单（实现单一并修正，纯注释）

1. `packages/agent/src/service.ts:7141-7148`：「`context.changed.token_count` =
   `ContextManager.tokenCount`」——0.55 P0 起已是 runtime 账本（`currentContextTokens`），注释过期。
2. `src/session/context-ratio-source.ts:10-16`：「分子 = `ContextManager.tokenCount` 原值」——同上过期。
3. `src/session/context-usage.ts:44-50`：「`estimated_tokens` 存的就是
   `execution.workingContext.tokenCount`」——与同文件 0.55 P0 头注自相矛盾，过期。
4. `execution-unit.ts:4556-4557`「与显示/闸同一个数」——P1 落地后才真正成立，补一句
   「兜底亦应用冻结占位集合」防止回退。

### 3.6 保留并文档化的语义差异（不是 bug，不统一）

- **压缩判据用整窗 `tokenCount`**（context-manager.ts:1236-1245）：窗口拿不到占位集合，
  整窗是请求视图的上界，有意保守；误压缩由 `compactionWouldBeMarginOnly`（1346-1351）拦。
  与显示口径**语义不同**（触发判据 vs 现值），保留。
- **provider `prompt_tokens` 只做地板/兜底**：它是「上一次请求」的真实大小，天然慢半拍
  （request-view.ts 合同 1），不许当现值。
- **UI 落盘兜底慢半拍**：历史会话/重启后只有落盘读数，最新也是上一条请求的估算——可接受，
  文档说明即可。
- **rotate 的 ratio 是信息不是闸**：拒绝永远来自人类审批（超时/拒绝/无通道）。
  `rotate_not_needed` 码名误导（§2.4），但结果形状是冻结契约且已带 `reason` 字段——
  建议调用方文档强调「看 reason 不看 code」，码名改动另议（不在本单）。

### 3.7 验收口径（只读核对，不加探针）

修复后在任一 `cleared > 0` 的会话时间线上核对：

1. 每个 run：`context.pressure.used` ≈ 紧随其后的 `llm.request.estimated_tokens`
   （差 = 两点之间追加的尾部消息，典型 <1%；事故样本的 45% 差消失）。
2. 同 run 内 rotate 的 `context_percent` == 通知百分比（同一 ratio、同一取整）。
3. `agents.tree.context_used` 跨 run 起点连续，不再 55%↔38% 跳变。
4. 发送前闸与压缩判据行为不变（`context.compacted` 的 decision 输入、
   `context_window_exceeded` 触发条件均不依赖本次改动的兜底路径）。

### 3.8 风险与回滚

- 改动集中在 `nextRequestTokens` 一个函数 + `requestView` 一个内存字段（预计 ~30 行，
  单文件），无事件形状/落盘 schema/对外契约变化；回滚 = revert 单提交。
- 通知数值整体下移（更准）⇒ 50% 预警比以前提得**晚**——这正是用户裁定要的行为
  （「系统提示要 rotate 但工具说不需要」消失）；真超限仍有发送前闸 + provider overflow 卡兜底。
- 无锚点会话兜底仍 ×1.15（合同 5 不变），不会引入低报。

### 3.9 实施清单（供实现单，本单零代码）

| # | 文件 | 改动 |
|---|---|---|
| P1 | `packages/core/src/runtime/execution-unit.ts:1698-1706` | 兜底应用 `segmentClearPlans` + `withClearedToolResults` |
| P2 | 同上 `:297, :3795-3798, :1703-1705` | `requestView.sourceMessageCount`，增量按源条数切片 |
| P5 | 同上 `:4556`；`packages/agent/src/service.ts:7141`；`src/session/context-ratio-source.ts:10`；`src/session/context-usage.ts:44` | 注释归队 |
| P4 | TUI（另单） | `/context`/状态栏改读账本 |

---

## 附：取证方法（可复现，只读）

- 生产时间线：`~/.vessel/data/sessions/f6484abd-26e3-4e49-8f36-4ccbf3c903fc/timeline.ndjson`
  （main 前身体，epoch 13 之前的同一会话），按 `type ∈ {context.pressure, llm.request,
  llm.response, run.started, context.cleared_tool_result}` 过滤 ts 窗口
  `[1795593400000, 1795594000000]`，得 §2.1 表。
- rotate 结果原文在该文件 seq 59056（`tool.call.completed`，tool_name=agent，
  arguments.action=rotate）。
- 代码基线：redblue-dev b939f4ce（= 生产 main fb44a979 + q-card-robust 事实通道改动；
  本调研涉及的计量链路两分支逐字一致，已 diff 核对）。