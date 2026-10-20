---
adr: 8
title: 事件类型枚举化 + payload schema
status: accepted
date: null
related: [27, 30]
---

## ADR-008：事件类型枚举化 + payload schema

- **上下文**：旧 Vessel 事件类型是散落字符串字面量，手写 dict 发布，易拼写错、无校验。
- **决策**：EventType 枚举 + 每类对应 payload schema；发布走 `EventStream.publish(RunEvent)`。**已被 ADR-027/030 取代**——事件名一律开放字符串字面量，payload schema 保留。
- **后果**：类型安全、可校验、可文档化。新增事件需扩枚举。→ 开放后新增事件零 core 变更（ADR-030）。
- **关联**：legacy/LESSONS 教训8；[SPEC.md](SPEC.md) §4.4；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)。
