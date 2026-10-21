---
adr: 84
title: 0.14.3 限额可见性与 provider 错误/重试
status: accepted
date: 2026-10-21
related: [19, 64, 80]
tags: [limits, usage, events, error-envelope, observability, provider, retry, http]
---

## ADR-084：0.14.3 限额可见性与 provider 错误/重试

- **上下文**：使用量限额（`limits.*`）命中时 runtime 只抛 `Error('Usage limits exceeded')`，事件流没有独立信号，`run.failed` 也只有一行文本——调用方与 UI 无法区分“命中哪一项、当前值、上限、配置来源”，TUI 的 `/errors` 只能按字符串猜。另一方面，内置 provider 的非 2xx 只抛普通 `Error`，HTTP 状态与响应体丢失；重试装饰器只能从 message 里正则取状态码，且 429 不读 `Retry-After`、402（额度耗尽）也会被重试。

- **决策**：
  1. **`LimitBlock` 冻结形状**：`scope: 'run'`、`key`（`request_limit` / `tool_calls_limit` / `input_tokens_limit` / `output_tokens_limit` / `total_cost_limit` / `max_iterations` / `max_runtime`）、`current`、`max`、`source`（配置键路径，如 `limits.inputTokensLimit` / `termination.maxIterations`）、`hint`（一句可执行建议）、`retryable: false`。由两个纯函数产出：`evaluateUsageLimits(stats, limits)`（顺序固定 request → tool calls → input tokens → output tokens → total cost）与 `evaluateTermination(stats, policy)`（先 `max_iterations`，再 `max_runtime`），各返回首个命中项。
  2. **一次事件 + 一次抛错，终止策略同路径**：运行时每轮先判终止策略、再判使用量限额；任一命中即在命中点发布一次 `limit.blocked`，data 含 `error_code: 'limit_blocked'`、`LimitBlock` 全部字段、`run_id`、`session_id`；随后抛 `LimitExceededError`（`code: 'limit_blocked'`，`details` 为同一 `LimitBlock`）。终止策略不再抛普通 `Error`。
  3. **envelope 附加，不改原文**：`run.failed` 保留原 `error` 文本，附加 `error_code: 'limit_blocked'` / `category: 'internal'` / `phase: 'run'` / `retryable: false` / `details: <LimitBlock>`。错误文本前缀按来源区分——使用量限额为 `Usage limits exceeded: <key> (current N >= max M, <source>)`，终止策略为 `Termination policy triggered: <key> (current N >= max M, <source>)`；`max_iterations` 的 `current` 是 `requestCount`，`max_runtime` 的 `current` 是已运行秒数（毫秒精度小数）。错误对象自带的 `details` 自动进入 envelope，显式 `options.details` 优先。
  4. **默认预算**：`limits.inputTokensLimit` 100,000 → 1,000,000（与 `context.maxTokens` 的 1M 对齐）；`termination.maxIterations` 20 → 50；`limits.requestLimit` 100、`limits.toolCallsLimit` 50、`limits.outputTokensLimit` 50,000、`termination.maxRuntimeSeconds` 300 不变。
  5. **`ProviderHttpError`**：core 新增 `status` / `body` / `retryAfterMs` 三个只读字段；message 仍为 `<Provider> API error: <status> - <body>`。OpenAI 兼容与 Anthropic 的流式 / 非流式 4 处非 2xx 全部抛该错误；`retryAfterMs` 由 `parseRetryAfterMs()` 从 `retry-after` 头解析（秒数或 HTTP date，非法 / 空值返回 `undefined`）。
  6. **重试分类**：`provider-openai` / `provider-anthropic` 的 `retry.ts` 保持逐字一致。可重试 = 429、500–599、网络类错误；402（额度耗尽）与其它 4xx、`AbortError` 不重试。429 携带 `Retry-After` 时按建议值退避（毫秒字段 → 秒字段 → 头，顺序固定），结果受 `retry_max_delay_ms` 截断且**不加抖动**；无建议值时仍走指数退避 + 抖动。流式已输出分片后不再重试。

- **冻结契约**：
  - `limit.blocked` 每次 run 至多一次，紧邻抛错，不重复发布；事件 data 必须含 `error_code`、`scope`、`key`、`current`、`max`、`source`、`hint`、`retryable: false`、`run_id`、`session_id`。
  - `run.failed` 的 `error` 文本不得改写；结构化字段只许追加，`details` 必须是完整 `LimitBlock`。
  - `LimitBlock.key` 只允许七个 key：五个使用量 key 加 `max_iterations` / `max_runtime`；使用量限额与终止策略共用同一事件与 envelope 形状，调用方按 `key` / `source` 区分。
  - 终止策略命中必须先发 `limit.blocked` 再抛 `LimitExceededError`，不得退回普通 `Error`；`max_runtime.current` 允许小数秒。
  - `ProviderHttpError.message` 前缀保持 `OpenAI API error:` / `Anthropic API error:`，不得改成裸状态码。
  - 429 的 `Retry-After` 退避只能被 `maxDelayMs` 截断，不得低于 0；402 永远不重试。
  - 无新增 canonical RPC 方法（仍 40），无新增配置键。

- **非目标**：
  - 不改变终止策略的触发条件与判定顺序（仍先于使用量限额）。
  - 不改 `LimitChecker` 接口方法签名；`MemoryLimitChecker.checkLimits` / `checkTermination` 仍返回布尔值。
  - 不做跨 run / 跨 session 的限额聚合，不做配额预留或预警阈值。
  - 不把 `retryAfterMs` 写进 `run.failed` envelope（只透出 `http_status`）。
  - 不改变 5xx / 网络错误的指数退避与抖动参数。
  - 不改 Anthropic / OpenAI 请求体与消息组装。

- **验证**：`packages/core/__tests__/agent-runtime.test.ts`（`limit.blocked` 只发一次、data 形状、`run.failed` 的 `limit_blocked` envelope 与 `details`；`max_iterations` 命中时事件与 envelope 同形状、错误文本保留 `Termination policy triggered`）、`packages/core/__tests__/error-envelope.test.ts`（`limit_blocked` 归 `internal` / `run`、details 透传）、`packages/core/__tests__/limit-checker.test.ts`（五个使用量 key + `max_iterations` / `max_runtime` 的 `source` / `hint` / `current`、检查顺序）、`packages/core/__tests__/provider.test.ts`（非 2xx 的 `ProviderHttpError` 与 `Retry-After` 解析）、`plugins/provider/openai/__tests__/retry.test.ts` 与 `plugins/provider/anthropic/__tests__/retry.test.ts`（429 截断、402 不重试、503 仍指数退避）。文档门禁：`bun run scripts/check-docs.ts`、`bun run scripts/check-rpc-methods.ts`、`bunx @biomejs/biome ci .`。

- **已知限制**：`max_runtime.current` 是小数秒，未做整数归一；`run.failed` 不透出建议退避时间；`retry-after` 只参与 429 判定；第三方 provider 的错误对象若既无 `status` 字段也不匹配 message 形状，仍只能按文本分类。

- **关联**：ADR-019（camelCase 类型 / snake_case YAML）、ADR-064（`context.maxTokens` 1M 默认预算）、ADR-080（结构化错误 envelope）；`packages/core/src/types/limits.ts`、`packages/core/src/limits/`、`packages/core/src/runtime/agent-runtime.ts`、`packages/core/src/runtime/error-envelope.ts`、`packages/core/src/provider/errors.ts`、`packages/core/src/provider/providers.ts`、`plugins/provider/openai/src/retry.ts`、`plugins/provider/anthropic/src/retry.ts`。
