/**
 * Spinner 三态组件（ADR-022 §1/§3）
 * @module @vessel/tui
 *
 * - thinking：`🤔 Thinking...`
 * - tool：`📖 {activity description}`
 * - idle：`✻ Idle`
 *
 * 思考态最少显示 2 秒，避免状态瞬变导致 UI 闪烁（ADR-022 §3）。
 */

import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { SpinnerVerb } from './StateTracker.js';

/** 思考态最少显示时长（ms） */
const MIN_THINKING_DISPLAY_MS = 2000;

export interface SpinnerWithVerbProps {
  verb: SpinnerVerb;
  /** tool 态的活动描述（如 "Reading src/foo.ts"） */
  description?: string;
}

/** 纯函数：离开当前可见态前还需等待的毫秒数（0 = 无需等待） */
export function minVerbDelayMs(visibleVerb: SpinnerVerb, elapsedMs: number, minMs: number): number {
  if (visibleVerb !== 'thinking') return 0;
  if (elapsedMs >= minMs) return 0;
  return minMs - elapsedMs;
}

export function SpinnerWithVerb({ verb, description }: SpinnerWithVerbProps) {
  const [visibleVerb, setVisibleVerb] = useState<SpinnerVerb>(verb);
  const verbSince = useRef(Date.now());

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

  if (visibleVerb === 'idle') {
    return (
      <Box>
        <Text color="gray">✻ Idle</Text>
      </Box>
    );
  }

  if (visibleVerb === 'tool') {
    return (
      <Box>
        <Spinner type="dots" />
        <Text color="blue"> 📖 {description ?? 'Working...'}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Spinner type="dots" />
      <Text color="gray"> 🤔 Thinking...</Text>
    </Box>
  );
}
