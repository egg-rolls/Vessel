---
adr: 104
title: 会话级上下文投射模式（passthrough / placeholder / externalize / archive_notice）
status: proposed
date: 2026-11-14
updated: 2026-11-15（用户裁定：默认 mode = `placeholder`；子 agent 允许收紧禁止放松；模式可跨会话混用；实现分期 U1/U2/U3）
related: [085, 099]
tags: [context, tools, projection, session, audit, gate, cache, compaction, extension-boundary]
---

## ADR-104：会话级上下文投射模式（passthrough / placeholder / externalize / archive_notice）

- **状态**：proposed。
- **owner 裁定（已并入）**：
  1. **不做插件，内化为 core 内建能力**。会话是底层逻辑，控制权暂由 vessel 官方（core + 官方装配层 /
     CLI）持有；机制成熟后再议开放（前置条件见 §3）。
  2. **字段命名防撞语义**：枚举值自带语义、不靠上下文猜；落盘字段一旦写下就不能改名（§2.1）。
  3. **`externalize` 本轮不实现**：只留枚举位与拒绝路径，机制细节降级为附录 A（冻结）。
  4. **`archive_notice` 保留**，机制见 §2.3；它的可用性硬绑"读回路径"。
  5. **阈值沿用现状**：`0.85` 主阈值不动，`0.20` 体积压力只告警；per-mode 阈值列为未定事项（§9）。
  6. 其余四项：判别键名 `.mode`；legacy 会话 C1h 继续红、不开临时放行；`params` 不公开成配置键；
     T6 语义变更**算破坏性变更**（需 minor + CHANGELOG）。
- **2026-11-15 用户裁定（本版修订，四条；改动处均标注「2026-11-15 用户裁定」）**：
  1. **默认 mode 全部改为 `placeholder`**（原稿为「新会话默认 `passthrough`」）。用户原话：「**先用 placeholder**」。
     依据是成本账实测（`docs/dev/handoff/cache-ab-cost-model.md`：645 段净赚 36:1、临界缓存折扣
     `r* = 2.68%`，§8.1 依据行）。`passthrough` 由此重新定位为**手动 opt-in 的逃生门**，不再是默认值；
     0.52 前旧会话仍为 `placeholder` + `source:'legacy'`（不顺带改，保持原口径）。
  2. **子 agent 的提权规则改为「允许收紧、禁止放松」**（原稿是「父 `passthrough` ⇒ 子只能 `passthrough`」，
     即只许同层或放松）；见 §8.3.1。
  3. **模式可跨会话混用**：不同会话各自声明不同模式（父 `placeholder` + 子 `archive_notice` 合法），
     同一批量/团队不要求统一；同一会话内仍不可变（§8.2）。用户原话：「之后要用的时候，可以混着用」。
     见 §2.5。
  4. **实现按期分三步（U1 → U2 → U3），`externalize` 本轮不实现**：见附录 B。
- **本轮范围**：只有这份 ADR。不改任何代码、不跑测试、不改 `docs/architecture/message-invariants.md`。
  §6 / §11 的文件清单是给实现轮的施工图，不是本轮改动。

### 0. 先核实的事实（后面所有条款都建在这上面）

| 事实 | 证据位置（main `7b99b90e`） | 对本 ADR 的后果 |
| --- | --- | --- |
| Hook 面**只能追加**，不能重写历史 | `packages/core/src/types/hook.ts`：`HookResult` 只有 `messages?`（追加）与 `block`；`systemPrompt` 写入被忽略并发 `hook.system_prompt_ignored`；hook 拿不到上下文正文 | **这是"现在不开放"的结构性理由**，不是单纯前提：append-only 的插件面在类型上就写不出 `placeholder` / `externalize`（这两种模式的全部内容就是"改写已存在的历史消息"），而给它加重写能力等于把"每轮前缀可变"合法化。结论：机制必须 core；将来即使开放，也只能开放"返回 ids 的决策"，不能开放"返回消息"。 |
| 现实现的占位是**请求期滤镜**，落盘仍是原文 | `context-manager.ts` 请求构建处注释："至多一处视图层改写……任何没有决策的请求，视图必须与落盘逐字一致"；替换点是 `formatClearedToolResult(...)` | 投射**不是段操作**（既非 `new` 也非 `pop`）。不得借 `context_trim` 解释它 —— `request-sequence.ts` 已写下：`context_trim` 是 pop 原因，"pop 不能解释中段改写"，V1 拿它解释中段改写"当场就红了"。 |
| C1h（存档 = 请求投影 = UI 列表，逐字一致；任何读侧滤镜都违反）**现在是 PENDING** | `docs/architecture/message-invariants.md`；`check-append-only-context.ts` 20 pass / 1 pending | 本 ADR 不宣称 C1h 变绿。它给出一条**受会话声明约束**的放行路径（D4），放行条件是四真同时成立。 |

**决策粒度的事实（本轮在代码里逐条核过，ADR 早期草案把它写成"段"是错的）：**

| 事实 | 证据位置 | 后果 |
| --- | --- | --- |
| 投射的冻结点 = **run 起点**（新 run 与 resume 各一次） | `execution-unit.ts:1589`（run 起点）、`:2021`（resume 起点）调 `freezeSegmentClearedToolResults` | 决策粒度是 run，不是"压缩边界/段" |
| 冻结表是 `WeakMap<object, ids>`，键是**每次 run 新建**的 `workingContext` | `:788` `segmentClearPlans = new WeakMap<object, readonly string[]>()`；`:1306` `const workingContext = this.contextFactory({ sessionId })` | 每个 run 起点必然重算；run 内所有请求共用同一份集合（一个 run 的工具循环会发很多次 LLM 请求） |
| 压缩与体积阈值是**另一套机制**：安全阀 + 提前触发压缩 | `context-manager.ts:816 shouldCompact()`（含 `shouldCompactForToolResultVolume`，由 `:823` 调用）；压缩只在 `compactAtSegmentStart`（`execution-unit.ts:741`）与手动压缩处发生 | 它们**不决定投射何时启动**；投射每 run 起点都跑，压缩只是可能在那次 run 起点真的丢东西 |

补充事实（本轮新核实，直接决定 `archive_notice` 的可行性）：

- 压缩丢的是**最旧的一段连续前缀**：`toSummarize = nonSystem.slice(0, keepFrom)`；边界因配对完整性
  回退到 owning assistant，所以丢弃集合永远以 assistant 为界（`context-manager.ts`）。
- 会话事件日志是落盘的追加式 ndjson（`<sessions_dir>/<session_id>/events.ndjson`，0600、每条 fsync，
  `session-event-log.ts`）—— 这是"原文还能读回"的唯一持久来源。
- 读回 RPC `sessions.events` **尚未实现**：它是 `docs/dev/handoff/refresh-gap-design.md` §3 方案 B /
  §7 第 1 项（"新增 RPC，需批准 + `check-rpc-methods` 登记"）。当前 `sessions.*` 方法里没有它。

补充实测（`docs/dev/handoff/measure-tool-result-clear.md`，46 次真实会话）：保留体积占比最大 **4.7%**，
多数会话 0–3%；按 **run 起点**冻结后前缀缓存上界从 37.0% 改善到 74.8%。

### 1. 背景与问题

**1.1 现机制（四步，全局默认，不可关）**

1. 请求构建时，`planClearedToolResults` 选一组要清的工具结果 id：保留最近 `≤10` 条、累计
   `≤ maxTokens × KEEP_RECENT_TOKEN_RATIO (0.05)`，其余进清除集合（`ToolResultKeepOptions` 可覆盖，
   但**配置层没有这两个键**）。
2. **run 起点**冻结该集合（新 run 与 resume 各算一次），run 内不再重选 —— run 内前缀稳定的来源。
3. 请求视图把被清结果正文换成机械占位（`formatClearedToolResult`），**落盘不动**。
4. 冻结当轮向历史追加一条 trim 卡（`appendNotice(renderContextTrimNotice(...))`），写
   `context.cleared_tool_result` 事件 + 审计字段 `cleared_tool_call_ids`。

体积维度另有一道闸：`TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.20`（保留预算的 4 倍），只可能被
**单条巨型结果**顶到。

**1.2 为什么要改**

- **收益量级错配：问题不是"占位赚不赚"，而是"全局强制唯一取值不可换"**。4.7% 只是**省字**上界，多数会话
  0–3%；真正的成本账要算缓存（`cache-ab-cost-model.md` 实测：段内冻结后净赚 **36:1**，见 §8.1 依据）。
  所以 2026-11-15 用户裁定的口径是：**默认仍是 `placeholder`**（"先用 placeholder"），但模式必须变成
  会话级可声明——否则"长文件阅读类"这类 `r*` 高的会话没有任何办法关掉它，而"多工具大输出类"也没法
  按需收紧到 `archive_notice`。
- **缓存代价断在 run 起点，不是"每轮请求"，也不是"段边界"**：

  | 实现 | 断点在哪 | 一个 run 有 20 次工具调用时 |
  | --- | --- | --- |
  | 0.51 及以前（每次请求按当前 messages 重算窗口） | 每次请求都可能多清一条 ⇒ 前缀整体右移 | **20 次断裂**（每个请求都比上一个多差一条） |
  | 0.52 V1（run 起点冻结） | run 起点一次 | **1 次**（run 内 20 次请求前缀逐字节稳定） |
  | 本 ADR（四模式） | 同 V1：run 起点、且只有"新增了要清的 id"时 | 1 次；`passthrough` / `archive_notice`（substitute=none）下集合不变 ⇒ **0 次** |

  实测口径：冻结后前缀缓存上界 37.0% → 74.8%（未命中上行界 100%）。所以准确说法是
  「**每个 run 起点可能断一次，run 内所有请求前缀稳定**」——"段边界断一次"是错的（段可以横跨多个 run）。

**度量 basis（避免把 4.7% 读成"平均收益"）**：

| 项 | 口径 |
| --- | --- |
| 样本 | 46 次真实会话（`docs/dev/handoff/measure-tool-result-clear.md`） |
| 指标 | "被保留的工具结果体积 ÷ `maxTokens`"的单会话**最大值**，不是全会话平均 |
| 因此 | **4.7% 只是省字上界**，多数会话 0–3%；它**不能**用来论证"默认值该给谁"——默认值的依据是成本账（§8.1 依据行），不是这个数 |
| 缓存指标 | 前缀缓存命中率**上界**（冻结前 37.0% / 冻结后 74.8%；未命中上行界 100%） |
| 已知偏差 | 样本全部来自本地 CLI 场景；WebUI / 团队并发会话未纳入（这也是 per-mode 阈值暂不定的原因之一，§10.2 第 1 项） |
- **占位没有摘要 ⇒ 重调用**：占位只说明"这里有过一个结果"，模型拿不到可复用信息，于是重跑同样的工具，
  净 token 反而更高。这是 `placeholder` 的结构性缺陷，不是参数问题；`archive_notice`（§2.3）就是
  针对这一条设计的。
- **没有会话级开关**：长跑工程会话需要压；短问答会话需要一字不改地看原文。一个默认值不能同时服务两者。

**1.3 目标 / 非目标**

- 目标：把"上下文投射"从全局默认行为改成**会话声明 + core 内建决策 + core 机械执行**；四种模式在一套
  契约下共存（`externalize` 本轮只占位）；门禁按 mode 精确判定；切换不破坏段语义与可重放；
  **不引入任何扩展点**。
- 非目标：不做摘要式压缩（那是 compaction / ADR-085 的地盘）；不把 Hook 面扩成可改写；不宣称
  同进程插件是安全边界；不在本轮实现。

### 2. 决策

#### 2.1 字段命名表（落盘契约，**冻结**；改名必须先改本 ADR）

