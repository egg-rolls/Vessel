/**
 * 头像首字母（纯函数）。
 *
 * 规则：
 * - 取第一个**字**（码点），不是第一个 UTF-16 单元 —— 否则 CJK / emoji 名会被劈开；
 * - 拉丁字母大写；其它文字原样（`张` → `张`，`ada` → `A`）；
 * - 空 / 全是空白 ⇒ `?`（宁可显示占位，也不要空圆圈）。
 *
 * 放在单独模块里：浮层组件不该为了这个规则带上 React。
 *
 * @module web/domains/auth/avatar-initial
 */

export function avatarInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  const first = Array.from(trimmed)[0];
  if (first === undefined) return '?';
  // `ß`.toUpperCase() → `SS`：只取结果的第一个字，宽度才稳定。
  return Array.from(first.toUpperCase())[0] ?? '?';
}
