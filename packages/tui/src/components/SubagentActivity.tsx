/**
 * 子 agent 活动展示（delegate_task）
 *
 * delegate-task 插件已经把子 runtime 事件以 `subagent.*` 前缀转发到父事件流。
 * 本组件只折叠其中少量事件成一行活动提示；不展示子 agent 的 token 流，
 * 也不实现任何传输/队列（当前没有队列事件）。
 */

import type { EventStream } from '@vessel/core';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import { asTuiEvent, type TuiEvent } from '../types/events.js';

export type SubagentStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface SubagentState {
  status: SubagentStatus;
  /** 仍在运行的 delegate 数（按 delegate.started / subagent.run.completed 估算） */
  active: number;
  task?: string;
  activity?: string;
}

const INITIAL: SubagentState = { status: 'idle', active: 0 };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function reduceSubagentState(prev: SubagentState, event: TuiEvent): SubagentState {
  switch (event.type) {
    case 'run.started':
      return INITIAL;

    case 'subagent.delegate.started':
      return {
        status: 'running',
        active: prev.active + 1,
        task: event.data.task,
        activity: undefined,
      };

    case 'subagent.tool.call.started':
      return prev.status === 'running' ? { ...prev, activity: event.data.tool_name } : prev;

    case 'subagent.run.completed': {
      const active = Math.max(0, prev.active - 1);
      return {
        ...prev,
        active,
        status: active > 0 ? 'running' : 'completed',
        activity: undefined,
      };
    }

    case 'subagent.run.failed': {
      const active = Math.max(0, prev.active - 1);
      return {
        ...prev,
        active,
        status: active > 0 ? 'running' : 'failed',
        activity: undefined,
      };
    }

    case 'run.completed':
    case 'run.failed':
      return INITIAL;

    default:
      return prev;
  }
}

export function SubagentActivity({ events }: { events: EventStream }) {
  const [state, setState] = useState<SubagentState>(INITIAL);

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setState((prev) => reduceSubagentState(prev, asTuiEvent(rawEvent)));
    });
    return unsubscribe;
  }, [events]);

  if (state.status === 'idle') return null;

  if (state.status === 'running') {
    const task = state.task ? truncate(state.task.replace(/\s+/g, ' '), 40) : 'subagent';
    return (
      <Box paddingX={1}>
        <Text color={theme.brand} wrap="truncate">
          ↳ {task}
          {state.activity ? ` · ${state.activity}` : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color={state.status === 'completed' ? theme.ok : theme.danger}>
        {state.status === 'completed' ? '✓ subagent finished' : '✗ subagent failed'}
      </Text>
    </Box>
  );
}
