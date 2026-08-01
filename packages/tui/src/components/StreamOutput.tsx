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

/** 一个按时间顺序排列的输出片段：文本段落或工具调用卡片 */
type Segment =
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

let segmentSeq = 0;
function nextSegId(): string {
  segmentSeq += 1;
  return `seg_${segmentSeq}`;
}

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
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // 追加/更新 segments 的辅助函数：保持 ref 与 state 同步
  const updateSegments = useCallback((fn: (prev: Segment[]) => Segment[]) => {
    segmentsRef.current = fn(segmentsRef.current);
    setSegments([...segmentsRef.current]);
  }, []);

  // 监听 clearSignal 变化，清空状态
  useEffect(() => {
    if (clearSignal !== undefined && clearSignal > 0) {
      segmentsRef.current = [];
      setSegments([]);
      setIsStreaming(false);
    }
  }, [clearSignal]);

  useEffect(() => {
    const unsubscribe = events.subscribe((event: RunEvent) => {
      switch (event.type) {
        case EventType.RunStarted: {
          segmentsRef.current = [];
          setSegments([]);
          setIsStreaming(true);
          break;
        }

        case EventType.LlmStreamChunk: {
          const data = event.data as { chunk: { type: string; delta?: string } };
          const delta = data.chunk.delta;
          if (data.chunk.type === 'text_delta' && delta) {
            updateSegments((prev) => {
              const last = prev.at(-1);
              if (last?.type === 'text') {
                // 追加到最后一个文本段落
                return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
              }
              // 创建新的文本段落
              return [...prev, { type: 'text', id: nextSegId(), text: delta }];
            });
          }
          break;
        }

        case EventType.ToolCallStarted: {
          const d = event.data as {
            tool_call_id: string;
            tool_name: string;
            arguments: unknown;
          };
          updateSegments((prev) => [
            ...prev,
            {
              type: 'tool_call',
              id: d.tool_call_id,
              name: d.tool_name,
              arguments: d.arguments,
              status: 'running',
            } as Segment,
          ]);
          break;
        }

        case EventType.ToolCallCompleted: {
          const d = event.data as {
            tool_call_id: string;
            tool_name: string;
            duration_ms: number;
          };
          updateSegments((prev) =>
            prev.map((seg) =>
              seg.type === 'tool_call' && seg.id === d.tool_call_id
                ? { ...seg, status: 'completed' as const, duration: d.duration_ms }
                : seg,
            ),
          );
          break;
        }

        case EventType.ToolCallFailed: {
          const d = event.data as {
            tool_call_id: string;
            tool_name: string;
            error: string;
            duration_ms: number;
          };
          updateSegments((prev) =>
            prev.map((seg) =>
              seg.type === 'tool_call' && seg.id === d.tool_call_id
                ? {
                    ...seg,
                    status: 'failed' as const,
                    error: d.error,
                    duration: d.duration_ms,
                  }
                : seg,
            ),
          );
          break;
        }

        case EventType.RunCompleted:
        case EventType.RunFailed: {
          // 通知父组件归档当前轮输出（合并所有文本段落）
          const responseText = segmentsRef.current
            .filter((seg) => seg.type === 'text')
            .map((seg) => (seg as { type: 'text'; text: string }).text)
            .join('');
          if (responseText) {
            onCompleteRef.current?.(responseText);
          }
          // 清空当前轮
          segmentsRef.current = [];
          setSegments([]);
          setIsStreaming(false);
          break;
        }
      }
    });

    return unsubscribe;
  }, [events, updateSegments]);

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
