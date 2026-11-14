# 请求 messages append-only 不变量审计

状态：审计结论（只读，未改产品代码）｜ 分支 0.52-audit-appendonly @ 53a77d8a
判据来源：docs/architecture/message-invariants.md:16-40、docs/PRODUCT.md:38-56（公理 8）、docs/PRODUCT.md:55（唯一白名单）
方法：调用链逐行静态核对；未运行 gate/build/install。结论附 `文件:行`；无法从代码确证处标「推断」。
## 1. 结论摘要

**在「请求序列」这一层，append-only 已经不存在了**，而且不是偶发退化，是 0.52 的显式设计：请求构造期会做工具结果占位、
读侧脱敏、以及（同一 run 内的）会话压缩。前两件被 message-invariants.md:22/26/32 点名禁止（「请求构造时改历史」
「把历史中的原文替换成掩码」）；第三件只在「新 run 的裁剪视图」白名单内合法（PRODUCT.md:55），但实现在同一 run 的
第二次请求之前就会改写中段。

三层防护同时失效（本审计最重要的发现）：**代码自我豁免** —— context-manager.ts:226 注释写「这是本不变量在 core 里唯一允许的
『视图层改写』」，契约原文没有这条豁免；**门禁背书** —— scripts/check-append-only-context.ts:627 把「请求里是占位、存档里是原文」
当成**正确结果**断言；**运行时守卫空转** —— 本轮只要发生过占位就登记 reason=context_trim（execution-unit.ts:2836），而 reason
一旦存在，守卫对任何漂移（含 system / tools 变化）一律放行（prompt-prefix-guard.ts:125-130），默认只告警，
抛错要 VESSEL_STRICT_PREFIX=1（:135-137）。

| 分类 | 数量 | 条目 |
|---|---|---|
| 肯定破坏 | 3 | V1 工具结果滑窗占位；V2 会话中途压缩；V3 请求期读侧脱敏 |
| 有条件破坏 | 4 | C1 归一化改写；C2 system 头部块重建/平移；C3 rewind 删尾；C4 超限重试绕过守卫 |
| 不破坏 | 3 | N1 常规尾部追加；N2 工具结果限长；N3 system / Self Card 稳定性 |

三条最严重：

1. **V1**：工具结果条数超过保留窗口（K = min(10, 5% 预算)，context-manager.ts:36-37、177-192）之后，**每一轮**请求都会把窗口外的
   老结果换成占位（context-manager.ts:228，调用点 execution-unit.ts:2833），分叉点每轮前移一条工具轮 ⇒ 长 run 的缓存从分叉点往后全废。
2. **V2**：压缩在 run 内每轮都可能触发，**就地删中段 + 插入新摘要**（context-manager.ts:673-681，tool-calling-loop.ts:193）；
   摘要由模型生成（非确定），下一次压缩还会再换一次摘要，中段可被反复改写。
3. **V3**：请求期对全历史正文做脱敏（execution-unit.ts:2841、read-side-mask.ts:44-56），存档与 UI 保持原文 ⇒ 违反
   message-invariants.md:18 与公理 8；插件重载/改配置会让全部历史按新规则重新脱敏，一次抖到底。
## 2. 真实请求构造链（会话存档 → buildRequestMessages → provider）

