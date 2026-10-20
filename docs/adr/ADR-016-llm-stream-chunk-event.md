---
adr: 16
title: LlmStreamChunk 事件类型——流式增量经事件流
status: accepted
date: null
related: [7, 8, 12, 30]
---

## ADR-016：LlmStreamChunk 事件类型——流式增量经事件流

- **上下文**：ADR-007 确立"流式 = 订阅事件流，非独立方法"，要求 loop 在 LLM 流式响应时增量发事件。当前 `LLMProvider.chat()` 仅返回完整 `LLMResponse`，loop 阻塞等待整段响应后一次发布 `LlmResponse`——TUI 只能看到整段文本，无法 token-by-token 渲染。ADR-012(2a) 允许扩展 EventType（"插座"级别演化）。
- **决策**：
  1. 新增 `llm.stream.chunk` 事件（携带 `LlmStreamChunkPayload { run_id, chunk: StreamChunk }`）；事件名现为开放字符串字面量（ADR-030，无 EventType 枚举）。
  2. `StreamChunk` 类型定义三层增量：`text_delta`（文本片段）、`tool_call_delta`（按 index 累积的 tool_call arguments 片段）、`finish`（完成原因 + usage）。
  3. `ChatRequest` 增加可选字段 `stream?: boolean` + `on_chunk?: (chunk: StreamChunk) => void`。Provider 在 `chat()` 内部处理流式（单方法，不动接口签名）：当 `stream=true` 且有 `on_chunk` 时走 SSE 逐块回调，最终仍返回拼装好的 `LLMResponse`（loop 后续逻辑不变）。
  4. Runtime 在 `toolCallingLoop` 始终传 `stream: true` + `on_chunk`（发布 `LlmStreamChunk` 事件）。支持流式的 Provider 走 SSE；不支持的 Provider 忽略字段，退化为整段返回（无 chunk 事件）。headless 无订阅者时 chunk 静默丢弃。
  5. 三个 Provider 同步实现流式：`MemoryLLMProvider`（供测试）、`OpenAICompatibleProvider`（SSE `data:` 行解析，tool_calls 按 index 累积）、`AnthropicProvider`（SSE `content_block_delta` 解析，tool_use `input_json_delta` 累积）。
- **备选**：(a) 新增 `chatStream()` 异步迭代器方法——被 SPEC §4.1 "非独立方法" 否决。(b) Provider 直接持 EventStream 引用 publish——耦合 provider 插件与 core 事件系统，且违 ADR-007"loop 增量发事件"。均不取。
- **后果**：TUI 可 token-by-token 渲染（emma 的 StreamRenderer 订阅 `llm.stream.chunk`）。事件名开放字符串字面量（ADR-030），新增无需扩枚举。Provider 非流式路径完全不变。core 稳定——不改 loop 逻辑、不引厂商 SDK。
- **关联**：[SPEC.md §4.1/§4.4](SPEC.md)；ADR-007、ADR-008、ADR-012(2a)。
