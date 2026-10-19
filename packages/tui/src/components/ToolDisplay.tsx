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
import { theme } from '../theme.js';

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

/** 把字符串摘要为单行文本（超长截断） */
function truncateString(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 默认渲染器：未注册自定义显示的工具统一走这里。
 * 结果/错误渲染函数为必选（与可选接口区分），保证 StreamOutput 回退始终可用。
 */
export const DEFAULT_TOOL_DISPLAY: ToolDisplayDefinition & {
  renderToolResultMessage: NonNullable<ToolDisplayDefinition['renderToolResultMessage']>;
  renderToolUseErrorMessage: NonNullable<ToolDisplayDefinition['renderToolUseErrorMessage']>;
} = {
  userFacingName: () => '',
  renderToolUseMessage: (input, options) => {
    const showArguments = options.showArguments !== false;
    const max = options.maxArgumentLength ?? DEFAULT_MAX_ARGUMENT_LENGTH;
    return (
      <Text color={theme.muted}>{showArguments ? ` ${summarizeArguments(input, max)}` : ' …'}</Text>
    );
  },
  getActivityDescription: () => null,
  renderToolResultMessage: (result, options) => {
    const max = options.maxArgumentLength ?? DEFAULT_MAX_ARGUMENT_LENGTH;
    return <Text color={theme.muted}>{truncateString(result, max)}</Text>;
  },
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
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

// ── 内置工具显示（bash / read / edit / 接缝工具）──────────────

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function inputString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  return typeof value === 'string' ? value : '';
}

/** 单行化并截断（活动描述用） */
function compact(text: string, max: number): string {
  return truncateString(text.replace(/\s+/g, ' ').trim(), max);
}

/** bash 结果实时视图保留的末尾行数（含退出码等关键行） */
const BASH_RESULT_TAIL_LINES = 8;

/**
 * 按行截断工具结果：保留末尾 `maxLines` 行，避免按字符切断行。
 * 截断时在顶部加一行提示。
 */
export function tailResultLines(result: string, maxLines: number): string {
  const trimmed = result.trim();
  if (!trimmed || maxLines <= 0) return maxLines <= 0 ? '' : trimmed;
  const lines = trimmed.split('\n');
  if (lines.length <= maxLines) return trimmed;
  return `…（前文已折叠）\n${lines.slice(-maxLines).join('\n')}`;
}

toolDisplayRegistry.register('bash', {
  userFacingName: () => 'bash',
  getActivityDescription: (input) => {
    const command = inputString(input, 'command');
    return command ? `Running: ${compact(command, 80)}` : 'Running shell command';
  },
  renderToolUseMessage: (input) => {
    const command = inputString(input, 'command');
    return <Text color={theme.muted}>{command ? ` $ ${compact(command, 160)}` : ''}</Text>;
  },
  renderToolResultMessage: (result) => (
    <Text color={theme.muted}>{tailResultLines(result, BASH_RESULT_TAIL_LINES)}</Text>
  ),
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
});

toolDisplayRegistry.register('read', {
  userFacingName: () => 'read',
  getActivityDescription: (input) => {
    const path = inputString(input, 'path');
    return path ? `Reading ${path}` : 'Reading file';
  },
  renderToolUseMessage: (input) => {
    const path = inputString(input, 'path');
    return <Text color={theme.muted}>{path ? ` ${path}` : ''}</Text>;
  },
  renderToolResultMessage: (result) => (
    <Text color={theme.muted}>{`Read ${result.split('\n').length} lines`}</Text>
  ),
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
});

toolDisplayRegistry.register('edit', {
  userFacingName: () => 'edit',
  getActivityDescription: (input) => {
    const path = inputString(input, 'path');
    return path ? `Editing ${path}` : 'Editing file';
  },
  renderToolUseMessage: (input) => {
    const path = inputString(input, 'path');
    return <Text color={theme.muted}>{path ? ` ${path}` : ''}</Text>;
  },
  renderToolResultMessage: (result, options) => (
    <Text color={theme.muted}>{truncateString(result, options.maxArgumentLength ?? 200)}</Text>
  ),
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
});

toolDisplayRegistry.register('delegate_task', {
  userFacingName: () => 'delegate_task',
  getActivityDescription: (input) => {
    const task = inputString(input, 'task');
    return task ? `Delegating: ${compact(task, 80)}` : 'Delegating subtask';
  },
  renderToolUseMessage: (input) => {
    const task = inputString(input, 'task');
    return <Text color={theme.muted}>{task ? ` ${compact(task, 160)}` : ''}</Text>;
  },
  renderToolResultMessage: (result, options) => (
    <Text color={theme.muted}>{truncateString(result, options.maxArgumentLength ?? 300)}</Text>
  ),
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
});

toolDisplayRegistry.register('ask_user', {
  userFacingName: () => 'ask_user',
  getActivityDescription: () => 'Asking user',
  renderToolUseMessage: () => <Text color={theme.muted} />,
  renderToolResultMessage: (result, options) => (
    <Text color={theme.muted}>{truncateString(result, options.maxArgumentLength ?? 120)}</Text>
  ),
  renderToolUseErrorMessage: (error) => <Text color={theme.danger}>{error}</Text>,
});
