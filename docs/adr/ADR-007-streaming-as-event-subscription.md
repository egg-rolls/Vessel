---
adr: 7
title: 流式 = 事件订阅，非独立 runtime
status: accepted
date: null
---

## ADR-007：流式 = 事件订阅，非独立 runtime

- **上下文**：旧 Vessel 流式是独立 StreamingAgentRuntime 类，与主 loop 分离；GAPS 自称修复的"统一事件模型"未兑现。
- **决策**：单一 runtime loop；流式输出通过订阅 EventStream 实现，TUI 订阅同一事件流渲染。
- **后果**：一套数据供 trace/replay/TUI；无重复 runtime。代价：loop 需在 LLM 流式响应时增量发事件。
- **关联**：legacy/LESSONS 教训10；[SPEC.md](SPEC.md) §3.3。