| # | 环节 | 文件:行 | 做了什么 | append-only |
|---|---|---|---|---|
| 1 | 存档 → 投影 | session/project-messages.ts:168-256 | 重放事件；`message.compaction` 替换中段（:225-233）；`session.rewound` 截投影（:214-215） | 只按事件走；rewind 见 C3 |
| 2 | 每 run 重建 WorkingContext | execution-unit.ts:2270-2281、1539-1569 | 清空后按存档顺序重放；无基底 system 时先在 index 0 补一条（:2271-2281） | 不改既有内容 |
| 3 | 压缩 | tool-calling-loop.ts:193 → context-manager.ts:673-681 | 就地写回：中段换成一条 `compaction_summary` system 消息，保留尾 30% | **破坏 V2** |
| 4 | 归一化 | execution-unit.ts:2870-2924 | 删孤 tool 消息（:2902）、tool_calls 残缺的 assistant 降级、清 tool_calls | **有条件破坏 C1** |
| 5 | 工具结果占位 | execution-unit.ts:2833 → context-manager.ts:228 | 滑窗把「最近 K 条以外」的 tool 结果 content 换成占位（cleared-tool-result.ts:91） | **破坏 V1** |
| 6 | 读侧脱敏 | execution-unit.ts:2841 → read-side-mask.ts:44-56 | 每条历史正文过 masker（全仓仅此一处调用） | **契约破坏 V3** |
| 7 | system 处理 | execution-unit.ts:2847-2860 | 基底 system 改写为「system + Self Card」（:2857-2860）；缺基底 system 且被 hook 改写过时头部插一条（:2850-2853，index 全平移） | 不破坏；插入路径见 C2 |
| 8 | provider 映射 | provider/providers.ts:307-345；字段口径 types/provider.ts:53-91 | 只保留 role / content / tool_calls / tool_call_id / name / reasoning_content | 不破坏 |

补充：`buildRequestMessages` **自身**没有裁剪、重排、合并、去重（execution-unit.ts:2828-2861 只组合上表 4-7）；所有改写
都来自它调用的那几层。工具 schema 变化（插件装卸）另算头部块变化（prompt-prefix-guard.ts:111、139-152）。

## 3. 判定标准（本审计口径）

1. **比较对象是 provider 投影，不是内存对象**：types/provider.ts:55-91 明确 timestamp / compaction_summary / run_id 等不进请求。
   门禁必须按 `{role,content,tool_calls,tool_call_id,name,reasoning_content}` 逐字比；现在守卫用 `JSON.stringify(整条 Message)`
   （prompt-prefix-guard.ts:74-76），会把时间戳差异算成漂移（假阳性）。
2. **合法变化只有两种**：(a) **后缀追加** —— 长度不减且 next[0..prev.length-1] 逐字相等；(b) **头部 system 块整体重建** ——
   把 index 0 的基底 system 单列比对，合法当且仅当它只由 session 常量决定（systemPrompt / SelfCard / model / tools 词表，
   构造期赋值后只读：execution-unit.ts:596-597、2442-2446）且其后序列与上次逐字相等。
   **禁止的第三形态**：头部块以外任何位置出现「不等」或「长度变短」，不论 reason 是什么一律记破坏。
3. **同一请求序列的边界**：同一 session、同一 ExecutionUnit 生命周期内的连续 provider 请求；**跨 run 仍属同一序列**（EU 按 session
   缓存复用，见 packages/agent/src/runtime.ts 的 getOrCreateExecutionUnit），因为缓存提供方感知不到 run 边界。压缩只允许发生在
   「新序列起点」（新 session / 新 EU / 用户 rewind 之后），不允许发生在 run 内第 2..n 次请求之前。
4. **seed 视图算不算延续**：同 session 内的 seed（execution-unit.ts:1539）是「同一序列的重建」，必须与上一请求逐字一致；
   fork/CoW 派生新 session 的 seed 视图是**新序列**（缓存本来不命中），不算破坏，但下一请求要登记 reason。

## 4. 必查项逐条结论

**① withClearedToolResults —— 肯定破坏。** context-manager.ts:228（调用点 execution-unit.ts:2833）。占位符由原始内容确定派生
（cleared-tool-result.ts:91），同一条消息一旦清洗就稳定。触发条件**不是压缩前、也不是仅新 run，而是每一次请求**：热路径按当前
messages 重算窗口，K = min(10, maxTokens 的 5%)（context-manager.ts:36-37、177-192）⇒ 第 11 条工具结果之后，每轮请求的占位集合
都比上轮多一条，分叉点在中段且每轮前移一条工具轮，之后全部重算。它在守卫眼里是「已声明」（execution-unit.ts:2836），对缓存是纯损失。
残留变量：占位符里的摘要串过 redactor（cleared-tool-result.ts:57-66），redactor 规则变也会带着历史占位一起变。

