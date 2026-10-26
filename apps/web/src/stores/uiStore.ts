/**
 * Shared UI preference store: theme, display form values and runtime-context
 * visibility.
 *
 * This is the single in-memory source for local-only UI preferences. It keeps
 * the storage keys/formats that predate the store:
 * - `vessel.theme`: plain theme id (`system` | `light` | `dark`)
 * - `vessel.web.runtimeContext`: JSON runtime-kind -> boolean map
 * - `vessel.web.display`: JSON `config key -> string` cache of the display
 *   form (the gateway config stays the source of truth for cross-device state)
 *
 * All reads are SSR / private-mode / malformed-storage safe: any inaccessible
 * or invalid value falls back to defaults. Writes swallow quota/private-mode
 * errors so a preference still applies for the current session.
 */
import { create } from 'zustand';
import { displaySettingFor } from '../state/display-settings';
import type { ErrorVisibility } from '../state/error-visibility';
import { initialTheme, storeTheme, THEME_KEY, type Theme } from '../state/theme';
import type { Verbosity } from '../state/visibility';

/** Local cache of `Settings → Display`; `''` means "not configured". */
export type DisplayValues = Record<string, string>;

export const DISPLAY_VALUES_STORAGE_KEY = 'vessel.web.display';

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

/**
 * Parse the local display cache. Unknown keys and values that do not match the
 * whitelist are dropped; `''` is kept so an optimistic revert can restore it.
 */
export function parseDisplayValues(raw: string | null | undefined): DisplayValues {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const next: DisplayValues = {};
  for (const [key, value] of Object.entries(parsed)) {
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

export function loadDisplayValues(storage: ReadStorage | null = browserStorage()): DisplayValues {
  if (!storage) return {};
  try {
    return parseDisplayValues(storage.getItem(DISPLAY_VALUES_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveDisplayValues(
  display: DisplayValues,
  storage: WriteStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(DISPLAY_VALUES_STORAGE_KEY, JSON.stringify(display));
  } catch {
    // Private mode / quota: keep the in-memory value for this session.
  }
}

/** `ui.verbosity` mirrored as a typed field; invalid/absent → `normal`. */
export function verbosityOf(display: DisplayValues): Verbosity {
  const raw = display['ui.verbosity'];
  return raw === 'minimal' || raw === 'debug' ? raw : 'normal';
}

/** `ui.errorLevel` mirrored as a typed field; invalid/absent → `user`. */
export function errorLevelOf(display: DisplayValues): ErrorVisibility {
  return display['ui.errorLevel'] === 'all' ? 'all' : 'user';
}

export interface UiPreferences {
  theme: Theme;
  display: DisplayValues;
  runtimeVisibility: RuntimeVisibility;
  verbosity: Verbosity;
  errorLevel: ErrorVisibility;
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
  const display = loadDisplayValues(storage);
  return {
    theme: readTheme(storage),
    display,
    runtimeVisibility: loadRuntimeVisibility(storage),
    verbosity: verbosityOf(display),
    errorLevel: errorLevelOf(display),
  };
}

interface UiStoreActions {
  setTheme: (theme: Theme) => void;
  setDisplay: (patch: DisplayValues) => void;
  setRuntimeKind: (kind: RuntimeMessageKind, visible: boolean) => void;
  setAllRuntimeKinds: (visible: boolean) => void;
  setVerbosity: (verbosity: Verbosity) => void;
  setErrorLevel: (level: ErrorVisibility) => void;
}

export type UiStoreState = UiPreferences & UiStoreActions;

/** Keep only known settings with values the server can persist. */
function sanitizeDisplayPatch(patch: DisplayValues): DisplayValues {
  const next: DisplayValues = {};
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

  setDisplay: (patch) => {
    const display = { ...get().display, ...sanitizeDisplayPatch(patch) };
    set({
      display,
      verbosity: verbosityOf(display),
      errorLevel: errorLevelOf(display),
    });
    saveDisplayValues(display);
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

  setVerbosity: (verbosity) => {
    get().setDisplay({ 'ui.verbosity': verbosity });
  },

  setErrorLevel: (level) => {
    get().setDisplay({ 'ui.errorLevel': level });
  },
}));

/** Display form values + setter, shared by Settings and other consumers. */
export function useDisplaySettings(): {
  display: DisplayValues;
  setDisplay: (patch: DisplayValues) => void;
} {
  const display = useUiStore((state) => state.display);
  const setDisplay = useUiStore((state) => state.setDisplay);
  return { display, setDisplay };
}
