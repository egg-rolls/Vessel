import { describe, expect, it } from 'bun:test';
import { renderViewAsText } from '../src/views/render-text.js';
import type { ConfirmView, DetailView, FormView, ListView, TableView } from '../src/views/types.js';

const table: TableView = {
  kind: 'table',
  title: 'Sessions',
  meta: '2',
  columns: [
    { key: 'title', header: 'TITLE' },
    { key: 'msgs', header: 'MSGS', align: 'right' },
  ],
  rows: [
    { key: 'a', cells: { title: 'Fix auth', msgs: '12' } },
    { key: 'b', cells: { title: 'Dashboard', msgs: '48' }, current: true },
  ],
  emptyText: 'No sessions.',
};

describe('renderViewAsText: table', () => {
  it('输出标题、表头、行与 current 标记', () => {
    const text = renderViewAsText(table);
    expect(text).toContain('Sessions · 2');
    expect(text).toContain('TITLE');
    expect(text).toContain('MSGS');
    expect(text).toContain('Fix auth');
    expect(text).toContain('Dashboard');
    expect(text).toContain('●');
    // current 行用 ● 标记，普通行用空格
    const currentLine = text.split('\n').find((line) => line.includes('Dashboard'));
    expect(currentLine?.startsWith('●')).toBe(true);
  });

  it('空表渲染 emptyText，不渲染只有表头的空表', () => {
    const text = renderViewAsText({ ...table, rows: [] });
    expect(text).toContain('No sessions.');
    expect(text).not.toContain('TITLE');
  });

  it('maxRows 截断并显示窗口说明', () => {
    const text = renderViewAsText(table, { maxRows: 1 });
    expect(text).toContain('Fix auth');
    expect(text).not.toContain('Dashboard');
    expect(text).toContain('showing 1-1 of 2');
  });

  it('显式 width 时按列宽对齐（CJK 安全）', () => {
    const cjk: TableView = {
      ...table,
      rows: [{ key: 'zh', cells: { title: '中文标题', msgs: '3' } }],
    };
    const text = renderViewAsText(cjk, { width: 40 });
    expect(text).toContain('中文标题');
    expect(text).toContain('TITLE');
  });
});

describe('renderViewAsText: list / detail / form / confirm', () => {
  it('list 输出 label、description、badge 与 current 标记', () => {
    const view: ListView = {
      kind: 'list',
      title: 'Tools',
      items: [
        { key: 'bash', label: 'bash', description: 'shell' },
        { key: 'read', label: 'read', badge: 'builtin', current: true },
      ],
      emptyText: 'No tools.',
    };
    const text = renderViewAsText(view);
    expect(text).toContain('Tools');
    expect(text).toContain('bash — shell');
    expect(text).toContain('read [builtin]');
    expect(text).toContain('●');
  });

  it('list 空态', () => {
    expect(
      renderViewAsText({ kind: 'list', title: 'Tools', items: [], emptyText: 'None.' }),
    ).toContain('None.');
  });

  it('detail 输出 badge、section、字段与原始行', () => {
    const view: DetailView = {
      kind: 'detail',
      title: 'Metrics',
      badge: { text: 'live', tone: 'info' },
      sections: [
        {
          title: 'Runs',
          fields: [{ label: 'Total', value: '3' }],
          lines: ['last updated 12:03'],
        },
      ],
    };
    const text = renderViewAsText(view);
    expect(text).toContain('Metrics [live]');
    expect(text).toContain('Runs');
    expect(text).toContain('Total');
    expect(text).toContain('3');
    expect(text).toContain('last updated 12:03');
  });

  it('form 输出字段与提交/取消标签', () => {
    const view: FormView = {
      kind: 'form',
      title: 'Rename session',
      fields: [
        { key: 'title', label: 'Title', value: '', placeholder: 'new title', required: true },
      ],
      submit: { id: 'save', label: 'save' },
      cancel: { id: 'cancel', label: 'cancel' },
    };
    const text = renderViewAsText(view);
    expect(text).toContain('Rename session');
    expect(text).toContain('Title: new title *');
    expect(text).toContain('[save]  [cancel]');
  });

  it('confirm 输出 message、details 与 y/n 标签', () => {
    const view: ConfirmView = {
      kind: 'confirm',
      title: 'Delete session?',
      message: 'This cannot be undone.',
      details: ['12 messages'],
      confirm: { id: 'delete', label: 'delete', tone: 'danger' },
      cancel: { id: 'cancel', label: 'keep' },
    };
    const text = renderViewAsText(view);
    expect(text).toContain('Delete session?');
    expect(text).toContain('This cannot be undone.');
    expect(text).toContain('12 messages');
    expect(text).toContain('[y] delete  [n] keep');
  });
});
