---
title: Core 边界与运行时不变量
kind: advisory
triggers: [core, runtime, run, resume, loop, tool pipeline, guardrail, hook, event, config, compaction, limits, lock, storage]
paths: [packages/core/**, packages/config/**]
applies_to: [N, M]
---

# Core 边界与运行时不变量

> 改 `packages/core/**` / `packages/config/**` 前读这一篇；硬安全规则仍以 [AGENTS.md](../../AGENTS.md) 为准。

## core 边界

- 不引入 LangChain / LangGraph（ADR-009）。core 的 `dependencies` 保持为空，重依赖只能进插件包。
- core 不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），不是第二套运行期机制；禁止 `ModuleHost` / `ModuleRegistry`。依赖方向单向 `core ← 其它`，由 `scripts/check-deps.ts` 检查。
- 事件名一律开放字符串 `<domain>.<action>.<event>`，不新增常量 / 枚举（ADR-030）；事件形状见 [events.md](../architecture/events.md)。
- 全异步，不写 sync-in-async；不留半成品 stub。

## 负空间（不得恢复）

- durable 只做 core 的 `RunStore` port；多租户原语在 core，跨节点 transport 在装配层；已移除 / 不进 core 的能力清单见 [plugins.md](plugins.md)。
- legacy 传输面（`transport.kind` / loopback / remote / 旧 team 面）见 [serve.md](serve.md#legacy-transport)。
- mock 场景只在 `src/mock/`；`VESSEL_MOCK_SCENARIO` 只在 CLI 入口读一次（ADR-063）。

## 运行时不变量

- **单 run 细节**：`run()` / `resume()` 经 `beginExecution` 占位、`finalizeRun` 收尾；不要绕开 `activeRun` 或另写终态持久化 / 事件发布路径（ADR-054）。规则句见 AGENTS。
- **工具执行唯一 pipeline**：不得直调 `ToolDefinition.handler`；顺序 getTool → ToolCall guardrail → BeforeTool → permission → handler → ToolResult guardrail → AfterTool；权限在 guardrail/hook 改写后判定；`tool.call.*` 由调用方发布（ADR-058）。
- **Host 契约**：per-run session 只由 `AgentHandle.run` 消费 `RunOptions.sessionId`；取消经 `AbortSignal.reason` 透传；`resume` 经 Scheduler（`ScheduledTask.runId`）；`snapshot()` 可 JSON 序列化；合成 `agent.run.*` 带 `mirror_of_run_id`（ADR-081）。唯一 checkpoint 写者是 `AgentRuntime`。
- **压缩摘要**：`role: 'system'` + `compaction_summary: true`，基底 system 之后、其它消息之前，同时最多一条；应用新压缩时移除旧摘要；不得写回 `assistant`（thinking 模式需要 `reasoning_content`）（ADR-083）。
- **限额**：命中时先发一次 `limit.blocked` 再抛 `LimitExceededError`；判定只经 `evaluateUsageLimits` / `evaluateTermination`（ADR-084）。
- **错误 envelope 只增不改**：`run.failed` / `tool.call.failed` 保留原 `error`，新增字段只附加；不写 prompt / reasoning / 完整工具结果（ADR-080）。
- **透明化**：事件形状冻结、快照只填已知字段、Self Card 每 run 一次、BeforeLlm 注入只增不改（ADR-086/087）。

## 配置与存储

- 配置层序固定 `CLI > env > tenant overlay > project > user > default`，只在 `loadConfig()` 合并；CLI flag 经 `buildCliConfigOverrides()`；serve / connect 不自读 argv / env（ADR-057）。
- legacy 配置只读：新版 `provider:` 优先；未注册 provider 且无 `provider.base_url` 抛 `ProviderConfigError`；YAML 解析失败 / 重复键是 validation error；API Key 经 `resolveEffectiveApiKey()`（ADR-068）。
- 默认 `session.backend: file`；保留 sqlite；检测到 legacy 数据只提示 `vessel migrate`，不自动迁移。
- `context.maxTokens` 默认 1M；`provider.maxTokens` 是单次输出上限（ADR-064）。

## 指针

- 运行细节：[runtime-lifecycle](../architecture/runtime-lifecycle.md) · [runtime-loop](../architecture/runtime-loop.md) · [state](../architecture/state.md) · [config](../architecture/config.md) · [events](../architecture/events.md)。
- 路径 denylist / 原子写 / 单 run / 密钥的**规则**见 AGENTS.md 硬安全规则；本文件不复述。
