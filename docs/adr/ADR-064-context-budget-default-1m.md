---
adr: 64
title: 上下文默认预算提升到 1M token
status: accepted
date: 2026-10-20
related: [12]
tags: [context, tokens, defaults, config]
---

## ADR-064：上下文默认预算提升到 1M token

- **上下文**：`context.maxTokens` 长期默认 4096。自动压缩按 `compactThreshold: 0.8` 在该预算上计算阈值，因此长会话在约 3.3k 估算 token 时就会触发摘要。现代模型的上下文窗口普遍远大于 4096，这个默认值会让上下文管理器过早压缩，丢失本可保留的对话细节；同时用户往往不会主动配置该字段。`provider.maxTokens` 是另一个概念——它约束单次输出的 `max_tokens`，不能与上下文预算混为一谈。

- **决策**：
  1. **默认值改为 1,000,000**。`packages/config/src/defaults.ts` 的 `DEFAULT_CONFIG.context.maxTokens` 与 core `MemoryContextManager` 的三处 fallback（构造函数、summarizer 的 `{ maxTokens }` 预算、`shouldCompact()`）统一为 `1_000_000`。
  2. **provider 输出不变**。`provider.maxTokens` 的 config 默认值仍是 4096；Anthropic provider 在请求未指定 `max_tokens` 时的 fallback 也仍是 4096。上下文预算不写入 provider 请求。
  3. **自动压缩阈值不变**。仍为 `compactThreshold: 0.8`，默认在约 800,000 估算 token 时触发；`autoCompact` 仍默认开启，摘要与 system 消息保留语义不变。
  4. **小窗口显式配置**。使用 8k 等小上下文模型时，调用方必须显式传入 `context.maxTokens`；默认值不为模型推断，也不做按模型自动降级。

- **备选**：(a) 128k——比 4096 实用，但对支持 1M 的模型仍偏小，且同样需要按模型调整；(b) 按模型名推断窗口——需要维护模型表并与 provider 解耦，core 会引入厂商 / 模型知识，违反 core 的领域无关边界；(c) 保持 4096——继续让长会话过早压缩，且用户无感知。均不取。

- **后果**：默认配置的长会话可以保留更多历史，减少过早摘要；代价是内存占用与发往 provider 的请求体增大，小窗口模型若不显式配置会在请求侧失败或截断。token 计数仍是估算值，1M 预算不等于 provider 的精确窗口。CI 的 `quality` / `cross-platform` 另需在 `bun test` 前安装 `apps/web` 依赖（根 workspaces 不含 `apps/web`），这不改变运行时行为。

- **关联**：ADR-012（core 稳定性与演化）、ADR-054（RunExecution——压缩仍发生在上下文管理器内，不改 run 终态路径）；`packages/core/src/context/context-manager.ts`、`packages/config/src/defaults.ts`、`.github/actions/quality/action.yml`、`.github/workflows/ci.yml`。
