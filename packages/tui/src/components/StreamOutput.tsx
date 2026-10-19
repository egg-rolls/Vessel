/**
 * 流式输出组件
 * 订阅 EventStream，实现 token-by-token 打字机动画 + 工具调用 spinner
 *
 * 只负责当前轮的实时流式显示。run 完成后通过 onComplete 回调通知父组件归档。
 *
 * ADR-021/022：工具显示经 ToolDisplayRegistry（userFacingName / getActivityDescription），
 * spinner 状态经 StateTracker 折叠，SpinnerWithVerb 三态渲染。
 */

import type { EventStream } from '@vessel/core';
import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../theme.js';
import { asTuiEvent, type TuiEvent } from '../types/events.js';
import { SpinnerWithVerb } from './SpinnerWithVerb.js';
import { useSpinnerState } from './StateTracker.js';
import { DEFAULT_TOOL_DISPLAY, toolDisplayRegistry } from './ToolDisplay.js';

// ── 类型 & 工厂 & 纯 reducer（导出供测试） ──

/** 一个按时间顺序排列的输出片段：文本段落或工具调用卡片 */
export type Segment =
  | { type: 'text'; id: string; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: unknown;
      status: 'running' | 'completed' | 'failed';
      duration?: number;
      result?: string;
      error?: string;
    };

/** 创建 tool_call segment 的工厂函数，避免 as 类型断言 */
export function makeToolCallSegment(id: string, name: string, args: unknown): Segment {
  return { type: 'tool_call', id, name, arguments: args, status: 'running' };
}

/** 从 segments 中提取所有文本段落的拼接结果 */
export function getResponseText(segs: Segment[]): string {
  return segs
    .filter((seg): seg is { type: 'text'; id: string; text: string } => seg.type === 'text')
    .map((seg) => seg.text)
    .join('');
}

/** 实时视图最多保留的片段数（工具段连续出现时防止 live frame 无限增高） */
export const DEFAULT_MAX_SEGMENTS = 6;
/** 单个文本片段最多保留的行数 */
export const DEFAULT_MAX_TEXT_LINES = 12;
/** 归档时工具结果最多保留的行数 / 字符数 */
const TRANSCRIPT_MAX_RESULT_LINES = 12;
const TRANSCRIPT_MAX_RESULT_CHARS = 1200;

/** 截断提示行（与 ToolDisplay 的按行截断保持一致的文案） */
const TRUNCATED_NOTICE = '…（前文已折叠）';

/**
 * 纯函数：按行取文本尾部，最多保留 `maxLines` 行。
 * 截断时在前面加一行 `…（前文已折叠）`；返回值已 trim。
 */
export function tailLines(text: string, maxLines: number): string {
  const trimmed = text.trim();
  if (!trimmed || maxLines <= 0) return maxLines <= 0 ? '' : trimmed;
  const lines = trimmed.split('\n');
  if (lines.length <= maxLines) return trimmed;
  return `${TRUNCATED_NOTICE}\n${lines.slice(-maxLines).join('\n')}`;
}

export interface LimitSegmentsOptions {
  /** 最多保留的片段数，默认 6 */
  maxSegments?: number;
  /** 每个文本片段最多保留的行数，默认 12 */
  maxLines?: number;
}

/**
 * 纯函数：只保留最后 maxSegments 段，并对文本段做按行截断。
 * 工具段保留原样（ToolDisplay 自己负责结果截断）。
 */
export function limitSegments(segs: Segment[], options: LimitSegmentsOptions = {}): Segment[] {
  const maxSegments = Math.max(1, options.maxSegments ?? DEFAULT_MAX_SEGMENTS);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_TEXT_LINES);
  return segs
    .slice(-maxSegments)
    .map((seg) => (seg.type === 'text' ? { ...seg, text: tailLines(seg.text, maxLines) } : seg));
}

