---
adr: 17
title: Core 正式冻结
status: superseded
date: null
related: [11, 12, 15, 16, 30]
---

## ADR-017：Core 正式冻结

- **上下文**：ADR-012 确立了 core 稳定性策略——只改三类事（插座/bug/横切）。ADR-011 确立四种扩展类型全经 PluginHost 投放。ADR-015 论证循环通用性——不需要 LoopStrategy 抽象。经 ADR-016（流式）补完 EventType 扩展面，9 个 core 接口 + 1 个循环 + 2 个插槽（ToolRegistry、ContextManager）的 MVP 范围已完整实现且与 SPEC 对齐。对所有已知功能诉求，Plugin/MCP/Skill 提供了充分且不侵入 core 的扩展路径。
- **决策**：
  1. `@vessel/core` 的 9 个接口 + tool-calling loop + HookType/GuardrailStage 枚举 + PluginHost 接口 **正式冻结**（事件名已开放，`EventType` 枚举已废弃，见 ADR-030）。冻结范围：`packages/core/src/**`。
  2. **只能因三种理由修改 core**（与 ADR-012(2a-c) 一致）：(a) 扩展"插座"（新增 HookType/GuardrailStage 成员，需写新 ADR；事件名开放，无需扩 EventType，见 ADR-030）；(b) 修复 loop 级或安全级 bug；(c) 被证明无法用 Plugin/Hook/Guardrail/事件/工具解决的横切需求（需先写新 ADR 论证）。
  3. **任何改 core 的 PR 必须带 ADR 且被两人 review 通过**。../role/DEVELOPER.md §Core 冻结 包含 AI 自检清单——拿不准不进 core。
  4. **解冻条件**（全部满足）：(a) 出现 Plugin/Hook/Guardrail/事件/工具均无法表示的架构级需求；(b) 经至少一个插件尝试证明不可行；(c) 新 ADR 论证 + 两人 review 通过。
- **备选**：永冻（不可逆）——过于僵化，ADR-012 保留的三种修改路径是合理安全阀。不冻（继续按 ADR-012 判断）——缺少显式里程碑，人类与 AI 对"可以改"的边界认知不统一。当前决策取了冻结 + 有限解冻条件的中间路径。
- **后果**：AI 合约明确——../role/DEVELOPER.md §Core 冻结 让每次编码会话首条指令级阻断。人类合约明确——PR 审查引用本 ADR 即可拒绝越界改动。Core 真正"固定不动"。若未来出现需解冻的需求，按本 ADR 第 4 条执行。
- **关联**：ADR-012、ADR-011、ADR-015；[../role/DEVELOPER.md §Core 冻结](../../role/DEVELOPER.md)。
