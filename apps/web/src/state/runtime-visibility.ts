/**
 * Runtime context messages (`role: 'user'`, `name: 'vessel:*'`) are model-only
 * context: message sources, runtime notices, subscription notices, budget
 * warnings, compaction markers. They are hidden from transcripts by default.
 *
 * Visibility is a purely local preference held by `uiStore` (localStorage
 * `vessel.web.runtimeContext`), never a gateway setting. The public hook and
 * helper signatures stay unchanged so transcript call sites do not change.
 */
import { useCallback } from 'react';
import {
  DEFAULT_RUNTIME_VISIBILITY,
  isRuntimeMessageKind,
  loadRuntimeVisibility,
  parseRuntimeVisibility,
  RUNTIME_MESSAGE_KINDS,
  RUNTIME_VISIBILITY_STORAGE_KEY,
  type RuntimeMessageKind,
  type RuntimeVisibility,
  saveRuntimeVisibility,
  useUiStore,
} from '../stores/uiStore';

export type { RuntimeMessageKind, RuntimeVisibility };
export {
  DEFAULT_RUNTIME_VISIBILITY,
  loadRuntimeVisibility,
  parseRuntimeVisibility,
  RUNTIME_MESSAGE_KINDS,
  RUNTIME_VISIBILITY_STORAGE_KEY,
  saveRuntimeVisibility,
};

const PREFIX = 'vessel:';

/** `vessel:source` → `source`; unknown `vessel:*` → `other`; others → undefined. */
export function runtimeMessageKind(message: { name?: string }): RuntimeMessageKind | undefined {
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return undefined;
  const suffix = name.slice(PREFIX.length);
  return isRuntimeMessageKind(suffix) ? suffix : 'other';
}

function targetKind(target: RuntimeMessageKind | string): RuntimeMessageKind | undefined {
  if (isRuntimeMessageKind(target)) return target;
  return runtimeMessageKind({ name: target });
}

/** Unknown / non-runtime messages are always visible; runtime kinds follow the setting. */
export function isRuntimeMessageVisible(
  visibility: RuntimeVisibility,
  target: RuntimeMessageKind | string,
): boolean {
  const kind = targetKind(target);
  return kind === undefined || visibility[kind];
}

export function setRuntimeKind(kind: RuntimeMessageKind, visible: boolean): void {
  useUiStore.getState().setRuntimeKind(kind, visible);
}

export function setAllRuntimeKinds(visible: boolean): void {
  useUiStore.getState().setAllRuntimeKinds(visible);
}

/**
 * React binding: Settings and transcripts subscribe to the same store slice, so
 * a toggle applies without a reload and persists on change.
 */
export function useRuntimeVisibility(): {
  visibility: RuntimeVisibility;
  setKind: (kind: RuntimeMessageKind, visible: boolean) => void;
  setAll: (visible: boolean) => void;
  isVisible: (target: RuntimeMessageKind | string) => boolean;
} {
  const visibility = useUiStore((state) => state.runtimeVisibility);
  const setKind = useUiStore((state) => state.setRuntimeKind);
  const setAll = useUiStore((state) => state.setAllRuntimeKinds);
  const isVisible = useCallback(
    (target: RuntimeMessageKind | string) => isRuntimeMessageVisible(visibility, target),
    [visibility],
  );
  return { visibility, setKind, setAll, isVisible };
}