| 字段 | 取值枚举 | 默认值 | 语义一句话 | 反例（不能用及原因） |
| --- | --- | --- | --- | --- |
| `SessionState.context_projection` | 声明对象（下表） | **总是存在**（会话创建时写） | 会话级底层投射声明 | ❌ `tool_result_clearing` / `compress_tool_results`：写成"工具结果压缩开关"，但 `externalize` 与 `archive_notice` 不是压缩，且 `passthrough` 下这个字段仍然有意义（它声明了"不投射"） |
| `context_projection.mode` | `passthrough` / `placeholder` / `externalize` / `archive_notice` | **新会话 `placeholder`**（2026-11-15 用户裁定：「先用 placeholder」）；0.52 前旧会话 `placeholder` + `source:'legacy'`（§7.1）。`passthrough` 是**手动 opt-in**、不是默认值（§8.1） | 请求视图如何由落盘历史导出 | ❌ `off` / `none` / `disabled` / `false`：会被读成"关闭了会话 / 关闭了上下文"，而这里关掉的只是"投射"；❌ `clear`：与 `cleared_tool_call_ids` 同词根但语义漂移（听起来像"清空上下文"）；❌ `on` / `true` / `compact`：把流程（压缩）当模式名 |
| `context_projection.declaration_id` | ulid | 创建时生成 | 声明幂等键 + 豁免判定凭据 | ❌ `session_id`：复用它无法表达"同段/同会话内声明不可替换"的幂等语义 |
| `context_projection.source` | `session_created` / `default` / `legacy` / `rotate` / `inherited` | 按建会话路径 | 这条声明由**谁**定（用户显式 / 系统缺省 / 旧会话补写 / agent rotate 自选 / 父会话继承） | ❌ `explicit: boolean`：`default`、`legacy`、`inherited` 都是"非显式"，布尔表不出三种来源；❌ 复用 `rotate` 表示继承：`inherited` 的主语是父会话，`rotate` 的主语是 agent 自己 |
| `context_projection.policy` | `core.context_projection`（固定） | 固定 | 决策由哪个**内建**实现产出 | ❌ `strategy` / `plugin_id`：现阶段没有插件，叫 strategy 会诱导后来的人当扩展点 |
| `context_projection.params` | 见 §4.2 | `keepRecentTokenRatio 0.05`、`keepRecentMax 10`、`volumeRatio 0.20` | run 起点解析并夹紧后的参数快照 | ❌ 拆成 `keep` / `clear` / `compact` 顶层字段：params 是一组，散落后每加一个都要改落盘 schema |
| `SessionState.context_projection_audit` | 审计对象（§5.1） | 无（旧会话缺省） | 每次决策变更的 run 起点一条的冻结决策与执行记录 | ❌ `projection_stats` / `projection_metrics`：它是重放的**唯一真相**，stats 听起来可丢 |
| `SessionState.cleared_tool_call_ids` | `string[]` | 无 | `placeholder` 模式的审计（**既有，不改名**） | ❌ 改名 `projected_ids`：落盘字段改名让旧会话不可读，换来的只是审美 |
| `context_projection_audit.mode` vs `.effective_mode` | 同 mode 枚举 | `.effective_mode = mode` | 声明值 vs 真实生效值 | ❌ 只留一个 `mode`：降级时会丢掉"用户声明了什么"，重放与告警都读不出差异 |

**旧命名处理**（逐项给结论，不留"以后再定"）：

| 既有符号 | 结论 |
| --- | --- |
| `cleared_tool_call_ids`（落盘） | **保留**，不改名，语义不变（`placeholder` 模式的审计） |
| `planClearedToolResults` / `isClearedToolResult` / `formatClearedToolResult` / `renderContextTrimNotice` / `KEEP_RECENT_TOKEN_RATIO` / `KEEP_RECENT_MAX` / `TOOL_RESULT_VOLUME_THRESHOLD_RATIO` | **保留原名**：它们描述的正是 `placeholder` 模式的机制与保留预算，语义未变。改名会让"这条门禁盯的是哪个常量"在 diff 里断掉 |
| `withClearedToolResults`（内部符号） | **改名** `applyContextProjection`：同一 commit 改全部调用点与门禁注释，无落盘影响 |
| `enableToolResultClearing` 一类布尔开关 | **不新增**（核查过：当前代码里不存在这样的开关）。布尔无法表达四模式，且 `false` 要表达 `passthrough` 会把"未设置"与"主动不投射"混成一件事 |

#### 2.2 四种模式：两个正交开关的四个点

模式不是四个并列分支，而是 `(substitute, announce)` 两维上的四个点 —— 门禁因此可以用两条断言覆盖全部模式。

| mode | 本轮落地 | substitute（替换正文） | announce（压缩发生的那次 run 起点追加一条卡） | 是否省 token | C1h |
| --- | --- | --- | --- | --- | --- |
| `passthrough` | **是**（**手动 opt-in 的逃生门**，不是默认值；2026-11-15 用户裁定） | `none` | `none` | 否（不投射基线） | 逐字一致，**不解禁** |
| `placeholder` | **是**（现实现；**新会话默认**，2026-11-15 用户裁定） | `placeholder` | trim 卡 | 是（实测 ≤4.7%） | 需会话级豁免 |
| `archive_notice` | **是**（代码就绪；默认白名单未启用，§7.3；硬依赖读回路径 §2.3f） | `none` | archive 卡 | **否** —— 省字全部来自压缩丢弃，卡本身净增 | 逐字一致（卡已落盘），**不解禁** |
| `externalize` | **`not_implemented`** | —（本轮为空） | —（本轮为空） | 本轮无 | 本轮无（声明即拒绝，§4.4） |

条款：模式枚举是**闭集** `'passthrough' | 'placeholder' | 'externalize' | 'archive_notice'`，类型定义与
门禁词表各登记一处；`externalize` **只占位、不可声明**；新增模式或解冻 `externalize` 必须先改本 ADR。

#### 2.3 `archive_notice` 的准确作用

一句话：**它不省一个字节，只把"被压缩丢掉的那批工具结果"从"无声消失"变成"一条可回读的归档卡"。**

**(a) 触发点：压缩真正丢东西的那一次 run 起点，run 内不动。** 压缩只在 `compactAtSegmentStart`
（run 起点 / resume）与用户显式压缩处发生（`execution-unit.ts:741`）；run 内撑爆上下文走「超限」卡 +
失败收尾，**不**压缩。所以归档卡只可能出现在这几种时刻之一。`DEFAULT_COMPACT_THRESHOLD = 0.85` 决定
"这次 run 起点要不要压缩"；`TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.20` 只是让 `shouldCompact()` 更早
为真（= 提前压缩），**与四模式何时启动无关** —— 投射每 run 起点都跑（D5）。0.20 触顶本身在
`passthrough` / `archive_notice` 下不产生任何压缩动作，只发 `context.projection_pressure` 告警。
run 内一律不动：run 内既不重算归档集合，也不追加第二张卡（R4d）。

**(b) 动作：不改写任何工具结果正文。** 重基座由压缩既有的**最旧优先丢弃**构成（压缩只在 run 起点发生）：
`toSummarize = nonSystem.slice(0, keepFrom)`，即丢弃最旧的一段**连续前缀**（配对完整性会把边界回退到
owning assistant）。归档对象 = **被丢弃前缀里的 `role === 'tool'` 消息**。丢与不丢**完全由既有压缩逻辑
决定**：`archive_notice` 不参与 `keepFrom`、`messageCapFor`、`keepRecent*` 的任何计算，也不会让压缩
多丢或少丢一条。

**(c) 追加：在压缩发生的那一次 run 起点，往历史尾部 append 一条持久化、UI 可见的合成消息（归档卡）。**
走既有 `appendNotice` 路径 ⇒ 与 trim 卡同一类，进 `sessions.*` 投影与 UI 消息列表。卡携带结构化元数据：

| 字段 | 内容 |
| --- | --- |
| `archived_tool_call_ids` | 被归档结果的 `tool_call_id` 列表（按丢弃顺序） |
| `tool_names` | 逐条工具名 |
| `bytes` | 逐条 + 合计原始字节数 |
| `source_log` | 原文所在：`<sessions_dir>/<session_id>/events.ndjson`（相对会话目录，见 §10.2 第 6 项） |
| `readback` | 读回方式：按 `tool_call_id` 从事件日志的 tool 结果记录回填；RPC 形态 = `sessions.events`（**未实现**，见 §0 与 §7.3） |

**(d) 模型侧效果：从"死占位"变成"知道怎么拿回来"。** 用 `placeholder` 时模型看到的是一条
`[cleared …]`、没有摘要、没有出路的占位，于是重跑同一个工具（§1.2 第三条）；用 `archive_notice` 时
模型看到"这批结果已归档 + 在哪 + 按 id 怎么取"，可以主动重读而不是盲目重跑。这是它唯一的价值。

**(e) 不变量（三条，都可断言）**

1. **不消费 substitute ⇒ 不消费 C1h 豁免**：卡是落盘消息，请求视图不需要任何滤镜，请求与落盘逐字一致。
   D4 第 1 条把 `archive_notice` 明确排除在豁免之外。
2. **append-only**：卡只在压缩发生的那次 run 起点追加一次，run 内不追加第二张（R4d）；重基座由压缩负责（既有 `new`/`pop`
   语义），投射层不引入任何新的历史改写。
3. **可见性对等**：UI 与模型看到**同一条卡**（同一 `message_id`、同一 `text_hash`）；不存在"UI 有、
   模型无"或反过来的旁路（C1h 的另一半语义）。

**(f) 代价与依赖**

- **自己不省 token**：省字 100% 来自压缩丢弃；卡本身占几十 token/段（上限 200 token）。
- **硬依赖读回路径**：卡写"怎么拿回来"才有意义，而读回依赖磁盘事件日志 + `sessions.events`
  （**当前未实现**）。读回路径不可用时，`archive_notice` 声明在会话创建时**降级为 `placeholder`**
  （**2026-11-15 用户裁定的推论**：原稿为 `passthrough`；默认值改为 `placeholder` 后降级目标随之改为
  默认值，且降级不得放松严格度，§8.3.1），并落
  `context.projection_degraded{reason:'readback_unavailable'}`（审计 `effective_mode: 'placeholder'`）
  —— 不允许写一张"指向不存在路径"的卡。
- **模型侧还缺一个读回通道**：现在没有任何面向模型的工具能按 `tool_call_id` 读会话事件 ⇒ 当前卡的
  "怎么拿回来"只对人/编排层成立。这一项列入 §10.2 未定事项，并与 `sessions.events` 同期解决。

#### 2.4 粒度：决策粒度是 **run**，不是段；模式粒度是 **会话**

三层粒度必须分开写，否则很容易把"每 run 重算"误读成"run 内改集合"：

| 层 | 时间粒度 | 决定什么 | 何时算 |
| --- | --- | --- | --- |
| **会话** | 整个 session | `mode`、`params`、`excluded_tools`、`declaration_id` | **会话创建时一次**，会话内不可变 |
| **run** | 每个 run 起点（新 run 与 resume 各一次） | 这一轮要投射哪些 `tool_call_id`（集合），以及 `plan_hash` | **每个 run 起点重算并冻结**；run 内所有请求共用 |
| **段** | 由段原因界定（`session_switch` / `compaction` / `context_trim` 的 pop） | 前缀是否被允许改形、缓存从哪重基座 | 压缩只在 run 起点发生；段可以横跨多个 run |

由此得到三条必须分开理解的结论：

1. **模式不可变 ≠ 集合不可变**。`ProjectionModeImmutableError` / `context.projection_rejected` 的触发
   条件只有一个：**试图在会话内改声明**（改 `mode`、`params`、`excluded_tools` 或写第二条声明）。
   换模式只能换会话。
2. **集合每 run 起点重算是正常行为，不是违规**。一个 run 的工具循环会发很多次 LLM 请求，它们共用
   同一份集合；下一个 run 起点按当时的 messages 重算，集合变大是预期结果（新产生的旧结果是新事实）。
   违规只有一种：**run 内**（同一次 run 的多次请求之间）集合变了。
