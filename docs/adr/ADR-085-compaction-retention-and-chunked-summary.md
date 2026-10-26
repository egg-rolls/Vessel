---
adr: 85
title: 0.14.4 上下文压缩质量：token 保留与分块摘要
status: accepted
date: 2026-10-21
related: [64, 83]
tags: [compaction, context, summarizer, chunking, tools]
---

## ADR-085：0.14.4 上下文压缩质量：token 保留与分块摘要

- **上下文**：`MemoryContextManager` 的压缩保留区此前按「最近 30% 非 system 消息」的**条数**划分，与 token 预算无关：短消息多时会保留过多内容，长工具结果少时会保留过少；保留边界还可能落在 `assistant(tool_calls)` / `tool` 之间，压缩后留下孤立 `tool` 消息被 provider 拒绝。摘要侧则把整段 transcript 以 `[role] content` 平铺后一次请求：工具调用名 / 参数和 `tool` 消息的调用标识全部丢失，长会话的单次摘要请求可能过大，一旦失败就丢掉整段摘要。

- **决策**：
  1. **保留区按 token 预算**：从最新非 system 消息向前累计 `estimateMessageTokens`，上限 `context.maxTokens × 0.3`；最新 2 条非 system 消息无论如何保留。非 system 少于 3 条时没有可摘要消息，返回不压缩。
  2. **保留区同时受条数上限约束**：`maxKept = max(2, messageCap - systemCount - 1)`，其中 `systemCount` 为当前 system 消息数（旧摘要被新摘要替换，净数不变），`-1` 为新摘要。`messageCap` 取显式 `context.maxMessages`，缺省 `max(100, floor(maxTokens / 100))`。token 或条数任一超限都触发摘要；两者都未超时 `keepFrom === 0`，不压缩。自动压缩触发条件不变：`tokenCount > maxTokens × 0.8` 或消息条数超过 `messageCap`。
  3. **保留边界不得切断 tool 配对**：若保留区第一条是 `tool`，把边界回退到持有对应 `tool_call_id` 的 `assistant(tool_calls)`，直到边界不是 `tool`。配对完整性优先于条数上限，回退后保留数可能略超 `maxKept`；历史本身不完整（找不到 owner）时保持原边界，不继续前移。
  4. **摘要 transcript 带工具上下文**：`assistant` 渲染为 `[assistant] <content>` 后逐条追加 `[tool_call:<name>] <arguments>`；`tool` 渲染为 `[tool:<id>] <content>`；其它角色为 `[<role>] <content>`。`reasoning_content` 不进入摘要。单条渲染超过 12,000 字符截断并追加 `[truncated]`。
  5. **摘要输入分块**：块预算 `min(48_000, max(2_000, floor(context.maxTokens / 8)))`，按渲染后文本的估算 token 分组；单条超预算时独占一块。单块一次摘要（输出 ≤ `max(128, min(context.maxTokens, 2048))`）；多块每块一次 partial（输出 ≤1024），再 reduce 一次（输出 ≤2048）。
  6. **逐块容错**：partial 失败写入 `[partial summary unavailable: chunk N]` 并继续；reduce 失败按序拼接 partial 并截断到输出 token 预算；全部 partial 失败返回空串，由 core 回退占位摘要 `[Auto Compact: N older messages summarized. Continuing...]`。摘要失败不中断 run。

- **冻结契约**：
  - 保留预算固定为 `maxTokens × 0.3`，不得退回按消息条数比例划分；至少保留 2 条非 system 消息。
  - 保留区不得以 `tool` 消息开头；配对回退可超出 `maxKept`，调用方不得依赖「保留数 ≤ maxKept」。
  - 摘要摘要消息的写入契约不变：`role: 'system'` + `compaction_summary: true`，同时最多一条（ADR-083）。
  - 摘要 transcript 必须包含 `assistant.tool_calls` 的名称与参数、`tool` 的 `tool_call_id` 与内容；`reasoning_content` 不得进入摘要。
  - 分块预算与输出预算按上述公式固定；单块失败只影响该块，不得因一块失败丢弃已成功的 partial。
  - 无新增配置键，无新增 canonical RPC 方法（仍 40），不新增事件名。

- **非目标**：
  - 不改自动压缩的 token 阈值（仍 `0.8`）与触发入口（`autoCompactAsync`）。
  - 不做 provider 精确 token 计数；仍用 `estimateTokens` 字符近似。
  - 不做摘要内容的结构化提取（决策 / 文件路径 / 待办仍靠 prompt 约束）。
  - 不做跨块重试、失败后下一轮补摘要或摘要质量评估。
  - 不改 `summarizer` 注入形状 `(messages, { maxTokens }) => Promise<string>`。
  - 不改 `applyCompaction` 的消息顺序与旧摘要移除逻辑。

- **验证**：`packages/core/__tests__/context-manager.test.ts`（token 预算保留、条数上限、两者任一超限触发、未超限不压缩、tool 配对回退与找不到 owner）、`src/__tests__/context-summarizer.test.ts`（transcript 含 `[tool_call:*]` / `[tool:*]`、12,000 字符截断、单块与多块分块预算、partial 失败标记、reduce 失败拼接、全部失败返回空串）。文档门禁：`bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`、`bunx @biomejs/biome ci .`。

- **已知限制**：token 估算为字符近似（ASCII 0.25 / CJK 0.5 token 每字符），边界附近保留量有偏差；配对回退可使保留数略超 `maxMessages`；全部块失败时只剩占位摘要，不重试。

- **关联**：ADR-064（`context.maxTokens` 1M 默认预算）、ADR-083（压缩摘要必须是 system 且同时最多一条）；`packages/core/src/context/context-manager.ts`、`src/tenant-runtime-factory.ts`。

## Errata

- **2026-10-26**：自动压缩默认阈值由 `0.8` 调整为 `0.9`（`tokenCount > maxTokens × 0.9`），显式 `compactThreshold` 仍优先；决策 2 与非目标 1 中的 0.8 以本 Errata 为准。80%–89.99% 不压缩，由 `context.pressure` 事件 + `vessel:limit` 尾部消息推荐 `agent(rotate)`；≥90% 自动压缩；overflow 的 `forceCompact` 兜底、保留区与摘要契约不变。
