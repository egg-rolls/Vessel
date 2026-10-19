/** 侧栏模式：CSS 断点与 JS 判定共用这些边界。 */
export const DRAWER_MAX_WIDTH = 680;
export const RAIL_MAX_WIDTH = 1023;
export const EXPANDED_MIN_WIDTH = 1200;

export type NavMode = 'expanded' | 'collapsed' | 'rail' | 'drawer';

export function navModeForWidth(width: number, collapsed: boolean): NavMode {
  if (width <= DRAWER_MAX_WIDTH) return 'drawer';
  if (width <= RAIL_MAX_WIDTH) return 'rail';
  return collapsed ? 'collapsed' : 'expanded';
}

/** 无显式偏好时：< 1200 默认折叠，>= 1200 默认展开。 */
export function defaultNavCollapsed(width: number): boolean {
  return width < EXPANDED_MIN_WIDTH;
}

/** localStorage 值 -> 显式偏好；非法值视为无偏好。 */
export function parseNavCollapsed(raw: string | null | undefined): boolean | null {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}
