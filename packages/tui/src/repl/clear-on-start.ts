/**
 * 进入 REPL 清屏（DECISION-021 §3.1）
 * @module @vessel/tui
 *
 * 仅 TTY 且 `ui.clearOnStart !== false` 时清可视区并把光标归位。
 * 非 TTY（管道 / headless）不清，避免污染机器可读输出。
 */

/** 清可视区 + 光标归位；不删 scrollback（用户仍可上翻） */
export const CLEAR_ON_START_SEQUENCE = '\x1b[2J\x1b[H';

export function shouldClearOnStart(isTTY: boolean, clearOnStart: boolean | undefined): boolean {
  return isTTY && clearOnStart !== false;
}

/**
 * 纯函数（副作用仅经 write 注入）：满足条件时写一次清屏序列。
 * 返回是否写入，便于守卫测试。
 */
export function maybeClearOnStart(options: {
  isTTY: boolean;
  clearOnStart: boolean | undefined;
  write: (text: string) => void;
}): boolean {
  if (!shouldClearOnStart(options.isTTY, options.clearOnStart)) return false;
  options.write(CLEAR_ON_START_SEQUENCE);
  return true;
}
