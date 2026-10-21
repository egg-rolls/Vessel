// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown 行是位置性的，整段文本变化即整体重渲染
/**
 * 轻量 Markdown 渲染（流式安全，0.18 平坦化）
 * @module @vessel-agent/tui
 *
 * 解析是纯函数，组件只负责映射为 Ink 节点。
 * 0.18：标题不显示 `#`；代码块不显示 ``` 围栏（左侧 `│` 槽 + 语言标签）；
 * 补表格（按 displayWidth 对齐，CJK 安全）、分隔线、嵌套列表与源序号；
 * 强调只有成对且符合 flanking 规则时才样式化——**不删除字面 `*` / `_`**
 * （`2*3*4` 仍然是 `2*3*4`）。
 */

import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { theme } from '../theme.js';
import { displayWidth, fitCell } from '../utils/text-layout.js';

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string };

export type TableAlign = 'left' | 'right' | 'center';

export interface TableBlock {
  type: 'table';
  header: string[];
  align: TableAlign[];
  rows: string[][];
}

export interface ListItemBlock {
  indent: number;
  text: string;
  /** 源标记：无序 `•`，有序保留源序号（如 `3.`） */
  marker: string;
}

export type MarkdownBlock =
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItemBlock[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'paragraph'; lines: string[] }
  | TableBlock
  | { type: 'rule' };

const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/;
const INLINE_CODE_PATTERN = /`([^`]+)`/;

function isPunctuation(ch: string): boolean {
  return /[!-/:-@[-`{-~]/.test(ch);
}

/** 纯函数：成对强调才样式化；不成对/词内标记保留字面字符 */
export function parseEmphasis(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    if (char !== '*' && char !== '_') {
      buffer += char;
      index++;
      continue;
    }

    const marker = char;
    const doubled = text[index + 1] === marker;
    const markerWidth = doubled ? 2 : 1;
    const before = index > 0 ? (text[index - 1] ?? '') : '';
    const after = text[index + markerWidth] ?? '';
    // 左 flanking：opener 前是行首/空白/标点，后不是空白
    const openerOk =
      (before === '' || /\s/.test(before) || isPunctuation(before)) &&
      after !== '' &&
      !/\s/.test(after);

    if (openerOk) {
      const close = text.indexOf(marker.repeat(markerWidth), index + markerWidth);
      if (close > index + markerWidth) {
        const content = text.slice(index + markerWidth, close);
        const afterClose = text[close + markerWidth] ?? '';
        const beforeClose = text[close - 1] ?? '';
        // 右 flanking：closer 前不是空白，后是行尾/空白/标点
        const closerOk =
          beforeClose !== '' &&
          !/\s/.test(beforeClose) &&
          (afterClose === '' || /\s/.test(afterClose) || isPunctuation(afterClose));
        if (closerOk) {
          flush();
          tokens.push({ type: doubled ? 'bold' : 'italic', text: content });
          index = close + markerWidth;
          continue;
        }
      }
    }

    buffer += marker.repeat(markerWidth);
    index += markerWidth;
  }

  flush();
  return tokens;
}

/** 纯函数：解析行内 markdown（链接 / 行内代码 / 成对强调 / 其余文本） */
export function parseInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;

  while (rest.length > 0) {
    const link = LINK_PATTERN.exec(rest);
    const code = INLINE_CODE_PATTERN.exec(rest);
    const linkIndex = link?.index ?? Number.POSITIVE_INFINITY;
    const codeIndex = code?.index ?? Number.POSITIVE_INFINITY;
    const next = Math.min(linkIndex, codeIndex);
    if (!Number.isFinite(next)) {
      tokens.push(...parseEmphasis(rest));
      break;
    }
    if (next > 0) tokens.push(...parseEmphasis(rest.slice(0, next)));
    if (link && next === linkIndex) {
      tokens.push({ type: 'link', text: link[1] ?? '', href: link[2] ?? '' });
      rest = rest.slice(next + (link[0]?.length ?? 0));
    } else if (code) {
      tokens.push({ type: 'code', text: code[1] ?? '' });
      rest = rest.slice(next + (code[0]?.length ?? 0));
    }
  }

  return tokens.filter((token) => token.type !== 'text' || token.text.length > 0);
}

/** 纯文本化（行内语法全部剥离，链接保留 URL；不成对的 `*`/`_` 原样保留） */
export function stripInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .map((token) => {
      if (token.type === 'link') {
        return token.text === token.href ? token.href : `${token.text} (${token.href})`;
      }
      return token.text;
    })
    .join('');
}

function leadingSpaces(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === ' ') count++;
    else if (char === '\t') count += 2;
    else break;
  }
  return count;
}

/** 表格行拆分（去掉首尾 `|`；`\|` 视为字面竖线） */
export function splitTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

