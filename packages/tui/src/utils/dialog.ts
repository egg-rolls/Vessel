/**
 * 弹窗布局工具——纯函数
 *
 * 终端宽度不可控：弹窗如果按内容自然撑开，超过终端宽度的部分会被终端级换行，
 * 导致边框错位。这里统一按 `useStdout().columns` 计算封顶宽度，并给长文本
 * 提供按显示宽度截断的工具（CJK / emoji 按 2 列计）。
 */

/** 弹窗最大宽度（含边框与内边距） */
export const DIALOG_MAX_WIDTH = 72;
/** 左右预留列数，避免贴边与滚动条 */
export const DIALOG_HORIZONTAL_MARGIN = 4;
/** 拿不到终端宽度时的回退值 */
export const FALLBACK_COLUMNS = 80;

/**
 * 弹窗宽度：`min(columns - 4, 72)`。
 * 终端异常窄（< 5 列）时兜底为 1，避免出现 0 / 负数宽度。
 */
export function computeDialogWidth(columns: number | undefined): number {
  const cols =
    columns !== undefined && Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : FALLBACK_COLUMNS;
  return Math.max(1, Math.min(cols - DIALOG_HORIZONTAL_MARGIN, DIALOG_MAX_WIDTH));
}

/** 单字符显示宽度（CJK / 全角 / emoji 按 2 列计） */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff);
  return wide ? 2 : 1;
}

/** 字符串显示宽度 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 截断到指定显示宽度，被截断时末尾保留一个 … */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;

  let out = '';
  let width = 0;
  for (const ch of text) {
    const next = charWidth(ch);
    if (width + next > maxWidth - 1) break;
    out += ch;
    width += next;
  }
  return `${out}…`;
}
