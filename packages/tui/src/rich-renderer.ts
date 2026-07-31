/**
 * Rich 终端渲染器
 * @module @vessel/tui
 *
 * 封装 @promptctl/rich-js（Python Rich 的 TypeScript 端口），
 * 对标 Hermes 的 rich_output 模块。
 */

import { HEAVY, Panel, ROUNDED, Rule, renderToString, Table } from '@promptctl/rich-js';

export { HEAVY, Panel, ROUNDED, Rule, renderToString, Table };

/** Vessel Banner */
export function buildBanner(): string {
  return renderToString(
    new Panel(
      'provider-agnostic  ·  pluggable  ·  open-source\n\nTypeScript + Bun  ·  single binary  ·  npx vessel',
      {
        title: 'VESSEL',
        subtitle: 'AI Agent Harness',
        box: HEAVY,
        padding: [1, 4, 1, 4],
      },
    ),
  );
}

/** 会话表格 */
export function buildSessionTable(
  sessions: Array<{
    id: string;
    messages: number;
    status: string;
    isCurrent: boolean;
  }>,
): string {
  if (sessions.length === 0) {
    return renderToString(new Panel('No sessions.', { title: 'Sessions', box: ROUNDED }));
  }

  const table = new Table({ title: 'Recent Sessions', box: ROUNDED });
  table.addColumn('#');
  table.addColumn('Session ID');
  table.addColumn('Msgs');
  table.addColumn('Status');

  for (const s of sessions) {
    table.addRow(s.isCurrent ? '*' : '', s.id, String(s.messages), s.status);
  }

  return renderToString(table);
}

/** Info 面板 */
export function infoPanel(title: string, ...lines: string[]): string {
  return renderToString(new Panel(lines.join('\n'), { title, box: ROUNDED }));
}

/** 分割线 */
export function divider(): string {
  return renderToString(new Rule());
}
