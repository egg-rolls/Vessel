/**
 * 行级 diff（edit 工具结果展示）
 * @module @vessel/tui
 *
 * LCS 行级比较；输出带 old/new 行号。超大输入退化为整块删除+新增，
 * 避免 O(n*m) 在超长 old_string 上耗尽内存。
 */

export type DiffKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  /** 旧文件行号（1-based；add 行没有） */
  oldLine?: number;
  /** 新文件行号（1-based；del 行没有） */
  newLine?: number;
  text: string;
}

/** 超过该规模不再做 LCS（n*m 上限） */
const LCS_CELL_LIMIT = 1_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** 纯函数：旧文本 -> 新文本的行级 diff（行号从 1 开始） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = splitLines(oldText);
  const after = splitLines(newText);

  if (before.length * after.length > LCS_CELL_LIMIT) {
    return [
      ...before.map((text, index): DiffLine => ({ kind: 'del', oldLine: index + 1, text })),
      ...after.map((text, index): DiffLine => ({ kind: 'add', newLine: index + 1, text })),
    ];
  }

  // dp[i][j] = before[i..] 与 after[j..] 的 LCS 长度
  const rows = before.length;
  const cols = after.length;
  const dp: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    if (!row || !next) continue;
    for (let j = cols - 1; j >= 0; j--) {
      row[j] =
        before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: before[i] ?? '' });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: 'del', oldLine: i + 1, text: before[i] ?? '' });
      i++;
    } else {
      lines.push({ kind: 'add', newLine: j + 1, text: after[j] ?? '' });
      j++;
    }
  }
  while (i < rows) {
    lines.push({ kind: 'del', oldLine: i + 1, text: before[i] ?? '' });
    i++;
  }
  while (j < cols) {
    lines.push({ kind: 'add', newLine: j + 1, text: after[j] ?? '' });
    j++;
  }
  return lines;
}

export type DisplayDiffLine = DiffLine | { kind: 'gap' };

export interface CondenseDiffOptions {
  /** 变更处保留的上下文行数（默认 2） */
  context?: number;
  /** 最多展示的行数（默认 40；超出时截断并追加 gap） */
  maxLines?: number;
}

/**
 * 纯函数：折叠大段未变更上下文，只保留变更附近的 context 行。
 * 没有变更时返回空数组（调用方回退到普通结果文本）。
 */
export function condenseDiff(
  lines: DiffLine[],
  options: CondenseDiffOptions = {},
): DisplayDiffLine[] {
  if (!lines.some((line) => line.kind !== 'context')) return [];

  const context = Math.max(0, options.context ?? 2);
  const maxLines = Math.max(1, options.maxLines ?? 40);
  const keep = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.kind === 'context') continue;
    for (let offset = index - context; offset <= index + context; offset++) {
      if (offset >= 0 && offset < lines.length) keep.add(offset);
    }
  }

  const result: DisplayDiffLine[] = [];
  let last = -1;
  for (let index = 0; index < lines.length; index++) {
    if (!keep.has(index)) continue;
    if (last === -1 && index > 0) result.push({ kind: 'gap' });
    if (last !== -1 && index !== last + 1) result.push({ kind: 'gap' });
    const line = lines[index];
    if (line) result.push(line);
    last = index;
    if (result.length >= maxLines) break;
  }
  // 末尾还有未展示的上下文时也要标记，否则用户会以为 diff 到此结束。
  if (last !== -1 && last < lines.length - 1) result.push({ kind: 'gap' });
  return result;
}
