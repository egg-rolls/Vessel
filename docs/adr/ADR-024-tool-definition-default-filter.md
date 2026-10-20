---
adr: 24
title: ToolDefinition.default 过滤——修复 loop 不按 default 字段过滤工具的 bug
status: superseded
date: null
related: [17, 18]
---

## ADR-024：ToolDefinition.default 过滤——修复 loop 不按 default 字段过滤工具的 bug

- **上下文**：SPEC §4.2 定义了 `ToolDefinition.default?: boolean` 字段，语义明确——`default: true` 的工具在 system prompt 中自动列出，`default: false` 的工具通过 `search_assets` 按需发现。PLUGINS.md §一 为每个工具分配了 default 值（file-ops/grep/web-search/web-fetch 为 `true`；shell 为 `false`）。类型系统中 `default` 字段已存在，但 `AgentRuntime.toolCallingLoop` 从不读取此字段——`listTools()` 返回全部工具后直接映射为 schema 发送给 LLM。结果：渐进式工具发现机制从未生效，所有工具（包括 shell）始终暴露在 LLM 请求中。
- **决策**：属 ADR-017(2b)「修复 loop 级 bug / spec-implementation gap」，无需解冻。在 `toolCallingLoop` 的 `listTools()` 之后、`map` 之前，加一行过滤：`allTools.filter(t => t.default !== false)`。语义：`default === false` 的工具不自动发送给 LLM；`default === true` 或未设置（`undefined`）的工具保持默认可见。`pluginHost.listTools()` 仍返回全部工具——`search_assets` 可通过它发现隐藏工具；运行时仅过滤 LLM 请求中的工具列表。`LlmRequest` 事件发布过滤后的 `toolSchemas`，与 LLM 实际收到的内容一致。
- **论证为何无法用 Plugin/Hook/Guardrail/事件表示**：(1) `BeforeLlm` hook 上下文不暴露工具列表，无法过滤；(2) 若由 plugin 从 registry 中移除 `default: false` 的工具，则 `search_assets` 也无法发现它们——过滤必须发生在「选择发送给 LLM 的工具」这一时刻，而非「注册工具」时；(3) Guardrail 作用于工具调用结果或输入，不作用于工具的可见性。唯一正确的切入点就是 tool-calling loop 组装 LLM 请求处。
- **备选**：(a) 在 `pluginHost.listTools()` 层面加参数 `listTools({ defaultOnly: true })`——但 `PluginHost` 接口需新增方法签名，破坏 Core 冻结且新增接口契约。(b) 新增独立的 `listDefaultTools()` 方法——同样需改接口。(c) 不做过滤，所有工具始终可见——与 SPEC 矛盾且 shell 等危险工具无法隐藏。均不取。
- **后果**：`default: false` 的工具不再出现在 LLM 请求中，渐进式发现机制的第一步生效。`search_assets` 元工具可通过 `listTools()` 发现并文档化这些隐藏工具。向后兼容：未设置 `default` 的工具视为可见，现有行为不变。debug 日志从 `[Debug] Total tools:` 改为 `[Debug] Visible tools: N / M` 以区分可见/全部。Core 冻结不变——本 ADR 属 spec-implementation gap fix，不冲击冻结状态。
- **关联**：ADR-017(2b)、ADR-018；SPEC §4.2；PLUGINS.md §一；[issue #71](https://github.com/egg-rolls/Vessel/issues/71)。
