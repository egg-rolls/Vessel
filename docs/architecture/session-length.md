---
title: 会话长度：四套机制与体积阈值归属
kind: current
triggers: [session length, context window, token budget, projection, placeholder, compaction, compact threshold, tool result volume, volume threshold, rotate, handoff, pagination, prefix]
paths: [packages/core/src/context/context-manager.ts, packages/core/src/context/cleared-tool-result.ts, packages/core/src/runtime/execution-unit.ts, packages/core/src/types/context.ts, packages/agent/src/tool.ts]
---

# 会话长度：四套机制与体积阈值归属

> 一句话：**投射**和**压缩**在同一个段起点动历史，**体积阈值**只是压缩的提前量，**rotate** 是 agent 自己换会话。四者**都不截断单条工具结果** —— 那是工具层的事（见决策 B）。

## 何时用哪个机制

```
单条工具结果本身就巨大？ ............ 是 ▶ 工具层：分页 / 限长 / 稳定 handle（决策 B，不属本文四机制）
只是想不让旧工具结果出网 / 变占位？ ... ▶ 投射（ADR-104；当前只落地 placeholder 一种）
窗口总量接近上限（≥85%）？ ......... ▶ 压缩（段起点：丢头部旧消息 + 1 张摘要卡）
保留的工具结果合计 > 20% 窗口？ ..... ▶ 体积阈值 ⇒ 同一次段起点「提前」压缩
要换 system prompt / 工具集，或彻底重开？ ▶ agent 自己 rotate + handoff
```

rotate 之后，前三种机制的基准全部归零（新 body ⇒ 新 session ⇒ 新段）。

## 决策 A：四机制对比

| 机制 | 触发条件 | 节奏 | 归属层 | 改落盘 | 影响请求前缀 | 失败时会怎样 |
|---|---|---|---|---|---|---|
| 投射（placeholder） | 段起点冻结的清除集合：最新工具结果累计 ≤ 窗口 5%、至少 1 条、至多 10 条（`context-manager.ts:240-260`），其余换成占位 | **run**：段起点算一次，run 内所有请求共用 | core runtime 定基准 + ContextManager 提供纯函数 | 否（只改写发出去的那份副本） | 否（视图 run 内固定；与落盘不同但已声明为 `context_trim`，`:3204-3209`） | 无决策（传 token 数或空集）时一条都不清，视图与落盘逐字一致（`:359-366`）；异常路径未找到 ⇒ 待核实 |
| 压缩 | `shouldCompact()`（`:816-826`）：估算 token > 窗口 × `DEFAULT_COMPACT_THRESHOLD`(0.85)，或条数超兜底上限 `isOverMessageCap` | **段起点**（run / resume 起点、手动 `/compact`）；run 内撑爆不改写历史，只追加「超限」卡（`execution-unit.ts:777`、`:2203-2210`） | context manager（`compactAsync`）；「开新段」在 runtime | **是**：pop 旧消息 + append 一张 `compaction_summary` | 是（头部被摘，前缀自然重算 —— append-only 的合法出口） | 摘要失败退化为占位卡 `[Auto Compact: N older messages summarized...]`，报 `degraded`，不中断 run |
| 体积阈值 | 保留那批工具结果原文估算合计 / 窗口 > `TOOL_RESULT_VOLUME_THRESHOLD_RATIO`(0.20)（`:304-329`） | 段起点判一次 | context manager（纯函数，只回答「该不该」，`:337`） | 否 | 否（它自己不调用任何改写） | 无独立失败面 |
| rotate + handoff | agent 自己判断；90% 压力提示只是建议（`execution-unit.ts:2735-2767`），模型发起需人确认（`packages/agent/src/tool.ts:505-516`） | 任意时刻，跨 run | agent 自觉 + AgentService（见 [member-team](member-team.md)） | 否（旧 session 原样留在盘上） | **是**（新 session ⇒ 新 system prompt 与工具集） | 待核实（spawn / 交接失败的回滚语义） |

## 1. 投射：粒度是 run，不是轮

- 段起点两次调用：`run()` 起点 `execution-unit.ts:1589`、`resumeRun()` 起点 `:2021`，都调 `freezeSegmentClearedToolResults`（定义在 `:806`）；它按 `workingContext` 对象把集合钉住（`:807-810`），而 workingContext **每个 run 新建** ⇒「run 内冻结、run 内所有请求共用」是结构性的，不是约定。
- 为什么必须 run 级：若每轮按当前 messages 重算，最新 K 条会整体右移，上一条被清的消息又被「最新 K 条」认领回来 ⇒ 请求前缀每轮变一次，prefix cache 全丢、append-only 也破了。这段理由写在 `withClearedToolResults` 的注释与请求构建处（`context-manager.ts:359-366`、`execution-unit.ts:3202-3203`）；修法是把「算」与「替换」拆开：`planClearedToolResults:272` 只算，替换在请求构建层。
- 四模式（passthrough / placeholder / externalize / archive_notice）是 [ADR-104](../adr/ADR-104-context-projection-policy.md) 的决策；**当前代码只有 placeholder 形态**（`renderContextTrimNotice` / `formatClearedToolResult`，`cleared-tool-result.ts:166` / `:91`），`externalize` 本轮不实现，core 里还没有模式枚举，也没有 `context_projection` 配置（全仓无实现命中）。

