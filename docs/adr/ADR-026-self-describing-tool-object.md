---
adr: 26
title: 工具自描述对象——权限/暂停/显示/条件启用下沉到工具节点
status: accepted
date: null
supersedes: [24]
related: [17, 21, 27, 28, 29]
---

## ADR-026：工具自描述对象——权限/暂停/显示/条件启用下沉到工具节点

- **上下文**：Vessel 的架构哲学是「接口极简、复杂度外推」——core 只保留接口和循环，把决策和实现推到边缘。但既有的 `ToolDefinition` 只含 `name/description/inputSchema/handler/default`，权限靠外部 guardrail 挂接、暂停靠 bootstrap 合成注册（ask-user/permission）、显示靠 TUI 的 `ToolDisplayRegistry`（ADR-021）、条件启用仅一个 `default` 布尔。结果是：每个新交互工具都要改 bootstrap、每次新事件都要动 core——**复杂度被收在中心，边缘无法自由生长**。复杂度外推为什么好：(1) 核心稳定——复杂度留在中心则每次演化动冻结区，冻结失去意义；(2) 可扩展——工具自包含，加能力不改核心；(3) 认知负荷——理解 core = 理解接口，不需理解全部实现；(4) 独立演化与测试——每个工具独立改、独立测；(5) 自由度——实现可替换。
- **决策**：
  1. `ToolDefinition` 扩展为自描述对象，新增**全可选**字段（向后兼容，现有工具零改动编译）：
     - `interactive?: boolean`——需要暂停等用户输入
     - `checkPermission?(input, ctx)`——执行时权限判定
     - `render?(input)`——自定义显示（与 ADR-021 调和：默认 TUI 模板，工具可选声明渲染数据）
     - `isEnabled?(): boolean`——条件启用
     - `shouldDefer?: boolean`——延迟加载（tool_reference，预留）
  2. `ToolContext` 注入 `events: EventStream`（配合 ADR-027），工具可发事件、等事件。
  3. ask-user / permission 从 bootstrap 合成注册改为普通工具对象（ADR-029）。
- **备选**：(a) 保持现状——暂停/权限继续死代码在 bootstrap，新交互工具要改装配层；(b) 在 core 加暂停/权限接口——把复杂度推回 core，违背 ADR-017 冻结。均不取。
- **后果**：工具自描述，注册系统只做「发现」，不做业务决策；新增交互工具只加一个工具文件，bootstrap 的暂停特例消失；`default` 布尔被 `shouldDefer`/`isEnabled` 取代。本 ADR **supersede ADR-024**（default 字段过滤）、**调和 ADR-021**（工具显示，TUI 模板为主 + 工具可选定制）。
- **关联**：ADR-027、ADR-028、ADR-029、ADR-017 解冻流程；[#91](https://github.com/egg-rolls/Vessel/issues/91)。
