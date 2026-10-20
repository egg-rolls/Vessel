/**
 * 运行态计数器（0.13 下栏）：bash 运行数 / 子 agent 数。
 * @module @vessel-agent/tui
 *
 * 纯 reducer + Ink hook。事件缺失时也不能把计数永久卡住：
 * 每个 run 开始/终态（completed / failed / cancelled）一律清零。
 */

import type { EventStream } from '@vessel-agent/core';
import { useEffect, useState } from 'react';
import { asTuiEvent, type TuiEvent } from '../types/events.js';

export interface RuntimeCounters {
  /** 正在运行的 bash 工具数（含子 agent 内部的 bash） */
  bash: number;
  /** 正在运行的子 agent 数（按 delegate started / subagent.run 终态估算） */
  subagents: number;
}

export const INITIAL_RUNTIME_COUNTERS: RuntimeCounters = { bash: 0, subagents: 0 };

function dec(value: number): number {
  return Math.max(0, value - 1);
}

function isBash(toolName: string): boolean {
  return toolName === 'bash';
}

/** 纯函数：折叠单个事件 */
export function reduceRuntimeCounters(prev: RuntimeCounters, event: TuiEvent): RuntimeCounters {
  switch (event.type) {
    case 'run.started':
    case 'run.resumed':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return INITIAL_RUNTIME_COUNTERS;

    case 'tool.call.started':
    case 'subagent.tool.call.started':
      return isBash(event.data.tool_name) ? { ...prev, bash: prev.bash + 1 } : prev;

    case 'tool.call.completed':
    case 'tool.call.failed':
    case 'subagent.tool.call.completed':
    case 'subagent.tool.call.failed':
      return isBash(event.data.tool_name) ? { ...prev, bash: dec(prev.bash) } : prev;

    case 'subagent.delegate.started':
      return { ...prev, subagents: prev.subagents + 1 };

    case 'subagent.run.completed':
    case 'subagent.run.failed':
      return { ...prev, subagents: dec(prev.subagents) };

    default:
      return prev;
  }
}

/** 订阅事件流，实时维护下栏计数 */
export function useRuntimeCounters(events: EventStream): RuntimeCounters {
  const [state, setState] = useState<RuntimeCounters>(INITIAL_RUNTIME_COUNTERS);

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setState((prev) => reduceRuntimeCounters(prev, asTuiEvent(rawEvent)));
    });
    return unsubscribe;
  }, [events]);

  return state;
}
