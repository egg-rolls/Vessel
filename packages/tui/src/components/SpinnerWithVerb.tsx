/**
 * 指示器（ADR-022 + R0 §4.1）
 * @module @vessel/tui
 *
 * - thinking：`⠹ thinking… · 6s`（动词 2500ms 轮换）
 * - tool：`⠹ Running: ... · 6s`
 * - idle：`○ idle`
 *
 * 思考态最少显示 2 秒，避免状态瞬变导致 UI 闪烁（ADR-022 §3）。
 * 风格由 `VESSEL_INDICATOR` 覆盖；无效值回退 unicode。
 */

import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme.js';
import { formatDuration } from '../utils/display-labels.js';
import {
  indicatorFrame,
  indicatorInterval,
  resolveIndicatorStyle,
  thinkingVerb,
} from './indicator.js';
import type { SpinnerVerb } from './StateTracker.js';

/** 思考态最少显示时长（ms） */
const MIN_THINKING_DISPLAY_MS = 2000;

export interface SpinnerWithVerbProps {
  verb: SpinnerVerb;
  /** tool 态的活动描述（如 "Reading src/foo.ts"） */
  description?: string;
  /** 当前态开始时间；提供时行尾显示时长 */
  startedAt?: number;
}

/** 纯函数：离开当前可见态前还需等待的毫秒数（0 = 无需等待） */
export function minVerbDelayMs(visibleVerb: SpinnerVerb, elapsedMs: number, minMs: number): number {
  if (visibleVerb !== 'thinking') return 0;
  if (elapsedMs >= minMs) return 0;
  return minMs - elapsedMs;
}

export function SpinnerWithVerb({ verb, description, startedAt }: SpinnerWithVerbProps) {
  const [visibleVerb, setVisibleVerb] = useState<SpinnerVerb>(verb);
  const verbSince = useRef(Date.now());
  const style = useRef(resolveIndicatorStyle(process.env.VESSEL_INDICATOR)).current;
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (verb === visibleVerb) return;
    const elapsed = Date.now() - verbSince.current;
    const delay = minVerbDelayMs(visibleVerb, elapsed, MIN_THINKING_DISPLAY_MS);
    if (delay > 0) {
      const timer = setTimeout(() => {
        verbSince.current = Date.now();
        setVisibleVerb(verb);
      }, delay);
      return () => clearTimeout(timer);
    }
    verbSince.current = Date.now();
    setVisibleVerb(verb);
    return;
  }, [verb, visibleVerb]);

  useEffect(() => {
    if (visibleVerb === 'idle') return;
    const timer = setInterval(() => setTick((value) => value + 1), indicatorInterval(style));
    return () => clearInterval(timer);
  }, [visibleVerb, style]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the 1s tick when a new turn starts
  useEffect(() => {
    if (visibleVerb === 'idle') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visibleVerb, startedAt]);

  if (visibleVerb === 'idle') {
    return (
      <Box>
        <Text color={theme.faint}>○ idle</Text>
      </Box>
    );
  }

  const elapsedMs = startedAt !== undefined ? Math.max(0, now - startedAt) : undefined;
  const elapsed =
    elapsedMs !== undefined && elapsedMs >= 1000 ? ` · ${formatDuration(elapsedMs)}` : '';
  const frame = indicatorFrame(style, tick);

  if (visibleVerb === 'tool') {
    return (
      <Box>
        <Text color={theme.info}>{frame}</Text>
        <Text color={theme.info}>
          {' '}
          {description ?? 'working…'}
          {elapsed}
        </Text>
      </Box>
    );
  }

  const word = elapsedMs !== undefined ? thinkingVerb(elapsedMs) : 'thinking';
  return (
    <Box>
      <Text color={theme.brand}>{frame}</Text>
      <Text color={theme.muted}>
        {' '}
        {word}…{elapsed}
      </Text>
    </Box>
  );
}
