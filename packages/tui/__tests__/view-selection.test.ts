import { describe, expect, it } from 'bun:test';
import {
  detailRow,
  listItemRow,
  viewContextKey,
  viewSelectionKey,
  viewSelectionRow,
} from '../src/views/selection.js';
import type { CommandView, DetailView, ListView, TableView, ViewRow } from '../src/views/types.js';

const table: TableView = {
  kind: 'table',
  title: 'Runs',
  columns: [{ key: 'title', header: 'TITLE' }],
  rows: [{ key: 'r1', cells: { title: 'Run 1' } }],
  key: 'table-context',
};

const list: ListView = {
  kind: 'list',
  title: 'Servers',
  items: [
    { key: 'github', label: 'github', current: true, tone: 'ok' },
    { key: 'fs', label: 'fs' },
  ],
  key: 'list-context',
};

const detail: DetailView = {
  kind: 'detail',
  title: 'Workflow run wf_1',
  sections: [],
  key: 'wf_1',
};

describe('viewSelectionRow', () => {
  it('table 使用传入的选中行', () => {
    const row: ViewRow = { key: 'r1', cells: { title: 'Run 1' } };
    expect(viewSelectionRow(table, row, undefined)).toBe(row);
    expect(viewSelectionRow(table, null, undefined)).toBeNull();
  });

  it('list 把 item 归一为带 current/tone 的行', () => {
    const row = viewSelectionRow(list, null, list.items[0]);
    expect(row).toEqual({
      key: 'github',
      cells: { title: 'github' },
      current: true,
      tone: 'ok',
    });
    expect(listItemRow(list.items[1] as ListView['items'][number])).toEqual({
      key: 'fs',
      cells: { title: 'fs' },
    });
  });

  it('detail 用 view.key 合成行（无 key 时为 null）', () => {
    expect(detailRow(detail)).toEqual({ key: 'wf_1', cells: { title: 'Workflow run wf_1' } });
    expect(detailRow({ ...detail, key: undefined })).toBeNull();
  });

  it('confirm/form 没有选中行', () => {
    const view: CommandView = {
      kind: 'confirm',
      title: 'Delete?',
      message: '',
      confirm: { id: 'delete', label: 'delete' },
      cancel: { id: 'cancel', label: 'keep' },
    };
    expect(viewSelectionRow(view, null, undefined)).toBeNull();
  });
});

describe('viewSelectionKey / viewContextKey', () => {
  it('selectionKey 来自归一化后的选中行', () => {
    expect(viewSelectionKey(viewSelectionRow(list, null, list.items[0]))).toBe('github');
    expect(viewSelectionKey(null)).toBe('');
  });

  it('上下文 key 覆盖 table/list/detail，confirm/form 为空', () => {
    expect(viewContextKey(table)).toBe('table-context');
    expect(viewContextKey(list)).toBe('list-context');
    expect(viewContextKey(detail)).toBe('wf_1');
    expect(
      viewContextKey({
        kind: 'form',
        title: 'x',
        fields: [],
        submit: { id: 'save', label: 'save' },
      }),
    ).toBeUndefined();
  });
});
