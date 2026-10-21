import { describe, expect, it } from 'bun:test';
import {
  mergeHistoryProjection,
  type ProjectableEvent,
  projectMessages,
} from '../src/session/project-messages.js';
import type { Message } from '../src/types/provider.js';

function userEvent(content: string, ts = 1000): ProjectableEvent {
  return {
    type: 'user.message',
    ts,
    data: { message: { role: 'user', content } },
  };
}

describe('projectMessages（0.18 纯函数投影）', () => {
  it('用户 → assistant(tool_calls) → tool → assistant 的完整轮次', () => {
    const events: ProjectableEvent[] = [
      userEvent('hello'),
      {
        type: 'llm.response',
        ts: 1100,
        data: {
          content: 'calling',
          reasoning: 'need a tool',
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'echo', arguments: '{"x":1}' },
            },
          ],
        },
      },
      {
        type: 'tool.call.started',
        ts: 1200,
        data: { tool_call_id: 'call-1', tool_name: 'echo', arguments: { x: 2 } },
      },
      {
        type: 'tool.call.completed',
        ts: 1300,
        data: { tool_call_id: 'call-1', tool_name: 'echo', result: 'tool-result' },
      },
      {
        type: 'llm.response',
        ts: 1400,
        data: { content: 'done', finish_reason: 'stop' },
      },
      {
        type: 'run.completed',
        ts: 1500,
        data: { output: 'final answer' },
      },
    ];

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: 'hello', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'calling',
        timestamp: 1100,
        reasoning_content: 'need a tool',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            // guardrail 改写后的实际参数（tool.call.started）优先
            function: { name: 'echo', arguments: '{"x":2}' },
          },
        ],
      },
      { role: 'tool', content: 'tool-result', tool_call_id: 'call-1', timestamp: 1300 },
      // run.completed.output 覆盖最终助手文本（输出 guardrail 可能改写）
      { role: 'assistant', content: 'final answer', timestamp: 1400 },
    ]);
  });

  it('tool.call.failed 折回 Error 文本；不影响后续 assistant', () => {
    const events: ProjectableEvent[] = [
      userEvent('run it'),
      {
        type: 'llm.response',
        ts: 1100,
        data: {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call-9',
              type: 'function',
              function: { name: 'bash', arguments: '{}' },
            },
          ],
        },
      },
      {
        type: 'tool.call.failed',
        ts: 1200,
        data: { tool_call_id: 'call-9', error: 'boom' },
      },
    ];

    const messages = projectMessages(events);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '' });
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call-9',
      content: 'Error: boom',
      timestamp: 1200,
    });
  });

  it('注入消息保持原顺序与形状', () => {
    const events: ProjectableEvent[] = [
      {
        type: 'message.injected',
        ts: 900,
        data: {
          message: { role: 'user', content: 'file ctx', name: 'agent:a', timestamp: 800 },
        },
      },
      userEvent('question', 1000),
    ];
    expect(projectMessages(events)).toEqual([
      { role: 'user', content: 'file ctx', name: 'agent:a', timestamp: 800 },
      { role: 'user', content: 'question', timestamp: 1000 },
    ]);
  });

  it('mergeHistoryProjection：按尾部重叠去重（旧数据无 derived）', () => {
    const cached: Message[] = [
      { role: 'system', content: 'sys', timestamp: 1 },
      { role: 'user', content: 'q', timestamp: 2 },
      { role: 'assistant', content: 'a', timestamp: 3 },
    ];
    const projected: Message[] = [
      { role: 'user', content: 'q', timestamp: 999 },
      { role: 'assistant', content: 'a', timestamp: 998 },
      { role: 'user', content: 'q2', timestamp: 997 },
    ];
    expect(mergeHistoryProjection(cached, projected)).toEqual([
      { role: 'system', content: 'sys', timestamp: 1 },
      { role: 'user', content: 'q', timestamp: 2 },
      { role: 'assistant', content: 'a', timestamp: 3 },
      { role: 'user', content: 'q2', timestamp: 997 },
    ]);
  });

  it('忽略非消息事件（run/permission/context/limit）', () => {
    const events: ProjectableEvent[] = [
      { type: 'run.started', ts: 1, data: { input: 'hi' } },
      { type: 'tool.permission.request', ts: 2, data: { requestId: 'r' } },
      { type: 'context.compacted', ts: 3, data: { removed: 2 } },
      { type: 'limit.blocked', ts: 4, data: {} },
    ];
    expect(projectMessages(events)).toEqual([]);
  });
});
