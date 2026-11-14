---
adr: 104
title: 会话级上下文投射模式（passthrough / placeholder / externalize / archive_notice）
status: proposed
date: 2026-11-14
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
- **本轮范围**：只有这份 ADR。不改任何代码、不跑测试、不改 `docs/architecture/message-invariants.md`。
  §6 / §10 的文件清单是给实现轮的施工图，不是本轮改动。

### 0. 先核实的三件事（后面所有条款都建在这上面）

| 事实 | 证据位置（main `7b99b90e`） | 对本 ADR 的后果 |
| --- | --- | --- |
| Hook 面**只能追加**，不能重写历史 | `packages/core/src/types/hook.ts`：`HookResult` 只有 `messages?`（追加）与 `block`；`systemPrompt` 写入被忽略并发 `hook.system_prompt_ignored`；hook 拿不到上下文正文 | **这是"现在不开放"的结构性理由**，不是单纯前提：append-only 的插件面在类型上就写不出 `placeholder` / `externalize`（这两种模式的全部内容就是"改写已存在的历史消息"），而给它加重写能力等于把"每轮前缀可变"合法化。结论：机制必须 core；将来即使开放，也只能开放"返回 ids 的决策"，不能开放"返回消息"。 |
| 现实现的占位是**请求期滤镜**，落盘仍是原文 | `context-manager.ts` 请求构建处注释："至多一处视图层改写……任何没有决策的请求，视图必须与落盘逐字一致"；替换点是 `formatClearedToolResult(...)` | 投射**不是段操作**（既非 `new` 也非 `pop`）。不得借 `context_trim` 解释它 —— `request-sequence.ts` 已写下：`context_trim` 是 pop 原因，"pop 不能解释中段改写"，V1 拿它解释中段改写"当场就红了"。 |
| C1h（存档 = 请求投影 = UI 列表，逐字一致；任何读侧滤镜都违反）**现在是 PENDING** | `docs/architecture/message-invariants.md`；`check-append-only-context.ts` 20 pass / 1 pending | 本 ADR 不宣称 C1h 变绿。它给出一条**受会话声明约束**的放行路径（D4），放行条件是四真同时成立。 |

补充事实（本轮新核实，直接决定 `archive_notice` 的可行性）：

- 压缩丢的是**最旧的一段连续前缀**：`toSummarize = nonSystem.slice(0, keepFrom)`；边界因配对完整性
  回退到 owning assistant，所以丢弃集合永远以 assistant 为界（`context-manager.ts`）。
- 会话事件日志是落盘的追加式 ndjson（`<sessions_dir>/<session_id>/events.ndjson`，0600、每条 fsync，
  `session-event-log.ts`）—— 这是"原文还能读回"的唯一持久来源。
- 读回 RPC `sessions.events` **尚未实现**：它是 `docs/dev/handoff/refresh-gap-design.md` §3 方案 B /
  §7 第 1 项（"新增 RPC，需批准 + `check-rpc-methods` 登记"）。当前 `sessions.*` 方法里没有它。

补充实测（`docs/dev/handoff/measure-tool-result-clear.md`，46 次真实会话）：保留体积占比最大 **4.7%**，
多数会话 0–3%；按段起点冻结后前缀缓存上界从 37.0% 改善到 74.8%。

### 1. 背景与问题

**1.1 现机制（四步，全局默认，不可关）**

1. 请求构建时，`planClearedToolResults` 选一组要清的工具结果 id：保留最近 `≤10` 条、累计
   `≤ maxTokens × KEEP_RECENT_TOKEN_RATIO (0.05)`，其余进清除集合（`ToolResultKeepOptions` 可覆盖，
   但**配置层没有这两个键**）。
2. 段起点冻结该集合，段内不再重选 —— 前缀稳定的唯一来源。
3. 请求视图把被清结果正文换成机械占位（`formatClearedToolResult`），**落盘不动**。
4. 冻结当轮向历史追加一条 trim 卡（`appendNotice(renderContextTrimNotice(...))`），写
   `context.cleared_tool_result` 事件 + 审计字段 `cleared_tool_call_ids`。

体积维度另有一道闸：`TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.20`（保留预算的 4 倍），只可能被
**单条巨型结果**顶到。

**1.2 为什么要改**

- **收益量级错配**：4.7% 是实测上界，多数会话 0–3%。为 0–5% 的收益把"改写历史正文"做成全局强制默认，
  代价是每个会话都背一次 C1h 例外、一次缓存边界、一次"模型看不到原文"。
