---
adr: 54
title: RunExecution 与失败隔离
status: accepted
date: 2026-10-19
related: [27, 30, 33, 40]
tags: [runtime, correctness, hooks, guardrails]
---

## ADR-054：RunExecution 与失败隔离

- **上下文**：0.7 及以前，`AgentRuntime` 的 usage 统计、`runCreatedAt`、`runBranch`、`context.setSessionId` 等 run 级状态都是**实例级字段**。同一 runtime 上并发 `run()` 会互相覆盖统计与分支；`resume()` 的用户取消发 `run.failed`，与 `run()` 的 `run.cancelled` 不一致；`run()` / `resume()` 各自维护一份终态持久化与事件发布代码。另一方面，`HookRunner` 遇到单个 hook 抛错会向上冒泡，`GuardrailRunner` 会把 `check()` 的异常直接抛成 run 失败——一个坏插件即可拖垮整次 run。0.8 Wave 1 收敛这些行为；决策范围只涉及 core 内部状态与失败处理，不改变公开 API。

- **决策**：
  1. **run 级状态收敛到 `RunExecution`**。新增内部类型 `RunExecution`（`run_id` / `session_id` / `branch` / `created_at` / `started_at` / `stats` / `context`），由 `run()` / `resume()` 在入口创建，`finally` 释放。`toolCallingLoop`、`recordToolFailure`、`writeCheckpoint` 一律从 execution 读取 run 级状态，不再读实例字段。`context` 仍是注入的 `ContextManager`，因此同一实例的并发 run 由下面的守卫串行化；多 session 并发由 Host / Scheduler 的“一 agent 一 runtime”模型承担。
  2. **单 run 守卫**。实例持有 `activeRun?: RunExecution`，在**任何 await 之前**同步占位；已有 active run 时，新的 `run()` / `resume()` 立即抛 `RunAlreadyRunningError`，错误码 `run_already_running`。`RunAlreadyRunningError` 继承 `RunResumeError`，既有的 `instanceof` 与 `code` 消费方保持兼容。同一 `runId` 的并发 resume 仍由 `resuming` 集合拒绝。
  3. **统一终态 `finalizeRun()`**。`run()` 与 `resume()` 共用一条终态路径：状态映射 → OnError hook（best-effort）→ `saveSession` → `writeCheckpoint` → 发布 `run.completed` / `run.cancelled` / `run.failed`。状态映射规则：正常返回 `completed`；`AbortSignal` 且 reason 属于 Host 中断集合 → checkpoint `interrupted` + `run.failed`；其它用户取消 → checkpoint `cancelled` + `run.cancelled`；无 abort 的错误 → `failed` + `run.failed`。`resume()` 的用户取消从此与 `run()` 一致。
  4. **终态持久化失败不覆盖原始错误**。`finalizeRun` 自身抛错（如磁盘写失败）时，发 `run.finalize.failed` 事件并保留最初的 run 错误向上抛，不把持久化异常当成 run 的失败原因。
  5. **Hook 故障隔离**。`HookRunner` 对每个 hook 单独 try/catch：失败时发 `hook.failed`（保留给既有订阅方）与 `hook.error`（统一信号），继续执行后续 hook，已聚合的结果不丢弃。`OnError` hook 同样 best-effort；它抛错只产生 `hook.error`，不替换原始错误、不跳过 session / checkpoint 写入。
  6. **Guardrail 故障 fail-closed**。`guardrail.check()` 抛错时发 `guardrail.error`，并按 `{ allowed: false, reason: 'guardrail_error' }` 处理，不再让原始异常冒泡。随后沿用各阶段既有的 blocked 语义：Input / Output 终止 run，ToolCall / ToolResult 折回 tool 错误；任何阶段都不会把 guardrail 的异常当作“放行”。
  7. **兼容性**：`AgentRuntime` 的构造参数、`run()` / `resume()` 签名与返回值不变；`RunOptions` / `RunStore` / 事件信封不变。新增的是 `RunExecution` 类型、`RunAlreadyRunningError`（从根入口与 `@vessel/core/session` 导出）、`hook.error` / `guardrail.error` / `run.finalize.failed` 三个开放字符串事件。`hook.failed` 继续发布。

- **备选**：(a) 保持实例级状态，只加一把互斥锁——锁能串行化，但 `resume()` 仍会读到上一次 run 的统计，且无法在事件中正确归属 branch；(b) 为并发 run 各自复制一个 `AgentRuntime`——可行但把隔离成本推给所有调用方，且 Host 之外的单 runtime 用法会意外失去并发保护；(c) hook / guardrail 异常继续冒泡，交给上层重试——坏插件会反复杀死 run，且 OnError hook 自己抛错时没有任何安全的错误通道。均不取。

- **后果**：同一 runtime 的行为从“并发时状态互相污染”变为“明确拒绝第二个 run”，调用方需要为真正的并行准备多个 runtime（与 Host 模型一致）。坏 hook / 坏 guardrail 从“run 失败”降级为“可观测的降级信号 + 继续执行”，代价是错误不再自动终止 run；需要强制终止的场景应通过 guardrail 返回 `allowed: false` 或显式 abort 表达，而不是依赖抛异常。终态持久化失败多出一个可观测事件。

- **关联**：ADR-027（事件订阅与 `waitFor`）、ADR-030（开放字符串事件名）、ADR-033（依赖倒置与编排外推）、ADR-040（durable run / resume 语义）；`packages/core/src/runtime/agent-runtime.ts`、`hook-runner.ts`、`guardrail-runner.ts`、`types/run.ts`、`types/run-store.ts`。