3. **`plan_hash` 的恒定范围是 run**（不是段、不是会话）。下游门禁/告警按 run 作界：run 内两次请求
   hash 不同 ⇒ 红；跨 run hash 不同 ⇒ 正常。

#### 2.5 模式可跨会话混用（2026-11-15 用户裁定）

用户原话：「**之后要用的时候，可以混着用**。」落成条款：

- **模式是会话级属性，不同会话可各自声明不同模式**（父 `placeholder` + 子 `archive_notice` 合法；
  同一团队里一个成员 `passthrough`、另一个 `placeholder` 也合法）。
- **同一批量 / 同一团队 / 同一次 `agent create` 派生**都不要求模式统一：任何"为了整齐而强制同模式"的
  实现或门禁都是**违规**（会把可混用退回成一刀切）。
- **同一会话内仍不可变**（§2.4 / §8.2）：可混用只发生在**会话边界之间**，不发生在会话中途。
- 唯一的一致性约束来自 §8.3.1 的**单调收紧**：子的严格度**不得低于**父（`passthrough` 最松）。

#### D1：内化为 core —— 决策层与机制层都在 core，只隔一个**内部 seam**

| 职责 | 归属（均在 core 内） | 落点 |
| --- | --- | --- |
| 选哪些 `tool_call_id` 进投射集合、豁免哪些工具、参数取值 | **决策层**（core 内建） | `packages/core/src/context/projection-policy.ts` |
| 占位 / 归档卡 / trim 卡的**文本渲染** | **机制层** | `formatClearedToolResult` / `renderContextTrimNotice` / `renderProjectionArchiveNotice` |
| run 起点冻结 | 机制层 | run 起点一次性冻结，run 内不重选（`execution-unit.ts:1589` / resume `:2021`） |
| 审计字段与事件写入 | 机制层 | `cleared_tool_call_ids` / `context_projection_audit` |
| 请求构建时的替换点 | 机制层 | `buildRequestMessages` 里唯一一处视图层改写 |
| 门禁判定 | 机制层 | §6（门禁只调 `isProjectionExempt()`，不复制判定逻辑） |

**内部 seam ≠ 公开插件 API**（硬条款）：

- seam 是 `packages/core/src/context/projection-policy.ts` 里的 `ContextProjectionPolicy`，标 `@internal`，
  **不从** `packages/core/src/index.ts` 导出，**不**在 `PluginHost` 上注册，**不**写进
  `docs/architecture/extensions.md`。
- 存在的唯一目的：将来若真要抽离/开放，机制层不用重写。代价是现在就得把入参出参冻结好。
- 制度闸：**把 seam 变成公开 API 的唯一合法路径是先修订 ADR**（并在 ADR-099 的"四类能力面"上走修订，
  而不是先改实现）。"先在 `index.ts` 导出、以后再补 ADR"按违规处理。

#### D2：决策层不产出文本

决策层只产出 **ids + mode + params + excludedTools**（+ 卡的**种类**，不是文本）。理由可判定：
R4（**run 内**占位/卡条数不增）、C1h（存档=投影）、缓存冻结三条门禁都以"**渲染是输入的纯函数**"为前提。

条款：内部 seam 的返回类型里**不存在**任何 `content` / `text` / `template` 字段；渲染函数签名只接受
`(toolCallId, toolName, bytes, 元数据)` 这类结构化数据，**不接受消息正文** —— 决策层在类型上就无法把内容
塞进占位/卡里。

#### D3：模式是会话属性（不可变）；集合是 run 属性（每 run 起点重算）

这两件事必须分开写（§2.4）：

- **模式 / 参数 / 豁免工具 = 会话级**。会话创建时写入声明（**总是写**，包括 `passthrough`），来源记
  `source`。"总是写"是为了让 D4 的豁免判定不需要"字段缺失即通过"这种隐式缺省。
- **要换模式 ⇒ 换会话**。会话内试图改声明（任何时刻，包括 run 起点）⇒ **拒绝**：抛
  `ProjectionModeImmutableError`，落 `context.projection_rejected`。因此 R3 的段原因词表**不新增**
  `mode_changed` 之类 —— 刻意不开"中途换投影"的洗白通道。
- **集合 = run 级**。每个 run 起点（新 run 与 resume）按当时 messages 重算并冻结；run 内所有请求共用。
  **每 run 重算是正常行为，不是违规**；违规只发生在 run 内集合发生变化。参数在 run 起点解析并夹紧，
  run 内请求一律读冻结值。

#### D4：C1h 豁免只挂在会话声明上

四真同时成立才放行，缺一条就红：

1. `context_projection.mode ∈ {placeholder}`（本轮只有它消费豁免；`passthrough` / `archive_notice` /
   未实现的 `externalize` 都不消费）；
2. `context_projection.declaration_id` 存在（声明存在性，不是"字段缺省即通过"）；
3. 对应审计存在：`cleared_tool_call_ids`（数组，可为空），且审计里的 `declaration_id` **等于**声明里的
   （防"拿 A 会话的声明解 B 会话的锁"）；
4. 请求视图由 core 从该声明 + 冻结计划纯函数渲染（**run 内** `plan_hash` 恒定，§6.1 R4a）。

**不许**全局白名单、**不许**按工具名白名单、**不许**环境变量开关。豁免唯一实现落点
`isProjectionExempt(session, audit)`，运行时与门禁**共用**这一个函数。legacy 会话（无审计记录）**继续红**，
不开迁移期临时放行。

#### D5：两个阈值各管各的；per-mode 阈值是未定事项

先纠正一个容易混的说法：**体积阈值与"四模式何时启动"无关**。投射在**每个 run 起点**都跑（§2.4），
阈值只决定"这一次 run 起点要不要压缩"。

| 常量 | 现值 | 作用对象 | 与投射的关系 |
| --- | --- | --- | --- |
| `DEFAULT_COMPACT_THRESHOLD` | `0.85`（**代码现值，不改数**） | `shouldCompact()` 的 token 主判据 → 是否在**这次 run 起点**压缩（`compactAtSegmentStart`） | 无关。它只决定段要不要重基座；任何 mode 下都保留 ⇒ 这就是"不会撞上下文溢出"的硬兜底 |
| `TOOL_RESULT_VOLUME_THRESHOLD_RATIO` | `0.20` | 同一处 `shouldCompact()`（`shouldCompactForToolResultVolume`，`context-manager.ts:823`） | 无关。它让压缩**更早**发生（单条巨型结果触顶），不让投射启动得更早 |

按模式分述：

- `placeholder`：0.20 触顶 ⇒ 压缩可能在那次 run 起点发生（等于"提前压一次"）；集合仍由 run 起点重算决定。
- `passthrough` / `archive_notice`：0.20 触顶**只发** `context.projection_pressure`（带
  `retained_tokens / max_tokens / ratio / top_result_bytes`），**不**占位、**不**自动压缩、**不**切模式。
  注意 0.85 主判据在这两个模式下照旧生效 —— 关掉的只是"体积维度多一个提前触发原因"。
- provider 返回 `context_length_exceeded` 时仍走既有 `context_trim`（pop，一次到位），且**不得**顺手把
  mode 改成 `placeholder`（改模式只能靠新会话）。
- **未定事项**：per-mode 阈值（例如 `archive_notice` 是否该用更低的体积阈值去提示开新段）**当前不就绪**，
  需要按模式做 A/B 数据；本 ADR 不预设任何 per-mode 数值（§10.2 第 1 项）。

#### D6：不扩 Hook 面、不新增插件注册点

- `HookResult` 保持 append-only。**不**给 hook 加重写/删除历史消息的能力，也不开放 `cache_control` 之类的注入。
- `PluginHost` 保持四类能力面（tool / provider / guardrail / hook），**不新增**
  `registerContextProjectionPolicy` 之类的方法。直接后果：**ADR-099 本轮不需要修订** —— 这是"现在不开放"
  最直接的收益，少一次把内部机制暴露成对外契约的机会。

#### D7：配置来源三层，冲突规则写死

优先级（高 → 低）：

1. **会话创建参数**（`context_projection` 显式声明）；
2. **节点级配置** `config.context.projectionDefaultMode`（一个 harness 实例 = 一个节点；由官方装配层 / CLI 传入）；
3. **core 内建默认**（**新会话 `placeholder`**，2026-11-15 用户裁定；旧会话走 §7.1 的兼容路径）。

规则：

- 高优先级值必须通过 §4.3 校验；**校验失败 = 会话创建失败**（`projection_declaration_invalid` 或
  `projection_mode_unavailable`），**不**静默退到低优先级（静默退化会把用户显式要的模式悄悄换成另一个）。
- 低优先级只影响"没有显式声明的会话"，**不追溯**已有会话（声明已落盘）。
- **现阶段谁能改**：只有 core（内建默认）与官方装配层 / CLI（节点级配置与会话创建参数）。
  插件**无权**：`PluginHost` 上没有这个注册点，hook 只能追加消息（§0），配置文件由用户/运维持有、
  属"官方装配层"路径，不构成第三方扩展面。
- **不用环境变量**：core 是库，同一份代码在不同机器上判定不同会让门禁无法逐例注入
  （沿用 `toolResultVolumeRatio` 的既有理由）。
- `params` **不**公开成配置键（第 5 项裁定）：`keepRecentTokenRatio` / `keepRecentMax` / `volumeRatio`
  只活在 `context_projection.params` 里，配置层不新增这三个键。
- 按**会话种类**的默认值表见 §8.1；本节的优先级规则决定"没有显式声明时填什么"，两者不重复。

### 3. 为什么现在不开放 + 将来开放的前置条件

**3.1 现阶段的口径**

会话是 vessel 最底层的机制：它决定"模型每一轮看到什么"，也决定"事后能不能复现当时看到了什么"。
任何能改这个决定的外部代码，等价于能改审计、改缓存语义、改模型行为归因。所以在机制稳定前，
控制权只放在两处：**core**（机制 + 内建决策）与**官方装配层 / CLI**（节点级配置、会话创建参数）。
这不是能力限制的临时妥协，是**归责要求**：投影出错时必须能指到 core 的一行代码，而不是"某个插件"。

三条支撑证据：

1. **插件面在结构上做不到**：hook 只能追加（§0），`placeholder`/`externalize` 需要改写历史视图；
   给它加重写能力就是把"每轮前缀可变"合法化，代价是缓存与可重放全崩。
2. **开放后门禁会被旁路**：决策决定"清掉哪些 id"= 决定"模型看不见哪些证据"。把这条能力外放，
   需要先有审计不可旁路 + 引用可见性（否则等于开放"证据掩盖"）。
3. **数据契约还没稳**：`context_projection_audit` 是本 ADR 新引入的落盘契约，第一天就把它变成
   第三方 ABI，等于把未验证的结构冻在外部世界上。

**3.2 将来开放的前置条件（全部满足才启动，缺一条不启动）**

| # | 前置条件 | 可验证形式 |
| --- | --- | --- |
| F1 | **决策可重放性验证** | 同一份 `SessionState` 连续两版构建请求前缀 hash 恒等；跨版本 golden 对比连续两个 minor 无回归 |
| F2 | **审计不可旁路** | 全仓唯一写入点（`assertSingleAuditWriter` 式门禁）；缺失/不匹配/被篡改三种构造下 `isProjectionExempt()` 必须 false |
| F3 | **门禁按 mode 判定已稳定** | §6 的模式矩阵与 `check-projection-modes` 连续两个 minor 全绿、无 flaky、无 skip |
| F4 | **对外 API 版本化** | 落盘 schema 带 `schema_version` + 向后兼容窗口（旧会话可读、有迁移脚本）；开放注册点需**先**改 ADR 并在 ADR-099 上走"四类 → 五类"修订 |
| F5 | **引用可见性先落地** | UI/`/context` 能展示"本 run 被投影/归档了哪些 id、原始字节数、是否可回读"；没有它不开放 |
| F6 | **信任模型成文** | 明确写"同进程插件不是安全边界"，并给出权限模型与失败归责口径 |