- **段边界是硬成本**：占位集合一变，前缀缓存从上一次命中点全部作废（37.0% → 74.8% 的差距就是它）。
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
| `context_projection.mode` | `passthrough` / `placeholder` / `externalize` / `archive_notice` | 新会话 `passthrough`；0.52 前旧会话 `placeholder`（§7.1） | 请求视图如何由落盘历史导出 | ❌ `off` / `none` / `disabled` / `false`：会被读成"关闭了会话 / 关闭了上下文"，而这里关掉的只是"投射"；❌ `clear`：与 `cleared_tool_call_ids` 同词根但语义漂移（听起来像"清空上下文"）；❌ `on` / `true` / `compact`：把流程（压缩）当模式名 |
| `context_projection.declaration_id` | ulid | 创建时生成 | 声明幂等键 + 豁免判定凭据 | ❌ `session_id`：复用它无法表达"同段/同会话内声明不可替换"的幂等语义 |
| `context_projection.source` | `session_created` / `default` / `legacy` | 按建会话路径 | 这条声明是显式给的、缺省填的、还是旧会话补的 | ❌ `explicit: boolean`：`legacy` 与 `default` 都是"非显式"，布尔表不出两种来源 |
| `context_projection.policy` | `core.context_projection`（固定） | 固定 | 决策由哪个**内建**实现产出 | ❌ `strategy` / `plugin_id`：现阶段没有插件，叫 strategy 会诱导后来的人当扩展点 |
| `context_projection.params` | 见 §4.2 | `keepRecentTokenRatio 0.05`、`keepRecentMax 10`、`volumeRatio 0.20` | 段起点解析并夹紧后的参数快照 | ❌ 拆成 `keep` / `clear` / `compact` 顶层字段：params 是一组，散落后每加一个都要改落盘 schema |
| `SessionState.context_projection_audit` | 审计对象（§5.1） | 无（旧会话缺省） | 每段一条的冻结决策与执行记录 | ❌ `projection_stats` / `projection_metrics`：它是重放的**唯一真相**，stats 听起来可丢 |
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

| mode | 本轮落地 | substitute（替换正文） | announce（段边界追加一条卡） | 是否省 token | C1h |
| --- | --- | --- | --- | --- | --- |
| `passthrough` | **是** | `none` | `none` | 否（不投射基线） | 逐字一致，**不解禁** |
| `placeholder` | **是**（现实现） | `placeholder` | trim 卡 | 是（实测 ≤4.7%） | 需会话级豁免 |
| `archive_notice` | **是**（代码就绪；默认白名单未启用，§7.3；硬依赖读回路径 §2.3f） | `none` | archive 卡 | **否** —— 省字全部来自压缩丢弃，卡本身净增 | 逐字一致（卡已落盘），**不解禁** |
| `externalize` | **`not_implemented`** | —（本轮为空） | —（本轮为空） | 本轮无 | 本轮无（声明即拒绝，§4.4） |

条款：模式枚举是**闭集** `'passthrough' | 'placeholder' | 'externalize' | 'archive_notice'`，类型定义与
门禁词表各登记一处；`externalize` **只占位、不可声明**；新增模式或解冻 `externalize` 必须先改本 ADR。

#### 2.3 `archive_notice` 的准确作用

一句话：**它不省一个字节，只把"被压缩丢掉的那批工具结果"从"无声消失"变成"一条可回读的归档卡"。**

**(a) 触发点：只在段边界，段内不动。** 段边界的两个来源是：压缩达
`DEFAULT_COMPACT_THRESHOLD = 0.85` 主阈值（真开新段），或体积压力被上层采纳后开新段。注意
`TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.20` 触顶本身**不产生任何动作**（只发
`context.projection_pressure` 告警，D5）；它只是"该会话宜显式声明 `placeholder`"的信号。
段内一律不动：段内既不重算归档集合，也不追加第二张卡（R4d）。

**(b) 动作：不改写任何工具结果正文。** 本段基座由压缩既有的**最旧优先丢弃**构成：
`toSummarize = nonSystem.slice(0, keepFrom)`，即丢弃最旧的一段**连续前缀**（配对完整性会把边界回退到
owning assistant）。归档对象 = **被丢弃前缀里的 `role === 'tool'` 消息**。丢与不丢**完全由既有压缩逻辑
决定**：`archive_notice` 不参与 `keepFrom`、`messageCapFor`、`keepRecent*` 的任何计算，也不会让压缩
多丢或少丢一条。

**(c) 追加：往历史尾部 append 一条持久化、UI 可见的合成消息（归档卡）。** 走既有 `appendNotice` 路径
⇒ 与 trim 卡同一类，进 `sessions.*` 投影与 UI 消息列表。卡携带结构化元数据：

