/**
 * Shared local-only UI preferences: theme and the optimistic overlay for
 * Settings → Display.
 *
 * Server-owned config is **not** cached here: configStore.config is the only
 * source for ui.* values. displayPending holds just the keys whose write is in
 * flight (or awaiting confirmation) so the form can show the chosen value
 * without keeping a second full server snapshot.
 *
 * 0.50：运行期上下文（vessel:*）可见性不再存本地，改为服务端
 * ui.showInternalEvents（见 state/runtime-visibility.ts）；旧的
 * vessel.web.runtimeContext 键直接丢弃。本文件只剩 vessel.theme 一个持久化键。
 *
 * All reads are SSR / private-mode / malformed-storage safe: any inaccessible
 * or invalid value falls back to defaults. Writes swallow quota/private-mode
 * errors so a preference still applies for the current session.
 */
import { create } from 'zustand';
import type { DisplayPendingEntry } from '../state/display-settings';
import { CORE_SETTINGS } from '../state/settings-registry';
import { initialTheme, storeTheme, THEME_KEY, type Theme } from '../state/theme';

/** Sparse optimistic overlay for settings writes; '' means "not configured". */
export type DisplayPending = Record<string, string>;
/** 泛化名（vscode-settings-design §3.6）；旧名 DisplayPending 保留过渡。 */
export type SettingsPending = DisplayPending;

type ReadStorage = Pick<Storage, 'getItem'>;

/** SSR / blocked storage: no localStorage access at all. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readTheme(storage: ReadStorage | null): Theme {
  if (!storage) return 'dark';
  try {
    return initialTheme(storage.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

export interface UiPreferences {
  theme: Theme;
  /** Sparse overlay for setting keys being saved; never persisted. */
  settingsPending: SettingsPending;
}

/** Hydration entry: safe for SSR and malformed/blocked storage. */
export function loadUiPreferences(storage: ReadStorage | null = browserStorage()): UiPreferences {
  return {
    theme: readTheme(storage),
    settingsPending: {},
  };
}

interface UiStoreActions {
  setTheme: (theme: Theme) => void;
  /** Merge an optimistic overlay entry (server write pending confirmation). */
  setSettingsPending: (patch: SettingsPending) => void;
  /** Drop overlay entries only while they still hold the expected value. */
  clearSettingsPending: (entries: readonly DisplayPendingEntry[]) => void;
  /** @deprecated 旧名过渡（DisplaySettingsView 双轨期）；同 setSettingsPending。 */
  setDisplayPending: (patch: DisplayPending) => void;
  /** @deprecated 旧名过渡；同 clearSettingsPending。 */
  clearDisplayPending: (entries: readonly DisplayPendingEntry[]) => void;
}

export type UiStoreState = UiPreferences & UiStoreActions;

/**
 * Keep only known settings with values the server can persist.
 * 泛化：按注册表核心定义校验 boolean/enum/number/string（原仅 boolean/enum，
 * number/string 的乐观 overlay 之前被静默丢弃——q-empty-response 键受益）。
 */
/** 插件设置 pending 键形状：<pluginId>.<key>（值校验权威在 serve 方法层）。 */
const PLUGIN_PENDING_KEY = /^[a-z0-9][a-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function sanitizeSettingsPatch(patch: SettingsPending): SettingsPending {
  const next: SettingsPending = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') continue;
    const setting = CORE_SETTINGS.find((def) => def.key === key);
    if (!setting) {
      // S4：插件键按 id（pluginId.key）入 overlay；形状合法即收，类型由服务端校验。
      if (PLUGIN_PENDING_KEY.test(key) && value !== '') next[key] = value;
      continue;
    }
    if (value === '') {
      next[key] = value;
      continue;
    }
    if (setting.type === 'boolean') {
      if (value === 'true' || value === 'false') next[key] = value;
    } else if (setting.type === 'enum') {
      if (setting.options?.includes(value) === true) next[key] = value;
    } else if (setting.type === 'number') {
      const num = Number(value);
      const min = setting.min ?? Number.NEGATIVE_INFINITY;
      const max = setting.max ?? Number.POSITIVE_INFINITY;
      if (Number.isInteger(num) && num >= min && num <= max) next[key] = value;
    } else if (setting.type === 'string') {
      next[key] = value;
    }
  }
  return next;
}

export const useUiStore = create<UiStoreState>()((set, get) => ({
  ...loadUiPreferences(),

  setTheme: (theme) => {
    // storeTheme 写入既有键/格式并同步本 store，AppearanceView 因此只有一条路径。
    const storage = browserStorage();
    if (storage) storeTheme(theme, storage);
    else set({ theme });
  },

  setSettingsPending: (patch) => {
    const next = sanitizeSettingsPatch(patch);
    if (Object.keys(next).length === 0) return;
    set({ settingsPending: { ...get().settingsPending, ...next } });
  },

  clearSettingsPending: (entries) => {
    const current = get().settingsPending;
    if (entries.length === 0) return;
    const next = { ...current };
    let changed = false;
    for (const { key, value } of entries) {
      // 值已被更新的选择覆盖（快速 A→B）时保留 B。
      if (next[key] !== value) continue;
      delete next[key];
      changed = true;
    }
    if (changed) set({ settingsPending: next });
  },

  // 旧名别名（双轨期 DisplaySettingsView 消费；S6 收敛删除）。
  setDisplayPending: (patch) => get().setSettingsPending(patch),
  clearDisplayPending: (entries) => get().clearSettingsPending(entries),
}));
