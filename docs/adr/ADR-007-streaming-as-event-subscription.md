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

## Errata（0.34 术语与分层）

> 2026-11-01，只追加。上文保留当时结论；以下为目标语义，**尚未实现**，见 [ADR-098](ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)。

- EventStream 是观察流（可丢弃、不可重放）；唯一真相是 SessionEventLog，写入者是 Run。
