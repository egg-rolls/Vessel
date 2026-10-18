---
adr: 22
title: Spinner 状态显示——追踪思考/工具执行状态
status: accepted
date: null
related: [17, 21]
---

## ADR-022：Spinner 状态显示——追踪思考/工具执行状态

- **上下文**：当前 REPL 没有"思考中"状态显示，用户不知道 AI 是否在思考、思考了多久、是否在等待响应。Claude Code 的 Spinner 组件设计值得参考。
- **决策**：
  1. **Spinner 组件**：实现 `<SpinnerWithVerb>` 组件，支持三种模式：
     - `thinking`：思考中，显示 `🤔 Thinking...`
     - `tool`：工具执行中，显示活动描述（如 `📖 Reading src/foo.ts`）
     - `idle`：空闲，显示 `✻ Idle`
  2. **状态追踪**：TUI 层实现 `StateTracker`，订阅事件流计算状态：
     - `LlmRequest` → `thinking` 开始
     - `LlmStreamChunk` → `thinking` 结束，计算时长
     - `ToolCallStarted` → `tool` 开始
     - `ToolCallCompleted` → `tool` 结束
  3. **最小显示时间**：思考状态最少显示 2 秒，避免 UI 闪烁。
  4. **附加信息**：Spinner 可显示：
     - 活动描述（`getActivityDescription()`）
     - Token 计数
     - 努力程度（effort suffix）
     - 下一个任务（如果有）
     - Token 预算（如果配置）
  5. **替代当前实现**：Spinner 组件替代 `StreamRenderer` 的 `renderToolCallStarted/Completed/Failed` 方法，提供更丰富的显示。
- **备选**：(a) 保持当前简单文本输出——用户体验差。(b) 在 Core 层追踪状态——违反 ADR-017。
- **后果**：用户获得更好的状态反馈，知道 AI 是否在思考、思考了多久、执行了什么工具。需要修改 TUI 层的 StreamRenderer 和 REPL 组件。
- **关联**：ADR-017（Core 冻结）、ADR-021（工具显示）；Claude Code `Spinner.tsx` 参考。
