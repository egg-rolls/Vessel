// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown 行是位置性的，整段文本变化即整体重渲染
/**
 * 轻量 Markdown 渲染（流式安全）
 * @module @vessel/tui
 *
 * 只处理代码块 / 标题 / 列表 / 引用 / 链接 / 行内代码；
 * 未闭合的代码 fence 视为代码（流式期间不会闪烁）。
 * 解析是纯函数，组件只负责映射为 Ink 节点。
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { theme } from '../theme.js';

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export type MarkdownBlock =
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | {
      type: 'list';
      ordered: boolean;
      start: number;
      items: Array<{ indent: number; text: string }>;
    }
  | { type: 'quote'; lines: string[] }
  | { type: 'paragraph'; lines: string[] };

const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/;
const INLINE_CODE_PATTERN = /`([^`]+)`/;

/** 纯函数：解析行内 markdown（链接 / 行内代码 / 其余文本） */
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
      tokens.push({ type: 'text', text: stripEmphasis(rest) });
      break;
    }
    if (next > 0) tokens.push({ type: 'text', text: stripEmphasis(rest.slice(0, next)) });
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

/** 去掉行内强调标记（**x** / *x* / __x__ / _x_） */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
}

/** 纯文本化（行内语法全部剥离，链接保留 URL） */
export function stripInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .map((token) =>
      token.type === 'link'
        ? token.text === token.href
          ? token.href
          : `${token.text} (${token.href})`
        : token.text,
    )
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

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index++;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const startMatch = /^\s*(\d+)[.)]\s+/.exec(line);
      const items: Array<{ indent: number; text: string }> = [];
      while (index < lines.length) {
        const item = lines[index] ?? '';
        const unorderedMatch = /^(\s*)[-*+]\s+(.*)$/.exec(item);
        const orderedMatch = /^(\s*)\d+[.)]\s+(.*)$/.exec(item);
        const match = ordered ? orderedMatch : unorderedMatch;
        if (!match) break;
        items.push({ indent: leadingSpaces(match[1] ?? ''), text: match[2] ?? '' });
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
      if (current.trim() === '' || /^\s*(#{1,6}\s+|>|([-*+]|\d+[.)])\s+|```)/.test(current)) {
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
    return <Text key={`t${index}`}>{token.text}</Text>;
  });
}

function renderBlock(block: MarkdownBlock, key: string): ReactNode {
  if (block.type === 'code') {
    return (
      <Box key={key} flexDirection="column">
        {block.lang ? <Text color={theme.faint}>```{block.lang}</Text> : null}
        {block.lines.map((line, index) => (
          <Text key={`${key}-${index}`} color={theme.muted}>
            {'│ '}
            {line}
          </Text>
        ))}
        {block.lang ? <Text color={theme.faint}>```</Text> : null}
      </Box>
    );
  }

  if (block.type === 'heading') {
    return (
      <Text key={key} color={theme.brand}>
        {`${'#'.repeat(block.level)} ${block.text}`}
      </Text>
    );
  }

  if (block.type === 'quote') {
    return (
      <Box key={key} flexDirection="column">
        {block.lines.map((line, index) => (
          <Text key={`${key}-${index}`} color={theme.muted}>
            {'│ '}
            {stripInlineMarkdown(line)}
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
              {'  '.repeat(Math.floor(item.indent / 2))}
              {block.ordered ? `${block.start + index}. ` : '• '}
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
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <Box flexDirection="column">{blocks.map((block, index) => renderBlock(block, `${index}`))}</Box>
  );
}
