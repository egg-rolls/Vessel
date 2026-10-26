/**
 * Runtime context messages (`role: 'user'`, `name: 'vessel:*'`) are model-only
 * context: message sources, runtime notices, subscription notices, budget
 * warnings, compaction markers. They are hidden from transcripts by default.
 *
 * Visibility is a purely local preference (localStorage
 * `vessel.web.runtimeContext`), never a gateway setting.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const RUNTIME_VISIBILITY_STORAGE_KEY = 'vessel.web.runtimeContext';

export const RUNTIME_MESSAGE_KINDS = [
  'source',
  'notice',
  'subscription',
  'limit',
  'compaction',
  'other',
] as const;

export type RuntimeMessageKind = (typeof RUNTIME_MESSAGE_KINDS)[number];

export type RuntimeVisibility = Record<RuntimeMessageKind, boolean>;

/** Ordinary users are not interrupted by model-only context. */
export const DEFAULT_RUNTIME_VISIBILITY: Readonly<RuntimeVisibility> = Object.freeze({
  source: false,
  notice: false,
  subscription: false,
  limit: false,
  compaction: false,
  other: false,
});

const PREFIX = 'vessel:';

function isKind(value: string): value is RuntimeMessageKind {
  return (RUNTIME_MESSAGE_KINDS as readonly string[]).includes(value);
}

/** `vessel:source` → `source`; unknown `vessel:*` → `other`; others → undefined. */
export function runtimeMessageKind(message: { name?: string }): RuntimeMessageKind | undefined {
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return undefined;
  const suffix = name.slice(PREFIX.length);
  return isKind(suffix) ? suffix : 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaults(): RuntimeVisibility {
  return { ...DEFAULT_RUNTIME_VISIBILITY };
}

/** Parse a stored payload; malformed JSON or non-boolean values fall back to defaults. */
export function parseRuntimeVisibility(raw: string | null | undefined): RuntimeVisibility {
  if (typeof raw !== 'string' || raw.length === 0) return defaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults();
  }
  if (!isRecord(parsed)) return defaults();
  const next = defaults();
  for (const kind of RUNTIME_MESSAGE_KINDS) {
    if (typeof parsed[kind] === 'boolean') next[kind] = parsed[kind];
  }
  return next;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

/** SSR / blocked storage: no localStorage access at all. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadRuntimeVisibility(
  storage: ReadStorage | null = browserStorage(),
): RuntimeVisibility {
  if (!storage) return defaults();
  try {
    return parseRuntimeVisibility(storage.getItem(RUNTIME_VISIBILITY_STORAGE_KEY));
  } catch {
    return defaults();
  }
}

export function saveRuntimeVisibility(
  visibility: RuntimeVisibility,
  storage: WriteStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RUNTIME_VISIBILITY_STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Private mode / quota: keep the in-memory value for this session.
  }
}

function targetKind(target: RuntimeMessageKind | string): RuntimeMessageKind | undefined {
  if (isKind(target)) return target;
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

// Shared store: Settings and transcripts subscribe to the same snapshot, so a
// toggle applies without a reload. Persisted on every change.
let snapshot: RuntimeVisibility | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): RuntimeVisibility {
  if (snapshot === null) snapshot = loadRuntimeVisibility();
  return snapshot;
}

function getServerSnapshot(): RuntimeVisibility {
  return DEFAULT_RUNTIME_VISIBILITY as RuntimeVisibility;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(next: RuntimeVisibility): void {
  snapshot = next;
  saveRuntimeVisibility(next);
  for (const listener of [...listeners]) listener();
}

export function setRuntimeKind(kind: RuntimeMessageKind, visible: boolean): void {
  update({ ...getSnapshot(), [kind]: visible });
}

export function setAllRuntimeKinds(visible: boolean): void {
  update(
    Object.fromEntries(RUNTIME_MESSAGE_KINDS.map((kind) => [kind, visible])) as RuntimeVisibility,
  );
}

/** React binding: read on mount, persist on change, share across components. */
export function useRuntimeVisibility(): {
  visibility: RuntimeVisibility;
  setKind: (kind: RuntimeMessageKind, visible: boolean) => void;
  setAll: (visible: boolean) => void;
  isVisible: (target: RuntimeMessageKind | string) => boolean;
} {
  const visibility = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isVisible = useCallback(
    (target: RuntimeMessageKind | string) => isRuntimeMessageVisible(visibility, target),
    [visibility],
  );
  return {
    visibility,
    setKind: setRuntimeKind,
    setAll: setAllRuntimeKinds,
    isVisible,
  };
}
