---
adr: 15
title: 循环通用性——不需要循环策略抽象
status: accepted
date: null
---

## ADR-015：循环通用性——不需要循环策略抽象

- **上下文**：旧 Vessel 在 Alpha 期就加了 workflow/team/durable 等表面"编排"能力，均属 speculative generality（教训14）。重写中我们曾怀疑"不同 Agent 范式（Harness Engineering / Loop Engineering / 树搜索 / A2A）是否需要不同的循环策略"。经逐项论证，结论是不需要。
- **决策**：
  1. Vessel 的工具调用循环是**通用的**——同一个 `while` 循环挂不同的工具/Hook/Guardrail 组合即可覆盖已知所有范式。
  2. **不引入** `LoopStrategy` 抽象（不需要"循环策略"可替换的接口）。当前硬编码的 `ToolCallingLoop` 在可预见的未来是唯一循环。
  3. 以下"看似需要新循环"的范式均证明可用现有机制实现：
     - A2A / 多 agent / 树搜索 → 工具（handler 内部 spawn 子 runtime）
     - Self-correction → Guardrail 或 Hook
     - Plan-then-execute → Agent 自身的推理 + 逐轮工具调用
     - Debate → 工具（handler 内部并行多 runtime）
     - 并行工具调用 → 工具内部 `Promise.all`；或循环中 `for each` → `Promise.all`（一行代码优化）
     - 流式工具结果 → `EventStream.publish(tool.progress)`，流的是观测层，循环仍等最终结果
     - 打断/暂停 → `signal.aborted` → `break`（一行代码）
  4. 若未来出现**真正无法用现有机制表达**的循环语义——即无法通过新增工具/Hook/Guardrail/事件类型解决——此时再写新 ADR。当前判断：不存在此类场景。
- **后果**：core 额外少一个接口（`LoopStrategy` 从 SPEC 移除）；所有范式统一用同一循环；新人不用学"选哪种策略"。代价：若未来确实需要新循环拓扑，需新 ADR。但按当前论证，那是很小概率的事件。
- **关联**：[SPEC.md §1.1](SPEC.md)；[PLUGINS.md §九](PLUGINS.md)；legacy/LESSONS 教训14。
