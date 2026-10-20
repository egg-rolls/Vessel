---
adr: 31
title: 上下文变化事件化——同步写入 + ContextChanged 观测
status: accepted
date: null
related: [17, 27, 30]
---

## ADR-031：上下文变化事件化——同步写入 + ContextChanged 观测

- **上下文**：`ContextManager` 是模型的输入源（关键路径），写入必须可靠、有序、及时。但上下文变化是"静默"的——模型下一轮读到，TUI/调试/回放/审计却无法观察到上下文如何演变。分层事件驱动原则（EVENT-SYSTEM §5）：内聚核心（上下文/工具反馈）用直接调用保证及时性，同时发布事件提供可观测性。
- **决策**：
  1. `ContextManager.add(msg)` **保持同步直接写**——可靠、有序、及时（模型下一轮必读，关键路径不走事件流）。
  2. 每次上下文变化发布 `context.changed` 事件（payload：新增消息 / token 数 / 消息数），TUI/调试/回放/审计订阅——**代码加入 + 消息发布**双轨。
  3. 事件名 `context.changed`（开放字符串协议，ADR-030）。
  4. 实现方式：首选由 runtime 在 `add()` 后统一发布（不改 `ContextManager` 冻结接口）；或 `ContextManager` 注入 `EventStream` 自发布（需 ADR-017 解冻）。
- **备选**：(a) 完全事件化（读写走事件流）——关键路径异步，模型可能读到不完整/乱序上下文，违背及时性；(b) 不发布事件——上下文变化静默，无法 trace/回放。均不取。
- **后果**：上下文写入仍可靠及时（关键路径），同时变化可观测/可回放/可调试；与工具反馈（`context.add` + `tool.call.completed` 事件）同构——**内聚核心 = 直接调用 + 事件观测**。
- **关联**：ADR-017（解冻说明）、ADR-027、ADR-030；[EVENT-SYSTEM.md §5](../api/EVENT-SYSTEM.md)。
