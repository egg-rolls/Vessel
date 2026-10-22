import type { CSSProperties, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewportWidth } from './useViewportWidth';

export type PaneKey = 'nav' | 'sessions' | 'chat';

export interface PaneLayout {
  nav: number;
  sessions: number;
  chat: number;
}

export interface PaneResizeApi {
  layout: PaneLayout;
  shellRef: RefObject<HTMLDivElement | null>;
  preview: (pane: PaneKey, value: number) => void;
  commit: (pane: PaneKey, value: number) => void;
  reset: (pane: PaneKey) => void;
  disabled: (pane: PaneKey) => boolean;
}

export const PANE_LAYOUT_KEY = 'vessel.ui.layout.v1';

export const PANE_LIMITS: Record<PaneKey, { min: number; max: number; default: number }> = {
  nav: { min: 200, max: 360, default: 256 },
  sessions: { min: 220, max: 420, default: 280 },
  chat: { min: 560, max: 1200, default: 860 },
};

export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  nav: PANE_LIMITS.nav.default,
  sessions: PANE_LIMITS.sessions.default,
  chat: PANE_LIMITS.chat.default,
};

/** 每个 pane 在 shell 上对应的 CSS 变量；chat 同时驱动内容列、dock 与手柄位置。 */
function paneCssEntries(pane: PaneKey, value: number): readonly [string, string][] {
  if (pane === 'chat') {
    return [
      ['--chat-content-w', `${value}px`],
      ['--dock-width', `${value}px`],
      ['--chat-half-w', `${value / 2}px`],
    ];
  }
  return [[pane === 'nav' ? '--nav-w' : '--sessions-w', `${value}px`]];
}

/** 与 `navModeForWidth` 的抽屉边界一致。 */
const MOBILE_MAX_WIDTH = 680;

/** 对话区左右 padding 预算；用于把 chat 夹进可视宽度。 */
const PANE_CHROME_W = 48;

export function clampPane(pane: PaneKey, value: number): number {
  const limits = PANE_LIMITS[pane];
  if (!Number.isFinite(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** chat 左右各扩 deltaX（右缘 1:1 跟手）；nav / sessions 只有一条边，1:1。 */
export function applyPaneResize(pane: PaneKey, start: number, deltaX: number): number {
  const scale = pane === 'chat' ? 2 : 1;
  return clampPane(pane, start + scale * deltaX);
}

export function parsePaneLayout(raw: string | null | undefined): PaneLayout {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return { ...DEFAULT_PANE_LAYOUT };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_PANE_LAYOUT };
  }
  const record = parsed as Record<string, unknown>;
  const read = (pane: PaneKey): number => {
    const value = record[pane];
    if (typeof value !== 'number' || !Number.isFinite(value)) return PANE_LIMITS[pane].default;
    return clampPane(pane, value);
  };
  return { nav: read('nav'), sessions: read('sessions'), chat: read('chat') };
}

export function paneCssVars(layout: PaneLayout): CSSProperties {
  return {
    '--nav-w': `${layout.nav}px`,
    '--sessions-w': `${layout.sessions}px`,
    '--chat-content-w': `${layout.chat}px`,
    '--dock-width': `${layout.chat}px`,
    '--chat-half-w': `${layout.chat / 2}px`,
  } as CSSProperties;
}

function readStoredLayout(): PaneLayout {
  try {
    return parsePaneLayout(localStorage.getItem(PANE_LAYOUT_KEY));
  } catch {
    // 隐私模式 / 配额满：使用默认布局。
    return { ...DEFAULT_PANE_LAYOUT };
  }
}

function writeStoredLayout(layout: PaneLayout): void {
  try {
    localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 隐私模式 / 配额满：本次会话内的布局仍然生效。
  }
}

function isCoarsePointer(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function usePaneResize(): PaneResizeApi {
  const viewportWidth = useViewportWidth();
  const [layout, setLayout] = useState<PaneLayout>(readStoredLayout);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pendingRef = useRef(new Map<PaneKey, number>());
  const frameRef = useRef<number | null>(null);

  const compact = viewportWidth <= MOBILE_MAX_WIDTH || isCoarsePointer();

  const flushPreview = useCallback(() => {
    frameRef.current = null;
    const shell = shellRef.current;
    const pending = pendingRef.current;
    if (shell) {
      for (const [pane, value] of pending) {
        for (const [name, cssValue] of paneCssEntries(pane, value)) {
          shell.style.setProperty(name, cssValue);
        }
      }
    }
    pending.clear();
  }, []);

  // 卸载时取消未落的帧，避免写已卸载节点。
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingRef.current.clear();
    };
  }, []);

  const preview = useCallback(
    (pane: PaneKey, value: number) => {
      pendingRef.current.set(pane, clampPane(pane, value));
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flushPreview);
      }
    },
    [flushPreview],
  );

  const commit = useCallback((pane: PaneKey, value: number) => {
    const next = { ...layoutRef.current, [pane]: clampPane(pane, value) };
    layoutRef.current = next;
    // 该 pane 的旧预览值不能在新一帧把 state 的结果盖回去。
    pendingRef.current.delete(pane);
    const shell = shellRef.current;
    if (shell) {
      for (const [name, cssValue] of paneCssEntries(pane, next[pane])) {
        shell.style.setProperty(name, cssValue);
      }
    }
    setLayout(next);
    writeStoredLayout(next);
  }, []);

  const reset = useCallback(
    (pane: PaneKey) => {
      commit(pane, PANE_LIMITS[pane].default);
    },
    [commit],
  );

  const disabled = useCallback(
    (pane: PaneKey) => compact || viewportWidth <= PANE_LIMITS[pane].min,
    [compact, viewportWidth],
  );

  // 移动端 / 触屏只“显示”默认布局；持久化值保留，变宽后自动恢复。
  // 桌面端把 chat 夹到当前可用对话区，避免居中手柄落到可视区外；只影响显示值。
  const effectiveLayout = useMemo(() => {
    if (compact) return DEFAULT_PANE_LAYOUT;
    const available = viewportWidth - layout.nav - layout.sessions - PANE_CHROME_W;
    return { ...layout, chat: clampPane('chat', Math.min(layout.chat, available)) };
  }, [compact, viewportWidth, layout]);

  return useMemo(
    () => ({
      layout: effectiveLayout,
      shellRef,
      preview,
      commit,
      reset,
      disabled,
    }),
    [effectiveLayout, preview, commit, reset, disabled],
  );
}
