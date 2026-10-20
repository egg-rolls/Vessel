/**
 * /mcp —— MCP server 状态与重连
 * @module @vessel-agent/tui
 *
 * 数据只来自 ReplContext.mcp（asm 注入的 McpControl）；本模块不 import 任何 MCP 实现。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import { t } from '../i18n/index.js';
import type { McpServerSummary, ReplContext } from '../repl-context.js';
import { padToWidth, truncateToWidth } from '../utils/text-layout.js';
import type {
  DetailView,
  ListView,
  ViewAction,
  ViewActionInvocation,
  ViewTone,
} from '../views/types.js';
import type { CommandEntry, CommandResult } from './commands.js';

const NAME_WIDTH = 16;
const STATUS_WIDTH = 10;
const ERROR_MAX = 80;

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return truncateToWidth(text, max);
}

/** 纯函数：把 server 快照渲染成列表文本（测试用） */
export function formatMcpServers(servers: McpServerSummary[]): string {
  if (servers.length === 0) return '\nNo MCP servers configured.\n';

  const lines = ['', `MCP servers (${servers.length}):`];
  for (const server of servers) {
    const base = `  ${padToWidth(server.name, NAME_WIDTH)} ${padToWidth(
      server.status,
      STATUS_WIDTH,
    )} ${String(server.tools.length).padStart(3)} tools`;
    const error = server.error ? `  ${truncate(oneLine(server.error), ERROR_MAX)}` : '';
    lines.push(`${base}${error}`);
  }
  lines.push('');
  return lines.join('\n');
}

function mcpEnvelope(view: ListView | DetailView): NonNullable<CommandResult['view']> {
  return { source: 'mcp', view };
}

/** 状态文本：glyph + 文本，无色终端也可读 */
export function mcpStatusLabel(server: McpServerSummary): string {
  if (server.status === 'connected') return '● connected';
  if (server.status === 'failed') return '✗ failed';
  return '○ disabled';
}

export function mcpStatusTone(server: McpServerSummary): ViewTone {
  if (server.status === 'connected') return 'ok';
  if (server.status === 'failed') return 'danger';
  return 'muted';
}

/** 列表动作：Enter 详情、r 重连、g 刷新 */
export function mcpListActions(): ViewAction[] {
  return [
    { id: 'inspect', key: 'enter', label: 'inspect', enabled: 'selected' },
    { id: 'reconnect', key: 'r', label: 'reconnect', enabled: 'selected' },
    { id: 'refresh', key: 'g', label: 'refresh' },
  ];
}

/** 详情动作：r 重连、g 刷新 */
export function mcpDetailActions(): ViewAction[] {
  return [
    { id: 'reconnect', key: 'r', label: 'reconnect' },
    { id: 'refresh', key: 'g', label: 'refresh' },
  ];
}

/** 纯函数：server 列表视图 */
export function buildMcpListView(servers: McpServerSummary[]): ListView {
  return {
    kind: 'list',
    title: 'MCP servers',
    items: servers.map((server) => ({
      key: server.name,
      label: server.name,
      description: [
        `${server.tools.length} tools`,
        server.error ? truncateToWidth(oneLine(server.error), ERROR_MAX) : '',
      ]
        .filter(Boolean)
        .join(' · '),
      badge: server.status,
      tone: mcpStatusTone(server),
    })),
    actions: mcpListActions(),
    emptyText: 'No MCP servers configured.',
  };
}

/** 纯函数：server 详情（工具名列表，限制行数） */
export function buildMcpDetailView(server: McpServerSummary, maxTools = 80): DetailView {
  const tools = server.tools.slice(0, Math.max(0, maxTools));
  const toolLines =
    server.tools.length === 0
      ? ['(no tools registered)']
      : [
          ...tools,
          ...(server.tools.length > tools.length
            ? [`… ${server.tools.length - tools.length} more tools`]
            : []),
        ];
  return {
    kind: 'detail',
    title: `MCP server ${server.name}`,
    badge: { text: server.status, tone: mcpStatusTone(server) },
    key: server.name,
    sections: [
      {
        title: 'Overview',
        fields: [
          { label: 'Status', value: mcpStatusLabel(server), tone: mcpStatusTone(server) },
          { label: 'Tools', value: String(server.tools.length) },
          ...(server.error
            ? [
                {
                  label: 'Error',
                  value: truncateToWidth(oneLine(server.error), ERROR_MAX),
                  tone: 'danger' as const,
                },
              ]
            : []),
        ],
      },
      { title: 'Tools', lines: toolLines },
    ],
    actions: mcpDetailActions(),
  };
}