| 字段 | 内容 |
| --- | --- |
| `archived_tool_call_ids` | 被归档结果的 `tool_call_id` 列表（按丢弃顺序） |
| `tool_names` | 逐条工具名 |
| `bytes` | 逐条 + 合计原始字节数 |
| `source_log` | 原文所在：`<sessions_dir>/<session_id>/events.ndjson`（相对会话目录，见 §9.2 第 6 项） |
| `readback` | 读回方式：按 `tool_call_id` 从事件日志的 tool 结果记录回填；RPC 形态 = `sessions.events`（**未实现**，见 §0 与 §7.3） |

**(d) 模型侧效果：从"死占位"变成"知道怎么拿回来"。** 用 `placeholder` 时模型看到的是一条
`[cleared …]`、没有摘要、没有出路的占位，于是重跑同一个工具（§1.2 第三条）；用 `archive_notice` 时
模型看到"这批结果已归档 + 在哪 + 按 id 怎么取"，可以主动重读而不是盲目重跑。这是它唯一的价值。

**(e) 不变量（三条，都可断言）**

1. **不消费 substitute ⇒ 不消费 C1h 豁免**：卡是落盘消息，请求视图不需要任何滤镜，请求与落盘逐字一致。
   D4 第 1 条把 `archive_notice` 明确排除在豁免之外。
2. **append-only**：卡只在段边界追加一次，段内不追加第二张（R4d）；重基座由压缩负责（既有 `new`/`pop`
   语义），投射层不引入任何新的历史改写。
3. **可见性对等**：UI 与模型看到**同一条卡**（同一 `message_id`、同一 `text_hash`）；不存在"UI 有、
   模型无"或反过来的旁路（C1h 的另一半语义）。

**(f) 代价与依赖**

- **自己不省 token**：省字 100% 来自压缩丢弃；卡本身占几十 token/段（上限 200 token）。
- **硬依赖读回路径**：卡写"怎么拿回来"才有意义，而读回依赖磁盘事件日志 + `sessions.events`
  （**当前未实现**）。读回路径不可用时，`archive_notice` 声明在会话创建时**降级为 `passthrough`**，
  并落 `context.projection_degraded{reason:'readback_unavailable'}`（审计 `effective_mode: 'passthrough'`）
  —— 不允许写一张"指向不存在路径"的卡。
- **模型侧还缺一个读回通道**：现在没有任何面向模型的工具能按 `tool_call_id` 读会话事件 ⇒ 当前卡的
  "怎么拿回来"只对人/编排层成立。这一项列入 §9 未定事项，并与 `sessions.events` 同期解决。

#### D1：内化为 core —— 决策层与机制层都在 core，只隔一个**内部 seam**

| 职责 | 归属（均在 core 内） | 落点 |
| --- | --- | --- |
| 选哪些 `tool_call_id` 进投射集合、豁免哪些工具、参数取值 | **决策层**（core 内建） | `packages/core/src/context/projection-policy.ts` |
| 占位 / 归档卡 / trim 卡的**文本渲染** | **机制层** | `formatClearedToolResult` / `renderContextTrimNotice` / `renderProjectionArchiveNotice` |
| 段起点冻结 | 机制层 | 段起点一次性冻结，段内不重选 |
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
R4（段内占位/卡条数不增）、C1h（存档=投影）、缓存冻结三条门禁都以"**渲染是输入的纯函数**"为前提。

条款：内部 seam 的返回类型里**不存在**任何 `content` / `text` / `template` 字段；渲染函数签名只接受
`(toolCallId, toolName, bytes, 元数据)` 这类结构化数据，**不接受消息正文** —— 决策层在类型上就无法把内容
塞进占位/卡里。

#### D3：模式是会话属性，创建时声明、随 session 落盘、段内不可变

- 会话创建时写入声明（**总是写**，包括 `passthrough`），来源记 `source`。
  "总是写"是为了让 D4 的豁免判定不需要"字段缺失即通过"这种隐式缺省。
- 段中点改模式或改参数 ⇒ **拒绝**：抛 `ProjectionModeImmutableError`，落 `context.projection_rejected`。
  语义等价于"这段已冻结"。
- 真要换模式 ⇒ **换会话**。因此 R3 的段原因词表**不新增** `mode_changed` 之类 —— 刻意不开"中途换投影"
  的洗白通道。
- 参数同理：`params` 在**段起点**解析并冻结进审计，段内请求一律读冻结值。

#### D4：C1h 豁免只挂在会话声明上

四真同时成立才放行，缺一条就红：

1. `context_projection.mode ∈ {placeholder}`（本轮只有它消费豁免；`passthrough` / `archive_notice` /
   未实现的 `externalize` 都不消费）；
2. `context_projection.declaration_id` 存在（声明存在性，不是"字段缺省即通过"）；
3. 对应审计存在：`cleared_tool_call_ids`（数组，可为空），且审计里的 `declaration_id` **等于**声明里的
   （防"拿 A 会话的声明解 B 会话的锁"）；
