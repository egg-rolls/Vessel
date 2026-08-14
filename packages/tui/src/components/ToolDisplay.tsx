/**
 * 工具显示注册表（ADR-021）
 * @module @vessel/tui
 *
 * 不改 core：`ToolDefinition` 保持冻结。显示接口在 TUI 层单独定义。
 * 工具可注册自定义显示定义（userFacingName / activityDescription / 渲染函数），
 * 未注册的工具走 DEFAULT_TOOL_DISPLAY 默认渲染器。
 */

import { Text } from 'ink';
import type { ReactNode } from 'react';

/** 渲染选项（默认渲染器读这些字段） */
export interface DisplayOptions {
  /** 是否显示工具参数（默认 true） */
  showArguments?: boolean;
  /** 参数字符串最大长度（超出截断，默认 120） */
  maxArgumentLength?: number;
}

/** 工具显示定义（ADR-021 §2） */
export interface ToolDisplayDefinition {
  /** 用户可见名称；返回空串表示回退到原始 tool_name */
  userFacingName(input: unknown): string;
  /** 用户可见颜色（可选） */
  userFacingColor?(input: unknown): string | undefined;
  /** 工具调用消息渲染（React 节点） */
  renderToolUseMessage(input: unknown, options: DisplayOptions): ReactNode;
  /** 活动描述（用于 SpinnerWithVerb 的 tool 态，如 "Reading src/foo.ts"） */
  getActivityDescription?(input: unknown): string | null;
  /** 工具结果渲染（React 节点） */
  renderToolResultMessage?(result: string, options: DisplayOptions): ReactNode;
  /** 工具错误渲染（React 节点） */
  renderToolUseErrorMessage?(error: string, options: DisplayOptions): ReactNode;
}

const DEFAULT_MAX_ARGUMENT_LENGTH = 120;

/** 把工具参数摘要为单行文本（超长截断） */
function summarizeArguments(input: unknown, max: number): string {
  if (input === undefined || input === null) return '';
  const json = JSON.stringify(input);
  if (json.length <= max) return json;
  return `${json.slice(0, max)}…`;
}

/** 默认渲染器：未注册自定义显示的工具统一走这里 */
export const DEFAULT_TOOL_DISPLAY: ToolDisplayDefinition = {
  userFacingName: () => '',
  renderToolUseMessage: (input, options) => {
    const showArguments = options.showArguments !== false;
    const max = options.maxArgumentLength ?? DEFAULT_MAX_ARGUMENT_LENGTH;
    return <Text color="gray">{showArguments ? ` ${summarizeArguments(input, max)}` : ' …'}</Text>;
  },
  getActivityDescription: () => null,
};

/** 工具显示注册表（ADR-021 §3）：注册自定义显示，未注册走默认渲染器 */
export class ToolDisplayRegistry {
  private definitions = new Map<string, ToolDisplayDefinition>();

  register(name: string, definition: ToolDisplayDefinition): void {
    this.definitions.set(name, definition);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): ToolDisplayDefinition {
    return this.definitions.get(name) ?? DEFAULT_TOOL_DISPLAY;
  }
}

/** 默认单例：内置工具/第三方插件经它注册自定义显示 */
export const toolDisplayRegistry = new ToolDisplayRegistry();
