/**
 * Shared local-only UI preferences: theme, runtime-context visibility and the
 * optimistic overlay for `Settings → Display`.
 *
 * Server-owned config is **not** cached here: `configStore.config` is the only
 * source for `ui.*` values. `displayPending` holds just the keys whose write is
 * in flight (or awaiting confirmation) so the form can show the chosen value
 * without keeping a second full server snapshot.
 *
 * Persisted local keys:
 * - `vessel.theme`: plain theme id (`system` | `light` | `dark`)
 * - `vessel.web.runtimeContext`: JSON runtime-kind -> boolean map
 *
 * All reads are SSR / private-mode / malformed-storage safe: any inaccessible
 * or invalid value falls back to defaults. Writes swallow quota/private-mode
 * errors so a preference still applies for the current session.
 */
import { create } from 'zustand';
import { type DisplayPendingEntry, displaySettingFor } from '../state/display-settings';
import { initialTheme, storeTheme, THEME_KEY, type Theme } from '../state/theme';

/** Sparse optimistic overlay for `Settings → Display`; `''` means "not configured". */
export type DisplayPending = Record<string, string>;

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

export const RUNTIME_VISIBILITY_STORAGE_KEY = 'vessel.web.runtimeContext';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SSR / blocked storage: no localStorage access at all. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function runtimeDefaults(): RuntimeVisibility {
  return { ...DEFAULT_RUNTIME_VISIBILITY };
}

export function isRuntimeMessageKind(value: string): value is RuntimeMessageKind {
  return (RUNTIME_MESSAGE_KINDS as readonly string[]).includes(value);
}

/** Parse a stored payload; malformed JSON or non-boolean values fall back to defaults. */
export function parseRuntimeVisibility(raw: string | null | undefined): RuntimeVisibility {
  if (typeof raw !== 'string' || raw.length === 0) return runtimeDefaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return runtimeDefaults();
  }
  if (!isRecord(parsed)) return runtimeDefaults();
  const next = runtimeDefaults();
  for (const kind of RUNTIME_MESSAGE_KINDS) {
    if (typeof parsed[kind] === 'boolean') next[kind] = parsed[kind];
  }
  return next;
}

export function loadRuntimeVisibility(
  storage: ReadStorage | null = browserStorage(),
): RuntimeVisibility {
  if (!storage) return runtimeDefaults();
  try {
    return parseRuntimeVisibility(storage.getItem(RUNTIME_VISIBILITY_STORAGE_KEY));
  } catch {
    return runtimeDefaults();
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

export interface UiPreferences {
  theme: Theme;
  runtimeVisibility: RuntimeVisibility;
  /** Sparse overlay for display keys being saved; never persisted. */
  displayPending: DisplayPending;
}

function readTheme(storage: ReadStorage | null): Theme {
  if (!storage) return 'dark';
  try {
    return initialTheme(storage.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

/** Hydration entry: safe for SSR and malformed/blocked storage. */
export function loadUiPreferences(storage: ReadStorage | null = browserStorage()): UiPreferences {
  return {
    theme: readTheme(storage),
    runtimeVisibility: loadRuntimeVisibility(storage),
    displayPending: {},
  };
}

interface UiStoreActions {
  setTheme: (theme: Theme) => void;
  /** Merge an optimistic overlay entry (server write pending confirmation). */
  setDisplayPending: (patch: DisplayPending) => void;
  /** Drop overlay entries only while they still hold the expected value. */
  clearDisplayPending: (entries: readonly DisplayPendingEntry[]) => void;
  setRuntimeKind: (kind: RuntimeMessageKind, visible: boolean) => void;
  setAllRuntimeKinds: (visible: boolean) => void;
}

export type UiStoreState = UiPreferences & UiStoreActions;

/** Keep only known settings with values the server can persist. */
function sanitizeDisplayPatch(patch: DisplayPending): DisplayPending {
  const next: DisplayPending = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') continue;
    const setting = displaySettingFor(key);
    if (!setting) continue;
    if (value === '') {
      next[key] = value;
      continue;
    }
    if (setting.type === 'boolean') {
      if (value === 'true' || value === 'false') next[key] = value;
    } else if (setting.options?.includes(value) === true) {
      next[key] = value;
    }
  }
  return next;
}

export const useUiStore = create<UiStoreState>()((set, get) => ({
  ...loadUiPreferences(),

  setTheme: (theme) => {
    // `storeTheme` writes the existing key/format and updates this store, so
    // AppearanceView (which calls it directly) stays a single source too.
    const storage = browserStorage();
    if (storage) storeTheme(theme, storage);
    else set({ theme });
  },

  setDisplayPending: (patch) => {
    const next = sanitizeDisplayPatch(patch);
    if (Object.keys(next).length === 0) return;
    set({ displayPending: { ...get().displayPending, ...next } });
  },

  clearDisplayPending: (entries) => {
    const current = get().displayPending;
    if (entries.length === 0) return;
    const next = { ...current };
    let changed = false;
    for (const { key, value } of entries) {
      // 值已被更新的选择覆盖（快速 A→B）时保留 B。
      if (next[key] !== value) continue;
      delete next[key];
      changed = true;
    }
    if (changed) set({ displayPending: next });
  },

  setRuntimeKind: (kind, visible) => {
    if (!isRuntimeMessageKind(kind)) return;
    const runtimeVisibility = { ...get().runtimeVisibility, [kind]: visible === true };
    set({ runtimeVisibility });
    saveRuntimeVisibility(runtimeVisibility);
  },

  setAllRuntimeKinds: (visible) => {
    const shown = visible === true;
    const runtimeVisibility = Object.fromEntries(
      RUNTIME_MESSAGE_KINDS.map((kind) => [kind, shown]),
    ) as RuntimeVisibility;
    set({ runtimeVisibility });
    saveRuntimeVisibility(runtimeVisibility);
  },
}));
