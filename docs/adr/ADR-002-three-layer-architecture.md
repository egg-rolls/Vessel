---
adr: 2
title: 三层结构（core + config + tui），非单框架/单应用
status: accepted
date: null
---

## ADR-002：三层结构（core + config + tui），非单框架/单应用

- **上下文**：纯框架无基础用户用不了；纯应用扩展性弱。用户提出"框架+控制UI"拆分。
- **决策**：三层。core=可嵌入运行时；config=声明式配置；tui=Claude-Code 式终端。无基础用 TUI，弱基础改配置，开发者写插件/嵌 core。
- **后果**：一个产品通吃三类用户；core 无 UI 依赖可独立嵌入。增加分包复杂度，但 monorepo 可控。
- **关联**：[PRD.md](PRD.md) §2；legacy/DESIGN-PRINCIPLES §1。
