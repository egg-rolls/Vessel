/**
 * @vessel-agent/doc-subscription - 无依赖 unified diff
 * @module @vessel-agent/doc-subscription/diff
 *
 * 单 hunk 的行级 diff：按 `\n` 切分、去掉行尾 `\r`（仅用于展示），
 * 裁剪公共前后缀，每侧保留 3 行上下文。不调用 git / shell，不引第三方依赖。
 */

/** diff 计算选项 */
export interface UnifiedDiffOptions {
  /** 文本字节上限 */
  maxBytes: number;
  /** 行数上限（含 hunk header） */
  maxLines: number;
}

/** diff 结果 */
export interface UnifiedDiffResult {
  /** unified diff 文本；无变化时为空串 */
  text: string;
  /** 文本行数（含 hunk header） */
  lines: number;
  /** UTF-8 字节数 */
  bytes: number;
  /** 超过 maxBytes 或 maxLines */
  truncated: boolean;
}

/** 每侧上下文行数 */
const CONTEXT_LINES = 3;

/**
 * 按 `\n` 切分并去掉行尾 `\r`；末尾换行产生的空元素丢弃。
 * 空串 = 0 行；`"a\nb\n"` = 2 行。
 */
export function splitDisplayLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 计算 unified diff（单 hunk） */
export function unifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions,
): UnifiedDiffResult {
  const oldLines = splitDisplayLines(oldText);
  const newLines = splitDisplayLines(newText);

  // 公共前缀
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  // 公共后缀（不与前缀重叠）
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix === oldLines.length && prefix === newLines.length) {
    return { text: '', lines: 0, bytes: 0, truncated: false };
  }

  const oldChangeStart = prefix;
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeStart = prefix;
  const newChangeEnd = newLines.length - suffix;

  const hunkOldStart = Math.max(0, prefix - CONTEXT_LINES);
  const hunkOldEnd = Math.min(oldLines.length, oldChangeEnd + CONTEXT_LINES);
  const hunkNewStart = Math.max(0, prefix - CONTEXT_LINES);
  const hunkNewEnd = Math.min(newLines.length, newChangeEnd + CONTEXT_LINES);

  const oldCount = hunkOldEnd - hunkOldStart;
  const newCount = hunkNewEnd - hunkNewStart;
  // 计数为 0 时起点写“插入点”（0 基），与 unified diff 约定一致
  const oldStart = oldCount === 0 ? hunkOldStart : hunkOldStart + 1;
  const newStart = newCount === 0 ? hunkNewStart : hunkNewStart + 1;

  const body: string[] = [];
  for (const line of oldLines.slice(hunkOldStart, oldChangeStart)) body.push(` ${line}`);
  for (const line of oldLines.slice(oldChangeStart, oldChangeEnd)) body.push(`-${line}`);
  for (const line of newLines.slice(newChangeStart, newChangeEnd)) body.push(`+${line}`);
  for (const line of oldLines.slice(oldChangeEnd, hunkOldEnd)) body.push(` ${line}`);

  const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body];
  const text = lines.join('\n');
  const bytes = Buffer.byteLength(text, 'utf-8');
  return {
    text,
    lines: lines.length,
    bytes,
    truncated: bytes > options.maxBytes || lines.length > options.maxLines,
  };
}
