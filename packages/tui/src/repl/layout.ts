/**
 * 终端高度自适应布局——纯函数
 * @module @vessel/tui
 *
 * 根据终端行数返回 live 区、流式输出、自动补全与 picker 的上限。
 * minimal / hidden 只给出空闲值；run 进行中的 live/stream 覆盖由调用方负责。
 */

export type LiveMode = 'normal' | 'compact' | 'minimal' | 'hidden';

export interface LiveLayout {
  mode: LiveMode;
  liveMaxHeight: number;
  streamMaxLines: number;
  autocompleteMax: number;
  pickerMaxRows: number;
  notice: string | null;
}

const LOW_HEIGHT_NOTICE =
  'Terminal height is low (<15 rows); live output is hidden. Resize to see streaming output.';

export function computeLiveLayout(rows: number): LiveLayout {
  const height = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));

  if (height >= 24) {
    return {
      mode: 'normal',
      liveMaxHeight: height - 12,
      streamMaxLines: Math.max(3, height - 14),
      autocompleteMax: 8,
      pickerMaxRows: 20,
      notice: null,
    };
  }

  if (height >= 20) {
    return {
      mode: 'normal',
      liveMaxHeight: height - 12,
      streamMaxLines: Math.max(3, height - 14),
      autocompleteMax: 8,
      pickerMaxRows: 15,
      notice: null,
    };
  }

  if (height >= 15) {
    return {
      mode: 'compact',
      liveMaxHeight: height - 12,
      streamMaxLines: height - 12,
      autocompleteMax: Math.max(3, height - 14),
      pickerMaxRows: 10,
      notice: null,
    };
  }

  if (height >= 11) {
    return {
      mode: 'minimal',
      liveMaxHeight: 0,
      streamMaxLines: 0,
      autocompleteMax: 3,
      pickerMaxRows: 5,
      notice: LOW_HEIGHT_NOTICE,
    };
  }

  return {
    mode: 'hidden',
    liveMaxHeight: 0,
    streamMaxLines: 0,
    autocompleteMax: 3,
    pickerMaxRows: 3,
    notice: LOW_HEIGHT_NOTICE,
  };
}
