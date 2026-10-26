/**
 * Effect runner for store-backed resources: runs immediately when enabled,
 * then polls; pauses while the page is hidden. The action is read through a
 * ref so inline callbacks do not re-trigger the effect on every render.
 *
 * `deps` must stay JSON-serialisable primitives (same contract as useResource).
 */
import { useEffect, useRef } from 'react';

export interface UsePolledActionOptions {
  enabled?: boolean;
  pollMs?: number;
  pauseWhenHidden?: boolean;
  deps?: readonly (string | number | boolean | null | undefined)[];
}

export function usePolledAction(action: () => void, options: UsePolledActionOptions = {}): void {
  const { enabled = true, pollMs, pauseWhenHidden = true, deps = [] } = options;
  const actionRef = useRef(action);
  actionRef.current = action;
  const depKey = JSON.stringify(deps);

  // biome-ignore lint/correctness/useExhaustiveDependencies: action via ref; depKey serialises deps
  useEffect(() => {
    if (!enabled) return;
    actionRef.current();
    if (pollMs === undefined || pollMs <= 0) return;
    const pollingPaused = pauseWhenHidden && document.visibilityState === 'hidden';
    let timer: number | undefined = pollingPaused
      ? undefined
      : window.setInterval(() => actionRef.current(), pollMs);
    if (!pauseWhenHidden) {
      return () => window.clearInterval(timer);
    }
    const onVisibility = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      actionRef.current();
      timer = window.setInterval(() => actionRef.current(), pollMs);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [enabled, pollMs, pauseWhenHidden, depKey]);
}
