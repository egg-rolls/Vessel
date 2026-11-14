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

/**
 * `SessionState.cleared_tool_call_ids` 的归一（additive 字段）。
 *
 * 旧行 / 旧文件没有这个键 ⇒ `undefined`（= 这一段还没做过占位决策，请求视图与落盘
 * 逐字一致）。非数组 / 空数组同样「没有决策」，避免把脏数据当成「全清」。
 */
export function normalizeClearedToolCallIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return undefined;
  return [...new Set(ids)];
}

/** env 卡作用域词：工具结果占位（`apps/web` 的 `ENV_NOTICE_SCOPES` 同步登记）。 */
export const TRIM_ENV_SCOPE = 'trim';

/** env 卡明细行前缀；与 `packages/agent` 的 env 卡保持同一格式（core 侧字面量复用）。 */
export const TRIM_ENV_DETAIL_MARK = '  · ';

/** 卡里最多点名几个 call id（其余折成 `+N`），别让卡本身再把上下文撑大。 */
const TRIM_NOTICE_MAX_IDS = 8;

/** 文案语言：模型侧默认 en，UI 侧按用户语言渲染同一份文案。 */
export type TrimNoticeLocale = 'en' | 'zh-CN';

/** 一张占位卡要说清的三件事：清了几条、留了几条、被清的 call id。 */
export interface TrimNoticeInput {
  /** 本段总共被换成占位的工具结果条数。 */
  cleared: number;
  /** 请求视图里仍保留原文的工具结果条数。 */
  kept: number;
  /** 要点名的 call id（只传本次新增的；同一批 id 只讲一次）。 */
  tool_call_ids: readonly string[];
}

function listToolCallIds(ids: readonly string[]): string {
  const shown = ids.slice(0, TRIM_NOTICE_MAX_IDS);
  const rest = ids.length - shown.length;
  return rest > 0 ? shown.join(', ') + ', +' + String(rest) : shown.join(', ');
}

/**
 * 工具结果占位的**可见投影**（env 卡正文）。
 *
 * 只讲「清了几条 / 为什么 / 哪些 call id」，**不含任何工具输出正文**；按 session 去重
 * （调用方只把新增的 id 传进来）。0.52 V1：占位集合在段起点冻结，所以这张卡也只在
 * 集合变了的那一个段起点出现一次。
 */
export function renderContextTrimNotice(
  input: TrimNoticeInput,
  locale: TrimNoticeLocale = 'en',
): string {
  const ids = listToolCallIds(input.tool_call_ids);
  if (locale === 'zh-CN') {
    return [
      TRIM_ENV_SCOPE +
        '：为守住上下文上限，把 ' +
        String(input.cleared) +
        ' 条较早的工具结果换成了占位符',
      TRIM_ENV_DETAIL_MARK + '保留最近 ' + String(input.kept) + ' 条工具结果原文',
      TRIM_ENV_DETAIL_MARK + '被清的 call id：' + ids,
    ].join('\n');
  }
  return [
    TRIM_ENV_SCOPE +
      ': ' +
      String(input.cleared) +
      ' older tool result(s) replaced with placeholders to stay under the context limit',
    TRIM_ENV_DETAIL_MARK + 'kept the ' + String(input.kept) + ' most recent tool result(s) as-is',
    TRIM_ENV_DETAIL_MARK + 'cleared call ids: ' + ids,
  ].join('\n');
}
