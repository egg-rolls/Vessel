---
title: Core 边界与运行时不变量
kind: advisory
triggers: [core, runtime, execution unit, run, resume, loop, tool pipeline, guardrail, hook, event, compaction, limits, journal, lease, 核心, 边界, 运行时不变量, 工具管线, 压缩, 上限, 租约]
paths: [packages/core/package.json, packages/core/src/runtime/execution-unit.ts, packages/core/src/runtime/runtime.ts, packages/core/src/runtime/tool-pipeline.ts, packages/core/src/runtime/tool-calling-loop.ts, packages/core/src/runtime/run-journal.ts, packages/core/src/runtime/provider-retry.ts, packages/core/src/runtime/error-envelope.ts, packages/core/src/context/context-manager.ts, packages/core/src/limits/limit-checker.ts, packages/core/src/kernel/types.ts, packages/core/src/types/lease.ts]
applies_to: [N, M]
---

# Core 边界与运行时不变量

> 改 core 运行时 / 上下文 / 限额代码前读这一篇；硬安全规则仍以 [AGENTS.md](../../AGENTS.md) 为准。配置事实家在 [config.md](../architecture/config.md) 与 [operations/CONFIG.md](../operations/CONFIG.md)，本文只留 core 侧不变量与链接。

## core 边界

- 不引入 LangChain / LangGraph（ADR-009）。core 的 `dependencies` 保持为空，重依赖只能进插件包。
- core 不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），不是第二套运行期机制；禁止 `ModuleHost` / `ModuleRegistry`。依赖方向单向 `core ← 其它`（评审时人工核对各包 `package.json`，仓库里没有自动脚本）。
- 事件名一律开放字符串 `<domain>.<action>.<event>`，不新增常量 / 枚举（ADR-030）；事件形状见 [events.md](../architecture/events.md)。
- 全异步，不写 sync-in-async；不留半成品 stub。

## 负空间（不得恢复）

- durable 只做 core 的 `RunRecordStore` port；两级租约原语（BindingLease / SessionLease，`types/lease.ts`）在 core；单公司 data-dir 写意图锁与跨节点 transport 在装配层。已移除 / 不进 core 的能力清单见 [plugins.md](plugins.md)。
- legacy 传输面（`transport.kind` / loopback / remote / 旧 team 面）见 [serve.md](serve.md#legacy-transport)。
- mock 场景只在 `src/mock/`；`VESSEL_MOCK_SCENARIO` 只在 CLI 入口读一次（ADR-063）。

## 运行时不变量

- **单 run**：`run()` / `resumeRun()` / `resumeSession()` 都经 `beginExecution` 同步占位、`finalizeRun` 统一终态；不要绕开 `activeRun` 或另写终态持久化 / 事件发布路径（ADR-054）。规则句见 AGENTS。
- **工具执行唯一 pipeline**（`tool-pipeline.ts`）：不得直调 `ToolDefinition.handler`；顺序 getTool → ToolCall guardrail → BeforeTool → PII 句柄替换 → permission → handler → ToolResult guardrail → AfterTool；权限在 guardrail/hook 改写后判定；`tool.call.*` 由调用方发布（ADR-058）。
- **Host 契约**（`kernel/types.ts`）：per-run session 只由 `AgentHandle.run` 消费 `RunOptions.sessionId`；取消经 `AbortSignal.reason` 透传；resume 经 Scheduler（`ScheduledTask.runId`）；`Scheduler.snapshot()` 可选，`RunSnapshot` / `SchedulerSnapshot` 纯 JSON 可序列化（ADR-081）。
- **Runtime / ExecutionUnit 分层**：`Runtime` 是 per-node 无状态工厂（只持单 node profile 与 `(内部单 id, sessionId)` EU 目录），`ExecutionUnit` 是 per-session 长活对象；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。
- **唯一写者**：事实事件 / RunRecord / SessionState 由 Run 经 `RunJournal` 写；`ExecutionUnit` 只持只读 EventLog（ADR-098 C1）。`WorkingContext` 归每次 Run（`contextFactory` 新建），不是 EU 的长期字段。
- **压缩摘要**：`role: 'system'` + `compaction_summary: true`，基底 system 之后、其它消息之前，同时最多一条；应用新压缩时移除旧摘要；不得写回 `assistant`（thinking 模式需要 `reasoning_content`）。`message.compaction` 可带 `cleared_tool_call_ids` / `degraded`，恢复先按 id 写回确定性占位再按 `kept` 裁剪（ADR-083）。
- **基底 system 无内置默认**：基底 system 只来自 `config.agent.systemPrompt` / 成员 `system_prompt`；未配置时为空并跳过 system 消息，core 不提供任何内置默认提示词。Self Card 是 runtime 元数据，仍注入（每 run 一次）。
- **限额**：判定只经 `evaluateUsageLimits` / `evaluateTermination`（ADR-084）。`request_limit` / token / cost / `max_iterations` / `max_runtime` 命中时先发 `limit.blocked` 再抛 `LimitExceededError`；没有工具调用软预算（legacy `tool_calls_limit` 键被忽略），loop 由 `max_iterations` / `max_runtime` 约束。
- **错误 envelope 只增不改**：`run.failed` / `tool.call.failed` 保留原 `error`，新增字段只附加；不写 prompt / reasoning / 完整工具结果（ADR-080）。
- **透明化**：事件形状冻结、快照只填已知字段、Self Card 每 run 一次、BeforeLlm 注入只增不改（ADR-086/087）；工具结果附图 / typed blocks 经既有注入通道 surfaced（协议见 [blocks.md](../architecture/blocks.md)）。
- **provider 重试**：只有「一个增量都没流出」的传输层断开与过载（429 / 502 / 503 / 504）自动重试（指数退避 + 抖动，默认 4 次 / base 500ms / 单次封顶 8s）；`AbortSignal` 中断立即抛。判定与退避是纯函数（`runtime/provider-retry.ts`），每次重试发 `llm.retry`（内部事件层）。

## 配置与存储（core 侧事实）

- core 不加载配置文件：配置经 `loadConfig()` 合并后只以构造选项进入 core；层序 / legacy 只读 / `session.backend` 等语义见 [config.md](../architecture/config.md) 与 [operations/CONFIG.md](../operations/CONFIG.md)。
- core 兜底：`maxTokens` 1M；`compactThreshold` 用 `DEFAULT_COMPACT_THRESHOLD`（0.85，`types/context.ts`，config defaults 复用同一常量）；`provider.maxTokens` 是单次输出上限（ADR-064）。
- 单公司根布局 / 写意图锁 / `non_root_layout` fail-fast 见 [topology.md](../architecture/topology.md) 与 [operations/CONFIG.md](../operations/CONFIG.md)；core `RunRecord` / 事件 DTO 无 `tenant_id`，legacy sqlite `sessions.tenant_id` 列按读写兼容保留。

## 指针

- 运行细节：[runtime-lifecycle](../architecture/runtime-lifecycle.md) · [runtime-loop](../architecture/runtime-loop.md) · [runtime-api](../architecture/runtime-api.md) · [context](../architecture/context.md) · [state](../architecture/state.md) · [events](../architecture/events.md)。
- 路径 denylist / 原子写 / 单 run / 密钥的**规则**见 AGENTS.md 硬安全规则；本文件不复述。