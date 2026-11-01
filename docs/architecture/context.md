---
title: 上下文与消息注入
kind: current
triggers: [context, message, injection, compaction, system prompt, self card, vessel:source, notice, token, prefix, history]
paths: [packages/core/src/context/**, packages/core/src/runtime/execution-unit.ts, packages/core/src/session/project-messages.ts, packages/agent/src/runtime.ts, src/runtime-notice-hook.ts, src/agent-owner-injection.ts, plugins/context/doc-subscription/**]
---

# 上下文与消息注入

`WorkingContext` 是**每次 Run 一份**的内存消息窗口（Stage 4）；`ExecutionUnit` 只持 `contextFactory`，不持跨 Run 实例。`Run` 是唯一写者（`RunJournal`），事件日志是恢复的真相源，**compaction 是唯一允许重写历史的地方**。

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
| `config.agent.systemPrompt` / 成员 `system_prompt` | 基底提示词 | `ExecutionUnit.systemPrompt` | 第一条 system | 是 |
| core `formatSelfCard` | role / parent / team / depth / model / tools / limits / context budget / how_to_ask | `composeRunSystemPrompt` | system | 是 |
| 历史恢复 | session cache + 事件日志 | `loadStoredHistory` / `projectMessages` | 用户输入前 | 是 |
| 用户输入 | `run(input)` | `addContext` + `user.message` | 本轮 user | 是 |
| `RunOptions.messages` | `@path` 引用、成员 `vessel:source`、技能/附件 | 调用方传入 | **用户输入前** | 是 |
| owner 队列 | 成员回复 | `agent-owner-injection` BeforeLlm → `ctx.messages` | 本轮 user 后 | 是 |
| `runtime.notice` | 热应用 / 版本通知 | `runtime-notice-hook` → `vessel:notice` | 尾部 | 是 |
| 文档订阅 | `<subscription-notice>` 短通知 | doc-subscription → `vessel:subscription` | 尾部 | 是 |
| 90% 预算预警（`limits.*` / `termination.*`） | `[runtime] input_tokens_limit: 900k/1M ...` | core `publishLimitWarnings` → `vessel:limit` | 尾部 | 是 |
| 90%–`compactThreshold` 上下文压力（默认 0.85 且自动压缩开启时不出现） | `[runtime] context_window: 900k/1M ...` 推荐 rotate | core `publishContextPressureWarning` → `vessel:limit` | 尾部 | 是 |
| 旧 `additionalContext` | 任意 hook | 自动转 `vessel:hook` | 尾部 | 是 |
| 任意 BeforeLlm hook | 自定义消息 | `ctx.messages` | 尾部 | 是（每 run 一次） |
| LLM 输出 / 工具结果 | assistant / tool | `llm.response` / `tool.call.*` | 顺序 | 是 |
| 压缩 | 摘要 | `compactAsync` / `autoCompactAsync` / `compactContext` | system 之后 | 是（事件日志 + session cache） |

**不注入**：Team 日志不会自动进上下文；只有 `teams.post` 里被 `@` 的成员会收到一条普通 user 消息。权限请求 / ask 事件不进上下文，只有工具结果会。

## 一次 run 的顺序

1. `setSessionId(sessionId)`
2. 本 Run 的新 context 生成 system（基底 + Self Card）+ 从 SessionState 快照 / 事件日志播种历史
3. 写入 `RunOptions.messages`（`message.injected`，用户输入之前）
4. 输入 guardrail（可改写用户文本）
5. 写入用户消息（`user.message`）→ `saveSession`
6. loop：limits 90% 预警 → termination / usage 检查 → 上下文 90% 压力预警 → `autoCompactAsync`（> `compactThreshold`，默认 85%）→ BeforeLlm hooks（system 只读；`ctx.messages` 追加）→ `appendInjectedMessages`
   → `buildRequestMessages`（归一化 + 替换基底 system）→ `pluginHost.listTools()`
   → **PrefixGuard** → LLM → assistant / tool 入上下文
7. `finalizeRun` → save session / checkpoint

## 持久化与恢复

- `RunJournal.saveSessionState` 在 run 开始（用户消息写入后）与结束各写一次；journal 是唯一写者。
- `loadStoredHistory`：有 cache 且知道 `derived_upto_seq` → 只读事件日志增量；否则全量 `projectMessages`，按尾部重叠去重。**增量中出现任一 `message.compaction` 时强制全量重投影**——压缩是替换语义，缓存 + 增量无法表达“删掉旧历史”；投影先按 `cleared_tool_call_ids` 写回确定性占位，再按 `kept` 裁剪。两次 Run 的窗口对象不同，但播种出的消息数据等价。
- **可观察面 parity**：同一 session 且日志尾未前进时静默播种（不发 `context.changed`），并沿用上一 Run 的真实 token 数；只有 baseline 也会播种的场景才发重建事件。
- 事件 → 消息：`user.message` / `message.injected` / `llm.response` / `tool.call.completed|failed` / `message.compaction`。
- durable 模式额外有 checkpoint；resume 先校验事件游标。详见 [state](state.md)、[events](events.md)。

## 压缩

| 项 | 值 |
|---|---|
| 预算 | `context.maxTokens` 默认 1,000,000；条数兜底 `maxMessages` 或 `max(100, maxTokens / 100)` |
| 自动压缩 | `autoCompact` 默认 true |
| 阈值 | `config.context.compactThreshold` 默认 0.85（应用层唯一来源；core 兜底同值）；严格 `>` 触发 |
| 保留 | system 全保留；最近非 system 在 30% 预算内，至少 2 条 |
| 工具结果清空 | 保留最近结果至累计 ≤ `maxTokens × 5%`（至少 1、最多 10）；占位 `[cleared <tool>: <命令摘要> -> exit <n>, <n> lines]`，不含完整参数 / 输出 |
| 摘要 | provider summarizer；15s 超时；per-session 连续 3 次失败熔断 10 分钟，`force` 绕过；输出预算 `clamp(removedTokens / 8, 2048, 8192)`，合并旧摘要，模板含“当前用户要求（原话）” |
| 结果 | `role: system` + `compaction_summary: true`；旧摘要移除，system 提前 |
| 事件 | `context.compacted`（auto / overflow / manual）；`message.compaction`（可选 `cleared_tool_call_ids` / `degraded`）；`context.pressure`（90%–threshold，每 run 一次） |

压缩摘要经 `RunJournal` 追加 `message.compaction` 事实事件（Run 内以当前 `runId`，两次 Run 之间的手动 `/compact` 用 `run_id='manual'`），恢复时从 session cache + 事件日志重建。
**90% 与 threshold 分工**：`context.tokenCount / maxTokens` 到 90% 且未超过 `compactThreshold` 时不压缩，发 `context.pressure` + `vessel:limit` 推荐 `agent(rotate)`；超过阈值（默认 85%）由 `autoCompactAsync` 自动压缩，因此默认配置（自动压缩开启）下压力提示不会出现。`limits.inputTokensLimit` 的 90% usage 预警是另一套机制。`rotate` 不自动触发；模型发起的 rotate 必须经人类权限确认。overflow 仍 `forceCompact` 后重试一次。

<a id="prefix"></a>

## 前缀不变量

1. **system 冻结**：hook 写 `ctx.systemPrompt` 被忽略，发 `hook.system_prompt_ignored`。
2. **只能追加**：`PromptPrefixGuard` 对比上一次请求；无 reason 的中间重写发 `prompt.prefix_changed`；`VESSEL_STRICT_PREFIX=1` 时抛 `PromptPrefixChangedError`。
3. **合法 reason**：`compaction` / `resume` / `branch` / `session_switch` / `system_revision` / `tools_changed` / `model_changed` / `context_trim`。
4. 动态元数据全部是尾部 `vessel:*` 消息，不改 system；Web 默认隐藏，Settings → Display 可按类打开。
5. 静态审计：`bun run check:prompt-prefix` 禁止新增 `additionalContext:` 与 `ctx.systemPrompt =`。

## 各层责任

core：system / Self Card、历史、用户、assistant/tool、压缩、PrefixGuard；`packages/agent`：`vessel:source`、成员/owner 队列、Team 派发。
asm (`src/`)：owner 队列注入、runtime notice、配置热应用通知、summarizer、版本通知。
plugins：doc-subscription `vessel:subscription`、hook-logging（只观测）、MCP 工具结果。
TUI / Web：`@path` 引用、用户输入、`vessel:*` 可见性过滤。
相关：[runtime-loop](runtime-loop.md)、[runtime-api](runtime-api.md)、[guardrails-hooks](guardrails-hooks.md)、[member-team](member-team.md)。
