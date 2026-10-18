---
adr: 25
title: 补全 SessionBackend 参考实现——不视为 Core 解冻
status: accepted
date: null
related: [17]
---

## ADR-025：补全 SessionBackend 参考实现——不视为 Core 解冻

- **上下文**：SPEC §4.8 明确规划 SessionBackend "提供 in-memory、file、sqlite 三种参考实现"。in-memory 和 sqlite 已完整实现，FileSessionBackend 存在基础 stub（`session-backend.ts` 97-170 行）但缺少 meta 派生、默认路径不对齐 `.vessel/` 规范。Issue #78 要求将 file 实现补全到与 sqlite 同等的参考实现质量。
- **决策**：**补全 SPEC 规划的参考实现不构成 ADR-017 的"改 core"**。理由：(1) `SessionBackend` 是已冻结的 9 个 core 接口之一——未修改接口本身；(2) SPEC §4.8 在冻结前已规划三种实现——这是完成既定设计，不是新增能力；(3) `FileSessionBackend` 已以 stub 形式存在于 core——本 PR 仅提取到独立文件并补全实现；(4) Session 持久化明确属于 core 内置（AGENTS.md §6）；(5) `SQLiteSessionBackend` 以同样方式（独立 `sqlite-backend.ts`）进入 core，无单独 ADR。**对 ADR-017 的澄清**：冻结阻止的是接口面扩张和新架构能力进入 core。为已冻结的接口补全预规划的参考实现——不改接口、不加能力——不需解冻。
- **备选**：(a) 将 FileSessionBackend 做成插件——增加不必要的复杂度：SessionBackend 实现在 core 中是与 runtime/session 模块紧耦合的基础设施，打成插件增加加载顺序、类型引用等无谓摩擦。(b) 不补全、留 stub——SPEC 明确要求三种实现，stub 质量不可用于生产。均不取。
- **后果**：三种 SessionBackend 全部就位：in-memory（测试/开发）、file（单机轻量部署）、sqlite（生产/查询）。Core 冻结范围不变——接口、循环、事件系统均未改动。
- **关联**：ADR-017、[SPEC §4.8](SPEC.md)、[#78](https://github.com/egg-rolls/Vessel/issues/78)。
