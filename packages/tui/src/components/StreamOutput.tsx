/**
 * 流式输出组件（0.18 结构化）
 * @module @vessel-agent/tui
 *
 * 订阅 EventStream，把事件折叠成 `UiItem[]`（纯 reducer 在 `repl/project/ui-item.ts`）。
 * live 区只渲染当前轮；run 终态把整轮 items 交给父组件归档到 `<Static>`。
 *
 * 不再把一轮压成一个字符串：工具参数 / 状态 / 耗时 / error envelope /
 * permission / 子 agent / notice / run 摘要全部保留为结构化 item。
 */

import type { EventStream } from '@vessel-agent/core';
import { Box, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import {
  createUiProjection,
  reduceUiProjection,
  resetUiProjection,
  type UiItem,
  type UiProjectionState,
} from '../repl/project/ui-item.js';
import { asTuiEvent, type TuiEvent } from '../types/events.js';
import { SpinnerWithVerb } from './SpinnerWithVerb.js';
import { useSpinnerState } from './StateTracker.js';
import { UiItemView } from './UiItemView.js';

/** live 区最多保留的 item 数（防止 live frame 无限增高） */
export const DEFAULT_MAX_ITEMS = 8;
/** 单个文本 item 最多保留的行数 */
export const DEFAULT_MAX_TEXT_LINES = 12;

export interface LimitUiItemsOptions {
  maxItems?: number;
  maxLines?: number;
}

/** 纯函数：按行取文本尾部，最多保留 `maxLines` 行（截断时前置折叠提示） */
export function tailLines(text: string, maxLines: number): string {
  const trimmed = text.trim();
  if (!trimmed || maxLines <= 0) return maxLines <= 0 ? '' : trimmed;
  const lines = trimmed.split('\n');
  if (lines.length <= maxLines) return trimmed;
  return `${t('tool.truncated')}\n${lines.slice(-maxLines).join('\n')}`;
}

function truncateItemText(item: UiItem, maxLines: number): UiItem {
  switch (item.kind) {
    case 'assistant':
    case 'user':
      return { ...item, text: tailLines(item.text, maxLines) };
    case 'command':
      return {
        ...item,
        text: tailLines(item.text, maxLines),
        ...(item.output !== undefined ? { output: tailLines(item.output, maxLines) } : {}),
      };
    default:
      return item;
  }
}

/** 纯函数：只保留最后 maxItems 项，并对长文本做按行截断 */
export function limitUiItems(items: UiItem[], options: LimitUiItemsOptions = {}): UiItem[] {
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_TEXT_LINES);
  return items.slice(-maxItems).map((item) => truncateItemText(item, maxLines));
}

/** 纯函数：把当前轮的投影状态重置为下一轮初始态（保留 id 序号） */
export function resetStreamProjection(state: UiProjectionState): UiProjectionState {
  return resetUiProjection(state);
}

/** 本轮流过滤状态（0.27：所有 body 的 `run.*` 进同一条事件流，live 区只跟本轮流） */
export interface StreamRunGateState {
  /** 本轮流 run_id；`undefined` = 未锁定（或本轮已终态释放） */
  runId: string | undefined;
  /** 当前锁定是否由 session_id 命中（否则是「首个 run」的兜底锁定） */
  matchedSession: boolean;
}

/** 单事件的过滤决策 */
export interface StreamRunGate extends StreamRunGateState {
  /** 该事件是否折叠进 live 投影 */
  feed: boolean;
  /** 折叠前是否重置本轮投影（新的本轮流开始） */
  reset: boolean;
  /** 折叠后是否为本轮终态（交给 onComplete 并释放锁定） */
  release: boolean;
}

/**
 * 纯函数：多 body 并发下的 live 区隔离。
 *
 * - 首个 `run.started` / `run.resumed` 锁定本轮流 `run_id` 并 reset；
 * - 给出 `sessionId`（本轮投递的 body）时优先锁定命中的 run：先锁到的若是别的 body，
 *   同一时刻命中 session 的 run 到达会**接管**锁并 reset；
 * - 锁定后只有 `run_id` 相同的事件进投影，其它 body 的 run 直接丢弃；
 * - 终态 `run.completed|failed|cancelled` 仅当 run_id 命中本轮流时结算并释放锁；
 * - 事件缺 `session_id` 时不做判定，退回「首个 run」语义，避免整屏无输出。
 */
