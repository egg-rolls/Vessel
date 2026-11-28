---
title: 上下文与消息注入
kind: current
triggers: [context, message, injection, compaction, system prompt, self card, vessel:source, notice, token, prefix, history, composition, whitelist, 上下文, 消息注入, 前缀缓存, 压缩, 系统提示词, 环境块, 组成, 白名单]
paths: [packages/core/src/context/**, packages/core/src/runtime/execution-unit.ts, packages/core/src/session/project-messages.ts, packages/agent/src/runtime.ts, packages/agent/src/self-card-delta.ts, src/runtime/runtime-notice-hook.ts, plugins/context/doc-subscription/**, src/data/attachment-ingest.ts, src/session/context-ratio-source.ts, src/session/image-delivery.ts, src/data/refs-notice-hook.ts, src/runtime/runtime-notice.ts, src/agent/self-card.ts]
---

# 上下文与消息注入

`WorkingContext` 是**每次 Run 一份**的内存消息窗口（Stage 4）；`ExecutionUnit` 只持 `contextFactory`，不持跨 Run 实例。`Run` 是唯一写者（`RunJournal`），事件日志是恢复的真相源，**落盘消息只能 append**（唯一的 pop 是 compression 整段替换，见 [env-info-append-only](env-info-append-only.md)）。

- **生命周期**：Run 开始由 `contextFactory` 新建，从 SessionState 快照 + 事件日志增量播种（无快照则全量投影）；Run 结束用它写投影后随 Run 释放，下一次 Run 重新 new（只复用消息数据，不复用对象）。
- **手动 `/compact`**：有 live EU 走 `ExecutionUnit.compactContext`；idle session 走等价瞬态路径（不启动 Run、不注入用户消息）；connect 走 `sessions.compact` RPC。两条本地路径都写 `message.compaction` + SessionState 并 flush，成功后 TUI mirror 用压缩后窗口刷新；connect 只拿到 `{removed, remaining}` 时本地视图显式标记 stale，下一次 run 刷新。`appendNotice` / `contextRatio` 行为不变。

## 消息模型

| role | 来源 | 说明 |
|---|---|---|
| `system` | 基底 prompt + Self Card | 会话级，冻结 |
| `system` + `compaction_summary` | 压缩摘要 | 独立一条，排在 system 之后 |
| `user` | 用户输入 / `RunOptions.messages` / hook | 动态元数据都是 `vessel:*` 的 user 消息 |
| `assistant` | LLM 输出 | 可带 `tool_calls` / `reasoning_content` |
| `tool` | 工具结果 | 与 assistant 的 tool_call 配对 |

<a id="injection"></a>

## 注入点

| 来源 | 内容 | 方式 | 位置 | 持久化 |
|---|---|---|---|---|
| `config.agent.systemPrompt` / 成员 `system_prompt` | 基底提示词（**只来自用户配置**；未配置时为空，不注入内置文案） | `ExecutionUnit.systemPrompt` | 第一条 system | 是 |
| core `formatSelfCard` | role / parent / team / depth / model / tools / limits / context budget / how_to_ask | `composeRunSystemPrompt` | system | 是 |
| 历史恢复 | session cache + 事件日志 | `loadStoredHistory` / `projectMessages` | 用户输入前 | 是 |
| 用户输入 | `run(input)` | `addContext` + `user.message` | 本轮 user | 是 |
| `RunOptions.messages` | `@path` 引用、成员 `vessel:source`、技能/附件 | 调用方传入 | **用户输入前** | 是 |
| `runtime.notice` | 热应用 / 版本通知 / 成员停下（scope `peer`，定向父 session） | `runtime-notice-hook` → `vessel:notice`（**按 scope 分组，一个 scope 一条消息**；跨组共享剩余行预算） | 尾部 | 是 |
| 基础信息变更（`agents.update` / `reinstate`） | `selfcard: N fields changed …` + 每字段一行（name / parent / team / model / system prompt / permission mode）；model / system prompt 明确写「本具 body 仍用旧值，下一具才用新值」 | `self-card-delta`（BeforeLlm，**每具 body 一个实例**）→ `vessel:notice`（Web scope `selfcard`） | 尾部 | 是（同一变更只注入一次；Self Card 本身仍是构造期快照，不热替换） |
| 附件引用（`Message.refs`） | `[refs] N attachments: kind path, …`（只有路径与种类；>3 条折 `+N more`；尾注按 media 工具是否可用分三档：`(use media: action=…)` / 未启用时说明需启用插件 / 纯 file 批次不加尾注） | `refs-notice-hook`（BeforeLlm，读 `ctx.refs`）→ `vessel:notice` | 尾部 | 是（同一批引用只注入一次，变化才再注入） |
| 文档订阅 | `files: N changed …` + 每文件一行 `<file path id rev bytes />`；**有 read 引用的条目**走 line-level：元数据行 additive 带 `lines="a-b"`，第一个（path 序）line-level 变化条目附 diff 明细行（11 行 / `content.maxBytes` 预算内，超出折截断标记；无 content 与旧版逐字节一致）。**health 源**：宿主 `node-health-watch` 探测被订阅 node `/health` 落快照，插件只读快照，签名（reachable / version / started_at / node_id）变化 → `health:` 通知（同通道同形状，节奏 `envGranularity.health` 独立 gate）。**script 源**（q-subscription-script）：用户配置 allowlist 检测命令异步跑（argv 无 shell / fire-and-forget / 单飞 / 超时 kill），空输出不出卡、diff 去重、首次全量；调度 run / request / interval 真 timer（idle 也跑）；scope 词 `script`（兜底）/ `doc-lag` / `code-heaviness`（内置专词，按 scope 分组出卡）；cadence / channel / scripts 走 live getter 热改即时生效 | doc-subscription → `vessel:notice`（Web scope `files` / `health` / `script` / `doc-lag` / `code-heaviness`，默认可见） | 尾部 | 是（同一路径去重；**不再**用 `vessel:subscription` 这个第二套通道） |
| 写协调（scope `lock` / `conflict`） | lock：工作区写锁争用 / 不可用；conflict：`expected_content` 并发修改冲突（均「写未执行」，锁路径 / 错误进明细行） | basic-tools `createWriteCoordNoticeHook`（BeforeLlm，priority 165，drain 内按条目 scope 过 cadence）→ `vessel:notice` | 尾部 | 是（表面记录按签名去重） |
| 工具面变更（热应用 / MCP toggle / `applyToolsToEntry` 热刷新 / 权限档 / inbox） | `tools: 2 added, 1 removed; …` + `· + ask — <description ≤80 字符>` / `· - fs_write (removed; calls will be rejected)`；首行写清生效点（新会话 / 新 body 才进请求列表） | core EU（`ExecutionUnit.appendToolSurfaceNotice`，每轮请求前 diff 已报面 vs live 宿主）→ `appendInjectedMessages` → `vessel:notice`（scope `tools`） | 尾部 | 是（同一变更只注入一次；回滚照样报；请求 tools[] 是会话起点快照，不随卡变） |
| 跨重启 / 换 body 的模型变更 | `model: A → B` + 生效点（之前的轮次用 A，本次 run 用 B） | core EU 首 run 比较（目标会话存档 `prompt_context` 指纹 vs 当前 model）→ `appendInjectedMessages` → `vessel:notice`（scope `model`） | 尾部 | 是（同一过渡只注入一次；回滚照样报；指纹缺省不发） |
| 90% 预警（`limits.*` / `termination.*`）/ 50% 上下文压力 | `[runtime] input_tokens_limit / context_window: 500k/1M …`（后者推荐 rotate；默认 50%–85% 带内每 run 一次） | core `publishLimitWarnings` / `publishContextPressureWarning` → `vessel:limit` | 尾部 | 是 |
| 旧 `additionalContext` / 任意 BeforeLlm hook | 自动转 `vessel:hook` / 自定义消息 | `ctx.messages` | 尾部 | 是（每 run 一次） |
| LLM 输出 / 工具结果 | assistant / tool | `llm.response` / `tool.call.*` | 顺序 | 是 |
| 压缩 | 摘要 | `compactAsync` / `autoCompactAsync` / `compactContext` | system 之后 | 是（事件日志 + session cache） |

**不注入**：Team 日志不会自动进上下文；只有 `teams.post` 里被 `@` 的成员会收到一条普通 user 消息。权限请求 / ask 事件不进上下文，只有工具结果会。成员回复没有独立注入通道：经正常 `admit` 投递进父 body 的下一轮 run input。**注入节奏与通道**：per-scope 两轴 —— cadence（`request` / `run` / `off`）+ channel（`model+ui` / `ui-only`），live resolver 每请求求值、热改即时生效；`off` 整段静默（不产事件、不注入），`ui-only` 只落 UI 卡事实（`message.injected`）、不进模型上下文。core 只做线格式 scope 切词（`noticeScopeOf`），不认识业务词表，判定交给注入的 `envCadence` / `envChannel` 端口。去重恒开；默认表 / resolver / scope 词表的事实家在 [env-info-append-only](env-info-append-only.md#cadence)。

**一次请求的完整清单**（唯一口径；新增注入通道必须在本表落一行，否则就是第二套真相源 —— `vessel:subscription` 当初就是这么漏出去的）：`messages[]` = 上表各注入点 + 历史正文（user / assistant / **tool 结果**）+ 压缩摘要（`role: system` + `compaction_summary`，顶掉历史的那一份）+ 请求级工具结果占位（`context_trim`：只替换出网那份，落盘仍是原文；白名单命中保持原文，见压缩节；投射三模式见 [session-length](session-length.md)）+ 回传的 `reasoning_content`；`tools[]` = **会话起点冻结快照**（`ensureToolPin`：懒捕获于该会话第一条 LLM 请求，重 pin 只发生在新 EU / session_switch / 段起点压缩成功；执行侧仍 live 读宿主），Self Card 的 `tools:` 行只是展示；provider 参数 = `model` / `max_tokens` / 温度等 / abort signal / **`attachment_plan`（这一轮要发哪几张图，见下一条）**；**明确不进请求**：`Message.refs` 的**正文**（只有路径 + sha256，图的内容经视觉基座以块进入请求，见下一条）、事件流本身、`prompt.system_context`（审计事件）。

**请求组成 introspection**：`buildRequestComposition`（`context/composition.ts`）把请求视图拆成固定 11 成分表（system_prompt / compaction_summary / user_history / current_input / assistant / tool_results / tool_placeholders / notices / images / tools / overhead，各 `{tokens, count, share}`，零值也写），与 `estimateRequestViewTokens` 同公式 —— 成分之和按构造等于总数；EU 每次真实请求落一条 `context.composition` 事实事件（`context.composition_record` 缺省 true，false 不算不发），`sessions.composition` RPC 读最近 N 条快照。占位原文体积（`cleared_original_tokens` / `cleared_saved_tokens`）回落盘窗口按 `tool_call_id` 配对。

**图片（决策：模型支持即直通；file-ref-ux A1 限定为逐条 opt-in）**：`Message.content` 仍是 `string`，图只有 `refs` 里的一条引用（`{kind:'image', path, sha256, inline?}`）；**缺省不内联**——只有 `inline === true` 的图才在入池时读文件、把字节冻结进内容寻址 blob（`<dataDir>/blobs/sha256/xx/<sha256>`，写一次永不重写；闸在装配层 `attachment-ingest`，0.56「上传即落」默认由此限定），缺省图只留路径、模型用 `media` 按需读（尾注自动落「use media」档、chip「未发送·没入池」）；已带 `sha256` 的历史引用幂等透传、继续内联（历史前缀逐字节不变）。请求期由 `vision/plan.ts` 解析成 `ChatRequest.attachment_plan`（张数上限由 token 预算推导：缺省窗口 5%，先到先得丢后面的，最终夹在后端描述符安全 cap 内；请求期丢弃追加模型侧事实注记 `context: N images … NOT inlined`，只首次报告，与 `context.image_dropped` 同一套去重），再由**传输适配器**把那一条消息的 `content` 升成 `[{type:'text'}, {type:'image_url'}…]`（形状归插件，核心不认识任何一家）。于是：`refs` 仍不进正文、图永不进 `Message`（前缀守卫逐条比字节）、图片计价只认后端 `tokenCost()`（不按 base64 字符数）、投递状态（已发送 / 已丢弃 / 未发送）**只从事件**（`image.sent` / `context.image_dropped`）派生、不写进 `refs`。

**Self Card 是构造期快照**：`agents.update` 只改 registry 记录，模型看到的 `[Self Card]` 仍是 spawn 时那张（`selfCard` / `systemPrompt` / `model` 在 `ExecutionUnit` 构造期赋值、之后只读），因此**不热替换**那张卡，而是把变化说成环境信息：`self-card-delta` hook 每轮 diff「模型相信的值」与真值盒，变了才注入一条 `vessel:notice`（同一变更只报一次，回滚照样报）；改名 / team / parent 立即生效、只补一句说明，model / system prompt 如实写「本具 body 仍是旧值，下一具 body 才用新的」（model-follow 见 [agent-structure](agent-structure.md)）。**基底 system 完全由用户掌握**：只有 `config.agent.systemPrompt`（或成员 `system_prompt`）会作为基底提示词；两者都未配置时基底为空（空串跳过，不写 system 消息），runtime 不提供任何内置默认提示词；Self Card 是 runtime 元数据，仍按 `composeRunSystemPrompt` 注入（无基底时 system 只有 card）。

## 一次 run 的顺序

1. `setSessionId(sessionId)`；本 Run 的新 context 生成 system（基底 + Self Card）+ 从 SessionState 快照 / 事件日志播种历史
2. 写入 `RunOptions.messages`（`message.injected`，用户输入之前）
3. 输入 guardrail（可改写用户文本）
4. 写入用户消息（`user.message`）→ `saveSession`
5. loop：limits 90% 预警 → termination / usage 检查 → 上下文 50% 压力预警 → `autoCompactAsync`（> `compactThreshold`，默认 85%）→ BeforeLlm hooks（system 只读；`ctx.messages` 追加）→ `appendInjectedMessages` → `buildRequestMessages`（归一化 + 替换基底 system）→ `ensureToolPin`（读会话 tools[] 快照）→ **PrefixGuard** → LLM → assistant / tool 入上下文
6. `finalizeRun` → save session / checkpoint

## 持久化与恢复

- `RunJournal.saveSessionState` 在 run 开始（用户消息写入后）与结束各写一次；journal 是唯一写者。
- `loadStoredHistory`：有 cache 且知道 `derived_upto_seq` → 只读事件日志增量；否则全量 `projectMessages`，按尾部重叠去重。**增量中出现任一 `message.compaction` 时强制全量重投影**——压缩是替换语义，缓存 + 增量无法表达“删掉旧历史”；投影先按 `cleared_tool_call_ids` 写回确定性占位，再按 `kept` 裁剪。两次 Run 的窗口对象不同，但播种出的消息数据等价。
- **可观察面 parity**：同一 session 且日志尾未前进时静默播种（不发 `context.changed`），并沿用上一 Run 的真实 token 数；只有 baseline 也会播种的场景才发重建事件。
- 事件 → 消息：`user.message` / `message.injected` / `llm.response` / `tool.call.completed|failed` / `message.compaction`。
- **真实 token 锚点与现值**（`SessionState.context_anchor`）：现值一律是 runtime 账本 `ExecutionUnit.currentContextTokens` = 下一次请求视图的上界估算（`request-view.ts`，含每条消息开销 / tools / 图片计划计价）× 锚点比值，再以 provider 上次 `prompt_tokens` 压地板；锚点 `ratio = prompt_tokens ÷ 同一请求视图的上界估算`，拿到 usage 那一刻记下、由 `RunJournal.saveSessionState` 随投影落盘，clamp 0.5–3、非有限值丢弃、`model` 不同不校正；无锚点乘 `NO_ANCHOR_SAFETY_MARGIN` 1.15。窗口 `realTokens` 退化成地板种子（重启续接取最近一次 `llm.response` 的 per-request usage，不是 RunRecord 累计）。**副作用（期望）**：校正后估算变大 ⇒ `compactThreshold` 提前触发 —— 那是校准到真实口径（CJK / reasoning / 工具参数），不是回退。**占用比率的单一真相源**：`contextRatio` 只有一条取数链 —— 装配层 `src/session/context-ratio-source.ts` 订阅父事件流，分子取 `context.changed.token_count`（= 账本现值，界面那一个数）、分母取 `context.pressure.max` / `prompt.system_context.context_max`（兜底装配层 `contextMaxTokens`，缺省 `1_000_000`），`withLiveContextRatio` 以原型委托覆盖 runtime 端口的 `contextRatio`；`percent` 一律 `Math.round(ratio*100)`。宿主 run 末的 `lastContextRatio` 只作回落，**任何地方不许再估一次**。
- durable 模式额外有 checkpoint；resume 先校验事件游标。详见 [state](state.md)、[events](events.md)。

## 压缩

| 项 | 值 |
|---|---|
| 预算 | `context.maxTokens` 默认 1,000,000；条数兜底 `maxMessages` 或 `max(100, maxTokens / 100)` |
| 阈值 | `autoCompact` 默认 true；`config.context.compactThreshold` 默认 0.85（core `DEFAULT_COMPACT_THRESHOLD` 单源，config defaults 复用）；严格 `>` 触发 |
| 保留 | system 全保留；最近非 system 在 30% 预算内，至少 2 条 |
| 工具结果清空 | 保留最近结果至累计 ≤ `maxTokens × 5%`（至少 1、最多 10）；占位 `[cleared <tool>: <命令摘要> -> exit <n>, <n> lines]`，不含完整参数 / 输出。**白名单**（`context.tool_result_whitelist`，缺省 `inbox read` / `agent read`；显式 `[]` 关闭、显式列表整体替换，构造期注入重启生效）命中保持原文：消费侧纯后过滤（EU 段起点冻结 + 压缩审计集合，planner 一字不动），**抗 trim 不抗 compaction**，落盘永远原文（`context/tool-result-whitelist.ts`） |
| 摘要 | provider summarizer；15s 超时；per-session 连续 3 次失败熔断 10 分钟，`force` 绕过；输出预算 `clamp(removedTokens / 8, 2048, 8192)`，合并旧摘要，模板含“当前用户要求（原话）” |
| 结果与事件 | `role: system` + `compaction_summary: true`，旧摘要移除、system 提前；`context.compacted`（auto / overflow / manual）、`message.compaction`（可选 `cleared_tool_call_ids` / `degraded`）、`context.pressure`（50%–threshold，每 run 一次） |

压缩摘要经 `RunJournal` 追加 `message.compaction` 事实事件（Run 内以当前 `runId`，两次 Run 之间的手动 `/compact` 用 `run_id='manual'`），恢复时从 session cache + 事件日志重建。**50% 与 threshold 分工**：`context.tokenCount / maxTokens` 到 50%（用户裁定 `CONTEXT_PRESSURE_WARN_RATIO`）且未超过 `compactThreshold` 时不压缩，发 `context.pressure` + `vessel:limit` 推荐 `agent(rotate)`；超过阈值（默认 85%）由 `autoCompactAsync` 自动压缩 —— 默认配置（自动压缩开启）下压力提示在 50%–85% 带内每 run 出现一次，50% 即建议切换防堆积。`limits.inputTokensLimit` 是另一套机制：仅在显式配置后才做 90% usage 预警与硬上限判定，缺省不限。`rotate` 不自动触发；模型发起的 rotate 必须经人类权限确认。**run 内 overflow 不改写历史**：provider 报上下文超限 ⇒ 把该次 400 记成真实锚点 + 地板、追加一张「超限」卡（`appendContextOverflowNotice`，scope `context`），本次 Run 以原始错误收尾；压缩留到下一个段起点（旧 `forceCompact` 就地重试已删）。

### 压缩索引与按需读回

压缩是**可逆的视图变换**，不是单向丢信息：压缩当刻留下「被替换的是哪些消息」的索引 —— compaction_id（同会话单调、多段累积不覆盖）、removed_ranges[{from_seq,to_seq,messages}]、replaced_by{summary_chars,summary_sha8}、at、reason、tokens_before/after、unmapped_messages。三处同源落点：`context.compacted` 的 data.compaction（事实）→ SessionState.compactions（壳缓存）→ 会话目录 compactions.ndjson（物化副本，可从事件重建）；seq 来自 ProjectionCursor.messageSeqs（与 messages 逐位对齐）+ CompactionReport.removed_indices，对不上不猜号、记 unmapped_messages；区间合并空档 ≤512、最多 8 段（避免逐段读回的固定开销）。压缩发布后 `windowSeqMaps` 重对齐到压缩后窗口（单调自检）；包装层（RoleAwareContext）必须转发 `lastCompaction` / `setContextAnchor` —— 可选成员被包装层吃掉会让成员压缩索引静默落空。诚实边界：**老会话可能有读不回来的条目**（事件日志里从未有对应事件，例如当时的运行时提示行）——索引用 unmapped_messages 如实记录，不编区间；backfill 出来的老段 tokens_before/after 未知（显示 n/a）。

- **读回通道**：`packages/core/src/session/compaction-recall.ts`，走 readTimelineRange（不整份读），三条上界：≤200 条 / ≤16k token / ≤20000 事件扫描；分页给 next_offset 与更便宜的 next_from_seq。
- **工具**：插件 recall（plugins/tools/recall），动作与参数表见 [tools](tools.md#tools)；描述开头写死 NOT files。
- **stub**：压缩当刻把一行 `[compacted] N messages (seq a..b) were summarized; call recall with compaction_id=<id> to read them back.` 追加进摘要正文，只写这一次（重放逐字节一致）；摘要器输入与指纹先 stripCompactionStub。

<a id="prefix"></a>

## 前缀不变量

1. **system 冻结**：hook 写 `ctx.systemPrompt` 被忽略，发 `hook.system_prompt_ignored`。
2. **只能追加**：`PromptPrefixGuard` 对比上一次请求；无 reason 的中间重写发 `prompt.prefix_changed`；`VESSEL_STRICT_PREFIX=1` 时抛 `PromptPrefixChangedError`。
3. **合法 reason**：`compaction` / `branch` / `session_switch` / `context_trim`。`system_revision` / `tools_changed` / `model_changed` / `resume` 已从词表删除（见 [message-invariants](message-invariants.md)）：这些语义只能靠「追加环境卡」或「`new` 开新会话」表达，resume 是续段不是新段。
4. 动态元数据全部是尾部 `vessel:*` 消息，不改 system；Web 默认隐藏，Settings → Display 可按类打开。
5. 不新增 `additionalContext:` 与 `ctx.systemPrompt =`（旧静态审计脚本 `check:prompt-prefix` 已按宪法删除，改动此处时人工核对）。

## 各层责任

core：system / Self Card、历史、用户、assistant/tool、压缩、PrefixGuard；`packages/agent`：`vessel:source`、Team 派发。asm (`src/`)：runtime notice、配置热应用通知、summarizer、版本通知。plugins：doc-subscription `vessel:notice`（scope `files` / `health` / `script` / `doc-lag` / `code-heaviness`）、basic-tools 写协调（lock / conflict）、hook-logging（只观测）、MCP 工具结果。TUI / Web：`@path` 引用、用户输入、`vessel:*` 可见性过滤。相关：[runtime-loop](runtime-loop.md)、[runtime-api](runtime-api.md)、[guardrails-hooks](guardrails-hooks.md)、[member-team](member-team.md)、[env-info-append-only](env-info-append-only.md)、[session-length](session-length.md)。