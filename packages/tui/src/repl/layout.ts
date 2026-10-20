/**
 * 终端高度自适应布局——纯函数
 * @module @vessel-agent/tui
 *
 * 根据终端行数返回 live 区、流式输出、自动补全与 picker 的上限。
 * minimal / hidden 只给出空闲值；run 进行中的 live/stream 覆盖由调用方负责。
 *
 * 行容量必须扣除真实渲染的 chrome（状态栏、边框、margin、标题、表头、提示），
 * 否则 24 行终端上的 overlay 会把输入行/状态栏挤出屏幕。
 */

import { t } from '../i18n/index.js';

export type LiveMode = 'normal' | 'compact' | 'minimal' | 'hidden';

/** 视图行容量按 picker 或通用命令视图分别计算（当前 chrome 相同，保留区分） */
export type ViewRowKind = 'picker' | 'view';

export interface LiveLayout {
  mode: LiveMode;
  liveMaxHeight: number;
  streamMaxLines: number;
  autocompleteMax: number;
  /** 会话 picker 的数据行容量（已扣除 chrome 与状态栏） */
  pickerMaxRows: number;
  /** 通用命令视图的数据行容量（已扣除 chrome 与状态栏） */
  viewMaxRows: number;
  /** 底部快捷键提示占用行数（0/1） */
  hintRows: number;
  notice: string | null;
}

/** 状态栏 = PanelFrame 上边框 + 内容 1 行 + 下边框，固定占 3 行 */
export const STATUS_BAR_ROWS = 3;

/** 运行态下栏与上栏同构：PanelFrame 3 行；显示时吸收原底部 hint 行（净增 2） */
export const BOTTOM_BAR_ROWS = 3;

export interface ChromeRows {
  /** 上栏可见行数；缺省 3（保持旧调用行为） */
  topRows?: number;
  /** 下栏可见行数；缺省 0（旧调用没有下栏；显示时传 3） */
  bottomRows?: number;
}

function chromeOf(options: ChromeRows | undefined): { top: number; bottom: number } {
  const top = Math.max(
    0,
    Math.floor(
      Number.isFinite(options?.topRows) ? (options?.topRows ?? STATUS_BAR_ROWS) : STATUS_BAR_ROWS,
    ),
  );
  const bottom = Math.max(
    0,
    Math.floor(Number.isFinite(options?.bottomRows) ? (options?.bottomRows ?? 0) : 0),
  );
  return { top, bottom };
}

/**
 * 纯函数：下栏默认显隐（自动规则）。
 * rows >= 18 且非 minimal/hidden 时默认显示；手动切换优先由调用方处理。
 */
export function defaultBottomBarVisible(rows: number): boolean {
  const height = normalizeRows(rows);
  const mode = modeForHeight(height);
  return height >= 18 && mode !== 'minimal' && mode !== 'hidden';
}

/**
 * normal / compact 每屏 chrome：
 * marginY 2 + 边框 2 + 标题 2（行 + marginBottom）+ 表头 1 + 按键提示 2（marginTop + 行）。
 * 窗口指示折进标题行，不单独占行。
 */
const NORMAL_CHROME_ROWS: Record<ViewRowKind, number> = {
  picker: 9,
  view: 9,
};

/**
 * minimal chrome：无 margin、无表头，只保留边框 2 + 标题 2 + 按键提示 2。
 */
const MINIMAL_CHROME_ROWS: Record<ViewRowKind, number> = {
  picker: 6,
  view: 6,
};

/**
 * normal/compact 数据行下限/上限。
 * 容量随 `height - chrome - status` 增长（宽屏不再固定 20 行），
 * 但保留下限避免矮终端抖动、上限避免超大终端一次渲染过多行。
 */
const NORMAL_ROW_MIN = 20;
const NORMAL_ROW_MAX = 60;
/**
 * minimal 数据行封顶（设计 §4.2：3–5 行）。
 * 状态栏加框后占 3 行；封顶取 3，保证 14 行（minimal）→15 行（compact）容量不回落。
 */
const MINIMAL_ROW_CAP = 3;

function normalizeRows(rows: number): number {
  return Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
}

function modeForHeight(height: number): LiveMode {
  if (height >= 20) return 'normal';
  if (height >= 15) return 'compact';
  if (height >= 11) return 'minimal';
  return 'hidden';
}

/**
 * 纯函数：数据行容量 = 终端行数 - 状态栏 - chrome，再按模式封顶。
 * hidden 不渲染数据行，返回 0。
 */