export function gateStreamEvent(
  state: StreamRunGateState,
  event: TuiEvent,
  sessionId?: string,
): StreamRunGate {
  if (event.type === 'run.started' || event.type === 'run.resumed') {
    const eventSession = readSessionId(event.data);
    const matches = sessionId !== undefined && eventSession === sessionId;

    if (state.runId === undefined) {
      // 有期望 session 时只锁该 body 的 run；事件缺 session_id 无法判定，退回「首个 run」。
      if (sessionId !== undefined && eventSession !== undefined && !matches) {
        return { ...state, feed: false, reset: false, release: false };
      }
      return {
        runId: event.run_id,
        matchedSession: matches,
        feed: true,
        reset: true,
        release: false,
      };
    }
    if (event.run_id === state.runId) {
      return { ...state, feed: true, reset: false, release: false };
    }
    // 兜底锁到别的 body：命中本轮 session 的 run 到达时接管。
    if (!state.matchedSession && matches) {
      return {
        runId: event.run_id,
        matchedSession: true,
        feed: true,
        reset: true,
        release: false,
      };
    }
    return { ...state, feed: false, reset: false, release: false };
  }

  if (state.runId !== undefined && event.run_id !== state.runId) {
    return { ...state, feed: false, reset: false, release: false };
  }

  const release =
    state.runId !== undefined &&
    (event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled');
  return {
    runId: release ? undefined : state.runId,
    matchedSession: release ? false : state.matchedSession,
    feed: true,
    reset: false,
    release,
  };
}

/** `run.*` 载荷里的 session_id（body id）；缺失返回 undefined。 */
function readSessionId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface StreamOutputProps {
  events: EventStream;
  clearSignal?: number;
  /** 外部按终端分档传入的文本行上限；缺省时按终端高度推导 */
  maxLines?: number;
  /** Ctrl+O 展开态：工具结果保留更多行 */
  expanded?: boolean;
  /** 递增触发：把当前完整 items 刷入 scrollback（Ctrl+O） */
  expandSignal?: number;
  /** 展开刷新回调（父组件追加到 Static history） */
  onFlush?: (items: UiItem[]) => void;
  /** 当前轮 run 结束时回调，传回整轮结构化 items 与终态原因 */
  onComplete?: (items: UiItem[], reason: 'completed' | 'failed' | 'cancelled') => void;
  /** Tool 卡展开/折叠由 Ctrl+O 控制；保留参数以兼容旧接线 */
  detailMode?: 'hidden' | 'collapsed' | 'expanded';
  /** 本轮投递的 body/session id（多 body 并发时用于锁定本轮流 run） */
  sessionId?: string;
}

export function StreamOutput({
  events,
  clearSignal,
  maxLines,
  expanded = false,
  expandSignal,
  onFlush,
  onComplete,
  detailMode = 'collapsed',
  sessionId,
}: StreamOutputProps) {
  const { stdout } = useStdout();
  const [projection, setProjection] = useState<UiProjectionState>(() => createUiProjection());
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const lastExpandSignalRef = useRef(0);
  /** 本轮流 run 过滤状态（多 body 并发时隔离其它 body 的事件） */
  const gateRef = useRef<StreamRunGateState>({ runId: undefined, matchedSession: false });
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const spinnerState = useSpinnerState(events, sessionId);

  const apply = useCallback((next: UiProjectionState) => {
    projectionRef.current = next;
    setProjection(next);
  }, []);

  const reset = useCallback(() => {
    apply(resetStreamProjection(projectionRef.current));
  }, [apply]);

  // 清屏信号：丢弃当前轮 live items
  useEffect(() => {
    if (clearSignal !== undefined && clearSignal > 0) reset();
  }, [clearSignal, reset]);

  // Ctrl+O：把当前完整 items 刷入 scrollback；running 工具留在 live 区继续更新。
  useEffect(() => {
    if (expandSignal === undefined || expandSignal <= lastExpandSignalRef.current) return;
    lastExpandSignalRef.current = expandSignal;
    const items = projectionRef.current.items;
    if (items.length > 0) onFlushRef.current?.(items);
    const remaining = items.filter(
      (item) => item.kind === 'tool' && item.view.status === 'running',
    );
    apply({ ...projectionRef.current, items: remaining });
  }, [expandSignal, apply]);

  useEffect(() => {
    const unsubscribe = events.subscribe((rawEvent) => {
      const event = asTuiEvent(rawEvent);
      // 0.27：所有 body 的 `run.*` 进同一条事件流（多 body 并发）。live 区只跟本轮流，
      // 由 gateStreamEvent 按 run_id（+ 本轮 session_id）锁定并丢弃其它 body 的事件。
      const gate = gateStreamEvent(gateRef.current, event, sessionIdRef.current);
      gateRef.current = { runId: gate.runId, matchedSession: gate.matchedSession };
      if (!gate.feed) return;
      if (gate.reset) apply(resetStreamProjection(projectionRef.current));

      const next = reduceUiProjection(projectionRef.current, event);
      apply(next);

      if (!gate.release) return;
      if (event.type === 'run.completed') {
        onCompleteRef.current?.(next.items, 'completed');
        apply(resetStreamProjection(next));
      } else if (event.type === 'run.failed') {
        onCompleteRef.current?.(next.items, 'failed');
        apply(resetStreamProjection(next));
      } else if (event.type === 'run.cancelled') {
        onCompleteRef.current?.(next.items, 'cancelled');
        apply(resetStreamProjection(next));
      }
    });

    return unsubscribe;
  }, [events, apply]);

  const maxTextLines = maxLines ?? Math.max(4, (stdout.rows ?? 24) - 14);
  const visibleItems = useMemo(
    () => limitUiItems(projection.items, { maxItems: DEFAULT_MAX_ITEMS, maxLines: maxTextLines }),
    [projection.items, maxTextLines],
  );

  const hasContent = visibleItems.length > 0;
  const isActive = spinnerState.verb !== 'idle';
  const columns = stdout.columns ?? 80;
  // detailMode 在 live 区保留语义：hidden 时只渲染非工具项。
  const renderedItems =
    detailMode === 'hidden' ? visibleItems.filter((item) => item.kind !== 'tool') : visibleItems;

  return (
    <Box flexDirection="column">
      {renderedItems.map((item) => (
        <Box key={item.id} flexDirection="column">
          <UiItemView
            item={item}
            columns={columns}
            expanded={expanded || detailMode === 'expanded'}
          />
        </Box>
      ))}

      {isActive && !hasContent && (
        <SpinnerWithVerb
          verb={spinnerState.verb}
          description={spinnerState.description}
          {...(spinnerState.startedAt !== undefined ? { startedAt: spinnerState.startedAt } : {})}
        />
      )}
    </Box>
  );
}
