/** 全局快捷键匹配（纯函数，可单测）。 */

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

export interface EditableTargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
}

/** input/textarea/select/contenteditable 内不劫持普通按键。 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as EditableTargetLike;
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Ctrl+K / Cmd+K 打开命令面板（Alt 组合保留给浏览器/系统）。 */
export function isPaletteShortcut(event: KeyEventLike): boolean {
  if (event.altKey) return false;
  return (event.ctrlKey === true || event.metaKey === true) && event.key.toLowerCase() === 'k';
}

/** 非输入框内按 `/` 打开命令模式。 */
export function isSlashPaletteShortcut(event: KeyEventLike): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === '/' && !isEditableTarget(event.target);
}

export function isEscape(event: KeyEventLike): boolean {
  return event.key === 'Escape';
}