/** 归档时裁剪工具结果：最多 12 行 / 1200 字符 */
function clipToolResult(result: string): string {
  const tail = tailLines(result, TRANSCRIPT_MAX_RESULT_LINES);
  if (tail.length <= TRANSCRIPT_MAX_RESULT_CHARS) return tail;
  return `…${tail.slice(-TRANSCRIPT_MAX_RESULT_CHARS)}`;
}

/**
 * 纯函数：把当前轮 segments 转成可归档到 history 的文本。
 *
 * - 文本段原样拼接；
 * - completed 工具段输出紧凑摘要（`✓ name (12ms)` + 结果尾部）；
 * - failed 工具段输出 `✗ name` + error。
 */
export function getTranscriptText(segs: Segment[]): string {
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg.type === 'text') {
      if (seg.text) parts.push(seg.text);
      continue;
    }

    if (seg.status === 'completed') {
      const duration = seg.duration !== undefined ? ` (${seg.duration}ms)` : '';
      const header = `✓ ${seg.name}${duration}`;
      const body = seg.result ? clipToolResult(seg.result) : '';
      parts.push(body ? `${header}\n${body}` : header);
    } else if (seg.status === 'failed') {
      const header = `✗ ${seg.name}`;
      const body = seg.error?.trim() ?? '';
      parts.push(body ? `${header}\n${body}` : header);
    }
    // running：run 结束时仍处于 running 的工具没有结果，跳过。
  }
  return parts.join('\n');
}

/**
 * 纯函数：根据 RunEvent 计算新的 segments 数组。
 *
 * - `RunStarted` → 返回空数组（重置）
 * - `LlmStreamChunk` → 追加/合并 text segment
 * - `ToolCallStarted/Completed/Failed` → 追加/更新 tool_call segment
 * - 其他事件 → 返回原数组
 *
 * `nextId` 用于为新 text segment 生成唯一 key。
 */
export function reduceSegments(prev: Segment[], event: TuiEvent, nextId: () => string): Segment[] {
  switch (event.type) {
    case 'run.started':
    case 'run.resumed':
      return [];

    case 'llm.stream.chunk': {
      const chunk = event.data.chunk;
      const delta = chunk.delta;
      if (chunk.type === 'text_delta' && delta) {
        const last = prev.at(-1);
        if (last?.type === 'text') {
          return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
        }
        return [...prev, { type: 'text', id: nextId(), text: delta }];
      }
      return prev;
    }

    case 'tool.call.started': {
      const d = event.data;
      return [...prev, makeToolCallSegment(d.tool_call_id, d.tool_name, d.arguments)];
    }

    case 'tool.call.completed': {
      const d = event.data;
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === d.tool_call_id
          ? { ...seg, status: 'completed' as const, result: d.result, duration: d.duration_ms }
          : seg,
      );
    }

    case 'tool.call.failed': {
      const d = event.data;
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === d.tool_call_id
          ? {
              ...seg,
              status: 'failed' as const,
              error: d.error,
              duration: d.duration_ms,
            }
          : seg,
      );
    }

    default:
      return prev;
  }
}

// ── 组件 ──

type ToolCallSegment = Extract<Segment, { type: 'tool_call' }>;

/** 渲染 tool_call 片段：running=spinner；completed/failed 经 ToolDisplayRegistry 渲染结果/错误 */
function renderToolCall(seg: ToolCallSegment): ReactNode {
  const display = toolDisplayRegistry.get(seg.name);
  const displayName = display.userFacingName(seg.arguments) || seg.name;
  const activity = display.getActivityDescription?.(seg.arguments) ?? null;

  if (seg.status === 'running') {
    return (
      <Box flexDirection="column">
        <SpinnerWithVerb verb="tool" description={activity ?? displayName} />
        {display.renderToolUseMessage(seg.arguments, { maxArgumentLength: 120 })}
      </Box>
    );
  }

  const renderResult =
    display.renderToolResultMessage ?? DEFAULT_TOOL_DISPLAY.renderToolResultMessage;
  const renderError =
    display.renderToolUseErrorMessage ?? DEFAULT_TOOL_DISPLAY.renderToolUseErrorMessage;

  if (seg.status === 'completed') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={theme.ok}>✓ {displayName}</Text>
          {display.renderToolUseMessage(seg.arguments, { maxArgumentLength: 100 })}
          <Text color={theme.faint}> {seg.duration}ms</Text>
        </Box>
        {renderResult(seg.result ?? '', {})}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.danger}>✗ {displayName}</Text>
      </Box>
      {renderError(seg.error ?? '', {})}
    </Box>
  );
}

