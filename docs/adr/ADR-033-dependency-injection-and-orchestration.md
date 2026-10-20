---
adr: 33
title: AgentRuntime 依赖倒置注入 + 编排逻辑外推（解冻 ADR-017 局部）
status: accepted
date: null
related: [17, 23, 26, 29]
---

## ADR-033：AgentRuntime 依赖倒置注入 + 编排逻辑外推（解冻 ADR-017 局部）

- **上下文**：ADR-017 冻结 core。但审计发现 `agent-runtime.ts`（757 行）存在两个 SOLID 违例，影响可测试性与可扩展性：(1) 依赖倒置违反——构造函数硬编码 `new MemoryLimitChecker()` / `new MemoryPluginHost()`，`AgentRuntimeOptions` 无 `pluginHost`/`limitChecker` 注入位，无法替换实现；(2) God-object——权限策略（~53 行）、guardrail 编排、hook 编排全部内联在 `AgentRuntime`，违反单一职责。
- **决策**：
  1. **依赖倒置注入（ADR-017(2a) 扩插座）**：`AgentRuntimeOptions` 新增**全可选**字段 `pluginHost?: PluginHost` 与 `limitChecker?: LimitChecker`，构造函数用 `?? new MemoryXxx()` 兜底。向后兼容（现有调用方零改动）。理由：构造语义无法用 Plugin/Hook/Guardrail/事件表示——Plugin 是构造后才注入的，无法决定对象构造时的依赖装配（ADR-023 同款论证）。
  2. **编排逻辑外推（内部重构，不改接口契约）**：把 `AgentRuntime` 内联的权限策略、guardrail 编排、hook 编排抽到独立模块（`runtime/permission-policy.ts`、`runtime/guardrail-runner.ts`、`runtime/hook-runner.ts`），`AgentRuntime` 降为协调者。不改变 9 接口语义、tool-calling loop 拓扑、事件名。
- **备选**：(a) 保持现状——可测试性差、`agent-runtime.ts` 持续膨胀；(b) 把权限/guardrail/hook 全做成插件——权限策略是 loop 骨架的默认行为（ADR-029），guardrail/hook 编排是 loop 的编排步骤，插件化会破坏 loop 骨架完整性。均不取。
- **后果**：`AgentRuntime` 从 778 行降至 676 行（权限/guardrail/hook 编排逻辑外推 156 行到三个 runner）；`LimitChecker`/`PluginHost` 可注入替代实现（测试/嵌入场景）；三个 runner 可独立单测。接口面仅增 2 个可选字段，向后兼容。冻结范围收紧为「9 接口语义 + loop 拓扑 + 事件名」不变。
- **关联**：ADR-017（解冻局部）、ADR-023（构造语义论证）、ADR-026/029（权限策略）。