const RULE_PATTERN = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** 纯函数：Markdown 文本 -> 展示块 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trimStart().startsWith('```')) {
      const fence = line.trimStart().slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        code.push(lines[index] ?? '');
        index++;
      }
      // 未闭合 fence 也消费到文末（流式安全）
      if (index < lines.length) index++;
      blocks.push({ type: 'code', lang: fence, lines: code });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? '',
      });
      index++;
      continue;
    }

    if (RULE_PATTERN.test(line)) {
      blocks.push({ type: 'rule' });
      index++;
      continue;
    }

    // 表格：当前行含 `|`，下一行是分隔行
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? '')
    ) {
      const header = splitTableRow(line);
      const separator = splitTableRow(lines[index + 1] ?? '');
      const align = separator.map(tableAlign);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trim() === '' || !current.includes('|')) break;
        rows.push(splitTableRow(current));
        index++;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index++;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }

    const listMatch = LIST_PATTERN.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2] ?? '');
      const startMatch = /^(\d+)[.)]$/.exec(listMatch[2] ?? '');
      const items: ListItemBlock[] = [];
      while (index < lines.length) {
        const item = lines[index] ?? '';
        const match = LIST_PATTERN.exec(item);
        if (!match) break;
        const marker = match[2] ?? '-';
        items.push({
          indent: leadingSpaces(match[1] ?? ''),
          text: match[3] ?? '',
          marker: /^\d/.test(marker) ? marker : '•',
        });
        index++;
      }
      blocks.push({
        type: 'list',
        ordered,
        start: startMatch ? Number.parseInt(startMatch[1] ?? '1', 10) : 1,
        items,
      });
      continue;
    }

    if (line.trim() === '') {
      index++;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        /^\s*(#{1,6}\s+|>|([-*+]|\d+[.)])\s+|```)/.test(current) ||
        RULE_PATTERN.test(current) ||
        (current.includes('|') &&
          index + 1 < lines.length &&
          isTableSeparator(lines[index + 1] ?? ''))
      ) {
        break;
      }
      paragraph.push(current);
      index++;
    }
    blocks.push({ type: 'paragraph', lines: paragraph });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  return parseInlineMarkdown(text).map((token, index) => {
    if (token.type === 'code') {
      return (
        <Text key={`c${index}`} color={theme.warn}>
          {token.text}
        </Text>
      );
    }
    if (token.type === 'link') {
      return (
        <Text key={`l${index}`}>
          <Text color={theme.info}>{token.text}</Text>
          {token.text === token.href ? null : <Text color={theme.faint}> ({token.href})</Text>}
        </Text>
      );
    }
    if (token.type === 'bold') {
      return (
        <Text key={`b${index}`} bold>
          {token.text}
        </Text>
      );
    }
    if (token.type === 'italic') {
      return (
        <Text key={`i${index}`} italic>
          {token.text}
        </Text>
      );
    }
    return <Text key={`t${index}`}>{token.text}</Text>;
  });
}

function padCell(text: string, width: number, align: TableAlign): string {
  if (align === 'right') return fitCell(text, width, 'right');
  if (align === 'center') {
    const fitted = fitCell(text, width, 'left');
    const gap = Math.max(0, width - displayWidth(text));
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${fitted.trimEnd()}${' '.repeat(gap - left)}`;
  }
  return fitCell(text, width, 'left');
}

/** 纯函数：表格 -> 对齐后的行（CJK / emoji 按显示宽度） */
export function buildTableLines(block: TableBlock): string[] {
  const columnCount = Math.max(
    block.header.length,
    ...block.rows.map((row) => row.length),
    block.align.length,
  );
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column++) {
    const cells = [block.header[column] ?? '', ...block.rows.map((row) => row[column] ?? '')];
    widths.push(Math.max(1, ...cells.map((cell) => displayWidth(cell))));
  }
  const alignOf = (column: number): TableAlign => block.align[column] ?? 'left';
  const renderRow = (cells: string[]): string =>
    widths
      .map((width, column) => padCell(cells[column] ?? '', width, alignOf(column)))
      .join(' │ ')
      .trimEnd();
  const separator = widths.map((width) => '─'.repeat(width)).join('─┼─');
  return [renderRow(block.header), separator, ...block.rows.map(renderRow)];
}

function renderBlock(block: MarkdownBlock, key: string, width: number): ReactNode {
  if (block.type === 'code') {
    return (
      <Box key={key} flexDirection="column">
        {block.lang ? (
          <Text color={theme.faint}>
            {'│ '}
            {block.lang}
          </Text>
        ) : null}
        {block.lines.map((line, index) => (
          <Text key={`${key}-${index}`} color={theme.muted}>
            {'│ '}
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  if (block.type === 'heading') {
    const color = block.level === 1 ? theme.brand : block.level === 2 ? theme.info : theme.muted;
    return (
      <Text key={key} color={color} bold>
        {renderInline(block.text)}
      </Text>
    );
  }

  if (block.type === 'rule') {
    return (
      <Text key={key} color={theme.faint}>
        {'─'.repeat(Math.max(10, Math.min(60, width - 4)))}
      </Text>
    );
  }

  if (block.type === 'table') {
    const lines = buildTableLines(block);
    return (
      <Box key={key} flexDirection="column">
        {lines.map((line, index) => (
          <Text
            key={`${key}-${index}`}
            color={index === 0 ? theme.brand : index === 1 ? theme.faint : undefined}
            bold={index === 0}
          >
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  if (block.type === 'quote') {
    return (
      <Box key={key} flexDirection="column">
        {block.lines.map((line, index) => (
          <Text key={`${key}-${index}`} color={theme.muted}>
            {'│ '}
            {renderInline(line)}
          </Text>
        ))}
      </Box>
    );
  }

  if (block.type === 'list') {
    return (
      <Box key={key} flexDirection="column">
        {block.items.map((item, index) => (
          <Box key={`${key}-${index}`} flexDirection="row">
            <Text color={theme.muted}>
              {'  '.repeat(Math.max(0, Math.floor(item.indent / 2)))}
              {item.marker}{' '}
            </Text>
            <Text>{renderInline(item.text)}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box key={key} flexDirection="column">
      {block.lines.map((line, index) => (
        <Text key={`${key}-${index}`}>{renderInline(line)}</Text>
      ))}
    </Box>
  );
}

export interface MarkdownTextProps {
  text: string;
}

/** Ink 组件：把文本按块渲染；解析失败/纯文本时退化为单段 */
export function MarkdownText({ text }: MarkdownTextProps) {
  const { stdout } = useStdout();
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  if (blocks.length === 0) return null;
  const width = stdout.columns ?? 80;
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => renderBlock(block, `${index}`, width))}
    </Box>
  );
}
