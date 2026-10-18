---
adr: 27
title: 事件流拓展——事件名+payload 开放 + waitFor 原语
status: accepted
date: null
related: [8, 15, 26, 29, 30]
---

## ADR-027：事件流拓展——事件名+payload 开放 + waitFor 原语

- **上下文**：事件流是 runtime 的核心机制——loop 的每个节点都在发事件。ADR-008 为防散落字符串拼错而枚举化，但副作用是 core 僵化：**每次新事件都要改冻结的 `EventType` 枚举、写 ADR**——这本身就是把扩展复杂度往 core 推。Claude Code 与 hermes 均验证过开放机制：事件名是字符串常量 + 任意 payload，无枚举、无注册表 schema 校验，是行业主流。复杂度外推：事件类型的扩展能力应属于插件层，而非 core。
- **决策**：
  1. `RunEvent.type` 从 `EventType` 枚举放宽为 `string`。事件名一律开放字符串字面量，不定义 `EventType` 常量（ADR-030 修正：舍弃常量，杜绝二义）。
  2. `EventStream` 新增 `waitFor(name, { requestId?, timeout }): Promise<unknown>`——等待一次匹配事件；内部维护 pending map，收到匹配事件（含 requestId）时 resolve，超时 reject。工具可发事件、等事件。
  3. `ToolContext` 注入 `events`（ADR-026）。新增事件**不需要改 core**，插件直接 `publish` 自定义字符串事件名。
- **备选**：(a) 全枚举（现状）——每次新事件动冻结区，core 僵化；(b) 注册表 `registerEventType(name, schema)`——core 加接口，且两个成熟项目均未做，非必需。均不取。
- **后果**：事件系统开放，插件自由发布/订阅事件；核心事件仍强类型（常量 + payload 文档）。本 ADR **supersede ADR-008 的枚举封闭部分**、**ADR-015 的「暂停 = `signal.aborted` 一行」条款**（交互暂停由 `waitFor` 承载，见 ADR-029）。
- **关联**：ADR-026、ADR-029；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)；[#91](https://github.com/egg-rolls/Vessel/issues/91)。