interface StreamOutputProps {
  events: EventStream;
  clearSignal?: number;
  /** 当前轮 run 完成时回调，传回响应文本 */
  onComplete?: (responseText: string) => void;
}

export function StreamOutput({ events, clearSignal, onComplete }: StreamOutputProps) {
  const { stdout } = useStdout();
  const [segments, setSegments] = useState<Segment[]>([]);
  const segmentsRef = useRef<Segment[]>([]);
  const seqRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const spinnerState = useSpinnerState(events);

  /** 组件实例级 ID 生成器，替代模块级可变计数器 */
  const nextId = useCallback(() => {
    seqRef.current += 1;
    return `seg_${seqRef.current}`;
  }, []);

  /** 统一的 segments 清空操作，所有重置路径走此处 */
  const resetSegments = useCallback(() => {
    segmentsRef.current = [];
    setSegments([]);
  }, []);

  // 监听 clearSignal 变化，清空状态
  useEffect(() => {
    if (clearSignal !== undefined && clearSignal > 0) {
      resetSegments();
    }
  }, [clearSignal, resetSegments]);

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      const event = asTuiEvent(rawEvent);
      switch (event.type) {
        case 'run.started':
          resetSegments();
          break;

        case 'run.resumed':
        case 'llm.stream.chunk':
        case 'tool.call.started':
        case 'tool.call.completed':
        case 'tool.call.failed': {
          const next = reduceSegments(segmentsRef.current, event, nextId);
          segmentsRef.current = next;
          setSegments([...next]);
          break;
        }

        case 'run.completed':
        case 'run.failed': {
          // 通知父组件归档当前轮输出：文本 + 工具摘要。
          // 纯工具轮没有文本段时回退到事件载荷，避免 bash 结果完全不进 history。
          const transcript = getTranscriptText(segmentsRef.current);
          const fallback = event.type === 'run.completed' ? event.data.output : event.data.error;
          const text = transcript || fallback || '';
          if (text) {
            onCompleteRef.current?.(text);
          }
          resetSegments();
          break;
        }
      }
    });

    return unsubscribe;
  }, [events, resetSegments, nextId]);

  // 按终端高度限制实时视图：留给状态栏 / 输入框 / 补全框 / running 行约 14 行。
  const maxTextLines = Math.max(4, (stdout.rows ?? 24) - 14);
  const visibleSegments = useMemo(
    () => limitSegments(segments, { maxSegments: DEFAULT_MAX_SEGMENTS, maxLines: maxTextLines }),
    [segments, maxTextLines],
  );

  const hasContent = visibleSegments.length > 0;
  const isActive = spinnerState.verb !== 'idle';

  return (
    <Box flexDirection="column">
      {/* 只渲染最近的有界片段，最新内容自然出现在底部 */}
      {visibleSegments.map((seg) => {
        if (seg.type === 'text') {
          return (
            <Box key={seg.id}>
              <Text>{seg.text}</Text>
            </Box>
          );
        }

        // tool_call segment（ADR-021：经 ToolDisplayRegistry 渲染）
        return (
          <Box key={seg.id} marginY={1}>
            {renderToolCall(seg)}
          </Box>
        );
      })}

      {/* 流式状态指示（ADR-022：StateTracker + SpinnerWithVerb 三态） */}
      {isActive && !hasContent && (
        <SpinnerWithVerb verb={spinnerState.verb} description={spinnerState.description} />
      )}
    </Box>
  );
}
