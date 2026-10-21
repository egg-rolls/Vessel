import { describe, expect, it } from 'bun:test';
import {
  buildTableLines,
  parseEmphasis,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  splitTableRow,
  stripInlineMarkdown,
  type TableBlock,
} from '../src/components/Markdown.js';
import { displayWidth } from '../src/utils/text-layout.js';

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

  it('强调只有成对且符合 flanking 规则时才样式化', () => {
    expect(parseEmphasis('**bold** and *it*')).toEqual([
      { type: 'bold', text: 'bold' },
      { type: 'text', text: ' and ' },
      { type: 'italic', text: 'it' },
    ]);
    const tokens = parseEmphasis('**bold** and *it*');
    expect(tokens.some((token) => token.type === 'bold')).toBe(true);
    expect(tokens.some((token) => token.type === 'italic')).toBe(true);
  });

  it('不得删除字面 * / _：2*3*4 保持原样', () => {
    expect(stripInlineMarkdown('2*3*4')).toBe('2*3*4');
    expect(stripInlineMarkdown('snake_case_name')).toBe('snake_case_name');
    expect(stripInlineMarkdown('a * b * c')).toBe('a * b * c');
  });

  it('未闭合强调保留字面标记', () => {
    expect(stripInlineMarkdown('**unclosed')).toBe('**unclosed');
    expect(stripInlineMarkdown('*no close')).toBe('*no close');
  });
});

describe('0.18 Markdown 平坦化', () => {
  it('标题块不保留 # 标记', () => {
    const [block] = parseMarkdownBlocks('## Subtitle');
    expect(block).toEqual({ type: 'heading', level: 2, text: 'Subtitle' });
  });

  it('代码块解析为 code 块（渲染层不输出 ``` 围栏）', () => {
    const blocks = parseMarkdownBlocks('```ts\nconst a = 1;\n```');
    expect(blocks[0]).toEqual({ type: 'code', lang: 'ts', lines: ['const a = 1;'] });
  });

  it('分隔线识别为 rule', () => {
    expect(parseMarkdownBlocks('before\n\n---\n\nafter').map((block) => block.type)).toEqual([
      'paragraph',
      'rule',
      'paragraph',
    ]);
  });

  it('嵌套列表保留缩进与源序号', () => {
    const [block] = parseMarkdownBlocks('3. three\n4. four\n   - nested\n     - deeper');
    expect(block?.type).toBe('list');
    if (block?.type !== 'list') throw new Error('expected list');
    expect(block.items.map((item) => item.marker)).toEqual(['3.', '4.', '•', '•']);
    expect(block.items.map((item) => item.indent)).toEqual([0, 0, 3, 5]);
    expect(block.start).toBe(3);
  });

  it('表格解析：表头 / 对齐 / 行', () => {
    const [block] = parseMarkdownBlocks('| Name | Count |\n| :--- | ---: |\n| a | 12 |');
    expect(block?.type).toBe('table');
    if (block?.type !== 'table') throw new Error('expected table');
    expect(block.header).toEqual(['Name', 'Count']);
    expect(block.align).toEqual(['left', 'right']);
    expect(block.rows).toEqual([['a', '12']]);
  });

  it('表格按 displayWidth 对齐（CJK 安全）', () => {
    const block: TableBlock = {
      type: 'table',
      header: ['名称', 'count'],
      align: ['left', 'right'],
      rows: [
        ['文件', '1'],
        ['abc', '20'],
      ],
    };
    const lines = buildTableLines(block);
    expect(lines).toHaveLength(4);
    // 每列宽度按显示列计算，所有数据行等宽
    for (const line of lines.slice(1)) {
      expect(displayWidth(line)).toBe(displayWidth(lines[0] ?? ''));
    }
    expect(lines[1]).toContain('─┼─');
    expect(lines[2]).toContain('文件');
    // 数字列右对齐
    expect(lines[2]?.endsWith(' 1')).toBe(true);
    expect(lines[3]?.endsWith('20')).toBe(true);
  });

  it('splitTableRow 处理首尾竖线与转义竖线', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitTableRow('a \\| b | c')).toEqual(['a | b', 'c']);
  });
});
