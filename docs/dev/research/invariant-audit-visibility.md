# 审计：可见性对等不变量（模型看到 ⊆ 用户看到）

- 不变量原文：`docs/architecture/message-invariants.md:18,26,32`、`docs/PRODUCT.md` 公理 8、`README.md`「核心设计不变量」。
- 基线：worktree `audit-visibility`，分支 `0.52-audit-visibility`，HEAD `53a77d8a`。
- 审计者：临时审计员，**只读代码 + 文档，未跑 gates/build**，未改产品代码。
- 覆盖：`read-side-mask` / 系统提示词与环境块 / tier 表 / 注入类 / `transcript-items` 折叠 / `recoverPendingInputs`。

## 0 摘要

违规 **6** 项（高 3 / 中 2 / 低 1），灰区 **6** 项待拍板（§3）。

根因只有一个：**模型侧投影（脱敏、占位、压缩摘要、运行时告警）缺少用户侧出口**。
而且「模型这一轮到底看到了什么」本身也没有落盘——`llm.request` 持久化时被裁成计数
（`execution-unit.ts:1935-1941`，`content_omitted: true`），所以磁盘上**没有可对账的第二份**。
门禁要能立起来，必须先补这一层（§5 F0）。

判断口径：只有「模型看到、UI 看不到或看到不同文本」才算违规；「模型看到更少」不违规
（`normalizeMessages` 丢孤儿 tool 消息、降级不完整 tool_calls，`execution-unit.ts:2817`）。

## 1 违规清单（按严重度排序）

