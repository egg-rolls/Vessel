/**
 * 终端文本布局工具——纯函数
 * @module @vessel-agent/tui
 *
 * 布局必须按「终端显示列」计算，不能用 `.length` / `.slice` / `.padEnd`：
 * CJK 与 emoji 占 2 列，按字符截断会让表格错位。
 * `utils/dialog.ts` 重新导出这里的实现，保持既有 import 可用且只有一份实现。
 */

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

/** 字符串显示宽度（终端列数） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/**
 * 截断到指定显示宽度；被截断时末尾保留一个 `…`。
 * 结果宽度恒 `<= maxWidth`；`maxWidth <= 0` 返回空串。
 */
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

/**
 * 补齐到指定显示宽度（不足补空格）。
 * 超宽时先按 `truncateToWidth` 截断，保证结果宽度恒 `=== maxWidth`。
 */
export function padToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  const fitted = truncateToWidth(text, width);
  const padding = width - displayWidth(fitted);
  return padding > 0 ? `${fitted}${' '.repeat(padding)}` : fitted;
}

/**
 * 单元格适配：按对齐方式截断并补齐到固定宽度。
 * 数字列用 `right`，文本列用 `left`。
 */
export function fitCell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  const fitted = truncateToWidth(text, width);
  const padding = width - displayWidth(fitted);
  if (padding <= 0) return fitted;
  if (align === 'right') return `${' '.repeat(padding)}${fitted}`;
  return `${fitted}${' '.repeat(padding)}`;
}

/**
 * 按显示宽度换行；保留显式换行。
 * 优先在空格处断行（英文单词不拆），找不到空格时按字符断行（CJK / emoji 安全）。
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';
    let lineWidth = 0;
    let lastSpace = -1;

    for (const ch of paragraph) {
      const chWidth = charWidth(ch);
      if (lineWidth + chWidth > width) {
        if (lastSpace > 0) {
          const head = line.slice(0, lastSpace);
          const tail = line.slice(lastSpace + 1);
          lines.push(head);
          line = tail;
          lineWidth = displayWidth(line);
        } else {
          lines.push(line);
          line = '';
          lineWidth = 0;
        }
      }
      if (ch === ' ' && lineWidth === 0) continue; // 行首空格丢弃
      line += ch;
      lineWidth += chWidth;
      if (ch === ' ') lastSpace = line.length - 1;
    }

    if (line.length > 0 || lines.length === 0) lines.push(line);
  }

  return lines;
}

/**
 * 纯函数：列表行的 React key。
 * 只依赖位置——文本内容可能为空或重复（例如 /history 的连续空行），
 * 用内容/累计偏移做 key 会碰撞。
 */
export function lineKey(index: number): string {
  return `line-${index}`;
}
