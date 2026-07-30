/**
 * 流式输出组件
 * 订阅 EventStream，实现 token-by-token 打字机动画 + 工具调用 spinner
 */

import type { EventStream, RunEvent } from '@vessel/core';
import { EventType } from '@vessel/core';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';

interface StreamOutputProps {
  events: EventStream;
  clearSignal?: number; // /clear 命令信号
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  status: 'running' | 'completed' | 'failed';
  duration?: number;
  error?: string;
}

export function StreamOutput({ events, clearSignal }: StreamOutputProps) {
  const [tokens, setTokens] = useState<string[]>([]);
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCall>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const tokensRef = useRef<string[]>([]);

  // 监听 clearSignal 变化，清空状态
  useEffect(() => {
    if (clearSignal !== undefined && clearSignal > 0) {
      tokensRef.current = [];
      setTokens([]);
      setToolCalls(new Map());
      setIsStreaming(false);
    }
  }, [clearSignal]);

  useEffect(() => {
    const unsubscribe = events.subscribe((event: RunEvent) => {
      switch (event.type) {
        case EventType.RunStarted: {
          tokensRef.current = [];
          setTokens([]);
          setToolCalls(new Map());
          setIsStreaming(true);
          break;
        }

        case EventType.LlmStreamChunk: {
          const data = event.data as { chunk: { type: string; delta?: string } };
          if (data.chunk.type === 'text_delta' && data.chunk.delta) {
            tokensRef.current = [...tokensRef.current, data.chunk.delta];
            setTokens([...tokensRef.current]);
          }
          break;
        }

        case EventType.ToolCallStarted: {
          const data = event.data as {
            tool_call_id: string;
            tool_name: string;
            arguments: unknown;
          };
          setToolCalls((prev) => {
            const next = new Map(prev);
            next.set(data.tool_call_id, {
              id: data.tool_call_id,
              name: data.tool_name,
              arguments: data.arguments,
              status: 'running',
            });
            return next;
          });
          break;
        }

        case EventType.ToolCallCompleted: {
          const data = event.data as {
            tool_call_id: string;
            tool_name: string;
            duration_ms: number;
          };
          setToolCalls((prev) => {
            const next = new Map(prev);
            const call = next.get(data.tool_call_id);
            if (call) {
              next.set(data.tool_call_id, {
                ...call,
                status: 'completed',
                duration: data.duration_ms,
              });
            }
            return next;
          });
          break;
        }

        case EventType.ToolCallFailed: {
          const data = event.data as {
            tool_call_id: string;
            tool_name: string;
            error: string;
            duration_ms: number;
          };
          setToolCalls((prev) => {
            const next = new Map(prev);
            const call = next.get(data.tool_call_id);
            if (call) {
              next.set(data.tool_call_id, {
                ...call,
                status: 'failed',
                error: data.error,
                duration: data.duration_ms,
              });
            }
            return next;
          });
          break;
        }

        case EventType.RunCompleted:
        case EventType.RunFailed:
          setIsStreaming(false);
          break;
      }
    });

    return unsubscribe;
  }, [events]);

  return (
    <Box flexDirection="column">
      {/* 流式 token 输出 */}
      {tokens.length > 0 && (
        <Box>
          <Text>{tokens.join('')}</Text>
        </Box>
      )}

      {/* 工具调用卡片 */}
      {Array.from(toolCalls.values()).map((call) => (
        <Box key={call.id} marginY={1}>
          {call.status === 'running' && (
            <Box>
              <Spinner type="dots" />
              <Text color="blue"> {call.name}</Text>
              <Text color="gray"> ...</Text>
            </Box>
          )}

          {call.status === 'completed' && (
            <Box>
              <Text color="green">✓ {call.name}</Text>
              <Text color="gray"> {call.duration}ms</Text>
            </Box>
          )}

          {call.status === 'failed' && (
            <Box>
              <Text color="red">✗ {call.name}</Text>
              <Text color="red"> {call.error}</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* 流式状态指示 */}
      {isStreaming && tokens.length === 0 && toolCalls.size === 0 && (
        <Box>
          <Spinner type="dots" />
          <Text color="gray"> Thinking...</Text>
        </Box>
      )}
    </Box>
  );
}