**② 压缩（compaction / compactMessagesForSeed）—— 肯定破坏（run 内）／允许（新序列起点）。** 实现：context-manager.ts:159-171
（applyCompactionToMessages）、:673-681（就地写回 sessionMessages）。结果形态 [system…, 新摘要, 尾部 30%] —— **不是追加摘要，
是删中段 + 插入摘要**，旧摘要被新摘要覆盖（project-messages.ts:252-254）。触发三处：(a) 每轮请求前 autoCompact
（tool-calling-loop.ts:193）；(b) add() 内同步压缩（context-manager.ts:404-410，未配 summarizer 时）；(c) 超限 forceCompact + 重建
（execution-unit.ts:2075-2076）。`compactMessagesForSeed` 只服务 fork seed ⇒ 不破坏。

**③ withReadSideMask —— 契约上肯定破坏，缓存上有条件。** read-side-mask.ts:44-56（调用点 execution-unit.ts:2841）。它是纯函数投影
（masker 集合与配置固定时逐字稳定，见 execution-unit.ts:2838-2842 的 idempotent 论证），缓存危害取决于**稳定性**：masker 由插件
运行时注册（guardrail-pii/src/index.ts:170-182、241-242，配置在 masker 创建时 merge），插件重载 / 改 `maskOnRead` / 换规则
⇒ 全部历史按新规则重新脱敏，从第一条命中消息起全前缀失效。它也全仓只在请求侧调用，存档与 UI 是原文 ⇒ 违反
message-invariants.md:18/26（「存档 = 请求投影 = UI 三者逐字一致」）与公理 8。本分支消息正文没有写入侧脱敏
（cleared-tool-result.ts:57 的 redactor 只作用于占位符里的摘要串）。

**④ buildRequestMessages 内的裁剪/重排/合并/去重 —— 函数自身不破坏。** 唯一的「删」是 normalizeMessages 丢孤 tool 消息（:2902），见 C1。

**⑤ system / 环境块 / SelfCard 重建 —— 不破坏（当前实现合格）。** `this.selfCard` / `this.systemPrompt` 构造期赋值后只读
（execution-unit.ts:596-597）；`runSystemPrompt` 每 run 重算但只是 `system + SelfCard` 的确定性拼接（:2442-2446）；动态部分
（改名 / 换 Team / 改 model）走**追加一条 `vessel:notice` 尾消息**而非重写 system（packages/agent/src/self-card-delta.ts:1-9），
环境信息同样走追加消息（appendInjectedMessages，tool-calling-loop.ts:254）。残留风险两点：hook 的 systemOverride 若含时间戳/随机 id，
每轮头部块都变（守卫只报 system_changed）；缺基底 system 时的头部插入（:2850-2853）会让其后所有条目整体后移 1 位 —— 见 C2。

**⑥ 工具结果截断/限长 —— 不破坏。** `TOOL_EVENT_PAYLOAD_LIMIT` 只在 serve 侧 UI 投影生效（packages/serve/src/tool-events.ts:17、72-75），
provider 请求路径看不到它；core 无 message content 截断，会话存储只截 title/preview。工具执行时的输出截断属「写入时定终态」，不构成请求期改写。

**⑦ run 内多轮 vs 跨 run —— 两者都破坏，机制不同。** run 内：V1 窗口每轮前移 + V2 可能 run 内压缩；跨 run：V1 的窗口在下一个 run 的
第一次请求就已前移（语义上什么都没变），V2 若正好落在 run 边界则属允许。

## 5. 违规清单、严重度、修复方向

