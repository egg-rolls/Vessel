/**
 * 被清空工具结果的确定性占位文本（0.34 S1 / CONTRACT-0.34-context C1、R4）。
 *
 * 压缩与投影共用同一函数：输入只来自事件日志（assistant.tool_calls 的名称/参数
 * 与原始 result），不含时间、随机数或结果正文，因此同一份日志重建出同一占位。
 * 独立成模块，避免 `session/*` 反向依赖 `context/context-manager.ts`。
 *
 * @module @vessel-agent/core/context
 */

import { createDefaultTraceRedactor } from '../observability/trace-redactor.js';
import type { Message } from '../types/provider.js';

/** 旧版（< 0.34）清空占位；只用于识别历史事件，不再写入。 */
const LEGACY_CLEARED_TOOL_RESULT = '[Old tool result content cleared]';

/** 新占位前缀；`isClearedToolResult` 据此识别幂等。 */
const CLEARED_PREFIX = '[cleared ';

/** 命令摘要的码点上限（R4：≤60 码点）。 */
const SUMMARY_MAX_CODE_POINTS = 60;

/** 参数中可作为命令摘要的首个字符串字段，按优先级排列。 */
const SUMMARY_ARGUMENT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern'] as const;

/** 原始结果里的确定性 exit code 提取（匹配不到则省略该段）。 */
const EXIT_CODE_PATTERN = /exit(?:\s+code)?[: ]+(-?\d+)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按码点截断（不切代理对）。 */
function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** 参数摘要：若 `arguments` 是合法 JSON 对象，取首个命中的字符串字段。 */
function summaryFromArguments(args: string | undefined): string | undefined {
  if (!args) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  for (const key of SUMMARY_ARGUMENT_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** 用 core 默认 redactor 脱敏一段普通字符串（redactor 只处理事件 data）。 */
function redactSummary(summary: string): string {
  const redactor = createDefaultTraceRedactor();
  const event = redactor.redact({
    type: 'context.cleared_tool_result',
    run_id: '',
    ts: 0,
    data: { summary },
  });
  const redacted = event.data.summary;
  return typeof redacted === 'string' ? redacted : summary;
}

/** 在已构建消息里找拥有该 tool_call 的 assistant，返回其名称/参数。 */
function findToolCall(
  messages: readonly Message[],
  toolCallId: string,
): { name: string; arguments: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      if (call.id === toolCallId) return call.function;
    }
  }
  return undefined;
}

/**
 * 生成被清空工具结果的占位文本：
 * `[cleared <name>: <summary ≤60 码点> -> exit <n>, <n> lines]`。
 *
 * 名称/参数/exit 解析不到时对应片段省略；行数来自原始结果的确定性切分。
 * 不输出完整参数与结果正文。
 */
export function formatClearedToolResult(
  messages: readonly Message[],
  toolCallId: string,
  originalContent: string,
): string {
  const call = findToolCall(messages, toolCallId);
  const rawSummary = summaryFromArguments(call?.arguments);
  const summary = rawSummary
    ? truncateCodePoints(redactSummary(rawSummary), SUMMARY_MAX_CODE_POINTS)
    : undefined;

  const head = call?.name ? `cleared ${call.name}` : 'cleared';
  const body = summary ? `${head}: ${summary}` : head;

  const details: string[] = [];
  const exitMatch = EXIT_CODE_PATTERN.exec(originalContent);
  if (exitMatch?.[1] !== undefined) details.push(`exit ${exitMatch[1]}`);
  details.push(`${originalContent.split('\n').length} lines`);

  return `[${body} -> ${details.join(', ')}]`;
}

/** 是否已经是清空占位（旧常量或 0.34 新前缀）。 */
export function isClearedToolResult(content: string): boolean {
  return content === LEGACY_CLEARED_TOOL_RESULT || content.startsWith(CLEARED_PREFIX);
}