F1–F6 是**准入条件**，不是路线图。谁想开放，先交出这六项的验证结果。

### 4. 接口契约草案（core 内部 seam，**不是**公开 API）

#### 4.1 内部 seam

```ts
// packages/core/src/context/projection-policy.ts  —— @internal，不从 index.ts 导出
export interface ContextProjectionPolicy {
  readonly id: 'core.context_projection';
  readonly version: number;                 // 进入审计，重放时校验
  plan(input: ContextProjectionInput): ContextProjectionPlan;   // 同步、纯函数
}

export interface ContextProjectionInput {
  readonly session_id: string;
  readonly run_index: number;              // run 序号（会话内从 1 起）——**决策粒度就是它**
  readonly run_kind: 'new' | 'resume';
  readonly segment_index: number;          // 段序号（压缩/缓存重基座语境，仅作解释）
  readonly segment_opened_by?: 'session_switch' | 'compaction' | 'context_trim';
  readonly declared_mode: ContextProjectionMode;   // 只读，决策层不得改
  readonly max_tokens: number;
  readonly used_tokens: number;            // 本次 run 起点请求的估算占用
  /** run 起点可见的工具结果摘要：**不含正文** */
  readonly tool_results: ReadonlyArray<{
    readonly tool_call_id: string;
    readonly tool_name: string;
    readonly bytes: number;
    readonly token_estimate: number;       // 与 estimateTokens 同口径
    readonly is_error: boolean;
    readonly turn: number;                 // 相对 run 起点的轮次
  }>;
  /** 本次 run 起点压缩刚丢弃的 tool 消息（archive_notice 的输入，同样不含正文） */
  readonly dropped_tool_results: ReadonlyArray<{ tool_call_id: string; tool_name: string; bytes: number }>;
  /** 上一 run 的决策结果，用于判断"这次是否变了"（变才写审计/事件） */
  readonly previous?: { readonly plan_hash: string; readonly tool_call_ids: readonly string[] };
  readonly excluded_tools: readonly string[];
  readonly params: ResolvedProjectionParams;      // 已解析、已夹紧
}
```

调用时机：**每个 run 起点一次**（新 run = `execution-unit.ts:1589`，resume = `:2021`）。
run 内所有请求读冻结结果，不再调用（run 内缓存与可重放都依赖这一点）。
`passthrough` 下 core 直接短路，不调用决策层。

#### 4.2 返回值 schema

```ts
export interface ContextProjectionPlan {
  readonly mode: ContextProjectionMode;        // 必须 === declared_mode
  readonly tool_call_ids: readonly string[];   // 要投影的结果，幂等集合
  readonly excluded_tools?: readonly string[]; // 只能追加会话免责令牌的子集
  readonly params?: {
    readonly keepRecentTokenRatio?: number;    // 0 < r <= 0.05
    readonly keepRecentMax?: number;           // 1..10
    readonly volumeRatio?: number;             // 0 < r <= 0.20
  };
  readonly archive?: { readonly kind: 'archive' };   // 只能选种类，文本由 core 渲染
}
```

| 字段 | 本轮状态 | 说明 |
| --- | --- | --- |
| `mode` / `tool_call_ids` / `excluded_tools` | 已实现 | 决策的全部内容 |
| `params.keepRecentTokenRatio` / `keepRecentMax` / `volumeRatio` | 已实现 | 只能收紧（下表） |
| `externalize`（含 `ttl_ms`） | **`not_implemented`** | 本轮**不存在**该字段（类型层面空着）；解冻时按附录 A 增补 |

夹紧（clamp）规则，超出即向**收紧**方向夹，并把夹紧项记进 `audit.params_clamped`（不报错、不降级）：
`keepRecentTokenRatio ≤ 0.05`、`keepRecentMax ≤ 10`、`volumeRatio ≤ 0.20`。

#### 4.3 校验（按顺序，全过才应用）

1. 字段白名单 + 单字符串 ≤ 512 字符（D2）；
2. `mode === declared_mode`，否则 `mode_mismatch`；
3. **`mode === 'externalize'` ⇒ `projection_mode_unavailable`（拒绝，会话创建失败）** —— 本轮固定行为；
4. `tool_call_ids ⊆` 该 run 起点可投影集合（每个 id 必须能在该 run 起点消息里找到对应的 `tool_use`），否则
   `ids_not_subset`；
5. 去重后按该 run 起点的消息顺序重排（core 决定顺序，防"顺序也是一种决策"）；
6. `excluded_tools ⊆ 会话声明豁免`，否则 `excluded_escalation`；
7. `mode === 'archive_notice'` 要求读回路径可用（`sessions.events` 探针），否则
   `readback_unavailable` ⇒ 降级 `placeholder`（§2.3f；**不**报创建失败，因为卡没有副作用）。

#### 4.4 失败行为（**绝不静默部分应用**）

| 情形 | 生效模式 | 事件 | 审计 |
| --- | --- | --- | --- |
| 声明 `externalize`（本轮） | **创建失败** | — | — |
| 决策层抛错 | `passthrough` | `context.projection_degraded{reason:'threw'}` | `audit.degraded = {reason, detail}` |
| 超时（`projection.policy_timeout_ms`，默认 50；同步实现下为保险丝） | `passthrough` | `...{reason:'timeout'}` | 同上 |
| 返回非法值（§4.3 任一 code） | `passthrough` | `...{reason:'<code>'}` | 同上 |
| `archive_notice` 但读回路径不可用 | `placeholder` | `...{reason:'readback_unavailable'}` | `effective_mode: 'placeholder'` |

降级后本次 run **全 run** 为 `passthrough`：不占位、不追加卡、不写 `cleared_tool_call_ids` 增量、不改冻结集合。
部分应用被禁止 —— 它会让"这条占位对应哪次决策"无法回答。

**两层降级不许混为一谈**（**2026-11-15 用户裁定**后必须区分；本表第 4 行原稿为 `passthrough`）：

- **声明期降级**（§7.1 第 4 行 / §2.3f）：`archive_notice` 声明遇上读回不可用 ⇒ 落到**默认值
  `placeholder`**（不放松）。
- **运行时降级**（本表第 2/3 行：决策层抛错/超时/返回非法值）：该 run **fail-open 到 `passthrough`**，
  即"这一 run 不投射"。这是运行时故障的保命路径，且**只影响该 run**、必发 `degraded` 事件 + 审计标
  `effective_mode`；不是"把会话放松到 `passthrough`"，会话声明仍是 `placeholder`。
- 判据：**会话声明只会变严（§8.3.1），单 run 可以 fail-open，但 fail-open 必须留痕可查。**

#### 4.5 core 渲染器（唯一文本作者）

| 渲染器 | 模式 | 本轮 | 文本约束（可断言） |
| --- | --- | --- | --- |
| `formatClearedToolResult` | `placeholder` | 已实现 | 现实现不变：`[cleared …]` + `tool_call_id` + 字节数 + 原因；不含正文；同输入逐字节相同 |
| `renderContextTrimNotice` | `placeholder` | 已实现 | 现实现不变（落盘卡） |
| `renderProjectionArchiveNotice` | `archive_notice` | 新增 | 首行固定 `archive: N tool results dropped from this segment are still readable`；随后逐条 `call_id` + 工具名 + 字节数 + 读回位置；≤ 200 token；纯函数于输入元数据；**不含正文**；**不得**声称"仍在上下文中"（它们已不在） |
| `formatExternalizedToolResult` | `externalize` | **`not_implemented`** | 见附录 A |

#### 4.6 声明结构

```ts
export interface ContextProjectionDeclaration {
  readonly mode: ContextProjectionMode;
  readonly declaration_id: string;              // ulid，幂等键
  readonly source: 'session_created' | 'default' | 'legacy' | 'rotate' | 'inherited';
  readonly policy: 'core.context_projection';
  readonly policy_version: number;
  readonly params: ResolvedProjectionParams;    // 已夹紧的解析值
  readonly declared_at: number;
  readonly excluded_tools: readonly string[];
}
```

声明在**会话创建时**一次性校验（§4.3），失败即创建失败。

### 5. 存储与可重放

#### 5.1 字段

| 位置 | 字段 | 本轮状态 |
| --- | --- | --- |
| `SessionState` | `context_projection?: ContextProjectionDeclaration` | 已实现（D3） |
| `SessionState` | `cleared_tool_call_ids?: string[]` | 已实现（`placeholder`，既有） |
| `SessionState` | `context_projection_audit?: ContextProjectionAudit` | 已实现 —— **每次决策变更的 run 起点一条**（首次 run 与 resume 都算），覆盖写入最新一条 |
| `context_projection_audit` | `externalized` | **`not_implemented`** —— 本轮**不写**该字段；解冻时按附录 A 增补并升 `schema_version` |

```ts
export interface ContextProjectionAudit {
  readonly schema_version: 1;
  readonly declaration_id: string;
  readonly run_index: number;                     // 这条决策属于哪个 run（决策粒度）
  readonly segment_index: number;                 // 该 run 起点落在哪个段（压缩/缓存重基座语境）
  readonly mode: ContextProjectionMode;           // 声明值
  readonly effective_mode: ContextProjectionMode; // 生效值（可能因降级为 passthrough）
  readonly policy: { id: 'core.context_projection'; version: number };
  readonly plan_hash: string;                     // sha256(规范化 ids + mode + params)
  readonly cleared_tool_call_ids: string[];
  readonly archived?: ReadonlyArray<{ tool_call_id: string; tool_name: string; bytes: number }>;
  readonly announced?: { kind: 'trim' | 'archive'; message_id: string; text_hash: string };
  readonly degraded?: { reason: string; detail?: string };
  readonly params_clamped?: string[];
  readonly previous_plan_hash?: string;           // 上一次变更时的 hash（链式可追溯）
}
```

**为什么不是每个 run 都写一条**：一个会话的 run 数远大于"决策真正变化的次数"。每次 run 起点都写会让
审计日志被"什么都没变"的记录淹掉（一个长跑会话几十个 run × N 段），也让"哪一次决策变了"更难查。
写入条件（唯一）：**下列任一发生变化** —— `cleared_tool_call_ids` 集合、`archived` 集合、
`effective_mode`、`plan_hash`、`degraded`。首次 run 与 resume 若集合未变，也**不**写新记录
（`previous_plan_hash` 因此天然表示"上一次变更"）。事件与 state 同条件，二者一一对应。

#### 5.2 事件（全部可重放；tier 表登记为 `notice`/`audit`，不得 `internal`）

| 事件 | 何时 | 本轮状态 |
| --- | --- | --- |
| `context.projection_declared` | 会话创建（含 rotate 开新会话、子 agent 继承） | 已实现（`source: session_created / default / legacy / rotate / inherited`，`previous_mode`、`reason`） |
| `context.projection_applied` | **决策发生变更的那次 run 起点**（条件见 §5.1，不是每个 run） | 已实现（`cleared / kept / archived / announced`） |
| `context.projection_degraded` | §4.4 | 已实现（含 `readback_unavailable`） |
| `context.projection_pressure` | 体积触顶（只告警；每个 run 起点最多一条，去重键 = run） | 已实现 |
| `context.projection_rejected` | **试图改声明**（改 mode/params/豁免工具）；不是"集合每 run 重算" | 已实现 |
| `context.cleared_tool_result` | `placeholder`（既有，不变） | 已实现 |
| `context.externalized_tool_result` | `externalize` 落盘 | **`not_implemented`**（附录 A） |

#### 5.3 重建规则（同一个 run 必须拿到同一决策）