| # | 位置 | 违反形式 | 严重度 | 证据 / 可判定反例 | 修复 |
|---|---|---|---|---|---|
| V1 | `packages/core/src/context/read-side-mask.ts:5` ＋ `execution-unit.ts:2838-2841` ＋ `plugins/security/guardrail-pii/src/index.ts:143` | 模型见掩码、UI 见原文，两侧都无标记；**默认开启**（`maskOnRead: true`） | 高 | 反例：用户消息写「我的手机 13800138000」→ 模型收到 `*******8000`（`rules.ts:266-273` partial 策略），UI 聊天流显示 `13800138000`（`packages/serve/src/gateway/methods/sessions.ts:1083` 直发原始 `messages`）。`read-side-mask.ts:5` 自陈「展示投影层」也要掩码，但 `apps/web` 全仓无 masker 调用、无「已脱敏」徽标（grep 命中 0）。与 `message-invariants.md:26`「禁止把历史中的原文替换成掩码」直接冲突。 | F1 |
| V2 | `execution-unit.ts:2833`（`withClearedToolResults`）＋ `packages/core/src/context/context-manager.ts:236` | 模型见占位符、UI 见全文，无标记；对应审计事件是**死登记** | 高 | 反例：长会话中 `bash` 一条 3 万行输出超预算 → 模型后续只看到 `[cleared bash: …]`（`context-manager.ts:236` 模板；`2804-2824` 只改请求投影、落盘保留原文），UI 的 tool 卡仍是全文。`context.cleared_tool_result` 在 `event-visibility.ts:123` 标了 `live: true` 却**全仓无生产者**（该字符串仅出现在 `cleared-tool-result.ts:60` 的复用处）；每轮 retention 清理不发任何事件。 | F2 |
| V3 | `execution-unit.ts:2331-2344` ＋ `packages/core/src/session/project-messages.ts:229` ＋ `apps/web/src/domains/chat/transcript-items.ts:890` ＋ `apps/web/src/domains/chat/EventRow.tsx:224-232` | 压缩摘要正文模型可见、用户**永久不可见**（是删除，不是折叠） | 高 | 反例：触发一次压缩 → 模型上下文里是那条 `role: system` + `compaction_summary` 的摘要正文（`project-messages.ts:226-241` 已把它投影进 `messages`）；UI 历史投影在 `transcript-items.ts:890`（`if (message.role === 'system') return;`）整条跳过；live 侧 `message.compaction` 是 `internal` 且无承接（`event-visibility.ts:125`）；`context.compacted` 行只渲 removed/remaining/reason（`EventRow.tsx:224-232`，`data.summary` 未渲染）⇒ UI 里**没有任何入口**能读到这段代替了用户历史的正文。`runtime-visibility.ts:25` 注释「压缩走 message.compaction 投影」在此不成立。 | F3 |
| V4 | `execution-unit.ts:2390-2398`、`2422-2434` ＋ `apps/web/src/state/runtime-visibility.ts:24` ＋ `apps/web/src/state/visibility.ts:23` | 模型可见的运行时告警消息默认隐藏 | 中 | 反例：上下文到 90% → 模型收到 `[runtime] context_window: …`（`execution-unit.ts:2390-2398`）；UI 默认 `showInternalEvents: false`（`visibility.ts:23`），`vessel:limit` 命中 `runtime-visibility.ts:24` 的 `limit → showInternalEvents` 分支 ⇒ 默认完全不可见。即便开开关，notice 行也不含模型看到的那句 `hint`（`EventRow.tsx:234-242` vs `execution-unit.ts:2422-2425`，`data.hint` 存在但未渲染）。 | F4 |
| V5 | `packages/agent/src/service.ts:6963`（`vessel:created`）、`packages/core/src/runtime/tool-calling-loop.ts:244`（`vessel:hook`）＋ `runtime-visibility.ts:24` | 进模型窗口的 runtime 消息被归入「跟随 internal 开关」的 `other` 类 | 中 | 反例 A：`/fork` 后模型上下文首条是 `role: user, name: vessel:created, content: "… mode=…; copied_messages=…"`（`service.ts:6960-6965`），UI 默认不显示（`runtime-visibility.ts:24` 的 `other`）。反例 B：外部插件 BeforeLlm 返回 `additionalContext` → 模型收到 `vessel:hook` 的 `content` 全文（`tool-calling-loop.ts:240-248`），UI 默认不显示；仓内暂无 `additionalContext` 生产者（latent，外部插件可触发）。 | F4 |
| V6 | `apps/web/src/state/event-visibility.ts:124,127` ＋ `packages/core/src/session/project-messages.ts:205` | 注入类消息 live 与 history 两路不对称，事件无承接 | 低 | 反例：hook 注入一条消息 → 当轮 live 时间线**无痕**（`message.injected` 为 `internal` 且无承接，`event-visibility.ts:124`），reload 后却从历史投影里冒出一张 user 消息卡（`project-messages.ts:205`）——同一事实两种可见性。同类：`prompt.prefix_changed`（`event-visibility.ts:127`，无承接）让「模型侧历史前缀被改写」对用户完全静默，与 V2 同源。 | F5 |

## 2 审查点逐项结论