| 编号 | 判定 | 违规点 | 严重度 | 最小改法 | 动契约 |
|---|---|---|---|---|---|
| V1 | 肯定 | 请求期滑窗占位（context-manager.ts:228 / execution-unit.ts:2833） | 高 | 占位集合改为 **run 起点算一次并冻结**（写进 WorkingContext，别再每次 build 重算）⇒ run 内只追加，前移只发生在 run 边界 | 否 |
| V2 | 肯定 | run 内就地压缩（context-manager.ts:673-681、404-410；tool-calling-loop.ts:193） | 高 | autoCompact 从「每轮」挪到「run 起点」；run 内超限只走占位 + 一次 overflow 重试 | 否 |
| V3 | 肯定（契约） | 请求期脱敏（read-side-mask.ts:44-56 / execution-unit.ts:2841） | 高 | (i) 按 message-invariants.md:32 改成 append 时落占位、真值留句柄；或 (ii) 保留读侧但写进契约白名单 + masker 集合 session 内冻结 | 选 (ii) 才动 |
| C1 | 有条件 | normalizeMessages 删/改历史（execution-unit.ts:2870-2924） | 中 | 写入侧保证配对（工具异常也补一条 error 内容的 tool 消息），并给它登记 reason | 否 |
| C2 | 有条件 | 缺基底 system 时头部插入导致 index 平移（:2850-2853）；systemOverride 每轮变 | 中 | 请求期一律不插入（seed 阶段已补，:2271-2281）；systemOverride 只允许常量 | 否 |
| C3 | 有条件 | rewind 删尾（project-messages.ts:214-215） | 低 | rewind 后下一请求登记 reason=branch，别让守卫报未知漂移 | 否（reason 加一枚） |
| C4 | 有条件 | 超限重试绕过守卫 + reason 泄漏到下一轮（:2075-2076、2259-2260；prompt-prefix-guard.ts:125-130） | 中 | 重试后的请求也过一次 check；reason 与该次请求一一绑定，不留到下次消费 | 否 |
| N1 | 不破坏 | assistant / tool / hook 注入都是追加（tool-calling-loop.ts:412-421、497-531、254） | — | — | — |
| N2 | 不破坏 | 限长只在 serve UI 与工具执行时（serve/tool-events.ts:17、72-75） | — | — | — |
| N3 | 不破坏 | system / SelfCard 构造期快照 + 增量走尾消息（self-card-delta.ts:1-9） | — | — | — |

**肯定破坏的可复现判定方法**（通用脚手架：用 `ExecutionUnitOptions.provider` 注入 recording provider —— `chat(req)` 只做两件事：
记录 `structuredClone(req.messages)`，按脚本返回（首轮返回带一个 tool_call 的 assistant，之后返回纯文本）；驱动 N 轮后对相邻两次
记录做 §3 的投影化前缀比较，输出首个分歧下标）：

- **V1**：同一 run 内循环 11 轮 tool_call。断言第 12 次 vs 第 11 次请求：首个分歧下标 = 第 1 条 tool 消息，且 next 侧该条含占位前缀
  （形态由 cleared-tool-result.ts:91 决定）。
- **V2**：把 maxTokens 调到「2 轮就过 0.85 阈值」（context-manager.ts:684-687），跑 2 轮工具循环。断言第 2 次 vs 第 1 次：首个分歧下标 = 1
  （原第 2 条被新摘要取代），且 next 长度 < prev 长度。
- **V3**：先写入一条含 PII 的历史消息并跑一轮拿基线；随后重载 guardrail-pii（或切 `maskOnRead`）再跑一轮：首个分歧下标 = 那条消息的位置。

## 6. 门禁提案：`check:request-append-only`

