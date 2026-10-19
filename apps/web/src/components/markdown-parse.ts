/**
 * 轻量 Markdown 解析（0.6.1 P1，无重依赖）。
 *
 * 只覆盖聊天里最常见的块级/内联语法：段落、标题、fenced code、表格、
 * 有序/无序列表、引用、分隔线；内联 code、链接、粗体、斜体。
 * 永远不输出原始 HTML；链接由 `isSafeHref` 过滤（拒绝 javascript:/data:）。
 */

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' };

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string };

const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s+(.*)$/;
const BLOCKQUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line)) return true;
  if (LIST_ITEM.test(line) || BLOCKQUOTE.test(line)) return true;
  const next = lines[index + 1];
  return line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next);
}

/** 解析块级 Markdown；容忍未闭合的 fenced code（流式尾部）。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (
          current.trim().startsWith(marker.slice(0, 3)) &&
          current.trim().length === marker.length
        ) {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      blocks.push({
        type: 'code',
        ...(lang ? { lang } : {}),
        text: body.join('\n'),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        text: (heading[2] ?? '').trim(),
      });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    const next = lines[index + 1];
    if (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const row = lines[index] ?? '';
        if (row.trim() === '' || !row.includes('|')) break;
        rows.push(splitTableRow(row));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    if (quote) {
      const parts: string[] = [];
      while (index < lines.length) {
        const current = BLOCKQUOTE.exec(lines[index] ?? '');
        if (!current) break;
        parts.push(current[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'blockquote', text: parts.join('\n') });
      continue;
    }

    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const ordered = /^\d/.test(listItem[1] ?? '');
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = LIST_ITEM.exec(current);
        if (match) {
          items.push(match[2] ?? '');
          index += 1;
          continue;
        }
        // 缩进续行并入上一项；空行结束列表。
        if (current.trim() === '') break;
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push((lines[index] ?? '').trimEnd());
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    } else {
      // 防御：startsBlock 判定为 true 但没有分支消费时，至少前进一行。
      index += 1;
    }
  }

  return blocks;
}

/** 仅允许 http(s)/mailto/锚点/相对路径；拒绝 javascript:/data:/协议相对 URL。 */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (value.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return /^(https?|mailto):/i.test(value);
  }
  return true;
}

const INLINE = /(`[^`\n]+`|\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\n]+)\*)/g;

/** 解析内联 Markdown；粗体/斜体内部不再嵌套解析（聊天场景足够）。 */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push({ type: 'text', text: source.slice(lastIndex, index) });
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const label = match[2] ?? '';
      const href = match[3] ?? '';
      if (isSafeHref(href)) nodes.push({ type: 'link', text: label, href });
      else nodes.push({ type: 'text', text: label });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'strong', text: match[4] ?? '' });
    } else {
      nodes.push({ type: 'em', text: match[5] ?? '' });
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < source.length) {
    nodes.push({ type: 'text', text: source.slice(lastIndex) });
  }
  return nodes;
}
