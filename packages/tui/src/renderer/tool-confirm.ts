/**
 * 工具执行权限确认
 * @module @vessel/tui
 *
 * ADR-029：permission 从「guardrail + readline 弹窗」改为事件流交互。
 * 默认权限策略由 runtime 统一判定（AgentRuntime.permission：'ask'/'allow' + autoApprove）；
 * 工具也可自带 `checkPermission` 自描述（mcp_connect 等）。'ask' 分支统一走事件流
 * （tool.permission.request / tool.permission.response）等用户 allow/deny，
 * 与 ask-user 同构：组件间交流全走事件流，无直接回调。
 */

/** tool.permission.request 事件载荷（工具 checkPermission / runtime 'ask' 分支发布，TUI 订阅展示确认框） */
export interface ToolPermissionRequestedData {
  requestId: string;
  tool: string;
  input: unknown;
}

/** tool.permission.response 事件载荷（TUI 发布用户决定；remember=true 表示"始终允许"） */
export interface ToolPermissionDecidedData {
  requestId: string;
  decision: 'allow' | 'deny';
  remember?: boolean;
}
