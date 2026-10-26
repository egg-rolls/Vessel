---
title: 上下文与消息注入
kind: current
triggers: [context, message, injection, compaction, system prompt, self card, vessel:source, notice, token, prefix, history]
paths: [packages/core/src/context/**, packages/core/src/runtime/agent-runtime.ts, packages/core/src/session/project-messages.ts, packages/agent/src/runtime.ts, src/runtime-notice-hook.ts, src/agent-owner-injection.ts, plugins/context/doc-subscription/**]
---

# 上下文与消息注入

`ContextManager` 是**每个 session 一份**的内存消息表；`AgentRuntime` 是唯一写者。
事件日志是恢复的真相源；**compaction 是唯一允许重写历史的地方**。

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
| `config.agent.systemPrompt` / 成员 `system_prompt` | 基底提示词 | `AgentRuntime.systemPrompt` | 第一条 system | 是 |
| core `formatSelfCard` | role / parent / team / depth / model / tools / limits / context budget / how_to_ask | `composeRunSystemPrompt` | system | 是 |
| 历史恢复 | session cache + 事件日志 | `loadStoredHistory` / `projectMessages` | 用户输入前 | 是 |
| 用户输入 | `run(input)` | `addContext` + `user.message` | 本轮 user | 是 |
| `RunOptions.messages` | `@path` 引用、成员 `vessel:source`、技能/附件 | 调用方传入 | **用户输入前** | 是 |
| owner 队列 | 成员回复 | `agent-owner-injection` BeforeLlm → `ctx.messages` | 本轮 user 后 | 是 |
| `runtime.notice` | 热应用 / 版本通知 | `runtime-notice-hook` → `vessel:notice` | 尾部 | 是 |
| 文档订阅 | `<subscription-notice>` 短通知 | doc-subscription → `vessel:subscription` | 尾部 | 是 |
| 80% 预算预警（`limits.*` / `termination.*`） | `[runtime] input_tokens_limit: 820k/1M ...` | core `publishLimitWarnings` → `vessel:limit` | 尾部 | 是 |
| 旧 `additionalContext` | 任意 hook | 自动转 `vessel:hook` | 尾部 | 是 |
| 任意 BeforeLlm hook | 自定义消息 | `ctx.messages` | 尾部 | 是（每 run 一次） |
| LLM 输出 / 工具结果 | assistant / tool | `llm.response` / `tool.call.*` | 顺序 | 是 |
| 压缩 | 摘要 | `compactAsync` / `autoCompactAsync` | system 之后 | 是（session cache） |

**不注入**：Team 日志不会自动进上下文；只有 `teams.post` 里被 `@` 的成员会收到一条普通 user 消息。
权限请求 / ask 事件不进上下文，只有工具结果会。

## 一次 run 的顺序

1. `setSessionId(sessionId)`
2. context 为空 → 生成 system（基底 + Self Card）+ 恢复历史；非空 → 重算静态 system
3. 写入 `RunOptions.messages`（`message.injected`，用户输入之前）
4. 输入 guardrail（可改写用户文本）
5. 写入用户消息（`user.message`）→ `saveSession`
6. loop：80% 预警 → termination / usage 检查 → `autoCompactAsync`
   → BeforeLlm hooks（system 只读；`ctx.messages` 追加）→ `appendInjectedMessages`
   → `buildRequestMessages`（归一化 + 替换基底 system）→ `pluginHost.listTools()`
   → **PrefixGuard** → LLM → assistant / tool 入上下文
7. `finalizeRun` → save session / checkpoint

## 持久化与恢复

- `saveSession` 在 run 开始（用户消息写入后）与结束各写一次。
- `loadStoredHistory`：有 cache 且知道 `derived_upto_seq` → 只读事件日志增量；否则全量 `projectMessages`，按尾部重叠去重。
- 事件 → 消息：`user.message` / `message.injected` / `llm.response` / `tool.call.completed|failed` / `message.compaction`。
- durable 模式额外有 checkpoint；resume 先校验事件游标。详见 [state](state.md)、[events](events.md)。

## 压缩

| 项 | 值 |
|---|---|
| token 预算 | `context.maxTokens` 默认 1,000,000 |
| 自动压缩 | `autoCompact` 默认 true |
| 阈值 | `compactThreshold` 默认 0.8 |
| 条数兜底 | `maxMessages` 或 `max(100, maxTokens / 100)` |
| 保留 | system 全保留；最近非 system 在 30% 预算内，至少 2 条 |
| 摘要 | provider summarizer；失败/空 → 占位摘要 |
| 结果 | `role: system` + `compaction_summary: true`；旧摘要移除，system 提前 |
| 事件 | `context.compacted`（auto / overflow / manual） |

压缩摘要主要靠 session cache 恢复；事件日志未为每次压缩发 `message.compaction`。
**两个 80% 不是一回事**：`context.compactThreshold` 触发压缩；`limits.inputTokensLimit` 80% 触发 `vessel:limit`。默认都 1M，但机制独立。压缩**未废弃**；`rotate` 是独立换 Body，不自动触发；overflow 仍 `forceCompact` 后重试一次。

<a id="prefix"></a>

## 前缀不变量

1. **system 冻结**：hook 写 `ctx.systemPrompt` 被忽略，发 `hook.system_prompt_ignored`。
2. **只能追加**：`PromptPrefixGuard` 对比上一次请求；无 reason 的中间重写发 `prompt.prefix_changed`；`VESSEL_STRICT_PREFIX=1` 时抛 `PromptPrefixChangedError`。
3. **合法 reason**：`compaction` / `resume` / `branch` / `session_switch` / `system_revision` / `tools_changed` / `model_changed` / `context_trim`。
4. 动态元数据全部是尾部 `vessel:*` 消息，不改 system；Web 默认隐藏，Settings → Display 可按类打开。
5. 静态审计：`bun run check:prompt-prefix` 禁止新增 `additionalContext:` 与 `ctx.systemPrompt =`。

## 各层责任

core：system / Self Card、历史、用户、assistant/tool、压缩、PrefixGuard。
`packages/agent`：`vessel:source`、成员/owner 队列、Team 派发。
asm (`src/`)：owner 队列注入、runtime notice、配置热应用通知、summarizer、版本通知。
plugins：doc-subscription `vessel:subscription`、hook-logging（只观测）、MCP 工具结果。
TUI / Web：`@path` 引用、用户输入、`vessel:*` 可见性过滤。

相关：[runtime-loop](runtime-loop.md)、[runtime-api](runtime-api.md)、[guardrails-hooks](guardrails-hooks.md)、[member-team](member-team.md)。
