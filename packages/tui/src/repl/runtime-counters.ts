/**
 * 运行态计数器（0.13 下栏）：bash 运行数 / 子 agent 数。
 * @module @vessel-agent/tui
 *
 * 0.18：子 agent 数改由 `agent-registry` 派生（与 SubagentActivity 同一份），
 * 不再消费已无生产者的 `subagent.*`。bash 仍按 tool.call.* 计数；每个 run 终态清零。
 */

import type { EventStream } from '@vessel-agent/core';
import { useEffect, useState } from 'react';
import { asTuiEvent, type TuiEvent } from '../types/events.js';
import { type AgentNode, countActiveAgents } from './agent-registry.js';

export interface RuntimeCounters {
  /** 正在运行的 bash 工具数（含子 agent 内部的 bash） */
  bash: number;
  /** 正在运行的子 agent 数（由 agent-registry 覆盖） */
  subagents: number;
}

export const INITIAL_RUNTIME_COUNTERS: RuntimeCounters = { bash: 0, subagents: 0 };

function dec(value: number): number {
  return Math.max(0, value - 1);
}

function isBash(toolName: string): boolean {
  return toolName === 'bash';
}

/** 纯函数：折叠单个事件（bash 计数；子 agent 数由 registry 派生） */
export function reduceRuntimeCounters(prev: RuntimeCounters, event: TuiEvent): RuntimeCounters {
  switch (event.type) {
    case 'run.started':
    case 'run.resumed':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return INITIAL_RUNTIME_COUNTERS;

    case 'tool.call.started':
      return isBash(event.data.tool_name) ? { ...prev, bash: prev.bash + 1 } : prev;

    case 'tool.call.completed':
    case 'tool.call.failed':
      return isBash(event.data.tool_name) ? { ...prev, bash: dec(prev.bash) } : prev;

    default:
      return prev;
  }
}

/** 订阅事件流，实时维护下栏计数；子 agent 数取 agent-registry */
export function useRuntimeCounters(
  events: EventStream,
  agents: readonly AgentNode[] = [],
): RuntimeCounters {
  const [state, setState] = useState<RuntimeCounters>(INITIAL_RUNTIME_COUNTERS);

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setState((prev) => reduceRuntimeCounters(prev, asTuiEvent(rawEvent)));
    });
    return unsubscribe;
  }, [events]);

  const subagents = countActiveAgents(agents);
  return state.subagents === subagents ? state : { ...state, subagents };
}