## 2. 压缩：段起点丢**头部**，保尾部

- **丢哪一端（口径纠正）**：「丢尾」「删中段」都不成立。`planCompactionForMessages`（`:161`）取 `toSummarize = nonSystem.slice(0, keepFrom)` ⇒ 丢掉**最旧的头部**，保留最新尾部：尾部累计 ≤ 窗口 30% 的预算、至少留 2 条，配对边界由 owner assistant 回退修正（`:196-215`）。system 消息一律不丢。这条正是决策 B 的理由之一：压缩保不住刚进来的那条大结果。另：项目里的 `pop` /「丢尾」指的是段内丢请求视图尾部，压缩不属它 —— `compaction` 登记在 `SEGMENT_NEW_CAUSES`、kind 是 `new`（`context/request-sequence.ts:315`、`:337`）。
- 摘要卡长什么样：一条 `role: system` 且 `compaction_summary: true` 的消息，插在 system 消息之后、其余历史之前（`applyCompactionToMessages:221-233`）；正文是摘要器输出，摘要器缺失/失败时退化为 `[Auto Compact: N older messages summarized. Continuing...]`（`placeholderSummary:25`），报告标 `degraded`。
- 节奏：`autoCompactAsync`（`:727`）只在段起点被调用（`execution-unit.ts:1585` / `:2019`）。run 内超大不改写历史，只追加超限卡并以失败收尾，等下一个段起点。压缩必然开新段（[message-invariants](message-invariants.md) §3）。

## 3. 体积阈值：量的是「被保留下来的那批」

- 量法 `measureRetainedToolResultVolume`（`:304-329`）：从尾部取 `retainedToolResultCount` 条（`:240-260`，累计 ≤ 窗口 5%、至少 1 条、至多 10 条）工具结果的**原文**估算 token 合计 ÷ maxTokens；`exceeds` 严格大于，等值不触发（`:326-327`）。
- 效果：让 `shouldCompact()` 为 true ⇒ **在这一次段起点就压缩**，即使 token 还不到 85%。判据是纯函数，「该不该」在 context manager，「开新段」在 runtime（`:331-336` 注释）。
- 它**不截断任何东西**：不删 message、不改正文、不缩短工具结果。实测 46 个真实 run 最坏 4.7%，从未触发（[measure-tool-result-clear](../dev/handoff/measure-tool-result-clear.md)）。它抓的是**单条巨型结果**：保留集合含「最新 1 条无论如何保留」这条硬规则（`:254-255`），所以一条巨型结果能直接顶穿 5% 预算 —— 这正是阈值要抓的唯一情形（`:301-302` 注释）。

## 4. rotate + handoff：唯一不在 core 里的机制

- 触发是 agent 的判断，不是 token 计数。core 只在 `ratio ≥ CONTEXT_PRESSURE_WARN_RATIO`(0.9) 且「未超过自动压缩阈值」时，发一条 `[runtime] context_window: …` 尾部消息（同时发 `context.pressure` 事件），hint 建议 `agent(rotate)`，每 run 每 key 只发一次（`execution-unit.ts:2735-2767`）。默认阈值 0.85 < 0.9，所以开着 autoCompact 时这条提示永不出现（`execution-unit.ts:2736`；另见 [context](context.md)）。
- rotate 换 body ⇒ 换 session（`packages/agent/src/registry.ts:5`，`body_id ≡ session_id`），因此它是**唯一能重置 system prompt 与工具集**的机制：同 session 内 base system 变了只发 notice、不开新段（`execution-unit.ts:1591-1598`）。交接只走 `startup_prompt`（`tool.ts:501-503`），人可见。
- 边界：不以 token 计为触发、不属 core 自动行为、不改旧会话落盘；它与前三种不共享状态。

## 决策 B：体积阈值放会话层还是工具层

**预防在工具层，观测与兜底在会话层。** 0.20 是「工具层失职」的告警，健康系统里应接近 0 次触发；单条结果不该巨大，第一责任在工具本身。

理由：

