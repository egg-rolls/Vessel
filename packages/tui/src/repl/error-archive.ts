/**
 * 失败归档：把一轮失败收敛成**一条**历史项。
 * @module @vessel/tui
 *
 * 0.10 R1-11：失败信息只渲染一次。
 * StreamOutput 在 run.failed 时调用 `buildFailureArchive` 归档；
 * 父组件仅在事件未到达时用 `failureFallbackAction` 补一条，避免双份。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import { t } from '../i18n/index.js';

/** 归档失败文本的行数上限 */
export const FAILURE_MAX_LINES = 8;
/** 归档失败文本的字符上限 */
export const FAILURE_MAX_CHARS = 500;

export interface FailureArchive {
  /** 展示用文本（可能截断） */
  text: string;
  /** 截断前的完整文本；未截断时缺省 */
  fullText?: string;
  tone: 'error';
  markdown: false;
  truncated: boolean;
}

/**
 * 纯函数：超过 8 行或 500 字符时保留尾部（错误信息通常在末尾），
 * 前置一行 Ctrl+O 展开提示。
 */
export function truncateFailureText(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { text: '', truncated: false };

  const lines = trimmed.split('\n');
  let clipped = trimmed;
  let truncated = false;

  if (lines.length > FAILURE_MAX_LINES) {
    clipped = lines.slice(-FAILURE_MAX_LINES).join('\n');
    truncated = true;
  }
  if (clipped.length > FAILURE_MAX_CHARS) {
    clipped = clipped.slice(-FAILURE_MAX_CHARS);
    truncated = true;
  }
  if (!truncated) return { text: trimmed, truncated: false };

  return { text: `${t('error.truncatedHint')}\n${clipped}`, truncated: true };
}

/** 纯函数：正文 + 分类错误 → 单条失败归档（纯文本、danger tone）。 */
export function buildFailureArchive(transcript: string, error: unknown): FailureArchive {
  const formatted = formatClassifiedError(classifyError(error));
  const body = [transcript.trim(), formatted].filter((part) => part.length > 0).join('\n\n');
  const { text, truncated } = truncateFailureText(body);
  return {
    text,
    ...(truncated ? { fullText: body } : {}),
    tone: 'error',
    markdown: false,
    truncated,
  };
}

export type FailureHistoryAction = {
  type: 'appendHistory';
  line: string;
  tone: 'error';
  fullText?: string;
};

/**
 * 纯函数：StreamOutput 已归档时返回 null；否则返回唯一一条 append action。
 * 调用方用 ref 记录 StreamOutput 是否已归档，保证失败只产生一条历史项。
 */
export function failureFallbackAction(
  archived: boolean,
  error: unknown,
): FailureHistoryAction | null {
  if (archived) return null;
  const archive = buildFailureArchive('', error);
  return {
    type: 'appendHistory',
    line: archive.text,
    tone: 'error',
    ...(archive.fullText !== undefined ? { fullText: archive.fullText } : {}),
  };
}

/** 截断项的 TextViewer 标题 */
export function failureViewerTitle(): string {
  return t('error.viewerTitle');
}