1. 恢复会话时**从不重跑决策**。请求视图 = `project(落盘消息, context_projection_audit)`。
2. `context_projection_audit` 是**唯一真相**（记的是最近一次变更）；`context.projection_applied` 是它的
   可见镜像（两者不一致时以 state 为准，并落 `projection_audit_mismatch` 告警）。
3. 缺 `context_projection_audit` 的旧会话 ⇒ 按 §7.1 兼容路径重建，且**不**声称拿到豁免
   （D4 条件 3 不满足 ⇒ C1h 仍红；这是已裁定口径）。
4. **run 内**连续构建两次请求，前缀必须逐字节相同（探针 P7）；**跨 run** 前缀变化是正常行为。
5. resume（`:2021`）会**重新决策**：若集合变了就写一条新审计 + 一条新事件，此时 run 边界上的前缀变化
   同样是正常行为；若没变则沿用上一条，不得凭空产生新 hash。

#### 5.4 幂等

- `declaration_id`：同一会话写第二条声明 ⇒ 拒绝（D3）。
- `plan_hash`：**run 内**两次请求算出不同 hash ⇒ 红（R4a）；跨 run 不同 ⇒ 正常。
- 累加字段（`cleared_tool_call_ids`）按集合并写入，重复事件不重复追加。
- 审计/事件写入按 §5.1 的变更条件去重：集合与 `effective_mode` 都没变 ⇒ 不写、不发。

### 6. 门禁改造清单

#### 6.1 R4（`check-request-append-only.ts`）

R4 原文：**同段内占位条数不增**。**口径澄清（本轮纠正）**：这里的"同一段"在实现里实际是
"**同一 run 的多次请求**" —— 投射的冻结点是 run 起点（`execution-unit.ts:1589` / resume `:2021`），
而段可以横跨多个 run（压缩只在 run 起点发生，且一次 run 起点不一定会开新段）。因此：

- **判界 = run**：run 内占位条数不增；**跨 run 增加是正常行为**（新产生的旧结果进集合），不算违规。
- 若按"段"判，会在"同一段内、跨 run 的自然增长"上误报。这条纠正直接影响 R4/R4a/R4b/R4d 四条断言的
  取样窗口。

改成分模式判定（`externalize` 列 = `not_implemented`：该列只断言"声明被拒绝、无运行时行为"）：

