---
adr: 9
title: 全自研，不依赖 LangChain/LangGraph
status: accepted
date: null
---

## ADR-009：全自研，不依赖 LangChain/LangGraph

- **上下文**：旧项目核心原则；保持运行时轻量、可控。
- **决策**：core 不引入 LangChain/LangGraph 等重型 agent 框架；provider/tool 协议自实现。
- **后果**：依赖精简、行为可预测；需自维护协议适配。
- **关联**：legacy/DESIGN-PRINCIPLES §5。
