import { describe, expect, it } from 'bun:test';
import {
  parseInlineMarkdown,
  parseMarkdownBlocks,
  stripInlineMarkdown,
} from '../src/components/Markdown.js';

describe('parseMarkdownBlocks', () => {
  it('未闭合代码 fence（流式中间态）仍按代码块处理，不丢内容', () => {
    const blocks = parseMarkdownBlocks('before\n```ts\nconst a = 1;\n');
    const code = blocks.find((block) => block.type === 'code');
    expect(code).toMatchObject({ type: 'code', lang: 'ts' });
    expect(code?.type === 'code' ? code.lines[0] : '').toBe('const a = 1;');
  });

  it('代码块内的 # 和 - 不会误判为标题/列表', () => {
    const blocks = parseMarkdownBlocks('```\n# not heading\n- not list\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'code', lines: ['# not heading', '- not list'] });
  });

  it('有序/无序列表保持类型与编号起点', () => {
    const unordered = parseMarkdownBlocks('- one\n- two');
    expect(unordered[0]).toMatchObject({ type: 'list', ordered: false });
    expect(unordered[0]?.type === 'list' ? unordered[0].items.map((i) => i.text) : []).toEqual([
      'one',
      'two',
    ]);

    const ordered = parseMarkdownBlocks('3. three\n4. four');
    expect(ordered[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('标题与引用分段', () => {
    const blocks = parseMarkdownBlocks('# Title\n> quoted\n\ntext');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: 'Title' });
    expect(blocks[1]).toMatchObject({ type: 'quote', lines: ['quoted'] });
    expect(blocks[2]).toMatchObject({ type: 'paragraph', lines: ['text'] });
  });
});

describe('inline markdown', () => {
  it('链接保留 label 与 URL，行内代码与强调剥离', () => {
    const tokens = parseInlineMarkdown('see [docs](https://x.dev) and `code` **bold**');
    expect(tokens).toContainEqual({ type: 'link', text: 'docs', href: 'https://x.dev' });
    expect(tokens).toContainEqual({ type: 'code', text: 'code' });
    expect(stripInlineMarkdown('see [docs](https://x.dev) and `code`')).toBe(
      'see docs (https://x.dev) and code',
    );
    expect(stripInlineMarkdown('**bold** and *it*')).toBe('bold and it');
  });

  it('不把普通方括号当链接', () => {
    expect(stripInlineMarkdown('[not a link]')).toBe('[not a link]');
  });
});
