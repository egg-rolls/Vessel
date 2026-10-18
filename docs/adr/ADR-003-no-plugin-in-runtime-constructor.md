---
adr: 3
title: runtime 构造函数不注入插件
status: accepted
date: null
---

## ADR-003：runtime 构造函数不注入插件

- **上下文**：旧 Vessel runtime 构造函数注入 ~20 依赖（guardrails/hooks/memory/mcp/corrections/resilience...），成 god-object，违反自身 scope 纪律。
- **决策**：runtime 构造函数只接收核心必需项（provider/model/tools/context/events/limits/termination/session）；guardrail/memory/mcp/corrections/resilience 等以 Plugin 形式经 `plugins` 注入，install 时注册到 PluginHost。
- **后果**：runtime 可测、可嵌入、职责单一；插件可按需加载。代价：Plugin 接口需设计稳定。
- **关联**：legacy/LESSONS 教训2；[SPEC.md](SPEC.md) §4.9。
