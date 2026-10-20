---
adr: 21
title: 工具显示接口——TUI 层定义，不改 Core
status: accepted
date: null
related: [17, 20]
---

## ADR-021：工具显示接口——TUI 层定义，不改 Core

- **上下文**：当前工具调用显示（`🔧 tool_name args ✓ duration_ms`）过于简单，需要支持更丰富的显示：工具活动描述、进度状态、结果渲染、错误显示等。Claude Code 的工具显示接口设计值得参考。
- **决策**：
  1. **不改 Core**：`@vessel/core` 的 `ToolDefinition` 保持不变（`name`, `description`, `inputSchema`, `handler`）。显示接口在 TUI 层单独定义。
  2. **TUI 层定义 `ToolDisplayDefinition`**：
     ```typescript
     interface ToolDisplayDefinition {
       userFacingName(input: unknown): string
       userFacingColor?(input: unknown): string
       renderToolUseMessage(input: unknown, options: DisplayOptions): React.ReactNode
       getActivityDescription?(input: unknown): string | null
       renderToolResultMessage?(result: string, options: DisplayOptions): React.ReactNode
       renderToolUseErrorMessage?(error: string, options: DisplayOptions): React.ReactNode
     }
     ```
  3. **注册机制**：TUI 层维护 `ToolDisplayRegistry`，工具可以注册自定义显示定义，未注册的工具使用默认渲染器。
  4. **简化设计**：移除 `isSearchOrReadCommand`（折叠显示）和 `isResultTruncated`（点击展开）等辅助功能，用默认行为替代。
- **备选**：(a) 扩展 Core 的 `ToolDefinition` 加 `display` 字段——违反 ADR-017 Core 冻结。(b) 不定义接口，每个工具硬编码渲染逻辑——难以维护。
- **后果**：Core 不改动，显示逻辑集中在 TUI 层，可独立演化。内置工具可以注册自定义显示，第三方工具使用默认渲染器。
- **关联**：ADR-017（Core 冻结）、ADR-020（命令设计）；Claude Code `Tool.ts` 参考。
