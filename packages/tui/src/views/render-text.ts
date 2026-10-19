/**
 * 视图 -> 纯文本——非 TTY / simple mode / 测试共用
 * @module @vessel/tui
 *
 * 输出契约：即使命令忘记写 `output`，non-TTY 也不会静默。
 * 不依赖终端宽度；可选 `width` 用于对齐（CJK 安全）。
 */

import { displayWidth, padToWidth } from '../utils/text-layout.js';
import { COLUMN_GAP, formatTableHeader, formatTableRow, resolveColumns } from './layout.js';
import type { CommandView, DetailView, ListView, TableView } from './types.js';

export interface RenderTextOptions {
  /** 对齐宽度；省略时按内容自然宽度 */
  width?: number;
  /** table 最多渲染行数（省略 = 全部） */
  maxRows?: number;
}

function tableText(view: TableView, options: RenderTextOptions): string[] {
  const lines: string[] = [view.meta ? `${view.title} · ${view.meta}` : view.title];

  if (view.rows.length === 0) {
    lines.push(view.emptyText ?? 'No items.');
    return lines;
  }

  const maxRows = options.maxRows ?? view.rows.length;
  const rows = view.rows.slice(0, Math.max(0, maxRows));

  if (options.width !== undefined) {
    const columns = resolveColumns(view.columns, Math.max(1, options.width), options.width);
    lines.push(`  ${formatTableHeader(columns)}`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const marker = row.current ? '●' : ' ';
      lines.push(
        `${marker} ${String(i + 1).padStart(2, ' ')}  ${formatTableRow(row.cells, columns)}`,
      );
    }
    return lines;
  }

  // 自然宽度：声明宽度优先，否则取表头/单元格最大显示宽度。
  const widths = view.columns.map((column) => {
    if (column.width !== undefined) return column.width;
    let width = displayWidth(column.header);
    for (const row of rows) {
      width = Math.max(width, displayWidth(row.cells[column.key] ?? ''));
    }
    return width;
  });

  const header = view.columns
    .map((column, i) => padToWidth(column.header, widths[i] ?? 1))
    .join(' '.repeat(COLUMN_GAP));
  lines.push(`  ${header}`);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const cells = view.columns
      .map((column, i) => padToWidth(row.cells[column.key] ?? '', widths[i] ?? 1))
      .join(' '.repeat(COLUMN_GAP));
    const marker = row.current ? '●' : ' ';
    lines.push(`${marker} ${String(r + 1).padStart(2, ' ')}  ${cells}`);
  }

  if (view.rows.length > rows.length) {
    lines.push(`  showing 1-${rows.length} of ${view.rows.length}`);
  }
  return lines;
}

function listText(view: ListView, options: RenderTextOptions): string[] {
  const lines: string[] = [view.title];
  if (view.items.length === 0) {
    lines.push(view.emptyText ?? 'No items.');
    return lines;
  }

  const maxRows = options.maxRows ?? view.items.length;
  const items = view.items.slice(0, Math.max(0, maxRows));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const marker = item.current ? '●' : ' ';
    let line = `${marker} ${String(i + 1).padStart(2, ' ')}  ${item.label}`;
    if (item.description) line += ` — ${item.description}`;
    if (item.badge) line += ` [${item.badge}]`;
    lines.push(line);
  }
  if (view.items.length > items.length) {
    lines.push(`  showing 1-${items.length} of ${view.items.length}`);
  }
  return lines;
}

function detailText(view: DetailView): string[] {
  const lines: string[] = [view.badge ? `${view.title} [${view.badge.text}]` : view.title];
  for (const section of view.sections) {
    lines.push('');
    if (section.title) lines.push(section.title);
    const labelWidth = Math.max(
      0,
      ...(section.fields ?? []).map((field) => displayWidth(field.label)),
    );
    for (const field of section.fields ?? []) {
      lines.push(`  ${padToWidth(field.label, labelWidth)}  ${field.value}`);
    }
    for (const line of section.lines ?? []) lines.push(`  ${line}`);
  }
  return lines;
}

/** 纯函数：把任意 CommandView 渲染为稳定、可读的纯文本 */
export function renderViewAsText(view: CommandView, options: RenderTextOptions = {}): string {
  switch (view.kind) {
    case 'table':
      return tableText(view, options).join('\n');
    case 'list':
      return listText(view, options).join('\n');
    case 'detail':
      return detailText(view).join('\n');
    case 'form': {
      const lines: string[] = [view.title];
      for (const field of view.fields) {
        const value = field.value || field.placeholder || '';
        lines.push(`  ${field.label}: ${value}${field.required && !field.value ? ' *' : ''}`);
      }
      lines.push('');
      lines.push(`  [${view.submit.label}]${view.cancel ? `  [${view.cancel.label}]` : ''}`);
      return lines.join('\n');
    }
    case 'confirm': {
      const lines: string[] = [view.title, view.message];
      for (const detail of view.details ?? []) lines.push(`  ${detail}`);
      lines.push('');
      lines.push(`  [y] ${view.confirm.label}  [n] ${view.cancel.label}`);
      return lines.join('\n');
    }
  }
}