4. 请求视图由 core 从该声明 + 冻结计划纯函数渲染（段内 `plan_hash` 恒定，§6.1 R4a）。

**不许**全局白名单、**不许**按工具名白名单、**不许**环境变量开关。豁免唯一实现落点
`isProjectionExempt(session, audit)`，运行时与门禁**共用**这一个函数。legacy 会话（无审计记录）**继续红**，
不开迁移期临时放行。

#### D5：阈值沿用现状；per-mode 阈值是未定事项

- `DEFAULT_COMPACT_THRESHOLD = 0.85`（**代码现值，不改数**）是唯一会让段真正重基座的阈值，任何 mode 下都保留
  ⇒ 这就是"不会撞上下文溢出"的硬兜底。
- `TOOL_RESULT_VOLUME_THRESHOLD_RATIO = 0.20` 在 `passthrough` / `archive_notice` 下**只**发
  `context.projection_pressure`（带 `retained_tokens / max_tokens / ratio / top_result_bytes`），
  **不**占位、**不**自动压缩、**不**切模式。
- provider 返回 `context_length_exceeded` 时仍走既有 `context_trim`（pop，一次到位），且**不得**顺手把
  mode 改成 `placeholder`（改模式只能靠新会话）。
- **未定事项**：per-mode 阈值（例如 `archive_notice` 是否可以用更低的体积阈值提示开新段）**当前不就绪**，
  需按模式做 A/B 数据；本 ADR 不预设任何 per-mode 数值（§9.2 第 1 项）。

#### D6：不扩 Hook 面、不新增插件注册点

- `HookResult` 保持 append-only。**不**给 hook 加重写/删除历史消息的能力，也不开放 `cache_control` 之类的注入。
- `PluginHost` 保持四类能力面（tool / provider / guardrail / hook），**不新增**
  `registerContextProjectionPolicy` 之类的方法。直接后果：**ADR-099 本轮不需要修订** —— 这是"现在不开放"
  最直接的收益，少一次把内部机制暴露成对外契约的机会。

#### D7：配置来源三层，冲突规则写死

优先级（高 → 低）：