| 编号 | 断言 | `passthrough` | `placeholder` | `archive_notice` | `externalize` |
| --- | --- | --- | --- | --- | --- |
| R4 | **run 内**占位条数不增（跨 run 不判） | 占位条数**恒 0** | 保持不变 | 占位条数**恒 0** | `not_implemented` |
| R4a | **run 内** `plan_hash` 恒定（跨 run 可不同） | 适用 | 适用 | 适用 | `not_implemented` |
| R4b | **run 内** `effective_mode === mode`（无未记录降级） | 适用 | 适用 | 适用 | `not_implemented` |
| R4c | 占位/卡文本不含正文（对原始 tool 结果做 512 字符子串包含检查） | — | 适用 | 适用（卡里不得出现正文） | `not_implemented` |
| R4d | archive 卡 ≤ 1 条/**run** 且位于其追加位置（R7 追加语义；跨 run 可各有一条） | — | — | 适用 | `not_implemented` |
| R4e | 段原因词表**不新增** `mode_changed` 之类（"每 run 重算集合"不进词表） | 适用 | 适用 | 适用 | `not_implemented` |
| R4f | 声明 `externalize` ⇒ 创建失败 `projection_mode_unavailable`，无 `context_projection_audit` 写入 | — | — | — | **本条即该列全部断言** |
| R4g | 审计/事件写入去重：集合与 `effective_mode` 未变的 run 起点**不产生**新记录（§5.1） | 适用 | 适用 | 适用 | `not_implemented` |

R3（段操作白名单 new/pop）与 R6（banned prefix reasons）**不改**：投射不是段操作，不进词表；
"每 run 起点重算集合"也**不是**段操作（它不改落盘历史，只改请求视图）。

#### 6.2 C1h（`check-append-only-context.ts`，现 20 pass / 1 pending）

| mode | 判定 |
| --- | --- |
| `passthrough` | 请求与落盘**逐字一致**（不消费豁免）；出现差异 ⇒ 红 |
| `archive_notice` | 请求与落盘**逐字一致**（卡已落盘）；差异 ⇒ 红；卡只出现在请求视图里 ⇒ 红 |
| `placeholder` | 消费会话级豁免；D4 四条全真才放行，任一条假 ⇒ 按原判据红 |
| `externalize` | **`not_implemented`**：只断言"声明被拒绝"，不参与 C1h 判定 |

新增 1 项断言（C1h-exempt）：`isProjectionExempt()` 在"声明存在但 `declaration_id` 与审计不匹配"、
"审计字段缺失"（含 legacy 会话）、"模式为 `passthrough` / `archive_notice`"三种构造下**必须**返回 false。

粒度说明：C1h 比较的是"请求视图 vs 落盘"，这一条**与 run/段无关** —— run 内与跨 run 都要求逐字一致
（`passthrough` / `archive_notice`）。run 判界只影响"条数不增"那类断言（R4 系列），不影响 C1h。

#### 6.3 `check-tool-result-clear`（现 43 项 → 50 项；T6 收窄为只判 `placeholder`，属**破坏性变更**）

保留 T1–T6，其中 **T6 的适用范围收窄到 `placeholder` 一个模式**：T6 断言的是"体积阈值触顶 ⇒
`shouldCompact()` 为真 ⇒ 可在 run 起点压缩"，而这个行为**只存在于 `placeholder`** ——
`passthrough` / `archive_notice` 下体积触顶不喂压缩、只发 `context.projection_pressure`，对应断言归
**T7 与 P9**，不在 T6 里混判。
把 T6 从"所有模式都判"收窄成"只判 `placeholder`"属**破坏性变更**（原断言在其余模式下会失败）：
需 minor 版本 + CHANGELOG 条目（§10.1 第 5 项 + §10.2 第 5 项）。新增 7 项：

| 新增 | 断言 |
| --- | --- |
| T7 | `passthrough`：不占位、不追加卡、`cleared_tool_call_ids` 不增、请求与落盘逐字一致 |
| T8 | `archive_notice`：占位 0；恰好 1 条 archive 卡；卡含 id/工具名/字节数/读回位置且**不含正文**；连续两轮请求逐字节相同 |
| T9 | `externalize` 声明 ⇒ 创建失败 `projection_mode_unavailable`；无 `context_projection_audit` 写入；无任何运行时行为（**该模式本轮的全部断言**） |
| T10 | 决策层抛错/超时/非法返回 ⇒ `effective_mode = passthrough` + `context.projection_degraded` + 该 run 无任何占位（不部分应用） |
| T11 | 重放：同一 `SessionState` 在**同一 run 内**构建两次请求前缀逐字节一致，且 `plan()` 调用次数 = 1（不重跑）；另断言"新 run 起点会重新调用一次 `plan()`"（1 → 2） |
| T12 | **会话内改声明**（mode/params/豁免工具，任何时刻，含 run 起点）⇒ `ProjectionModeImmutableError` + `context.projection_rejected`，冻结集合不变；**并反向断言"每 run 起点集合重算不报此错"** |
| T13 | 硬兜底：`used_tokens / max_tokens ≥ 0.85` 在**三个已实现模式**下都触发 compaction，且不切模式 |

（审计去重的断言在 R4g，不重复计数；总数仍为 43 → 50。）

#### 6.4 新探针 `scripts/check-context-projection-modes.ts`（13 项）

P1 声明总是在会话创建时落盘（含 `source:'default'`）；P2 模式闭集（枚举外值 ⇒ 类型 + 运行双红）；
P3 **run 内** `plan_hash` 恒定（跨 run 可不同）；P4 `ids ⊆` 该 run 起点可投影集合（构造越界 ⇒ 降级）；
P5 `mode_mismatch` 降级；
P6 `excluded_escalation` 降级；P7 重放确定性（同一 run 内两次构建前缀 hash 相等；新 run 起点允许不同）；
P8 渲染器纯函数性
（同输入两次渲染逐字节相同；对任意正文的 512 字符子串包含 = false）；P9 体积阈值分模式
（`placeholder` 走 T6；`passthrough` / `archive_notice` 只发 `context.projection_pressure`）；
P10 硬兜底（0.85 不受 mode 影响）；P11 `externalize` 拒绝路径唯一（`projection_mode_unavailable`，
无部分写入）**且** `archive_notice` 在读回探针缺失时降级 `placeholder` + 审计标 `degraded`；
P12 无全局白名单（删掉声明后 C1h 必须回到红；legacy 会话必须红）；
P13 入口一致性：8.3 全表入口传 `externalize` 返回**同一**错误码 `projection_mode_unavailable`；
`agent send` 传任何 mode 返回 `projection_mode_immutable`；子 agent 越权返回 `projection_mode_not_allowed`
（三者不得混用、不得有入口返回 OK）。
接线：`package.json` 加 `check:projection-modes`，与 `check:append-only-context`、`check:tool-result-clear` 同组。

### 7. 迁移与兼容

#### 7.1 默认值矩阵（不是一刀切）

> 按**会话种类**的完整默认表在 §8.1（含 WebUI / 首个会话 / 子 agent / 临时任务）。本节只保留
> "旧会话 vs 新建会话 vs 显式声明"的迁移视角。

| 情形 | 默认 mode | 理由 |
| --- | --- | --- |
| 0.52 之前已有会话（有 `cleared_tool_call_ids`、无声明） | **`placeholder`**（创建时补一条 `source:'legacy'` 声明） | 这些会话上一轮就是"占位视图"，切成 `passthrough` 会让同一批历史在下一轮"原文又回来"——前缀一次性变化、缓存全废，体验是"上下文抽搐"。注意：补的声明有 `declaration_id`，但这些会话**没有** `context_projection_audit`，D4 条件 3 不满足 ⇒ C1h 对它们**仍然红**（已裁定：不开临时放行）。0.53 起默认值也是 `placeholder`，所以旧会话与新会话的视图口径天然一致（差别只在 `source`）。 |
| 0.53 起新建会话 | **`placeholder`**（**2026-11-15 用户裁定**：「先用 placeholder」；原稿为 `passthrough`） | 成本账实测（`docs/dev/handoff/cache-ab-cost-model.md`：645 段净赚 **36:1**、临界缓存折扣 `r* = 2.68%`）说明段内冻结占位是**净赚**的，而不是 §1.2 那个 4.7% 那样"白付"。防爆价值（0.20 触顶 ⇒ 提前压一次）也随默认值一起留下。要"一字不改看原文"就**显式** opt-in `passthrough`（逃生门，§8.1 依据行）。 |
| 显式声明 `externalize` | **拒绝**（`projection_mode_unavailable`） | 本轮不实现，不静默换成别的模式（§4.3 第 3 条）。 |
| 显式声明 `archive_notice` 但读回路径不可用 | **降级 `placeholder`** + `projection_degraded{readback_unavailable}` | 卡不能指向不存在的路径（§2.3f）。**2026-11-15 用户裁定的推论**：降级目标原稿是 `passthrough`，默认值改为 `placeholder` 后降级目标随之改为默认值——降级不得顺手把会话放松到 `passthrough`（§8.3.1 单调收紧）。 |

默认值唯一来源：`config.context.projectionDefaultMode`（**core 内建默认 `'placeholder'`**，2026-11-15 用户裁定）。

#### 7.2 为什么不是一刀切

- **本轮的默认值是一刀切 `placeholder`**（2026-11-15 用户裁定：「先用 placeholder」），代价是名单外的会话
  永久背 C1h 例外、且每个会话都背一次缓存边界。这笔代价是**算过账才认的**：段内冻结后实测净赚 36:1，
  临界缓存折扣 `r* = 2.68%`（§8.1 依据行），即只有缓存折扣超过 2.68% 时才转亏——这是可接受的风险面。
- 一刀切 `placeholder` 的**剩余**代价在长文件阅读类会话：这类会话的工具结果体量大、复用率高，实测
  `r < 6.4%` 时就转亏。它们正是 `passthrough` 作为**手动 opt-in 逃生门**存在的理由（不是默认值，不做
  自动判定——自动判定需要 per-mode A/B 数据，§10.2 第 1 项）。
- 一刀切换成 `passthrough` 的代价（**已否决**）：长跑工程会话失去唯一一道"巨型工具结果防爆"手段（主阈值
  0.85 还在，但巨型单条结果会从 0.20 触顶信号一路涨到 0.85 才被压缩，中间几轮可能撞 provider 硬限），
  且与成本账方向相反。故 `passthrough` 必须配 `context.projection_pressure` 告警，并与既有主阈值共存（D5）。

#### 7.3 灰度

1. 第一批（**U1 + U2**，附录 B）：`projectionDefaultMode = 'placeholder'`（2026-11-15 用户裁定），
   `modes_enabled = ['placeholder', 'passthrough']`——`passthrough` 在名单里但**不是默认**，只能被显式
   声明（opt-in 逃生门）；`archive_notice` 待 `sessions.events` 就绪后进白名单；`externalize` 恒被拒绝。
2. 观察两周：`projection_pressure` 触发率、`projection_degraded` 率、缓存命中上界、巨型结果导致的
   provider 错误率，以及 **`mode=passthrough` 的声明占比**（若占比异常高，说明默认值或逃生门门槛有问题）。
3. 第二批（**U3**）：`sessions.events` 就绪 ⇒ 放开 `archive_notice`（并同步做 §10.2 第 3 项的模型侧读回通道）。

#### 7.4 回退

- 任一模式故障 ⇒ 该 run 降级 `passthrough` + `degraded` 事件（§4.4）；**不删** `context_projection_audit`
  （删了重放就不确定）。注意这一条是**运行时故障**路径，与 §7.1 第 4 行"声明期降级到 `placeholder`"是两层。
- 全局回退 = 把 `projectionDefaultMode` 改回 `'placeholder'`：由于 2026-11-15 裁定后 `placeholder` 已是默认值，
  这条回退的语义变成"**从任何新模式回到默认**"（例如 U3 的 `archive_notice` 出问题时）；已有会话声明不动，
  只影响新会话，**无需数据迁移**。
- 声明合法但行为不对 ⇒ 把 `projection.modes_enabled` 收成 `['placeholder']`：其余模式在创建时被拒绝
  （fail loud），不会静默走另一条路。**代价要说清**：这会把 `passthrough` 逃生门一起关掉，长文件阅读类
  会话将无法 opt-in ⇒ 属最后手段，且必须记进 CHANGELOG。

### 8. 模式声明来源与入口

这一节把"谁能定 mode、在哪定、定不了时怎么办"写死。它与 §2.4 的关系：**模式粒度 = 会话**，所以"定
mode"这件事只发生在**会话创建之前**；任何"创建之后再改"的入口都必须被服务端拒绝（8.2）。

#### 8.1 默认兜底表（会话种类 → 默认 mode）

| # | 会话种类 | 默认 mode | 依据 |
| --- | --- | --- | --- |
| 1 | WebUI 交互主会话（用户在对话框里直接聊的那个） | **`placeholder`** | **2026-11-15 用户裁定**（「先用 placeholder」，含主会话）。原稿给 `passthrough`（理由："用户正盯着这份历史看，存档与请求不一致须显式同意"），该理由仍然成立但**反向使用**：正因为默认值会代劳，才要由用户显式 opt-in `passthrough` 才能看到原文。用户正看着历史时，`placeholder` 的视图差异由 §8.5 权限卡片在创建时披露。 |
| 2 | agent 自己开的首个会话（`agent create` / `vessel run` 未传 mode） | **`placeholder`** | **2026-11-15 用户裁定**（含首个会话）。与全局默认一致。agent 的"自选权"只开在 rotate 上（8.4），不在创建时隐式征用；且 rotate 也只能在单调收紧方向上选（§8.4 / §8.3.1）。 |
| 3 | team 成员会话（子 agent，`agent hire` 建的） | **继承父会话 mode**（`source:'inherited'`），但**允许收紧、禁止放松**：父 `placeholder` ⇒ 子 ∈ {`placeholder`, `archive_notice`}（`passthrough` 被拒，码 `projection_mode_not_allowed`）；父 `passthrough` ⇒ 子 ∈ {`passthrough`, `placeholder`, `archive_notice`} | 子 agent 的上下文是父上下文的一部分；父子模式不一致会让"同一批历史两个视图"，且共享缓存前缀时最吃亏。**继承是默认动作**（`source:'inherited'`），显式收紧要写 `source:'session_created'` 并留 `declaration_id`。规则改写见 §8.3.1（2026-11-15 用户裁定：原稿是"父 `passthrough` ⇒ 子只能 `passthrough`"）。 |
| 4 | 临时任务会话（短寿命一次性任务：`agent create` + 少量 send 后 close） | **`placeholder`** | **2026-11-15 用户裁定**。原稿给 `passthrough`（理由："4.7% 是上界、短寿命会话收益趋近 0"），该理由被成本账推翻：`r* = 2.68%` 的临界点远低于短会话的实际缓存折扣，段内冻结仍净赚（§8.1 依据行）。短会话要"看原文"同样走显式 opt-in。 |
| 5 | 0.52 之前已存在的会话 | **`placeholder`** + `source:'legacy'` | 保持现行为，见 §7.1（且**不**消费 C1h 豁免，因为无审计记录）；与新的默认值口径一致，差别只在 `source`。 |

**§8.1 依据（2026-11-15 用户裁定的量化依据）**：`docs/dev/handoff/cache-ab-cost-model.md` 的 **645 段实测**——
段内冻结占位相对每请求重算是**净赚 36:1**，临界缓存折扣 **`r* = 2.68%`**（缓存折扣超过该值才转亏）；
**长文件阅读类会话**的形状不同，实测 **`r < 6.4%` 才转亏**，即它们的缓存折扣普遍高于临界值，
`placeholder` 在这类会话上是负收益 ⇒ **`passthrough` 作为这类会话的手动 opt-in 逃生门**（报告 §4 有数据）。
即：默认值取 `placeholder` 是**算过账的**，逃生门取 `passthrough` 是**留给形状不对的会话的**，两者不冲突。

优先级与 `source` 的对应（三层优先级见 D7）：

| 来源 | 何时出现 | `source` 值 |
| --- | --- | --- |
| 会话创建参数（显式声明，最高） | 用户在 WebUI 选定 / CLI 传 `--projection` / 工具调用传 mode | `session_created` |
| 节点级配置或全局默认（缺省填） | 没有显式参数 | `default` |
| rotate 自选 | agent 在 rotate 时指定下一个会话的模式（8.4） | `rotate` |
| 父会话继承 | 子 agent 会话（8.1 第 3 行） | `inherited` |
| 旧会话补写 | 0.52 前的会话首次加载 | `legacy` |

条款：`source` 记录的是"这条声明由谁定"，不是"优先级"。`default` 与 `session_created` 在落盘 schema 里
必须可区分（否则事后无法回答"是用户选的还是我们替他选的"）。

第 4 行"临时任务会话"的**判定**必须可执行，不能靠感觉：会话创建入口带 `ephemeral: true` 标志时按第 4 行；
不带该标志一律按第 2 行。当前实现里没有这个标志 ⇒ 0.53 起需要新增（见 §11 入口行），在此之前第 4 行不生效
（即所有 `agent create` 会话都按第 2 行取 **`placeholder`**；2026-11-15 裁定后第 2/4 行取值相同，
所以"标志未落地"这件事不再影响默认值，只影响 metrics 归类）。

#### 8.2 锁点在服务端，不在 UI

- **模式是会话创建参数，不是可变的会话属性。** 落声明发生在会话**首次创建**时（第一条消息进会话之前）。
- 服务端判定（唯一判据）：

  | 请求形态 | 服务端行为 |
  | --- | --- |
  | 会话**不存在** + 带 mode | 作为创建参数接受，走 §4.3 校验 |
  | 会话**已存在**（无论是否发过消息）+ 带 mode，且与声明不同 | **拒绝**：`ProjectionModeImmutableError`；RPC 错误码 `projection_mode_immutable`；事件 `context.projection_rejected{reason:'mode_immutable', requested, actual}` |
  | 会话已存在 + 带 mode 但**与声明相同** | 幂等成功（不是修改），不写新事件 |
  | 会话已存在 + 带相同 `declaration_id` 的重复提交 | 幂等成功（§5.4） |
  | 会话已存在 + 通过 config 重载/其它路径改 | 拒绝，同上（不允许旁路） |

- **不允许静默忽略**：任何"改 mode"的尝试都必须返回可观察的失败（错误码 + 事件）。静默忽略会让
  agent/UI 以为设置生效，之后用错误的心智模型解释自己的上下文。
- **WebUI 那个按钮只负责"提前展示创建参数"**：新建会话（尚未创建）时可改；发出第一条消息后按钮变只读。
  但**只读是服务端的结论**，不是 UI 的礼貌：UI 只是不给人点。
- 会话摘要需要暴露两个字段供 UI 渲染：`projection_mode`（当前值）与 `projection_locked: boolean`
  （`true` = 会话已存在，不可再改）。UI 不得自行推断 locked。

#### 8.3 工具入口矩阵

| 工具 / 入口 | 能传 mode？ | 作用对象 | 有默认兜底？ | 为什么 |
| --- | --- | --- | --- | --- |
| `agent create` | **能** | 新建 agent 的**首个会话** | 是（8.1 第 2 行） | 会话还没创建 ⇒ 这是创建参数 |
| `agent hire` | **能**（受 8.3.1 约束） | 新建 contractor 的**首个会话** | 是（8.1 第 3 行：默认继承父） | 与 create 同构；但它建的是下级成员，能声明的集合受**单调收紧**约束（只能收紧、不能放松） |
| `agent send` | **不能** | — | — | 目标会话已在用（可能正跑到一半）；带 mode ⇒ `projection_mode_immutable`（8.2） |
| `agent rotate` | **能** | **下一个 body 的会话**（不是当前会话） | 是（8.1 第 2 行） | rotate 本身就是"开新会话"的动作，新会话尚未创建 ⇒ 合法；但受 8.4 风险条款约束 |
| `agent post` / `subscribe` / `inbox` / `ask` | **不能** | — | — | 不创建会话，没有声明点 |
| CLI `vessel run --projection <mode>` | **能** | 本次 run 的首个会话 | 是 | 与 `agent create` 同一条创建路径 |
| MCP / 插件 / 任意工具入参 | **不能** | — | — | 不开放扩展点（D6）；出现该字段按未知字段拒绝 |

**8.3.1 子 agent 只能收紧、不能放松（硬条款；2026-11-15 用户裁定改写）**

> 2026-11-15 用户裁定：原条款是"父 `passthrough` ⇒ 子只能 `passthrough`"（允许同层、也隐含允许放松），
> 现改为**单调收紧**方向：**允许收紧、禁止放松**。

- **严格度全序（本 ADR 的唯一权威排序）**：
  `passthrough` **<** `placeholder` **≈** `archive_notice` **<** `externalize`（未实现，恒被拒）。
  越靠右 = 越"狠"地遮蔽原文 = 越保守（token 上越省）。
  - `archive_notice` 与 `placeholder` **同层**的理由：两者都**丢掉正文**，差别只在"丢得可不可寻址"
    （`archive_notice` 给一张归档卡指向 `sessions.events`）⇒ 在"模型看不看得见原文"这个判据上二者等价，
    不构成严格度差异。因此 `placeholder ↔ archive_notice` 之间的互相切换视为**同层**，不算放松、不算收紧。
  - 未列出的 mode（如未来的新枚举）**不得**默认插进这个序里：必须在 ADR 里补一行排序才能被声明。
- **可执行判据（服务端单行）**：设父会话模式为 `m_parent`、子会话请求的模式为 `m_child`，
  `strict(m_child) < strict(m_parent)` ⇒ **拒绝**，`projection_mode_not_allowed`，会话/成员**创建失败**，
  **不静默降级**；否则接受（等于同层或收紧）。
  - 父 `placeholder` ⇒ 子**不得**选 `passthrough`（放松被拒，码 `projection_mode_not_allowed`）；
  - 父 `passthrough` ⇒ 子**可以**选 `placeholder`（**收紧允许**：token 上更保守，且子会话通常短命，
    收紧不会带来跨会话缓存断裂的额外代价）；
  - 父 `passthrough` ⇒ 子选 `archive_notice` 亦合法（更保守一侧）。
  - 父 `archive_notice` ⇒ 子可选 `{archive_notice, placeholder}`（同层或收紧），**不得** `passthrough`。
- 允许集合 = `{m | strict(m) ≥ strict(m_parent)}` ∩ 节点策略 `projection.allowed_modes`。
  `archive_notice` / `externalize` 的**可选性仍受节点 `allowed_modes` 约束**（与严格度是两个正交的闸）：
  节点不许 ⇒ `projection_mode_unavailable`；父不许 ⇒ `projection_mode_not_allowed`。两个码不得混用。
- 拒绝理由（静默降级不可接受）：静默降级会产生"我要求了 X、实际跑了 Y"这种无法归因的状态，而模式直接
  决定"模型看不看得见原文"，归因必须准确。
- **继承与节点策略冲突时的顺序**（避免"父要 placeholder、节点禁 placeholder"这种死结）：节点策略
  `allowed_modes` **优先于**继承。父 mode ∉ `allowed_modes` 时，子会话取 `projectionDefaultMode`
  （缺省兜底），`source` 记 `default`，事件里带 `narrowed_from: 'inherited'`，**不**让成员创建失败
  （hire/create 的首要职责是把成员建出来）。只有"成员自己显式声明了越权 mode"才失败（上一条）。
  **注意**：兜底取默认值时若默认值 `placeholder` 比父 `passthrough` **更严**，这是合法收紧；反之若默认值
  比父更松（例如将来默认改成 `passthrough` 而父是 `placeholder`），兜底必须**取两者较严者**，
  不得因兜底而放松（单调收紧在所有路径上都要成立，包括兜底和降级）。

#### 8.4 rotate 换模式：风险条款

rotate 是 agent 自己用来**逃上下文上限**的动作 —— 允许它选 mode，等于允许它选择"以后可以无限长"。
所以四条不可省：

1. **落声明 + 落事件**：新会话声明 `source: 'rotate'`；事件
   `context.projection_declared{source:'rotate', previous_mode, mode, reason}`。
2. **handoff 必须自证**：rotate 的 `startup_prompt` 里必须写出下一个会话的模式与原因，格式固定一行：
   `next_session_projection: mode=<mode> · keep=<r>/<n>/<vol> · reason=<一句话>`。
   漏写 ⇒ 声明无效（`projection_handoff_missing`），新会话落回 8.1 默认兜底，并落
   `context.projection_rejected{reason:'handoff_missing'}`。
3. **节点策略可整体禁自选**：`projection.allow_agent_selected_mode = false` 时，rotate 的 mode 参数
   **忽略**（按默认兜底），落 `context.projection_rejected{reason:'agent_mode_selection_disabled', requested}`。
   **不**中断 rotate —— rotate 的首要职责是换 body，不能因为模式策略失败把 agent 卡死。
4. **拒绝语义分两类，不要混**：
   - **越权**（子 agent 超出父/节点允许集合）⇒ **拒绝并失败**（8.3.1）；
   - **策略禁自选**（节点不允许 agent 选）⇒ **忽略 + 记账 + 继续 rotate**（本条 ③）。
   两者的区别必须写进错误码与事件 reason，不能都返回"成功"。

另：rotate 选 `externalize` ⇒ `projection_mode_unavailable`（8.6）；选 `archive_notice` 但读回路径不可用
⇒ 降级 `placeholder` + `readback_unavailable`（§2.3f，与 §7.1 第 4 行同一条降级规则；降级目标是默认值
`placeholder`，不得放松到 `passthrough`），handoff 里的 reason 照写（降级事实不得隐去）。

另（**2026-11-15 用户裁定的推论**）：rotate 的 mode 自选同样受 **§8.3.1 单调收紧**约束——新会话的模式
不得比**当前会话**更松（当前会话 `placeholder` ⇒ rotate 不得选 `passthrough`）。理由：rotate 是 agent
自己发起的换体动作，若允许它借 rotate 把会话放松到 `passthrough`，§8.3.1 对 hire/create 的收紧就形同虚设
（agent 只要先 rotate 就能出圈）。用户要让某个会话看原文，走创建期显式 opt-in，不走 rotate。

#### 8.5 权限卡片内容（逐字段，approve 前展示）

权限卡片是用户**审查**的界面，不是日志。逐字段：

| 字段 | 内容 | 为什么必须在这一屏 |
| --- | --- | --- |
| `session_id` / `agent_id` | 目标会话与 agent | 定位 |
| `mode` | 当前模式值（枚举原名，不翻译成"压缩/不压缩"） | 用户审的是"你将要看到什么" |
| `params` | 三个参数快照：`keepRecentTokenRatio / keepRecentMax / volumeRatio` | 只看模式名不够：参数决定"清多少" |
| `declaration_id` | ulid | 与审计/事件对账的唯一凭据 |
| `source` | `session_created` / `default` / `legacy` / `rotate` / `inherited` | 区分"我自己选的" / "系统替我选的" / "agent 自己选的" |
| **C1h 披露** | 当 `mode ∈ {placeholder, externalize}`：`⚠ 本会话的存档/UI 与请求投影将不一致（消费 C1h 豁免）：模型看到的是占位/引用，你看到的是原文` | **这是整张卡最重要的一行**：用户要审的不是模式名，而是"你和模型看到的不是同一份东西" |
| `effective_mode` | 若已发生降级（读回不可用 / 决策层失败） | 防止"以为在 placeholder，其实在 passthrough" |
| `readback`（仅 `archive_notice`） | 可读回 / 不可读回 + 不可读回时的降级结论 | 卡的价值前提（§2.3f） |
| `reason`（仅 `source: rotate`） | agent 自选模式的一句话理由（= handoff 那行） | 审计 agent 的动机，而不只是结果 |

条款：C1h 披露行**不得**折叠/省略；`mode ∈ {passthrough, archive_notice}` 时不显示该行（不消费豁免，
显示反而制造噪音）。**2026-11-15 用户裁定后的后果**：默认值改为 `placeholder` ⇒ 这张卡在**新会话默认路径上
必然出现 C1h 披露行**（原稿默认 `passthrough` 时它只在用户显式选 `placeholder` 时出现）。这不是噪音，
是"默认即消费豁免"的必要披露；若用户想看到不带警示行的卡，只能显式 opt-in `passthrough`（§8.1 依据行）。

#### 8.6 `externalize` 未实现的入口表现

- **传入即拒绝**：任一入口（8.3 全表）传 `externalize` ⇒ `projection_mode_unavailable`，创建失败。
- **UI 不给选项**：模式选择器里不出现该项；若因旧客户端/配置出现 ⇒ 置灰 + 提示
  「本轮未实现（ADR-104 附录 A）」。
- **不接受"选了再降级"**：降级只发生在两处 —— `archive_notice` 读回不可用（§2.3f）与决策层失败（§4.4）。
  `externalize` 不在降级名单里（它没有可降级的实现）。
- 门禁：除 T9 / P11 外，另加一条入口一致性断言（§6.4 P13）：**任一入口**传 `externalize` 必须返回同一
  错误码，不允许某个入口返回 OK。

### 9. 风险与未解



**(a) `archive_notice` 的全部价值押在"读回路径"上。** 卡里写"怎么拿回来"，而读回依赖磁盘事件日志
（`<sessions_dir>/<session_id>/events.ndjson`）+ `sessions.events`（**未实现**）。读回不可用时
`archive_notice` 只能降级 `placeholder`（§2.3f / §7.1 第 4 行；**2026-11-15 用户裁定的推论**：原稿此处写
`passthrough`，默认值改后降级目标随之改为默认值，且降级不得放松严格度），否则就是给模型一张指向不存在
路径的卡 —— 那比 `placeholder` 更糟（它会诱导模型去读一个读不到的东西）。风险的第二层：事件日志可能被裁剪/损坏
（`truncatePartialTail`、重启恢复），所以卡只能承诺"日志里若还在则可回读"，不能承诺"一定可回读"。

**(b) `archive_notice` 自己**不**省 token**。省字 100% 来自压缩丢弃；卡本身每次压缩净增几十 token（上限 200）。
任何"用它来压上下文"的预期都是错的；它的收益是**减少重复调用**，只有 A/B 才能证明（与 §10.2 第 1 项同源）。

**(c) 同进程 = 同信任域，不是安全边界。** 现阶段决策在 core 内，这条风险暂时被"不开放"压住：
没有第三方代码能决定"清掉哪条结果"。但这同时意味着**将来一开放就把"证据掩盖"能力外放** —— 把一次
失败的 tool 结果选进清除集合，是有效的证据掩盖。这就是 F2（审计不可旁路）与 F5（引用可见性）
必须是准入条件的原因。审计（ids + 原始字节数 + `plan_hash` + `policy_version`）必须对用户可见，
否则"为什么模型不知道这件事"无法回答。

**(d) rotate 让 agent 给自己选"能不能无限长"，是激励错位。** rotate 的动机是"逃上下文上限"，所以它天然
倾向选 `passthrough`（永不触发压缩）。三条缓解已写进 §8.4（handoff 必须写出模式与原因、节点可整体禁自选、
落 `context.projection_rejected` 记账），但它们**只能让动机可见，不能让它变善良**。残余风险：用户不读
权限卡片时，agent 可以长期把会话保持在"不压缩"状态，代价是更贵的 token 账单而非错误 —— 所以 C1h 披露
行只覆盖 `placeholder`/`externalize` 是不够的，`passthrough` 下的"本会话不做任何投影"也应在卡片上有一行
中性说明（§10.2 第 7 项）。

**(e) 未解**：`archive_notice` 与 compaction 的交互细节（mode 是会话级不可变 ⇒ 不存在"先 `placeholder`
后切 `archive_notice`"的情形；多 run 各自重算集合是正常行为，已定）；
卡文本的双语与长度预算；`/context` 是否展示"本 run 归档了哪些 id"（F5 的实现前置）。

### 10. 已裁定（本轮记录）与剩余未定事项

**10.1 已裁定（不再讨论，实现按此）**

| # | 事项 | 裁定 |
| --- | --- | --- |
| 1 | 枚举命名 | 采纳 `passthrough` / `placeholder` / `externalize` / `archive_notice`（§2.1、§2.2） |
| 2 | 判别键名 | `context_projection.mode`（不用 `.projection` / `.request_view`） |
| 3 | legacy 会话的 C1h | 继续红，**不开**迁移期临时放行（D4、§7.1） |
| 4 | `params` 是否公开成配置键 | **不公开**（D7） |
| 5 | T6 适用范围 | **收窄到只对 `placeholder` 生效**（体积触顶 ⇒ 压缩的行为只存在于该模式）；属**破坏性变更** ⇒ 需 minor 版本 + CHANGELOG 条目（§6.3） |
| 6 | `externalize` | 本轮不实现，只留枚举位与拒绝路径（§2.2、§4.3、附录 A） |
| 7 | **投射决策粒度** | **run**：每个 run 起点（新 run 与 resume）重算并冻结集合，run 内所有请求共用；"段"只保留给压缩/缓存重基座语境（§2.4）。模式仍是会话级不可变，二者分开 |
| 8 | **入口与默认兜底** | 会话种类默认表（§8.1）；锁点在服务端（§8.2，`projection_mode_immutable`）；工具矩阵（§8.3）；rotate 四条（§8.4）；权限卡片 8 字段含 C1h 披露行（§8.5）；`externalize` 入口一律拒绝（§8.6） |
| 9 | **默认 mode（2026-11-15 用户裁定）** | **`placeholder`**——主会话 / agent 首个会话 / 短任务会话一律 `placeholder`；`passthrough` 降级为**手动 opt-in 逃生门**（长文件阅读类会话用）；旧会话 `placeholder` + `source:'legacy'` 不变。依据：`cache-ab-cost-model.md` 645 段实测净赚 **36:1**、`r* = 2.68%`；长文件阅读类 `r < 6.4%` 才转亏（§8.1 依据行、§7.1、§7.2） |
| 10 | **子 agent 提权规则（2026-11-15 用户裁定）** | 改为**允许收紧、禁止放松**（单调收紧）：严格度序 `passthrough < placeholder ≈ archive_notice`；`strict(子) < strict(父)` ⇒ `projection_mode_not_allowed`；节点 `allowed_modes` 仍是正交的第二道闸（§8.3.1，rotate 同受约束 §8.4） |
| 11 | **模式可跨会话混用（2026-11-15 用户裁定）** | 模式是**会话级**属性，不同会话可各自声明不同模式（父 `placeholder` + 子 `archive_notice` 合法）；同一批量/团队**不要求**统一；同一会话内仍不可变（§2.5、§8.2） |
| 12 | **实现分期（2026-11-15 用户裁定）** | **U1**（声明与锁：字段落盘、`declaration_id`、不可变拒绝、`sessions.get` 暴露 `projection_mode`/`projection_locked`，**不接线**、行为不变）→ **U2**（`passthrough` 接线 + 门禁按 mode 判定，T6 只对 `placeholder` 生效）→ **U3**（`archive_notice`：run 起点追加归档卡 + 靠 `sessions.events` 读回）；**`externalize` 本轮不实现**（只留枚举位 + 拒绝路径）。详见附录 B |

**10.2 剩余未定事项（本轮不就绪，不得写成已决）**

| # | 未定事项 | 当前状态 | 卡在哪 |
| --- | --- | --- | --- |
| 1 | **per-mode 阈值** | 未定，`0.85` 与 `0.20` 沿用现状 | 需要按模式的 A/B 数据；不得先设数字（D5） |
| 2 | **`externalize` 解冻时机** | 冻结 | 需要真实巨型结果场景 + 附录 A 的选型（磁盘 vs 句柄）与 F1–F6 |
| 3 | **模型侧读回通道** | 不存在 | 现在没有任何面向模型的工具能按 `tool_call_id` 读会话事件；没有它，`archive_notice` 的"怎么拿回来"只对人/编排层成立（§2.3f） |
| 4 | **`sessions.events` 发布节奏** | RPC 未实现（refresh-gap-design §7 第 1 项，需批准 + `check-rpc-methods` 登记） | `archive_notice` 是否与它同期发布，还是先只留枚举位 |
| 5 | **T6 破坏性变更落在哪个 minor** | 未定 | `0.53.0` 还是更晚；CHANGELOG 措辞待定 |
| 6 | **卡里 `source_log` 的路径形态** | 未定 | 本地 CLI 可给相对会话目录路径，网关/远端会话是否该暴露宿主路径需按部署形态决定 |
| 7 | **`passthrough` 是否也需要一行卡片说明** | 未定 | §8.5 的 C1h 披露行只覆盖 `placeholder`/`externalize`；`passthrough` 下"本会话不做任何投影"要不要也写一行（关系到 §9(d) 的账单可见性） |

### 11. 影响面（实现轮施工图；本轮不动）

| 层 | 文件 | 动作 |
| --- | --- | --- |
| 类型 | `packages/core/src/types/projection.ts`（新）、`types/session.ts`、`types/hook.ts`（**不动**） | 声明 / 审计 / 内部 seam 类型；`SessionState` 加两个字段 |
| 决策 | `packages/core/src/context/projection-policy.ts`（新，`@internal`，**不从 index.ts 导出**） | 内建决策（= 现 `planClearedToolResults` 泛化）+ 夹紧 + 校验 + `externalize` 拒绝 |
| 机制 | `context/cleared-tool-result.ts`、`context-manager.ts`、`runtime/execution-unit.ts`（**run 起点冻结处** `:1589` / `:2021` + `buildRequestMessages` + `appendNotice`） | 按模式分派；新增 `renderProjectionArchiveNotice`；`withClearedToolResults` → `applyContextProjection`；冻结表键继续用每 run 新建的 `workingContext` |
| 存储 | `session/project-messages.ts` | 重建从审计读，不重跑决策（`externalize` 无存储改动） |
| 配置 | `config.context.projectionDefaultMode`（内建默认 `'placeholder'`，2026-11-15 用户裁定）、`projection.modes_enabled` | 三层来源的落点（D7）；`params` 不新增配置键；插件无权 |
| 门禁 | `check-request-append-only.ts`（R4a–R4g）、`check-append-only-context.ts`（C1h + exempt）、`check-tool-result-clear.ts`（43→50，T6 收窄为只判 `placeholder`）、`check-context-projection-modes.ts`（新 13 项） | §6 |
| 入口 / 服务端锁 | `agent create` / `agent hire` / `agent rotate` 的 mode 参数；`agent send` 的拒绝路径；`ephemeral: true` 标志（§8.1 第 4 行判定）；`sessions.get` / `sessions.list` 暴露 `projection_mode` + `projection_locked` | §8.2、§8.3、§8.6；错误码 `projection_mode_immutable` / `projection_mode_not_allowed` / `projection_mode_unavailable` |
| UI | WebUI 新会话发送框工具栏按钮（仅新建会话可改，只读态由服务端 `projection_locked` 决定）；权限卡片的 8 个字段（含 C1h 披露行） | §8.2、§8.5；UI 不自行推断 locked |
| 依赖 | `sessions.events`（**未实现**，refresh-gap-design §7 第 1 项） | `archive_notice` 的读回前置；未就绪则不放开该模式（白名单外 ⇒ `projection_mode_unavailable`），已声明但读回失败则降级 `placeholder`（§7.1 第 4 行） |
| 文档 | `docs/architecture/context.md`、`docs/architecture/extensions.md`（**加一句"投射不是扩展点"**）、`message-invariants.md`（C1h 豁免条款） | 实现轮同步；本轮不动 |

### 附录 A：`externalize` 的备选实现（**冻结，不在当前范围**）

> 本附录只是把已讨论过的实现形态记下来，防止将来重新发明。**它不可被声明、不可被启用**：
> 声明即 `projection_mode_unavailable`（§4.3、§8.6）。下面任何一条都不构成本轮决策。

- **语义**：把大工具结果的**正文**移出请求，上下文只留句柄引用（`reference`），并追加一张 externalize 卡。
- **备选形态 1（磁盘文件，推荐优先评估）**：`<data_dir>/externalized/<session_id>/<handle>.bin`，
  路径由 core 生成（任何一层都不得指定路径，防穿越）；引用文本
  `[… handle=<trh_…> · <bytes> B · read with vessel.result.read(handle)]`，**不含正文**；
  清理随会话删除 + 每会话上限 `projection.externalized_max_bytes`（默认 512 MiB）；跨重启可读回。
- **备选形态 2（进程内句柄 + TTL）**：简单，但 `PiiVault` 已证明这条路的天花板 —— broker 重启后句柄
  一律 `invalidated_handle`，"引用全死"。
- **解冻需要同时补齐**：`formatExternalizedToolResult` 渲染器、`context_projection_audit.externalized`
  字段 + `schema_version` 升级、`context.externalized_tool_result` 事件、`ProjectionStore.readHandle`
  与失效三分支（`unknown_handle` / `expired_handle` / `invalidated_handle`）、C1h 豁免把
  `externalize` 重新纳入 D4 条件 1、R4 与 C1h 的 `externalize` 列从 `not_implemented` 换成真实断言；
  入口侧放开 §8.3 的限制并去掉 §8.6 的拒绝路径。

### 附录 B：实现分期（**2026-11-15 用户裁定**，U1 → U2 → U3，`externalize` 本轮不做）

> 分期原则：**先让"声明"这件事成立且可见（U1 不改行为），再逐个打开模式**。这样每一步都能独立回退，
> 且 U1 就能把"默认 `placeholder`"与"会话级不可变"两条都落盘验证，而请求行为一个字节都不变。

#### U1：声明与锁（**不接线**，行为不变）

- 落盘：`SessionState` 增 `projection_mode` + `projection_locked`（+ 声明记录含 `declaration_id`、
  `source`、`params` 快照），旧会话读取时按 §7.1 生成 `source:'legacy'` 声明。
- 锁：服务端在任何"创建之后"的入口改 mode ⇒ `projection_mode_immutable`（§8.2）。
- 读取：`sessions.get` 暴露 `projection_mode` / `projection_locked`（`sessions.list` 同）。
- 判定：创建期按 §8.1 表取默认值（**`placeholder`**）与 §8.3.1 的单调收紧做**校验与拒绝**
  （`projection_mode_not_allowed` / `projection_mode_unavailable`）——**只校验、不执行**。
- 明确**不**包含：`passthrough` 的投射分派、T6 的按 mode 分支、归档卡渲染、任何 `modes_enabled` 生效逻辑。
- 验收：行为与 0.52 逐字节相同（T1–T5、T7–T9、R4、C1h 全绿）；新增门禁项只有"声明/锁/读取"三类。

#### U2：`passthrough` 接线 + 门禁按 mode 判定

- 接线：`buildRequestMessages` 在 `passthrough` 下**跳过**投射（`withClearedToolResults` →
  `applyContextProjection` 的短路分支），其余模式行为不变。
- 门禁：`check-request-append-only` / `check-append-only-context` 的 C1h 判定改为**按会话 mode**
  查表（`placeholder`/`externalize` 才要求豁免），**T6 收窄为只对 `placeholder` 生效**（已裁定 =
  破坏性变更，需 minor + CHANGELOG）。
- 灰度：`modes_enabled` 里 `passthrough` 只作为 opt-in 出现在白名单，**不是默认值**（§7.3）。
- 验收：默认路径（`placeholder`）与 0.52 行为一致；显式 `passthrough` 会话 C1h 无条件全绿；
  越权/不可用两类拒绝码可用 `check-context-projection-modes` 覆盖。

#### U3：`archive_notice`

- 前提：`sessions.events` 可读（refresh-gap-design §7 第 1 项，需批准 + `check-rpc-methods` 登记）。
- 实现：run 起点（`execution-unit.ts` 的冻结处）在压缩发生时追加**归档卡**（文本模板见 §2.3f，
  上限 200 token），卡里指向 `sessions.events` 的 `tool_call_id` 查询；读回**只**通过
  `sessions.events`，不做模型侧读回通道（§10.2 第 3 项仍未解）。
- 降级：读回不可用 ⇒ 降级 `placeholder` + `projection_degraded{readback_unavailable}`（§7.1 第 4 行）。
- 验收：卡不含正文；卡的存在与否不改变 `tool_call_id` 集合语义；§6.3 T10–T12 相关断言转为真实断言（若在该轮范围内）。

#### `externalize`：**本轮不实现**

- 只保留：枚举位（`passthrough` / `placeholder` / `externalize` / `archive_notice` 四值固定）+ §4.3 第 3 条
  的拒绝路径 + §8.6 的入口一致性断言。任何"顺手实现"都算越界（附录 A 的形态冻结不动）。
- 解冻条件见 §10.2 第 2 项（真实巨型结果场景 + 磁盘/句柄选型 + F1–F6）。