**为什么不复用现状**：`check:append-only-context` 断言的是**磁盘**不改写，并把「请求里是占位」当作通过条件
（scripts/check-append-only-context.ts:627），所以永远抓不到 V1/V3；`check:prompt-prefix` 是静态扫描，只能管「别新增 mutation 语句」，
管不了「同一份代码在不同输入下产生非前缀序列」。

**先落一个可测纯函数** `packages/core/src/context/request-sequence.ts`（零依赖，脚本可直接 import）：

- `toProviderPayload(messages)` —— 与 provider/providers.ts:307-345 同口径的投影；让 providers.ts 反向复用同一函数，避免门禁口径
  与真实请求漂移。
- `diffRequestSequence(prev, next)` → `{ kind: 'append' | 'head-rebuilt' | 'middle-rewrite' | 'shrunk'; firstDivergence }` —— 实现 §3.2 的三分法。
- `ExecutionUnit` 导出测试缝 `projectRequestMessages()`：把私有 `buildRequestMessages` 的纯逻辑抽出（非纯部分只有 selfCard /
  runSystemPrompt，作为参数传入），`buildRequestMessages` 只剩三行组合；顺手把 normalizeMessages 从 `this` 摘下来变纯函数（它当前不依赖实例状态）。

**脚本 `scripts/check-request-append-only.ts`（新增，风格沿用现有 check-*：自定义 assert + 场景表）**

| 场景 | 驱动 | 判据 |
|---|---|---|
| R1 同一 run 多轮（11+ 工具结果） | RecordingProvider，一次 run() | 相邻请求只能 kind=append |
| R2 跨 run 连续两轮（同一 session） | 两次 run() | 首个分歧下标必须为 null |
| R3 压缩 | maxTokens 调小，run 内跨阈值 | 只允许 kind=shrunk 且分歧下标=1 且 reason=compaction；并断言压缩只出现在 run 边界（当前必红 = V2） |
| R4 读侧脱敏 | 含 PII 历史 + 换 masker 集合 | 断言 masker 集合 session 内冻结，否则 kind=middle-rewrite 记硬失败（当前必红 = V3） |
| R5 中断恢复 | 造一条残缺工具轮后 resume | 分歧下标落在毒消息处且 reason=normalize（当前 reason 缺失 = C1 红） |

**怎么拿到两次请求**：R1-R5 用进程内录制；另在 `ExecutionUnit` 加仅调试用环形缓冲（`VESSEL_DEBUG_REQUEST_FRAMES=1` 时留最近 4 帧投影化
请求），线上即可「导出两帧 → diffRequestSequence → 得到首个分歧下标」复现。**灰度**：V1/V2 修完前这条门禁必然红，建议按 R1/R2 → C1 → R3 → R4
逐段从 fail-open 名单挪进硬断言，避免立一条永远红的门禁。

## 7. 需要 owner 拍板的点

1. **契约要不要保留「请求期视图改写」豁免？** 代码（context-manager.ts:226）与门禁（scripts/check-append-only-context.ts:627）按「允许」在跑，
   message-invariants.md:22/26 与 PRODUCT.md:55 按「禁止」在写。这决定 V1/V3 是 bug 还是文档债。
2. **V3 二选一**：写时落占位（满足公理 8，存档从此是占位符 + 真值句柄）vs 读时脱敏 + 契约白名单 + masker 冻结（存档是真相）。附带情报：
   main 分支 383509e1「PII 句柄金库：append 侧脱敏 + 边界替换」已实现前者，本审计分支基线早于它，需确认以哪条为准。
3. **压缩允许的粒度**：我按 PRODUCT.md:55 字面只允许「run 边界」。若产品上必须 run 内压缩（长 agentic run 会超限），就得承认
   「run 内丢一次前缀」并写进契约，同时 V1 修法要升级成「整个 run 冻结窗口 + 超限即重启 run」。
4. **C4 是否接受「reason 与该次请求一一绑定」** —— 会让 execution-unit.ts:2259-2260 的现有注释失效，但能恢复守卫的发现能力。
