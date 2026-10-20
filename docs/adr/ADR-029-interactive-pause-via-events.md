---
adr: 29
title: 交互暂停事件流化——ask-user/permission 用事件流实现
status: accepted
date: null
related: [15, 26, 27]
---

## ADR-029：交互暂停事件流化——ask-user/permission 用事件流实现

- **上下文**：暂停型工具（ask-user / permission）既在 bootstrap 合成注册，靠 `AskUserBridge` + 回调注入与 CLI/TUI 交互——这是「死代码」：每个交互工具都要在装配层写一遍回调桥。ADR-027 提供 `waitFor` 后，暂停可由工具自己用事件流实现，组件间交流全走事件流，无直接回调。
- **决策**：
  1. ask-user 改为普通工具：handler 里 `events.publish('ask.user.requested', { requestId, question })` → `await events.waitFor('ask.user.answered', { requestId, timeout })` → 返回回答。
  2. TUI 订阅 `ask.user.requested` → 展示选择框 → 用户作答 → `publish('ask.user.answered', { requestId, answer })`。
  3. permission 改为工具自带 `checkPermission`：同样用事件流等用户 allow/deny/ask 决定。
  4. 删除 `src/bootstrap.ts` 的 tool-permission / ask-user 合成注册；`AskUserBridge` 退役。
- **备选**：(a) 保持 bridge——回调式，工具与 TUI 耦合，新交互工具要重复装配；(b) core 暂停接口——把暂停逻辑推回 core，违背 ADR-027 的事件流外推。均不取。
- **后果**：暂停 = 工具发事件 + 等事件，loop 不改（handler 天然 await）；新交互工具只写一个 handler，不再碰 bootstrap；headless 无订阅者时靠 `waitFor` 超时/注入策略兜底。本 ADR **supersede ADR-015 的暂停条款**。
- **关联**：ADR-026、ADR-027；[EVENT-SYSTEM.md](../api/EVENT-SYSTEM.md)；[#94](https://github.com/egg-rolls/Vessel/issues/94)。
