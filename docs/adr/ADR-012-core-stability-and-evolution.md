---
adr: 12
title: Core 稳定性与演化策略
status: accepted
date: null
related: [11, 15, 30]
---

## ADR-012：Core 稳定性与演化策略

- **上下文**：旧 Vessel core 不断膨胀（教训2/14），因"加插件"滑成"给 core 加钩子给我的插件用"。需明确何时可改 core。
- **决策**：
  1. tool-calling loop 对功能开发冻结；功能增长一律走 Plugin/MCP/Skill（ADR-011）。
  2. core 仅在三种情况可改：(a) 新增/演化扩展面（HookType/GuardrailStage 等"插座"；事件名已开放，无需扩 EventType，见 ADR-030）；(b) 修复 loop 级缺陷；(c) 支持证明无法被工具/Hook/Guardrail/事件解决的横切需求（经 ADR-015 论证，尚无已知的此类需求）。
  3. 每次 core 改动必须先写 ADR；拿不准先做插件，验证后再议是否提升进 core。
  4. 重依赖/垂直能力永不进 core。
- **后果**：core 保持极小稳定；扩展可控；避免重蹈旧版 core 臃肿。代价：少数 loop 级能力需等 ADR + 排期。
- **关联**：legacy/LESSONS 教训2/14；[PLUGINS.md](PLUGINS.md) §九；[CLAUDE.md](../../CLAUDE.md) §6 红线。
