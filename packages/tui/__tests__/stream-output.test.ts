import { describe, expect, it } from 'bun:test';
import { limitUiItems, resetStreamProjection, tailLines } from '../src/components/StreamOutput.js';
import { createUiProjection, type UiItem } from '../src/repl/project/ui-item.js';

const assistant = (id: string, text: string): UiItem => ({
  kind: 'assistant',
  id,
  text,
  at: 0,
});

const tool = (id: string): UiItem => ({
  kind: 'tool',
  id,
  view: {
    id: `call-${id}`,
    name: 'bash',
    args: { command: 'ls' },
    status: 'completed',
    title: 'bash',
    subtitle: 'ls',
    result: 'a\nb\nc\nd',
  },
});

describe('tailLines', () => {
  it('超过上限保留尾部并前置折叠提示', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('…（前文已折叠）\nc\nd');
  });

  it('未超过上限原样返回', () => {
    expect(tailLines('a\nb', 3)).toBe('a\nb');
  });

  it('maxLines <= 0 返回空串', () => {
    expect(tailLines('a', 0)).toBe('');
  });
});

describe('limitUiItems', () => {
  it('只保留最后 maxItems 项', () => {
    const items = [assistant('a', '1'), assistant('b', '2'), assistant('c', '3')];
    expect(limitUiItems(items, { maxItems: 2 }).map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('长文本按行截断，工具卡保持完整', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const limited = limitUiItems([assistant('a', text), tool('t')], { maxLines: 3 });
    const first = limited[0];
    expect(first?.kind).toBe('assistant');
    expect(first?.kind === 'assistant' ? first.text : '').toContain('line 20');
    expect(first?.kind === 'assistant' ? first.text : '').toContain('…（前文已折叠）');
    expect(limited[1]?.kind === 'tool' ? limited[1].view.result : '').toBe('a\nb\nc\nd');
  });

  it('空列表返回空', () => {
    expect(limitUiItems([], {})).toEqual([]);
  });
});

describe('resetStreamProjection', () => {
  it('清空 items / 工具映射，但保留 id 序号', () => {
    const state = { ...createUiProjection(), seq: 9, items: [assistant('a', 'x')] };
    const reset = resetStreamProjection(state);
    expect(reset.items).toEqual([]);
    expect(reset.seq).toBe(9);
    expect(reset.toolItemIds).toEqual({});
  });
});
