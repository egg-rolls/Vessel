import { describe, expect, it } from 'bun:test';
import {
  type CommandView,
  type ConfirmView,
  type DetailView,
  type FormView,
  formatConfirmMessage,
  isViewActionEnabled,
  type ListView,
  type TableView,
  type ViewAction,
  type ViewRow,
  viewActions,
} from '../src/views/types.js';

const row = (key: string, current = false): ViewRow => ({
  key,
  cells: { title: `Title ${key}` },
  ...(current ? { current: true } : {}),
});

const action = (overrides: Partial<ViewAction> = {}): ViewAction => ({
  id: 'delete',
  key: 'x',
  label: 'delete',
  ...overrides,
});

const tableView: TableView = {
  kind: 'table',
  title: 'Sessions',
  columns: [{ key: 'title', header: 'TITLE' }],
  rows: [row('a'), row('b', true)],
  actions: [action({ enabled: 'not-current' })],
  initialKey: 'a',
  emptyText: 'No sessions.',
  meta: '2',
};

const listView: ListView = {
  kind: 'list',
  title: 'Tools',
  items: [{ key: 'bash', label: 'bash', description: 'shell' }],
};

const detailView: DetailView = {
  kind: 'detail',
  title: 'Metrics',
  badge: { text: 'live', tone: 'info' },
  sections: [{ fields: [{ label: 'Runs', value: '3' }] }],
};

const formView: FormView = {
  kind: 'form',
  title: 'Rename',
  fields: [{ key: 'title', label: 'Title', value: 'old', required: true }],
  submit: { id: 'save', label: 'save' },
  cancel: { id: 'cancel', label: 'cancel' },
};

const confirmView: ConfirmView = {
  kind: 'confirm',
  title: 'Delete?',
  message: 'This cannot be undone.',
  confirm: { id: 'delete', label: 'delete', tone: 'danger' },
  cancel: { id: 'cancel', label: 'keep' },
};

describe('CommandView 构造', () => {
  it('五种 kind 都能作为 CommandView 使用', () => {
    const views: CommandView[] = [tableView, listView, detailView, formView, confirmView];
    expect(views.map((view) => view.kind)).toEqual(['table', 'list', 'detail', 'form', 'confirm']);
  });

  it('viewActions 只返回声明的 actions', () => {
    expect(viewActions(tableView)).toHaveLength(1);
    expect(viewActions(listView)).toEqual([]);
    expect(viewActions(confirmView)).toEqual([]);
  });
});

describe('ViewAction 条件', () => {
  it('current 行上 not-current 动作不可用', () => {
    expect(isViewActionEnabled(action({ enabled: 'not-current' }), row('a'))).toBe(true);
    expect(isViewActionEnabled(action({ enabled: 'not-current' }), row('b', true))).toBe(false);
  });

  it('selected 动作需要选中行', () => {
    expect(isViewActionEnabled(action({ enabled: 'selected' }), row('a'))).toBe(true);
    expect(isViewActionEnabled(action({ enabled: 'selected' }), null)).toBe(false);
  });

  it('缺省 always 总是可用（含无选中）', () => {
    expect(isViewActionEnabled(action(), null)).toBe(true);
  });

  it('confirm 模板用 {name} 替换选中行展示名', () => {
    const deleteAction = action({ confirm: 'Delete "{name}"?' });
    expect(formatConfirmMessage(deleteAction, row('a'))).toBe('Delete "Title a"?');
    expect(formatConfirmMessage(deleteAction, null)).toBe('Delete ""?');
  });
});