1. `withReadSideMask` / `applyReadSideMaskers`：**违规（V1）**。与「脱敏落在 append 时」是互斥实现——现实现改的是请求投影（`execution-unit.ts:2841`），落盘与 `context.messages` 保留原文（`read-side-mask.ts:3`）。方向是「模型少看、用户多看」，而 `message-invariants.md:26` 明确禁止这种改写，`README` 的「用户多看一点只能来自显式动作」也没满足（UI 无解锁动作，默认就看到原文）。
2. 系统提示词 / 环境块 / selfCard：**合规**。`prompt.system_context`（`execution-unit.ts:2533-2541`）带 `system_prompt` 与 `self_card` 全文；UI 侧 `apps/web/src/domains/chat/EnvCard.tsx:69,125` 的「全量快照原文」块可展开看全。默认折叠但可展开 ⇒ 属折叠，不属删除。
3. tier `internal` / `observe`：`observe` 类无模型内容（元数据/审计）。`internal` 里**确实有**模型内容：`llm.request`（模型侧投影，隐藏可接受，且应是门禁数据源）、`message.compaction`（V3）、`message.injected`（V6）、`context.cleared_tool_result`（V2，死登记）、`prompt.prefix_changed`（V6）。
4. 注入类：`vessel:notice`（inbox 计数行，`packages/agent/src/inbox.ts:1078`）→ env 卡从模型原文解析渲染（`apps/web/src/domains/chat/env-notice.ts`），**合规**；`message.injected`（`execution-unit.ts:1286` 一带）→ V6；`withClearedToolResults` → V2；压缩摘要 → V3。
5. `transcript-items.ts` 折叠/过滤：折叠均可展开，**合规**；无内容 assistant 丢弃（`transcript-items.ts:967`）——模型侧同样为空，允许；未配对 tool 有 orphan 兜底（`transcript-items.ts:1270` 一带），**合规**；失败 run 有失败卡（`transcript-items.ts:1763-1785`），**合规**；verbosity `minimal` 隐藏工具卡（`chat-visibility.ts:31`）属用户显式选择，**允许**；`role === 'system'` 跳过 = **V3**（删除）。
6. `recoverPendingInputs`：**合规**。重放走 `admitInternal` + `reuse_message_id`（`service.ts:3200-3250`），等价于一次正常人类输入 ⇒ `user.message` 落盘、UI 可见。但**恢复失败**（`agent.inbox.recover_failed`，`service.ts:3170` 一带）在 UI 无任何卡或通知，属反向遗漏 → 灰区 G4。
7. `hidden: true` / `internal` / `observe` / `local only` 在模型可见路径上：无 `hidden: true` 字面量；实际生效的是 tier 表与 `runtimeMessageKind` 两处（V4/V5/V6）。另有一处**合法例外**：`emitEvents === false` 的窗口重灌路径直接写 `workingContext` 不发事件（`execution-unit.ts:1549-1554`），内容均为历史旧消息 → 灰区 G5。

## 3 合规定义澄清

**允许的不对称**

- A1 系统提示词/环境块不进聊天流，但必须能在别处全量读到：现在满足（`prompt.system_context` + `EnvCard` 原文块）。
- A2 折叠（工具卡、思考块、env 卡）可展开 ⇒ 满足「包含」，不算违规。
- A3 用户显式动作带来的「多看一点」：`ui.showInternalEvents`、`verbosity: debug`（`visibility.ts:22-23`）⇒ 合规。
- A4 模型见更少（孤儿 tool 被 `normalizeMessages` 丢弃、不完整 tool_calls 降级）⇒ 合规，包含关系只要求 UI ⊇ 模型。

**灰色（需 owner 拍板）**

- G1 **脱敏方向**（V1 的修法二选一）：保留读侧脱敏 + UI 显示同一掩码投影（原文靠显式动作解锁）；还是回到 append 时落掩码、放弃原文保留。影响 0.52 PII 契约与原文留存策略。
- G2 **「包含」的判定定义**：逐字子串 / 规范化后子串 / 允许「带标注的差异」。门禁断言取哪一种。
- G3 `vessel:source` 被吸收进 agent 卡 meta（`transcript-items.ts:894`）——地址与内容都在，但形式变了：算不算满足「逐字一致」。
- G4 恢复失败的用户输入在 UI 无提示（反向：user→model 丢失），是否纳入本不变量。
- G5 `emitEvents === false` 的窗口重灌（`execution-unit.ts:1549-1554`）：模型侧写入无对应事件，门禁须显式豁免，否则误报。
- G6 压缩摘要卡的位置与默认展开度（V3 修好后的呈现形态）。

## 4 修复方案（每项最小改法 / 是否动契约）

