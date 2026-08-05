/**
 * 流式输出组件
 * 订阅 EventStream，实现 token-by-token 打字机动画 + 工具调用 spinner
 *
 * 只负责当前轮的实时流式显示。run 完成后通过 onComplete 回调通知父组件归档。
 */

import type { EventStream, RunEvent } from '@vessel/core';
import { EventType } from '@vessel/core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useRef, useState } from 'react';

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
export function reduceSegments(prev: Segment[], event: RunEvent, nextId: () => string): Segment[] {
  switch (event.type) {
    case EventType.RunStarted:
      return [];

    case EventType.LlmStreamChunk: {
      const delta = event.data.chunk.delta;
      if (event.data.chunk.type === 'text_delta' && delta) {
        const last = prev.at(-1);
        if (last?.type === 'text') {
          return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
        }
        return [...prev, { type: 'text', id: nextId(), text: delta }];
      }
      return prev;
    }

    case EventType.ToolCallStarted: {
      return [
        ...prev,
        makeToolCallSegment(event.data.tool_call_id, event.data.tool_name, event.data.arguments),
      ];
    }

    case EventType.ToolCallCompleted: {
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === event.data.tool_call_id
          ? { ...seg, status: 'completed' as const, duration: event.data.duration_ms }
          : seg,
      );
    }

    case EventType.ToolCallFailed: {
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === event.data.tool_call_id
          ? {
              ...seg,
              status: 'failed' as const,
              error: event.data.error,
              duration: event.data.duration_ms,
            }
          : seg,
      );
    }

    default:
      return prev;
  }
}

// ── 组件 ──

interface StreamOutputProps {
  events: EventStream;
  clearSignal?: number;
  /** 当前轮 run 完成时回调，传回响应文本 */
  onComplete?: (responseText: string) => void;
}

export function StreamOutput({ events, clearSignal, onComplete }: StreamOutputProps) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const segmentsRef = useRef<Segment[]>([]);
  const seqRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

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
      setIsStreaming(false);
    }
  }, [clearSignal, resetSegments]);

  useEffect(() => {
    const unsubscribe = events.subscribe((event: RunEvent) => {
      switch (event.type) {
        case EventType.RunStarted:
          resetSegments();
          setIsStreaming(true);
          break;

        case EventType.LlmStreamChunk:
        case EventType.ToolCallStarted:
        case EventType.ToolCallCompleted:
        case EventType.ToolCallFailed: {
          const next = reduceSegments(segmentsRef.current, event, nextId);
          segmentsRef.current = next;
          setSegments([...next]);
          break;
        }

        case EventType.RunCompleted:
        case EventType.RunFailed: {
          // 通知父组件归档当前轮输出
          const responseText = getResponseText(segmentsRef.current);
          if (responseText) {
            onCompleteRef.current?.(responseText);
          }
          resetSegments();
          setIsStreaming(false);
          break;
        }
      }
    });

    return unsubscribe;
  }, [events, resetSegments, nextId]);

  const hasContent = segments.length > 0;

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

        // tool_call segment
        return (
          <Box key={seg.id} marginY={1}>
            {seg.status === 'running' && (
              <Box>
                <Spinner type="dots" />
                <Text color="blue"> {seg.name}</Text>
                <Text color="gray"> ...</Text>
              </Box>
            )}

            {seg.status === 'completed' && (
              <Box>
                <Text color="green">✓ {seg.name}</Text>
                <Text color="gray"> {seg.duration}ms</Text>
              </Box>
            )}

            {seg.status === 'failed' && (
              <Box>
                <Text color="red">✗ {seg.name}</Text>
                <Text color="red"> {seg.error}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {/* 流式状态指示 */}
      {isStreaming && !hasContent && (
        <Box>
          <Spinner type="dots" />
          <Text color="gray"> Thinking...</Text>
        </Box>
      )}
    </Box>
  );
}
