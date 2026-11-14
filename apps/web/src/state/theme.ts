/** 主题偏好（System / Light / Dark）：localStorage 持久化 + `data-theme`。 */
import { useUiStore } from '../stores/uiStore';

export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'vessel.theme';

/** label 由 UI 层经 i18n 提供（`appearance.theme.<id>`），这里只保留可选值。 */
export const THEMES: readonly { id: Theme }[] = [{ id: 'system' }, { id: 'light' }, { id: 'dark' }];

export function normalizeTheme(raw: string | null | undefined): Theme {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** 无存储偏好或值非法时默认 dark；显式 system/light/dark 保持原值。 */
export function initialTheme(raw: string | null | undefined): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'dark';
}

/** system → 移除属性（让 prefers-color-scheme 生效）。 */
export function themeAttribute(theme: Theme): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme;
}

/** 解析实际主题：system 跟随系统偏好，显式值原样返回。 */
export function resolvedTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/** 能挂 `data-theme` 的宿主：`document.documentElement`，或测试里的假根（不依赖 DOM lib）。 */
export type ThemeRoot = {
  dataset: Record<string, string>;
  removeAttribute: (name: string) => void;
};

/** 应用主题；幂等，可在模块加载时调用。 */
export function applyTheme(
  theme: Theme,
  root: ThemeRoot = document.documentElement as unknown as ThemeRoot,
): void {
  const attribute = themeAttribute(theme);
  if (attribute === null) root.removeAttribute('data-theme');
  else root.dataset.theme = attribute;
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): Theme {
  try {
    return initialTheme(storage.getItem(THEME_KEY));
  } catch {
    return 'dark';
  }
}

export function storeTheme(theme: Theme, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // 隐私模式/配额满：主题仍在本会话内生效，不阻塞 UI。
  }
  // **0.52：这里是 DOM 主题的唯一写者。** 之前 DOM 由 `AppShell` 的
  // `useEffect(() => applyTheme(theme), [theme])` 跟着 store 变，而挂载时它会把 store 里
  // 的值（可能还没从存储初始化成用户选择）盖到 `main.tsx` 刚写好的 `data-theme` 上 ——
  // 真机复现过「存储 light、刷新后 data-theme=dark」。把 apply 收进这一处之后，
  // 写 DOM 的只剩：`main.tsx`（首帧前按存储）、`storeTheme()`（用户显式改）、`AppShell` 自愈。
  applyTheme(theme);
  // 同步共享 store：TUI/其它面板读的是 store，不是 DOM。
  // `setState`（不是 `setTheme`）避免二次持久化。
  useUiStore.setState({ theme });
}

/** Theme preference + stable setter backed by the shared UI store. */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  return { theme, setTheme };
}
