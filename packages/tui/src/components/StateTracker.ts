/**
 * 状态追踪（ADR-022 §2）
 * @module @vessel/tui
 *
 * 订阅事件流，把核心事件折叠成 Spinner 三态（thinking/tool/idle）。
 * - run.started → thinking 开始
 * - llm.stream.chunk（首个文本）→ thinking 结束，归档耗时
 * - tool.call.started → tool 开始（携带工具名作为活动描述）
 * - tool.call.completed/failed → 回到 thinking
 * - run.completed/failed → idle
 *
 * reduceSpinnerState 为纯函数（可单测），useSpinnerState 在组件里订阅事件流。
 */

import type { EventStream } from '@vessel/core';
import { useEffect, useState } from 'react';
import { asTuiEvent, type TuiEvent } from '../types/events.js';

/** Spinner 三态（ADR-022 §1） */
export type SpinnerVerb = 'thinking' | 'tool' | 'idle';

/** 折叠后的事件流状态 */
export interface SpinnerState {
  verb: SpinnerVerb;
  /** tool 态的活动描述（工具名或自定义 getActivityDescription） */
  description?: string;
  /** 当前态开始时间戳 */
  startedAt?: number;
  /** 上一段思考耗时（首个 chunk 或 run 结束时归档） */
  lastThinkingMs?: number;
}

/** 纯 reducer：根据单个事件推进 spinner 状态 */
export function reduceSpinnerState(prev: SpinnerState, event: TuiEvent, now: number): SpinnerState {
  switch (event.type) {
    case 'run.started':
      return { verb: 'thinking', startedAt: now };

    case 'llm.stream.chunk':
      if (prev.verb !== 'thinking') return prev;
      return {
        verb: 'idle',
        lastThinkingMs: prev.startedAt !== undefined ? now - prev.startedAt : undefined,
      };

    case 'tool.call.started':
      return { verb: 'tool', description: event.data.tool_name, startedAt: now };

    case 'tool.call.completed':
    case 'tool.call.failed':
      return { verb: 'thinking', startedAt: now };

    case 'run.completed':
    case 'run.failed':
      return {
        verb: 'idle',
        lastThinkingMs: prev.startedAt !== undefined ? now - prev.startedAt : undefined,
      };

    default:
      return prev;
  }
}

/** 订阅事件流，实时计算 spinner 状态 */
export function useSpinnerState(events: EventStream): SpinnerState {
  const [state, setState] = useState<SpinnerState>({ verb: 'idle' });

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      setState((prev) => reduceSpinnerState(prev, asTuiEvent(rawEvent), Date.now()));
    });
    return unsubscribe;
  }, [events]);

  return state;
}
