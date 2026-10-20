/**
 * 弹窗布局工具——纯函数
 *
 * 终端宽度不可控：弹窗如果按内容自然撑开，超过终端宽度的部分会被终端级换行，
 * 导致边框错位。这里统一按 `useStdout().columns` 计算封顶宽度，并给长文本
 * 提供按显示宽度截断的工具（CJK / emoji 按 2 列计）。
 *
 * 宽字符工具的唯一实现在 `utils/text-layout.ts`；本文件重新导出以保持既有 import。
 */

export {
  charWidth,
  displayWidth,
  fitCell,
  padToWidth,
  truncateToWidth,
  wrapToWidth,
} from './text-layout.js';

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
