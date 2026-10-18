---
adr: 4
title: 统一声明式扩展（Plugin + PluginHost）
status: accepted
date: null
---

## ADR-004：统一声明式扩展（Plugin + PluginHost）

- **上下文**：旧 Vessel 有 4 套扩展机制（工具=装饰器、provider=register、hook=子类、workflow=add_node），心智不统一。
- **决策**：tool/provider/guardrail/hook 全部经 `Plugin.install(host)` 用同一组 register 方法注册。
- **后果**：单一心智；内置能力也走同机制（一致性）。表达力靠 Plugin 接口保证。
- **关联**：legacy/LESSONS 教训3；[SPEC.md](SPEC.md) §5。