| # | 最小改法 | 动契约？ |
|---|---|---|
| F0 | `llm.request` 的 `persistData`（`execution-unit.ts:1935-1941`）补投影指纹：每条消息 `(role, index, sha256(content))` + `mask_flags` / `cleared` 标注。不落全文也够对拍，不放大存储。 | 不动 wire，只改落盘数据（事件 payload 兼容，旧日志缺字段按「不可判定」跳过） |
| F1 | G1 选 A：UI 消息投影复用同一 masker 列表与同一 config，消息卡加「模型侧已脱敏」徽标 + 「看原文」显式动作。G1 选 B：`guardrail-pii` 改为 append 时落掩码。 | 选 A：不动 wire，动 `read-side-mask.ts` 导出面（新增 UI 调用点）。选 B：动 PII 契约（改 `message-invariants.md:32` 的实现推论） |
| F2 | 让 `withClearedToolResults` 真正发 `context.cleared_tool_result`（payload：`call_id` + 占位符 + 原文行数），tool 卡显示「模型看到的是占位符」。事件类型已登记，无需新类型。 | 不动契约（补生产者） |
| F3 | `transcript-items.ts:890` 之前加分支：`compaction_summary` 的 system 消息 → 一张 `kind: 'compaction'` 卡（默认折叠前几行，可展开全文）。摘要已在 `sessions.get().messages` 里，无需新数据。 | 不动契约 |
| F4 | 让「模型可见的 `vessel:*` 消息」默认可见：`runtime-visibility.ts` 里 `limit` / `other` 的 on 条件不再跟随 `showInternalEvents`（该开关只控**事件行**，不控消息）；notice 行补渲 `hint` 原文。 | 不动契约（改 UI 默认值） |
| F5 | `message.injected` 升到 `content` 并给承接（它承载一条真消息）；`prompt.prefix_changed` 给一句 notice。 | 动 UI tier 表语义（`event-visibility.ts`），不动 wire |

## 5 可机械判定的门禁提案：`scripts/check-visibility-symmetry.ts`

形态照抄现有 `scripts/check-chat-visibility.ts` / `check-archived-visibility.ts`（fixture + FAIL 计数 + 退出码），不新增框架。

- **输入**：一个会话的 `llm.request` 序列（模型侧投影，`execution-unit.ts:1923-1930`）+ 同会话 UI 侧投影（`sessions.ts:1083` 原始 messages 经 `transcript-items` 折叠后的可见文本）。
- **断言 A（硬失败，包含关系）**：对每个 `m ∈ modelMessages \ {role: system}`，存在一条 UI 可见项使 `normalize(uiText) ⊇ normalize(m.content)`；system 消息豁免但要过断言 C。
- **断言 B（硬失败，变形可归因）**：若 `m.content` 与 UI 原文不同，则必须存在对应的可见标记（`masked` / `cleared` / `truncated` / `injected`），否则 fail —— 这条直接判 V1/V2。
- **断言 C（硬失败，承接存在性）**：模型可见的 system/注入内容必须命中白名单且能在 UI 渲染：`system_prompt` → `prompt.system_context` 卡；`vessel:notice` → env 卡；`compaction_summary` → compaction 卡（V3 修好后）；`vessel:limit` → limit 卡。
- **断言 D（表驱动，可离线跑，不需要会话）**：`event-visibility.ts` 表加一列 `reachesModel`；规则 `tier !== 'content' && reachesModel && 承接 == null` ⇒ fail；并校验 `live: true` 的事件**必须有生产者**（现在的 `context.cleared_tool_result` 会立刻红）。
- **断言 E（反向豁免）**：`emitEvents === false` 的重灌路径（`execution-unit.ts:1549-1554`）列入白名单，断言「豁免集合只减不增」。
- **前置条件**：必须先做 F0，否则 A/B 在 CI 里永远空转（`content_omitted: true` 让模型侧文本不存在）。

## 6 待 owner 拍板（一句话一条）

1. **G1**：脱敏走「读侧掩码 + UI 同映」还是「append 落掩码」？（决定 V1 修法，影响 0.52 PII 契约）
2. **G2**：「包含」用逐字还是规范化判定？（决定门禁断言 A 的严格度）
3. **G6 / G4 / G5**：压缩摘要卡的呈现形态、恢复失败提示是否纳入、窗口重灌豁免是否接受。

## 7 证据可信度声明

- 本报告所有 `文件:行` 均来自本次审计的实读；未跑测试，**未验证运行时行为**。
- 标「latent」的是「可达但仓内无当前生产者」的路径（V5 反例 B、V6）。
- `apps/web` 无 masker 调用、无 `hidden: true` 字面量，均为**全仓 grep 结论**；若后续新增读取路径，需重跑。
