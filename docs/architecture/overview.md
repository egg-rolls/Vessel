---
title: 概览与分层
kind: guide
triggers: [architecture, layering, dependency, kernel, module, adapter, core, philosophy, 分层, 依赖, 内核, 模块, 适配器, 哲学, 三层]
children: [layering.md, assembly.md, runtime-lifecycle.md, context.md, gateway.md, plugins.md, member-team.md, tools.md, interfaces.md, state.md, events.md]
---

# 概览与分层

> 导航页（guide）：只登记下层文档指针，不落事实。分层 / 依赖 / core 边界 / 哲学事实见 [layering.md](layering.md)；目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted；tenant 部分已被 ADR-100/T0–T5 取代）。

## 结构入口

- [layering.md](layering.md) —— 三层结构、依赖方向、Module ≠ Plugin 边界、ports & adapters / subpath exports、核心哲学（语言空间 / 两个适配器 / 两个插槽）。
- [assembly.md](assembly.md) —— 装配层 `src/` 导航：CLI 入口、bootstrap 装配序、工厂 wiring 与各 src 域叶子。

## 运行时域

- [runtime-lifecycle.md](runtime-lifecycle.md) —— Run 生命周期：Runtime / ExecutionUnit / Run / ToolCallingLoop 职责与 resume。
- [context.md](context.md) —— 上下文与消息注入：WorkingContext、投影与注入粒度。
- [interfaces.md](interfaces.md) —— 核心接口：provider / context / event 类型契约。
- [state.md](state.md) —— 状态与持久化接口：session / run-record-store / message 身份。
- [events.md](events.md) —— 事件系统：开放字符串事件名、EventLog 与重放等价。

## 外壳与扩展域

- [gateway.md](gateway.md) —— Gateway 协议与远程：`vessel.gateway/1` 帧、端点、静态托管、TLS。
- [member-team.md](member-team.md) —— AgentService、Body 与 Team：成员生命周期、准入投递、可见性。
- [tools.md](tools.md) —— 工具与权限边界：能力工具、工具名规则、engine 执行。
- [plugins.md](plugins.md) —— Plugin 架构：能力插件与体验插件、发现与信任。