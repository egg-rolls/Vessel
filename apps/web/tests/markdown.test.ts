import { describe, expect, it } from 'bun:test';
import { isSafeHref, parseInline, parseMarkdown } from '../src/components/markdown-parse';

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists, quotes and rules', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'first line',
        'second line',
        '',
        '- one',
        '- two',
        '',
        '> quoted',
        '',
        '---',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'first line\nsecond line' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
      { type: 'blockquote', text: 'quoted' },
      { type: 'hr' },
    ]);
  });

  it('parses fenced code and tolerates an unclosed fence', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```\n\ntail');
    expect(blocks[0]).toEqual({ type: 'code', lang: 'ts', text: 'const x = 1;' });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'tail' });

    const unclosed = parseMarkdown('```json\n{"a":1}');
    expect(unclosed).toEqual([{ type: 'code', lang: 'json', text: '{"a":1}' }]);
  });

  it('parses tables with header and rows', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks).toEqual([
      {
        type: 'table',
        header: ['a', 'b'],
        rows: [
          ['1', '2'],
          ['3', '4'],
        ],
      },
    ]);
  });

  it('parses ordered lists', () => {
    expect(parseMarkdown('1. first\n2. second')).toEqual([
      { type: 'list', ordered: true, items: ['first', 'second'] },
    ]);
  });
});

describe('parseInline', () => {
  it('parses code, links, bold and italic', () => {
    expect(parseInline('a `code` **bold** *em* [site](https://example.com)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' ' },
      { type: 'strong', text: 'bold' },
      { type: 'text', text: ' ' },
      { type: 'em', text: 'em' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'site', href: 'https://example.com' },
    ]);
  });

  it('rejects unsafe link schemes and keeps the label as text', () => {
    for (const href of ['javascript:alert', 'data:text/html,x', '//evil.example']) {
      expect(parseInline(`[click](${href})`)).toEqual([{ type: 'text', text: 'click' }]);
    }
  });

  it('never emits HTML elements for raw HTML input', () => {
    const nodes = parseInline('<img src=x onerror="alert(1)">');
    expect(nodes).toEqual([{ type: 'text', text: '<img src=x onerror="alert(1)">' }]);
  });

  it('allows anchors, mail and relative links', () => {
    expect(isSafeHref('#section')).toBe(true);
    expect(isSafeHref('/docs/a')).toBe(true);
    expect(isSafeHref('./a.md')).toBe(true);
    expect(isSafeHref('mailto:a@example.com')).toBe(true);
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('javascript:void(0)')).toBe(false);
    expect(isSafeHref('')).toBe(false);
  });
});
