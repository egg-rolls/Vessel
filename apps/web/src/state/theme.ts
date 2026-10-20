/** 主题偏好（System / Light / Dark）：localStorage 持久化 + `data-theme`。 */
export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'vessel.theme';

export const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

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

/** 应用主题；幂等，可在模块加载时调用。 */
export function applyTheme(
  theme: Theme,
  root: Pick<HTMLElement, 'dataset' | 'removeAttribute'> = document.documentElement,
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
}
