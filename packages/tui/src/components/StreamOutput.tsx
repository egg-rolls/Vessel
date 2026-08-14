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
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
    return <SpinnerWithVerb verb="tool" description={activity ?? displayName} />;
  }

  const renderResult =
    display.renderToolResultMessage ?? DEFAULT_TOOL_DISPLAY.renderToolResultMessage;
  const renderError =
    display.renderToolUseErrorMessage ?? DEFAULT_TOOL_DISPLAY.renderToolUseErrorMessage;

  if (seg.status === 'completed') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green">✓ {displayName}</Text>
          <Text color="gray"> {seg.duration}ms</Text>
        </Box>
        {renderResult(seg.result ?? '', {})}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="red">✗ {displayName}</Text>
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
          // 通知父组件归档当前轮输出
          const responseText = getResponseText(segmentsRef.current);
          if (responseText) {
            onCompleteRef.current?.(responseText);
          }
          resetSegments();
          break;
        }
      }
    });

    return unsubscribe;
  }, [events, resetSegments, nextId]);

  const hasContent = segments.length > 0;
  const isActive = spinnerState.verb !== 'idle';

  return (
    <Box flexDirection="column">
      {/* 按时间顺序渲染所有片段，最新内容自然出现在底部 */}
      {segments.map((seg) => {
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
