import { describe, expect, test } from 'bun:test';
import {
  filterPaletteItems,
  groupPaletteItems,
  moveIndex,
  type PaletteItem,
  parsePaletteQuery,
} from '../src/state/palette';

function item(
  id: string,
  group: PaletteItem['group'],
  label: string,
  keywords: string[] = [],
): PaletteItem {
  return { id, group, label, keywords, run: () => undefined };
}

const ITEMS: PaletteItem[] = [
  item('nav-chat', 'navigation', '打开会话', ['chat', 'session']),
  item('nav-runs', 'navigation', '打开运行', ['runs']),
  item('action-new', 'action', '新建会话', ['new', 'session']),
  item('action-refresh', 'action', '刷新当前视图', ['refresh']),
  item('help-keys', 'help', '键盘快捷键', ['shortcut']),
  item('session-1', 'entity', '修复 gateway 重连', ['abc123']),
];

describe('parsePaletteQuery', () => {
  test('treats > as action mode', () => {
    expect(parsePaletteQuery('> 新建')).toEqual({ actionMode: true, needle: '新建' });
    expect(parsePaletteQuery('新建')).toEqual({ actionMode: false, needle: '新建' });
  });
});

describe('filterPaletteItems', () => {
  test('empty query keeps group order', () => {
    const filtered = filterPaletteItems(ITEMS, '');
    expect(filtered.map((entry) => entry.id)).toEqual([
      'nav-chat',
      'nav-runs',
      'session-1',
      'action-new',
      'action-refresh',
      'help-keys',
    ]);
  });

  test('matches label and keywords', () => {
    expect(filterPaletteItems(ITEMS, '会话').map((entry) => entry.id)).toEqual([
      'nav-chat',
      'action-new',
    ]);
    expect(filterPaletteItems(ITEMS, 'abc').map((entry) => entry.id)).toEqual(['session-1']);
    expect(filterPaletteItems(ITEMS, 'refresh').map((entry) => entry.id)).toEqual([
      'action-refresh',
    ]);
  });

  test('action mode excludes navigation and entities', () => {
    const filtered = filterPaletteItems(ITEMS, '>');
    expect(filtered.map((entry) => entry.id)).toEqual([
      'action-new',
      'action-refresh',
      'help-keys',
    ]);
    expect(filterPaletteItems(ITEMS, '>会话').map((entry) => entry.id)).toEqual(['action-new']);
  });

  test('exact and prefix matches rank before substring/keyword matches', () => {
    const entries = [
      item('a', 'action', '连接设置', []),
      item('b', 'action', '设置', []),
      item('c', 'action', '打开设置页面', []),
      item('d', 'action', '其它', ['设置']),
    ];
    expect(filterPaletteItems(entries, '设置').map((entry) => entry.id)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
  });

  test('returns nothing for unmatched text', () => {
    expect(filterPaletteItems(ITEMS, 'zzzz')).toEqual([]);
  });
});

describe('groupPaletteItems', () => {
  test('drops empty groups and labels them', () => {
    const sections = groupPaletteItems(filterPaletteItems(ITEMS, '>新建'));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe('action');
    expect(sections[0]?.label).toBe('动作');
  });
});

describe('moveIndex', () => {
  test('wraps both directions', () => {
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
  });

  test('empty lists return -1', () => {
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