/** 纯函数：MCP 未配置时的诚实空态 */
export function disabledMcpView(): DetailView {
  return {
    kind: 'detail',
    title: 'MCP servers',
    badge: { text: 'disabled', tone: 'warn' },
    sections: [
      {
        title: 'Not enabled',
        lines: ['MCP is not enabled (no mcp_servers configured).'],
      },
    ],
  };
}

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nMCP is not enabled (no mcp_servers configured).\n',
    view: mcpEnvelope(disabledMcpView()),
  };
}

function usage(message: string): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

/** /mcp 的执行体（导出供单测） */
export async function runMcpCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const control = ctx.mcp;
  if (!control) return disabledMessage();

  const [subcommand, name, ...rest] = args;

  if (subcommand === undefined) {
    try {
      const servers = await control.list();
      return {
        handled: true,
        output: formatMcpServers(servers),
        view: mcpEnvelope(buildMcpListView(servers)),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\n${t('error.command.listMcp')}\n${formatClassifiedError(classifyError(error))}\n`,
      };
    }
  }

  if (subcommand !== 'reconnect') {
    return usage(`Unknown /mcp subcommand "${subcommand}". Usage: /mcp [reconnect <name>]`);
  }

  if (!name || rest.length > 0) {
    return usage('Usage: /mcp reconnect <name>');
  }

  let servers: McpServerSummary[];
  try {
    servers = await control.list();
  } catch (error) {
    return {
      handled: true,
      output: `\n${t('error.command.listMcp')}\n${formatClassifiedError(classifyError(error))}\n`,
    };
  }

  const target = servers.find((server) => server.name === name);
  if (!target) return usage(`No MCP server named "${name}".`);
  if (target.status === 'disabled') {
    return usage(`MCP server "${name}" is disabled (enabled: false).`);
  }

  try {
    const summary = await control.reconnect(name);
    return {
      handled: true,
      output: `\nReconnected MCP server "${name}" (${summary.tools.length} tools).\n`,
    };
  } catch (error) {
    return {
      handled: true,
      output: `\n${t('error.command.reconnectMcp', { name })}\n${formatClassifiedError(
        classifyError(error),
      )}\n`,
    };
  }
}

/** 重新列出 servers（视图刷新/动作共用） */
async function listServers(ctx: ReplContext): Promise<McpServerSummary[]> {
  if (!ctx.mcp) throw new Error('mcp control is not available');
  return ctx.mcp.list();
}

/**
 * `/mcp` 视图动作：Enter 详情、r 重连（沿用子命令的 disabled/unknown 守卫）、g 刷新。
 * 重连成功只回 toast，视图保持打开（按 g 刷新）。
 */
export async function runMcpViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  const name = invocation.selectionKey || invocation.viewKey || '';

  if (invocation.actionId === 'refresh') {
    try {
      return {
        handled: true,
        view: mcpEnvelope(buildMcpListView(await listServers(ctx))),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\n${t('error.command.listMcp')}\n${formatClassifiedError(classifyError(error))}\n`,
      };
    }
  }

  let servers: McpServerSummary[];
  try {
    servers = await listServers(ctx);
  } catch (error) {
    return {
      handled: true,
      output: `\n${t('error.command.listMcp')}\n${formatClassifiedError(classifyError(error))}\n`,
    };
  }
  const target = servers.find((server) => server.name === name);
  if (!target) {
    return usage(name ? `No MCP server named "${name}".` : 'Select an MCP server first.');
  }

  if (invocation.actionId === 'inspect' || invocation.actionId === 'enter') {
    return { handled: true, view: mcpEnvelope(buildMcpDetailView(target)) };
  }

  if (invocation.actionId === 'reconnect') {
    if (target.status === 'disabled') {
      return usage(`MCP server "${name}" is disabled (enabled: false).`);
    }
    try {
      const summary = await (ctx.mcp as NonNullable<ReplContext['mcp']>).reconnect(name);
      return {
        handled: true,
        output: `\nReconnected MCP server "${name}" (${summary.tools.length} tools).\n`,
      };
    } catch (error) {
      return {
        handled: true,
        output: `\n${t('error.command.reconnectMcp', { name })}\n${formatClassifiedError(
          classifyError(error),
        )}\n`,
      };
    }
  }

  return { handled: true, output: `\nUnknown /mcp view action "${invocation.actionId}".\n` };
}

export function mcpCommand(): CommandEntry {
  return {
    name: 'mcp',
    description: t('command.mcp.description'),
    usage: '/mcp [reconnect <name>]',
    category: 'inspect',
    keywords: ['server', 'reconnect'],
    available: (ctx) => Boolean(ctx.mcp || ctx.rpc),
    unavailableHint: 'not configured',
    run: (args, ctx) => runMcpCommand(args, ctx),
    viewAction: (invocation, ctx) => runMcpViewAction(invocation, ctx),
  };
}