export function viewCapacity(
  rows: number,
  mode: LiveMode,
  kind: ViewRowKind = 'view',
  options: Pick<ChromeRows, 'topRows'> = {},
): number {
  if (mode === 'hidden') return 0;
  const height = normalizeRows(rows);
  const { top } = chromeOf(options);
  const chrome = mode === 'minimal' ? MINIMAL_CHROME_ROWS[kind] : NORMAL_CHROME_ROWS[kind];
  const available = height - top - chrome;
  const cap =
    mode === 'minimal'
      ? MINIMAL_ROW_CAP
      : Math.min(NORMAL_ROW_MAX, Math.max(NORMAL_ROW_MIN, available));
  return Math.max(1, Math.min(cap, available));
}

/** 纯函数：chrome + 上栏占用的行数（测试用于断言 chrome + 容量 ≤ 终端行数） */
export function viewChromeRows(
  mode: LiveMode,
  kind: ViewRowKind = 'view',
  options: Pick<ChromeRows, 'topRows'> = {},
): number {
  if (mode === 'hidden') return 0;
  const { top } = chromeOf(options);
  const chrome = mode === 'minimal' ? MINIMAL_CHROME_ROWS[kind] : NORMAL_CHROME_ROWS[kind];
  return chrome + top;
}

/** 内联确认提示预留行数（marginTop + 单行文案 + 按键行；文案强制 truncate） */
export const CONFIRM_PROMPT_ROWS = 3;
/** 重命名输入预留行数（marginTop + 一行输入） */
export const RENAME_PROMPT_ROWS = 2;
/** 临时 notice 预留行数（marginTop + 一行） */
export const NOTICE_ROWS = 2;

export type OverlayInputMode = 'browse' | 'filter' | 'rename' | 'confirm' | 'form';

/**
 * 纯函数：当前交互模式额外的行占用。
 * 确认/重命名/notice 会追加在数据行之后，必须从容量里扣掉，避免把底栏顶出屏幕。
 */
export function viewExtraRows(mode: OverlayInputMode, hasNotice = false): number {
  const prompt =
    mode === 'confirm' ? CONFIRM_PROMPT_ROWS : mode === 'rename' ? RENAME_PROMPT_ROWS : 0;
  return prompt + (hasNotice ? NOTICE_ROWS : 0);
}

/** 底部快捷键提示只在 >=18 行显示 */
export function showsQuickHint(rows: number): boolean {
  return normalizeRows(rows) >= 18;
}

/**
 * 纯函数：队列预览行数（含 PanelFrame 上下边框 2 行）。
 * rows<12 只显示一行；否则标题 + 最多 3 条 + 「…and N more」。
 */
export function queuePreviewRows(queuedCount: number, rows: number): number {
  if (!Number.isFinite(queuedCount) || queuedCount <= 0) return 0;
  const frameRows = 2;
  if (normalizeRows(rows) < 12) return frameRows + 1;
  return frameRows + 1 + Math.min(3, Math.floor(queuedCount)) + (queuedCount > 3 ? 1 : 0);
}

/**
 * 纯函数：按终端行数计算 live 预算。
 * `queueRows`、上/下栏与底部 hint 行都从 live 区扣除，保证输入行不被挤掉。
 * 下栏显示时吸收 hint 行（`hintRows = 0`），所以净增 `BOTTOM_BAR_ROWS - 1 = 2` 行。
 */
export function computeLiveLayout(
  rows: number,
  queueRows = 0,
  options: ChromeRows = {},
): LiveLayout {
  const height = normalizeRows(rows);
  const mode = modeForHeight(height);
  const low = mode === 'minimal' || mode === 'hidden';
  const { top, bottom } = chromeOf(options);
  const queue = Math.max(0, Math.floor(Number.isFinite(queueRows) ? queueRows : 0));
  const hintRows = showsQuickHint(height) && bottom === 0 ? 1 : 0;
  // base 9 = 输入行 / 运行态提示 / 边距等（不含状态栏）；12/14 的旧常量即 base + STATUS_BAR_ROWS。
  const base = 9;
  const extra = queue + hintRows + top + bottom;

  return {
    mode,
    liveMaxHeight: low ? 0 : Math.max(1, height - base - extra),
    streamMaxLines: low
      ? 0
      : mode === 'compact'
        ? Math.max(1, height - base - extra)
        : Math.max(3, height - base - 2 - extra),
    autocompleteMax: mode === 'normal' ? 8 : low ? 3 : Math.max(3, height - base - 2 - extra),
    pickerMaxRows: viewCapacity(height, mode, 'picker', { topRows: top }),
    viewMaxRows: viewCapacity(height, mode, 'view', { topRows: top }),
    hintRows,
    notice: low ? t('layout.lowHeight') : null,
  };
}
