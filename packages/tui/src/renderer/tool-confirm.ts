/**
 * 工具执行权限确认
 * @module @vessel/tui
 *
 * ADR-029：permission 从「guardrail + readline 弹窗」改为工具自带 `checkPermission`。
 * `ToolPermissionChecker.forTool(name)` 生成绑定到具体工具的 checkPermission——
 * 策略决定 'allow'（无需确认）或 'ask'（需用户决定）。'ask' 由 runtime 用事件流
 * （tool.permission.request / tool.permission.response）等待用户 allow/deny，
 * 与 ask-user 同构：组件间交流全走事件流，无直接回调。
 */

import type { ToolDefinition } from '@vessel/core';

/** 权限确认配置 */
export interface ToolPermissionConfig {
  /** 是否启用权限确认 */
  enabled?: boolean;
  /** 需要确认的工具列表（为空则全部确认） */
  tools?: string[];
  /** 自动批准的工具列表 */
  autoApprove?: string[];
}

/** 默认配置 */
const DEFAULT_CONFIG: ToolPermissionConfig = {
  enabled: true,
  tools: [],
  autoApprove: [],
};

/** tool.permission.request 事件载荷（工具 checkPermission / runtime 'ask' 分支发布，TUI 订阅展示确认框） */
export interface ToolPermissionRequestedData {
  requestId: string;
  tool: string;
  input: unknown;
}

/** tool.permission.response 事件载荷（TUI 发布用户决定） */
export interface ToolPermissionDecidedData {
  requestId: string;
  decision: 'allow' | 'deny';
}

/**
 * 工具权限确认器——生成绑定到具体工具的 checkPermission（策略判定）
 *
 * 仅做「要不要问」的决策，不做交互等待：'ask' 返回给 runtime，
 * 由 runtime 发布 tool.permission.request 并 waitFor tool.permission.response。
 */
export class ToolPermissionChecker {
  private config: ToolPermissionConfig;

  constructor(config: ToolPermissionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查工具是否需要用户确认
   */
  needsConfirmation(toolName: string): boolean {
    if (!this.config.enabled) {
      return false;
    }
    if (this.config.autoApprove?.includes(toolName)) {
      return false;
    }
    if (this.config.tools && this.config.tools.length > 0) {
      return this.config.tools.includes(toolName);
    }
    return true;
  }

  /**
   * 生成绑定到某工具的 checkPermission。
   * 返回 'allow'（放行）或 'ask'（需用户决定——由 runtime 事件流等待）。
   */
  forTool(toolName: string): NonNullable<ToolDefinition['checkPermission']> {
    return async () => (this.needsConfirmation(toolName) ? 'ask' : 'allow');
  }
}