1. 会话层只能**事后压缩**，而压缩丢的是最旧的头部，**丢不掉刚进来的那条巨大结果** —— 越大越新，越被「最新 1 条必留」保住。钱也已经花了：投影与压缩都在这一轮请求之后才生效，钱已在那一轮付掉。
2. 压缩后原文**不再可寻址**：被摘要或占位掉的内容，人和 agent 都不能再按行号/路径取第二遍。工具层知道语义（行号、JSON 路径、匹配序号），能**无损分片**；会话层只知道「一大坨字符串」。
3. 只有会话层同时看得见窗口总量、消息构成与全局占比；工具层各自不知道别人贡献了多少。

**工具层该做的**（这是要求，不是现状断言）：`read` 分页（返回 `has_more` / `next_offset`）、`bash` 输出限长并告知「已截断到 N 行，用 `sed -n` 续读」、`grep` 限匹配数、大结果给稳定 handle 可分段取。

硬约束：工具层截断**不得静默丢弃**，必须说清截断了多少、怎么续读；否则违反可见性对等的精神（[message-invariants](message-invariants.md) §1 —— agent 看不见的那部分也必须被明说出来）。

反例 / 风险：

- **只靠工具层**：多个工具各让一点，拼起来仍可能爆窗口；工具被替换（插件 / MCP / 外部 harness）时无人兜底 ⇒ 会话层兜底不能删。
- **只靠会话层**：巨大结果已经进了上下文（钱已花，可能一次就爆），而且压缩保不住它（理由 1）；请求可能直接被 provider 拒绝。
- 口径差异：ADR-104 D6 说 `passthrough` 下超阈值**只发** `context.projection_pressure`、不触发压缩；该行为**当前未实现**（`context_projection` / `projection_pressure` 全仓无实现命中），现存实现只有一条路径：走 `shouldCompact()` 的压缩分支。**待核实**。

## 不要混淆的事

| 看起来像 | 实际不是 |
|---|---|
| 投射 ≈ 压缩 | 投射只改写**发出去的那份副本**，落盘一字不动、run 内冻结（[message-invariants](message-invariants.md) §2 允许的唯一视图层改写）；压缩**真的改落盘**：pop 旧消息 + append 摘要卡，且必然开新段。 |
| 体积阈值 ≈ 截断 | 它只让压缩提前发生；不看单条结果占窗口多少，也不动任何正文。 |
| rotate ≈ 压缩 | rotate 换 session（新 system prompt / 工具集、基准归零）；压缩在同一 session 内开新段。 |
| 工具结果占位 ≈ PII 脱敏 | 占位是**请求期**、可逆、run 内冻结、原文仍在盘上；PII 脱敏 **append 即定型**（`protect()` 在写入前做真值 → 句柄，降级是掩码，写入即不可逆，`execution-unit.ts:896`）。 |

## 交叉索引

- [message-invariants](message-invariants.md)：两条不变量（可见性对等 / 请求 append-only）与 §3「分段只有 new / pop」—— 本文四机制都受约束。
- [context](context.md)：WorkingContext per Run、注入点、压缩与前缀不变量的完整表。
- [ADR-104](../adr/ADR-104-context-projection-policy.md)：四模式定义与 D6（模式与压缩的关系）。
- [member-team](member-team.md)：rotate / admit / dispatch 与 body 生命周期。
- [measure-tool-result-clear](../dev/handoff/measure-tool-result-clear.md)：46 个真实 run 的体积实测、判据与门禁清单。
- [refresh-gap-design](../dev/handoff/refresh-gap-design.md)：相邻但不同层 —— 它讲事件流回放缺口。相关点：投射 / 压缩 / 体积阈值这三件事的判定大多**不产生正文**，留痕靠事件（`context.compacted`、`context.pressure`）；gap 一出现这些事件就永久丢，长会话复盘只能靠消息侧的 `[runtime]` 尾巴（`:146`）。
- `docs/dev/handoff/tool-result-compression-mechanism.md`：**本分支不存在**（`docs/dev/handoff/` 下无此文件）⇒ 未链接，待核实是否改名或未落库。

## 待核实

1. ADR-104 D6 与现码不一致（见决策 B 末条）：`context_projection` / `projection_pressure` 是否有在途实现。
2. rotate 失败（spawn / 交接失败）时的回滚与用户可见文案。
3. 投射替换链路上的异常降级：本文按 `withClearedToolResults` 默认形态推断为「一条都不清」，未找到显式 catch。
4. 工具层现状（`read` 的 `has_more`/`next_offset`、`bash` 限长、`grep` 限匹配数）**不在本仓库**：packages 里没有内置 read/bash/grep 实现，工具面由 harness 注入（`packages/agent/src/tool-surface-delta.ts`）。
