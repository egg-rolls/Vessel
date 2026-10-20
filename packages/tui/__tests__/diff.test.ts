import { describe, expect, it } from 'bun:test';
import { condenseDiff, diffLines } from '../src/utils/diff.js';

describe('diffLines', () => {
  it('replacement 保留旧/新行号（off-by-one 会让用户定位错行）', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    const del = lines.find((line) => line.kind === 'del');
    const add = lines.find((line) => line.kind === 'add');
    expect(del).toEqual({ kind: 'del', oldLine: 2, text: 'b' });
    expect(add).toEqual({ kind: 'add', newLine: 2, text: 'B' });
    expect(lines.filter((line) => line.kind === 'context').map((line) => line.oldLine)).toEqual([
      1, 3,
    ]);
  });

  it('纯新增行没有旧行号，纯删除行没有新行号', () => {
    const lines = diffLines('a', 'a\nb');
    expect(lines.at(-1)).toEqual({ kind: 'add', newLine: 2, text: 'b' });
    expect(lines.at(-1)?.oldLine).toBeUndefined();

    const removed = diffLines('a\nb', 'a');
    expect(removed.at(-1)).toEqual({ kind: 'del', oldLine: 2, text: 'b' });
    expect(removed.at(-1)?.newLine).toBeUndefined();
  });

  it('相同文本不产生 add/del', () => {
    expect(diffLines('a\nb', 'a\nb').every((line) => line.kind === 'context')).toBe(true);
  });
});

describe('condenseDiff', () => {
  it('大段未变更上下文被折叠为 gap，但所有变更行保留', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
    const after = before.replace('l10', 'L10');
    const condensed = condenseDiff(diffLines(before, after), { context: 1 });
    const text = condensed.map((line) => (line.kind === 'gap' ? 'GAP' : line.text));
    expect(text).toContain('L10');
    expect(text).toContain('l10');
    expect(text.filter((line) => line === 'GAP').length).toBeGreaterThan(0);
    expect(text).not.toContain('l1');
    expect(text).not.toContain('l20');
  });

  it('没有变更时返回空数组（调用方回退普通结果文本）', () => {
    expect(condenseDiff(diffLines('same', 'same'))).toEqual([]);
  });
});