1. **会话创建参数**（`context_projection` 显式声明）；
2. **节点级配置** `config.context.projectionDefaultMode`（一个 harness 实例 = 一个节点；由官方装配层 / CLI 传入）；
3. **core 内建默认**（新会话 `passthrough`；旧会话走 §7.1 的兼容路径）。

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
| F5 | **引用可见性先落地** | UI/`/context` 能展示"本段被投影/归档了哪些 id、原始字节数、是否可回读"；没有它不开放 |
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
  readonly segment_index: number;           // 段序号，从 1 起
  readonly segment_kind: 'new' | 'pop';
  readonly declared_mode: ContextProjectionMode;   // 只读，决策层不得改
  readonly max_tokens: number;
  readonly used_tokens: number;             // 段起点请求的估算占用
  /** 段起点可见的工具结果摘要：**不含正文** */
  readonly tool_results: ReadonlyArray<{
    readonly tool_call_id: string;
    readonly tool_name: string;
    readonly bytes: number;
    readonly token_estimate: number;        // 与 estimateTokens 同口径
    readonly is_error: boolean;
    readonly turn: number;                  // 相对段起点的轮次
  }>;
  /** 段边界上被压缩丢弃的 tool 消息（archive_notice 的输入，同样不含正文） */
  readonly dropped_tool_results: ReadonlyArray<{ tool_call_id: string; tool_name: string; bytes: number }>;
  readonly excluded_tools: readonly string[];
  readonly params: ResolvedProjectionParams;      // 已解析、已夹紧
}
```

调用时机：**段起点一次**。段内每轮读冻结结果，不再调用（缓存与可重放都依赖这一点）。
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
4. `tool_call_ids ⊆` 段起点可投影集合（每个 id 必须能在段起点消息里找到对应的 `tool_use`），否则
   `ids_not_subset`；
5. 去重后按段起点顺序重排（core 决定顺序，防"顺序也是一种决策"）；
6. `excluded_tools ⊆ 会话声明豁免`，否则 `excluded_escalation`；
7. `mode === 'archive_notice'` 要求读回路径可用（`sessions.events` 探针），否则
   `readback_unavailable` ⇒ 降级 `passthrough`（§2.3f；**不**报创建失败，因为卡没有副作用）。

#### 4.4 失败行为（**绝不静默部分应用**）

| 情形 | 生效模式 | 事件 | 审计 |
| --- | --- | --- | --- |
| 声明 `externalize`（本轮） | **创建失败** | — | — |
| 决策层抛错 | `passthrough` | `context.projection_degraded{reason:'threw'}` | `audit.degraded = {reason, detail}` |
| 超时（`projection.policy_timeout_ms`，默认 50；同步实现下为保险丝） | `passthrough` | `...{reason:'timeout'}` | 同上 |
| 返回非法值（§4.3 任一 code） | `passthrough` | `...{reason:'<code>'}` | 同上 |
| `archive_notice` 但读回路径不可用 | `passthrough` | `...{reason:'readback_unavailable'}` | `effective_mode: 'passthrough'` |

降级后本段**整段**为 `passthrough`：不占位、不追加卡、不写 `cleared_tool_call_ids` 增量、不改冻结集合。
部分应用被禁止 —— 它会让"这条占位对应哪次决策"无法回答。

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
  readonly source: 'session_created' | 'default' | 'legacy';
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
| `SessionState` | `context_projection_audit?: ContextProjectionAudit` | 已实现（每段一条，段起点覆盖写入） |
| `context_projection_audit` | `externalized` | **`not_implemented`** —— 本轮**不写**该字段；解冻时按附录 A 增补并升 `schema_version` |

```ts
export interface ContextProjectionAudit {
  readonly schema_version: 1;
  readonly declaration_id: string;
  readonly segment_index: number;
  readonly mode: ContextProjectionMode;           // 声明值
  readonly effective_mode: ContextProjectionMode; // 生效值（可能因降级为 passthrough）
  readonly policy: { id: 'core.context_projection'; version: number };
  readonly plan_hash: string;                     // sha256(规范化 ids + mode + params)
  readonly cleared_tool_call_ids: string[];
  readonly archived?: ReadonlyArray<{ tool_call_id: string; tool_name: string; bytes: number }>;
  readonly announced?: { kind: 'trim' | 'archive'; message_id: string; text_hash: string };
  readonly degraded?: { reason: string; detail?: string };
  readonly params_clamped?: string[];
}
```

#### 5.2 事件（全部可重放；tier 表登记为 `notice`/`audit`，不得 `internal`）

| 事件 | 何时 | 本轮状态 |
| --- | --- | --- |
| `context.projection_declared` | 会话创建 | 已实现 |
| `context.projection_applied` | 段起点 | 已实现（`cleared / kept / archived / announced`） |
| `context.projection_degraded` | §4.4 | 已实现（含 `readback_unavailable`） |
| `context.projection_pressure` | 体积触顶（只告警） | 已实现 |
| `context.projection_rejected` | 段中点改 mode/params | 已实现 |
| `context.cleared_tool_result` | `placeholder`（既有，不变） | 已实现 |
| `context.externalized_tool_result` | `externalize` 落盘 | **`not_implemented`**（附录 A） |

#### 5.3 重建规则（同一段必须拿到同一决策）

1. 恢复会话时**从不重跑决策**。请求视图 = `project(落盘消息, context_projection_audit)`。
2. `context_projection_audit` 是**唯一真相**；`context.projection_applied` 只是可见镜像（两者不一致时以
   state 为准，并落 `projection_audit_mismatch` 告警）。
3. 缺 `context_projection_audit` 的旧会话 ⇒ 按 §7.1 兼容路径重建，且**不**声称拿到豁免
   （D4 条件 3 不满足 ⇒ C1h 仍红；这是已裁定口径）。
4. 同一份 state 连续构建两次请求，前缀必须逐字节相同（探针 P7）。

#### 5.4 幂等

- `declaration_id`：同一会话写第二条声明 ⇒ 拒绝（D3）。
- `plan_hash`：段内两轮算出不同 hash ⇒ 红（R4a）。
- 累加字段（`cleared_tool_call_ids`）按集合并写入，重复事件不重复追加。

### 6. 门禁改造清单

#### 6.1 R4（`check-request-append-only.ts`）

R4 原文：**同段内占位条数不增**。改成分模式判定（`externalize` 列 = `not_implemented`：该列只断言
"声明被拒绝、无运行时行为"）：

| 编号 | 断言 | `passthrough` | `placeholder` | `archive_notice` | `externalize` |
| --- | --- | --- | --- | --- | --- |
| R4 | 段内占位条数不增 | 占位条数**恒 0** | 保持不变 | 占位条数**恒 0** | `not_implemented` |
| R4a | 段内 `plan_hash` 恒定 | 适用 | 适用 | 适用 | `not_implemented` |
| R4b | 段内 `effective_mode === mode`（无未记录降级） | 适用 | 适用 | 适用 | `not_implemented` |
| R4c | 占位/卡文本不含正文（对原始 tool 结果做 512 字符子串包含检查） | — | 适用 | 适用（卡里不得出现正文） | `not_implemented` |
| R4d | archive 卡 ≤ 1 条/段且位于段末（R7 追加语义） | — | — | 适用 | `not_implemented` |
| R4e | 段原因词表**不新增** `mode_changed` 之类 | 适用 | 适用 | 适用 | `not_implemented` |
| R4f | 声明 `externalize` ⇒ 创建失败 `projection_mode_unavailable`，无 `context_projection_audit` 写入 | — | — | — | **本条即该列全部断言** |

R3（段操作白名单 new/pop）与 R6（banned prefix reasons）**不改**：投射不是段操作，不进词表。

#### 6.2 C1h（`check-append-only-context.ts`，现 20 pass / 1 pending）

| mode | 判定 |
| --- | --- |
| `passthrough` | 请求与落盘**逐字一致**（不消费豁免）；出现差异 ⇒ 红 |
| `archive_notice` | 请求与落盘**逐字一致**（卡已落盘）；差异 ⇒ 红；卡只出现在请求视图里 ⇒ 红 |
| `placeholder` | 消费会话级豁免；D4 四条全真才放行，任一条假 ⇒ 按原判据红 |
| `externalize` | **`not_implemented`**：只断言"声明被拒绝"，不参与 C1h 判定 |

新增 1 项断言（C1h-exempt）：`isProjectionExempt()` 在"声明存在但 `declaration_id` 与审计不匹配"、
"审计字段缺失"（含 legacy 会话）、"模式为 `passthrough` / `archive_notice`"三种构造下**必须**返回 false。

#### 6.3 `check-tool-result-clear`（现 43 项 → 50 项；T6 变更算**破坏性变更**）

保留 T1–T6，其中 **T6 语义改为按 mode 三态**：`passthrough` / `archive_notice` ⇒ 触顶只发
`context.projection_pressure` 且不压缩；`placeholder` ⇒ 保持现行为（可触发 `shouldCompact`）。
T6 由"阈值 ⇒ 该压缩"改成"阈值 ⇒ 按 mode 分派"属**破坏性变更**：需 minor 版本 + CHANGELOG 条目
（§9.1 第 5 项 + §9.2 第 5 项）。新增 7 项：

| 新增 | 断言 |
| --- | --- |
| T7 | `passthrough`：不占位、不追加卡、`cleared_tool_call_ids` 不增、请求与落盘逐字一致 |
| T8 | `archive_notice`：占位 0；恰好 1 条 archive 卡；卡含 id/工具名/字节数/读回位置且**不含正文**；连续两轮请求逐字节相同 |
| T9 | `externalize` 声明 ⇒ 创建失败 `projection_mode_unavailable`；无 `context_projection_audit` 写入；无任何运行时行为（**该模式本轮的全部断言**） |
| T10 | 决策层抛错/超时/非法返回 ⇒ `effective_mode = passthrough` + `context.projection_degraded` + 该段无任何占位（不部分应用） |
| T11 | 重放：同一 `SessionState` 构建两次请求前缀逐字节一致，且 `plan()` 调用次数 = 1（不重跑） |
| T12 | 段中点改 mode/params ⇒ `ProjectionModeImmutableError` + `context.projection_rejected`，冻结集合不变 |
| T13 | 硬兜底：`used_tokens / max_tokens ≥ 0.85` 在**三个已实现模式**下都触发 compaction，且不切模式 |

#### 6.4 新探针 `scripts/check-context-projection-modes.ts`（12 项）

P1 声明总是在会话创建时落盘（含 `source:'default'`）；P2 模式闭集（枚举外值 ⇒ 类型 + 运行双红）；
P3 段内 `plan_hash` 恒定；P4 `ids ⊆ 段起点集合`（构造越界 ⇒ 降级）；P5 `mode_mismatch` 降级；
P6 `excluded_escalation` 降级；P7 重放确定性（两次构建前缀 hash 相等）；P8 渲染器纯函数性
（同输入两次渲染逐字节相同；对任意正文的 512 字符子串包含 = false）；P9 体积阈值三态；
P10 硬兜底（0.85 不受 mode 影响）；P11 `externalize` 拒绝路径唯一（`projection_mode_unavailable`，
无部分写入）**且** `archive_notice` 在读回探针缺失时降级 `passthrough` + 审计标 `degraded`；
P12 无全局白名单（删掉声明后 C1h 必须回到红；legacy 会话必须红）。
接线：`package.json` 加 `check:projection-modes`，与 `check:append-only-context`、`check:tool-result-clear` 同组。

### 7. 迁移与兼容

#### 7.1 默认值矩阵（不是一刀切）

| 情形 | 默认 mode | 理由 |
| --- | --- | --- |
| 0.52 之前已有会话（有 `cleared_tool_call_ids`、无声明） | **`placeholder`**（创建时补一条 `source:'legacy'` 声明） | 这些会话上一轮就是"占位视图"，默认 `passthrough` 会让同一段历史在下一轮"原文又回来"——前缀一次性变化、缓存全废，体验是"上下文抽搐"。注意：补的声明有 `declaration_id`，但这些会话**没有** `context_projection_audit`，D4 条件 3 不满足 ⇒ C1h 对它们**仍然红**（已裁定：不开临时放行）。 |
| 0.53 起新建会话 | **`passthrough`** | 4.7% 上界收益不值得给每个会话背一次历史改写；`passthrough` 是唯一让 C1h 无条件全绿的模式。要压就显式声明 `placeholder` / `archive_notice`。 |
| 显式声明 `externalize` | **拒绝**（`projection_mode_unavailable`） | 本轮不实现，不静默换成别的模式（§4.3 第 3 条）。 |
| 显式声明 `archive_notice` 但读回路径不可用 | **降级 `passthrough`** + `projection_degraded{readback_unavailable}` | 卡不能指向不存在的路径（§2.3f）。 |

默认值唯一来源：`config.context.projectionDefaultMode`（core 内建默认 `'passthrough'`）。

#### 7.2 为什么不是一刀切

- 一刀切 `passthrough` 的代价：长跑工程会话失去唯一一道"巨型工具结果防爆"手段（主阈值 0.85 还在，
  但巨型单条结果会从 0.20 触顶信号一路涨到 0.85 才被压缩，中间几轮可能撞 provider 硬限）。故
  `passthrough` 必须配 `context.projection_pressure` 告警，并与既有主阈值共存（D5）。
- 一刀切保留 `placeholder` 的代价：所有会话永久背 C1h 例外；收益 0–3% 的会话白付缓存断裂。

#### 7.3 灰度

1. 第一批：`projectionDefaultMode = 'passthrough'`，`modes_enabled = ['placeholder']`；
   `archive_notice` 待 `sessions.events` 就绪后进白名单；`externalize` 恒被拒绝。
2. 观察两周：`projection_pressure` 触发率、`projection_degraded` 率、缓存命中上界、巨型结果导致的
   provider 错误率。
3. 第二批：`sessions.events` 就绪 ⇒ 放开 `archive_notice`（并同步做 §9.2 第 3 项的模型侧读回通道）。

#### 7.4 回退

- 任一模式故障 ⇒ 该段降级 `passthrough` + `degraded` 事件（§4.4）；**不删** `context_projection_audit`
  （删了重放就不确定）。
- 全局回退 = 把 `projectionDefaultMode` 改回 `placeholder`：已有会话声明不动，只影响新会话，**无需数据迁移**。
- 声明合法但行为不对 ⇒ 把 `projection.modes_enabled` 收成 `['placeholder']`：其余模式在创建时被拒绝
  （fail loud），不会静默走另一条路。

### 8. 风险与未解

**(a) `archive_notice` 的全部价值押在"读回路径"上。** 卡里写"怎么拿回来"，而读回依赖磁盘事件日志
（`<sessions_dir>/<session_id>/events.ndjson`）+ `sessions.events`（**未实现**）。读回不可用时
`archive_notice` 只能降级 `passthrough`（§2.3f），否则就是给模型一张指向不存在路径的卡 —— 那比
`placeholder` 更糟（它会诱导模型去读一个读不到的东西）。风险的第二层：事件日志可能被裁剪/损坏
（`truncatePartialTail`、重启恢复），所以卡只能承诺"日志里若还在则可回读"，不能承诺"一定可回读"。

**(b) `archive_notice` 自己**不**省 token**。省字 100% 来自压缩丢弃；卡本身每段净增几十 token（上限 200）。
任何"用它来压上下文"的预期都是错的；它的收益是**减少重复调用**，只有 A/B 才能证明（与 §9.2 第 1 项同源）。

**(c) 同进程 = 同信任域，不是安全边界。** 现阶段决策在 core 内，这条风险暂时被"不开放"压住：
没有第三方代码能决定"清掉哪条结果"。但这同时意味着**将来一开放就把"证据掩盖"能力外放** —— 把一次
失败的 tool 结果选进清除集合，是有效的证据掩盖。这就是 F2（审计不可旁路）与 F5（引用可见性）
必须是准入条件的原因。审计（ids + 原始字节数 + `plan_hash` + `policy_version`）必须对用户可见，
否则"为什么模型不知道这件事"无法回答。

**(d) 未解**：`archive_notice` 与 compaction 的交互细节（一个段里先 `placeholder` 后切 `archive_notice`
不允许 ⇒ 只能靠新会话，这条已定；但"同一会话多段各自不同 mode"不会发生，因为 mode 会话级）；
卡文本的双语与长度预算；`/context` 是否展示"本段归档了哪些 id"（F5 的实现前置）。

### 9. 已裁定（本轮记录）与剩余未定事项

**9.1 已裁定（不再讨论，实现按此）**

| # | 事项 | 裁定 |
| --- | --- | --- |
| 1 | 枚举命名 | 采纳 `passthrough` / `placeholder` / `externalize` / `archive_notice`（§2.1、§2.2） |
| 2 | 判别键名 | `context_projection.mode`（不用 `.projection` / `.request_view`） |
| 3 | legacy 会话的 C1h | 继续红，**不开**迁移期临时放行（D4、§7.1） |
| 4 | `params` 是否公开成配置键 | **不公开**（D7） |
| 5 | T6 语义变更性质 | **破坏性变更** ⇒ 需 minor 版本 + CHANGELOG 条目（§6.3） |
| 6 | `externalize` | 本轮不实现，只留枚举位与拒绝路径（§2.2、§4.3、附录 A） |

**9.2 剩余未定事项（本轮不就绪，不得写成已决）**

| # | 未定事项 | 当前状态 | 卡在哪 |
| --- | --- | --- | --- |
| 1 | **per-mode 阈值** | 未定，`0.85` 与 `0.20` 沿用现状 | 需要按模式的 A/B 数据；不得先设数字（D5） |
| 2 | **`externalize` 解冻时机** | 冻结 | 需要真实巨型结果场景 + 附录 A 的选型（磁盘 vs 句柄）与 F1–F6 |
| 3 | **模型侧读回通道** | 不存在 | 现在没有任何面向模型的工具能按 `tool_call_id` 读会话事件；没有它，`archive_notice` 的"怎么拿回来"只对人/编排层成立（§2.3f） |
| 4 | **`sessions.events` 发布节奏** | RPC 未实现（refresh-gap-design §7 第 1 项，需批准 + `check-rpc-methods` 登记） | `archive_notice` 是否与它同期发布，还是先只留枚举位 |
| 5 | **T6 破坏性变更落在哪个 minor** | 未定 | `0.53.0` 还是更晚；CHANGELOG 措辞待定 |
| 6 | **卡里 `source_log` 的路径形态** | 未定 | 本地 CLI 可给相对会话目录路径，网关/远端会话是否该暴露宿主路径需按部署形态决定 |

### 附录 A：`externalize` 的备选实现（**冻结，不在当前范围**）

> 本附录只是把已讨论过的实现形态记下来，防止将来重新发明。**它不可被声明、不可被启用**：
> 声明即 `projection_mode_unavailable`（§4.3）。下面任何一条都不构成本轮决策。

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
  `externalize` 重新纳入 D4 条件 1、R4 与 C1h 的 `externalize` 列从 `not_implemented` 换成真实断言。

### 10. 影响面（实现轮施工图；本轮不动）

| 层 | 文件 | 动作 |
| --- | --- | --- |
| 类型 | `packages/core/src/types/projection.ts`（新）、`types/session.ts`、`types/hook.ts`（**不动**） | 声明 / 审计 / 内部 seam 类型；`SessionState` 加两个字段 |
| 决策 | `packages/core/src/context/projection-policy.ts`（新，`@internal`，**不从 index.ts 导出**） | 内建决策（= 现 `planClearedToolResults` 泛化）+ 夹紧 + 校验 + `externalize` 拒绝 |
| 机制 | `context/cleared-tool-result.ts`、`context-manager.ts`、`runtime/execution-unit.ts`（段起点冻结处 + `buildRequestMessages` + `appendNotice`） | 按模式分派；新增 `renderProjectionArchiveNotice`；`withClearedToolResults` → `applyContextProjection` |
| 存储 | `session/project-messages.ts` | 重建从审计读，不重跑决策（`externalize` 无存储改动） |
| 配置 | `config.context.projectionDefaultMode`、`projection.modes_enabled` | 三层来源的落点（D7）；`params` 不新增配置键；插件无权 |
| 门禁 | `check-request-append-only.ts`（R4a–R4f）、`check-append-only-context.ts`（C1h + exempt）、`check-tool-result-clear.ts`（43→50，T6 破坏性）、`check-context-projection-modes.ts`（新 12 项） | §6 |
| 依赖 | `sessions.events`（**未实现**，refresh-gap-design §7 第 1 项） | `archive_notice` 的读回前置；未就绪则降级 `passthrough` |
| 文档 | `docs/architecture/context.md`、`docs/architecture/extensions.md`（**加一句"投射不是扩展点"**）、`message-invariants.md`（C1h 豁免条款） | 实现轮同步；本轮不动 |
