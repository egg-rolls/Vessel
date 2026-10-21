/**
 * 工具显示注册表（ADR-021，0.18 收敛为 toView）
 * @module @vessel-agent/tui
 *
 * 不改 core：`ToolDefinition` 保持冻结。显示接口在 TUI 层单独定义。
 * 0.18 起每个工具只提供 `toView(input, result, status): ToolCallView`
 * （PLAN §4.2 冻结形状）与可选的 `renderDetail(view)`；旧的 4 个 render* 已删除。
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import type { ToolCallStatus, ToolCallView } from '../repl/project/ui-item.js';
import { theme } from '../theme.js';
import { condenseDiff, type DisplayDiffLine, diffLines } from '../utils/diff.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';
import { truncateToWidth } from '../utils/text-layout.js';

/** 工具显示定义（0.18：toView + 可选 renderDetail） */
export interface ToolDisplayDefinition {
  /** 产出工具卡模型；id/name/args/status 由注册表再次校正 */
  toView(input: unknown, result: string | undefined, status: ToolCallStatus): ToolCallView;
  /** 展开态的富渲染（edit diff 等）；缺省由卡片渲染 result 原文 */
  renderDetail?(view: ToolCallView): ReactNode;
  /** 活动描述（用于 SpinnerWithVerb 的 tool 态，如 "Reading src/foo.ts"） */
  getActivityDescription?(input: unknown): string | null;
}

/** 构造 ToolCallView 的公共壳（id 由投影层填写） */
export function makeToolCallView(
  name: string,
  input: unknown,
  result: string | undefined,
  status: ToolCallStatus,
  extra: Partial<ToolCallView> = {},
): ToolCallView {
  return {
    id: '',
    name,
    args: input,
    status,
    title: name,
    ...(result !== undefined ? { result: sanitizeTerminalText(result) } : {}),
    ...extra,
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function inputString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  return typeof value === 'string' ? value : '';
}

/** 单行化并截断（活动描述 / 参数摘要用） */
function compact(text: string, max: number): string {
  const oneLine = sanitizeTerminalText(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function summarizeArguments(input: unknown, max: number): string {
  if (input === undefined || input === null) return '';
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  return compact(json, max);
}

/**
 * 默认工具显示：未注册自定义显示的工具统一走这里。
 */
export const DEFAULT_TOOL_DISPLAY: ToolDisplayDefinition = {
  toView: (input, result, status) =>
    makeToolCallView('tool', input, result, status, {
      subtitle: summarizeArguments(input, 60),
    }),
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

  /** 产出工具卡模型；identity 字段以调用点为准，避免定义层伪造工具名 */
  view(
    name: string,
    input: unknown,
    result: string | undefined,
    status: ToolCallStatus,
  ): ToolCallView {
    const view = this.get(name).toView(input, result, status);
    return {
      ...view,
      id: '',
      name,
      args: input,
      status,
      title: view.title || name,
    };
  }
}

/** 默认单例：内置工具/第三方插件经它注册自定义显示 */
export const toolDisplayRegistry = new ToolDisplayRegistry();

// ── 内置工具显示（bash / read / edit / ask_user）──────────────

toolDisplayRegistry.register('bash', {
  toView: (input, result, status) =>
    makeToolCallView('bash', input, result, status, {
      subtitle: compact(inputString(input, 'command'), 200),
    }),
  getActivityDescription: (input) => {
    const command = inputString(input, 'command');
    return command
      ? t('tool.activity.running', { command: compact(command, 80) })
      : t('tool.activity.runningShell');
  },
});

toolDisplayRegistry.register('read', {
  toView: (input, result, status) =>
    makeToolCallView('read', input, result, status, {
      subtitle: compact(inputString(input, 'path'), 200),
    }),
  getActivityDescription: (input) => {
    const path = inputString(input, 'path');
    return path ? t('tool.activity.reading', { path }) : t('tool.activity.readingFile');
  },
});

/** 单行 diff 的行号列（4 位右对齐） */
function lineNumber(value: number | undefined): string {
  return (value ?? '').toString().padStart(4, ' ');
}

function renderDiffLine(line: DisplayDiffLine, key: string): ReactNode {
  if (line.kind === 'gap') {
    return (
      <Text key={key} color={theme.faint}>
        {'      …'}
      </Text>
    );
  }
  if (line.kind === 'add') {
    return (
      <Text key={key} color={theme.ok}>
        {`+ ${lineNumber(line.newLine)} │ `}
        {truncateToWidth(line.text, 120)}
      </Text>
    );
  }
  if (line.kind === 'del') {
    return (
      <Text key={key} color={theme.danger}>
        {`- ${lineNumber(line.oldLine)} │ `}
        {truncateToWidth(line.text, 120)}
      </Text>
    );
  }
  return (
    <Text key={key} color={theme.faint}>
      {`  ${lineNumber(line.oldLine)} │ `}
      {truncateToWidth(line.text, 120)}
    </Text>
  );
}

/** edit 的结构化 diff：入参里的 old_string/new_string -> +/- 行与行号 */
export function renderEditDiff(input: unknown, result: string, expanded = false): ReactNode {
  const oldText = inputString(input, 'old_string');
  const newText = inputString(input, 'new_string');
  if (!oldText && !newText) {
    return <Text color={theme.muted}>{truncateToWidth(sanitizeTerminalText(result), 200)}</Text>;
  }
  const lines = condenseDiff(diffLines(oldText, newText), {
    context: 2,
    maxLines: expanded ? 200 : 24,
  });
  if (lines.length === 0) {
    return <Text color={theme.muted}>{truncateToWidth(sanitizeTerminalText(result), 200)}</Text>;
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => renderDiffLine(line, `d${index}`))}
    </Box>
  );
}

toolDisplayRegistry.register('edit', {
  toView: (input, result, status) => {
    const path = compact(inputString(input, 'path'), 200);
    const added = inputString(input, 'new_string')
      ? inputString(input, 'new_string').split('\n').length
      : 0;
    const removed = inputString(input, 'old_string')
      ? inputString(input, 'old_string').split('\n').length
      : 0;
    const delta = added || removed ? `+${added} −${removed}` : '';
    const subtitle = [path, delta].filter((part) => part.length > 0).join('  ');
    return makeToolCallView('edit', input, result, status, {
      ...(subtitle ? { subtitle } : {}),
    });
  },
  renderDetail: (view) => renderEditDiff(view.args, view.result ?? '', true),
  getActivityDescription: (input) => {
    const path = inputString(input, 'path');
    return path ? t('tool.activity.editing', { path }) : t('tool.activity.editingFile');
  },
});

toolDisplayRegistry.register('ask_user', {
  toView: (input, result, status) => {
    const questions = asRecord(input).questions;
    const first =
      Array.isArray(questions) && typeof questions[0] === 'object' && questions[0] !== null
        ? (questions[0] as { question?: unknown }).question
        : undefined;
    const subtitle = typeof first === 'string' ? compact(first, 120) : '';
    return makeToolCallView('ask_user', input, result, status, {
      ...(subtitle ? { subtitle } : {}),
    });
  },
  getActivityDescription: () => t('tool.activity.askingUser'),
});
