import { parseNavCollapsed } from './layout';

export const NAV_COLLAPSED_KEY = 'vessel.nav.collapsed';

export function readNavPreference(): boolean | null {
  try {
    return parseNavCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY));
  } catch {
    return null;
  }
}

export function writeNavPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // 隐私模式/配额满：折叠仍在本会话内生效。
  }
}
