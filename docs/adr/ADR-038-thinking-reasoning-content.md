---
adr: 38
title: thinking 模式 `reasoning_content` 回传
status: accepted
date: null
related: [7, 27, 30, 35, 36, 37]
---

## ADR-038：thinking 模式 `reasoning_content` 回传

> 编号说明：ADR-035 = 0.1 core loop 修复，ADR-036 = gateway 协议，**ADR-037 = 0.2 runtime（见下）**，ADR-038 = reasoning_content（本条）。

- **上下文**：OpenAI 兼容的 thinking 模型（如 DeepSeek reasoning）在响应里返回 `reasoning_content`。当响应包含工具调用时，下一轮请求必须把该字段原样回传，否则 API 会拒绝（`reasoning_content required`）。同时，思维链属于模型内部推理，不应出现在 TUI / 事件流 / 观测里，但会话恢复后仍需保留以支持后续轮次。
- **决策**：
  1. `Message` / `LLMResponse` 增加**可选** `reasoning_content?: string`（additive，不破坏既有接口）。
  2. Provider：OpenAI 兼容非流式读取 `choice.message.reasoning_content`；流式在 `StreamAccumulator` 累积 `delta.reasoning_content`，**刻意不回调 `on_chunk`**。Anthropic 不变。
  3. 请求映射：只对 `assistant` 消息回传（普通文本与含 `tool_calls` 两种），其他角色不带。
  4. Runtime：`stop` / `tool_calls` / `length` 三处把 `reasoning_content` 写入 assistant 消息；会话持久化（JSON / SQLite）自然保留，恢复后继续回传。
  5. **事件流剔除**：`llm.request` 的 messages 与 `context.changed` 的 message 在发布前剥离 `reasoning_content`，防止思维链泄漏到 TUI / 观测 / 回放。
  6. 请求归一化：不完整 `tool_calls` 轮次降级时，若文本为空但存在 `reasoning_content`，仍保留该 assistant 消息。
- **备选**：(a) 不进 `Message`、单独旁路存储——恢复与回传需要额外关联，跨会话易丢；(b) 拼进 `content`——思维链会暴露给 TUI 并污染上下文；(c) 只在 Provider 内存缓存——跨进程 / 会话恢复不可靠。均不取。
- **后果**：thinking 模型可连续进行工具调用；接口保持向后兼容；事件流与 TUI 看不到思维链；持久化恢复可用。代价：`reasoning_content` 占用会话存储；直接读取 `context.messages` 的嵌入方仍可看到该字段（core 不强制隐藏持久化数据）。
- **关联**：ADR-007、ADR-027、ADR-030、ADR-035；`ARCHITECTURE.md` §3.2 / §5.1 / §10 / §13。
