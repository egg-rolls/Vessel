import { describe, expect, it } from 'bun:test';
import {
  charWidth,
  displayWidth,
  fitCell,
  padToWidth,
  truncateToWidth,
  wrapToWidth,
} from '../src/utils/text-layout.js';

describe('displayWidth', () => {
  it('ASCII / CJK / emoji 按终端列计算', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('a中🚀b')).toBe(6);
    expect(charWidth('中')).toBe(2);
    expect(charWidth('a')).toBe(1);
  });
});

describe('truncateToWidth', () => {
  it('未超宽时原样返回', () => {
    expect(truncateToWidth('/resume 恢复会话', 20)).toBe('/resume 恢复会话');
  });

  it('中文标题按显示宽度截断并以 … 结尾', () => {
    const out = truncateToWidth('恢复会话并继续之前的上下文', 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('不会把宽字符切成半列', () => {
    // 宽度 4：两个中文正好；再加一个字符触发截断
    const out = truncateToWidth('中文标题', 4);
    expect(displayWidth(out)).toBeLessThanOrEqual(4);
    expect(out).toBe('中…');
  });

  it('emoji 标题不会破坏列宽', () => {
    const out = truncateToWidth('🚀🚀🚀 deploy', 5);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith('…')).toBe(true);
  });

  it('宽度 <= 0 返回空串', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
    expect(truncateToWidth('abc', -1)).toBe('');
  });
});

describe('padToWidth / fitCell', () => {
  it('按显示宽度补齐空格', () => {
    expect(padToWidth('中文', 6)).toBe('中文  ');
    expect(displayWidth(padToWidth('中文', 6))).toBe(6);
    expect(padToWidth('abc', 5)).toBe('abc  ');
  });

  it('超宽时先截断再补齐，绝不溢出', () => {
    const out = padToWidth('中文标题', 4);
    expect(displayWidth(out)).toBe(4);
    expect(out).toBe('中… ');
  });

  it('fitCell 支持左右对齐', () => {
    expect(fitCell('12', 5, 'right')).toBe('   12');
    expect(fitCell('ab', 5, 'left')).toBe('ab   ');
    expect(fitCell('中文', 5, 'right')).toBe(' 中文');
  });

  it('宽度非正返回空串', () => {
    expect(fitCell('abc', 0)).toBe('');
    expect(padToWidth('abc', -1)).toBe('');
  });
});

describe('wrapToWidth', () => {
  it('保留显式换行', () => {
    expect(wrapToWidth('a\nb', 10)).toEqual(['a', 'b']);
    expect(wrapToWidth('', 10)).toEqual(['']);
  });

  it('英文优先在空格处断行', () => {
    expect(wrapToWidth('hello world', 6)).toEqual(['hello', 'world']);
  });

  it('中文按显示宽度断行', () => {
    expect(wrapToWidth('中文中文中文', 4)).toEqual(['中文', '中文', '中文']);
  });

  it('每行宽度不超过上限', () => {
    for (const line of wrapToWidth('中文 emoji 🚀 混合文本 abcdef', 7)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(7);
    }
  });
});
