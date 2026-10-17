/**
 * /mcp —— MCP server 状态与重连
 * @module @vessel/tui
 *
 * 数据只来自 ReplContext.mcp（asm 注入的 McpControl）；本模块不 import 任何 MCP 实现。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { McpServerSummary, ReplContext } from '../repl-context.js';
import type { CommandEntry, CommandResult } from './commands.js';

const NAME_WIDTH = 16;
const STATUS_WIDTH = 10;
const ERROR_MAX = 80;

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 纯函数：把 server 快照渲染成列表文本（测试用） */
export function formatMcpServers(servers: McpServerSummary[]): string {
  if (servers.length === 0) return '\nNo MCP servers configured.\n';

  const lines = ['', `MCP servers (${servers.length}):`];
  for (const server of servers) {
    const base = `  ${server.name.padEnd(NAME_WIDTH)} ${server.status.padEnd(STATUS_WIDTH)} ${String(
      server.tools.length,
    ).padStart(3)} tools`;
    const error = server.error ? `  ${truncate(oneLine(server.error), ERROR_MAX)}` : '';
    lines.push(`${base}${error}`);
  }
  lines.push('');
  return lines.join('\n');
}

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nMCP is not enabled (no mcp_servers configured).\n',
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
      return { handled: true, output: formatMcpServers(await control.list()) };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to list MCP servers:\n${formatClassifiedError(classifyError(error))}\n`,
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
      output: `\nFailed to list MCP servers:\n${formatClassifiedError(classifyError(error))}\n`,
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
      output: `\nFailed to reconnect MCP server "${name}":\n${formatClassifiedError(
        classifyError(error),
      )}\n`,
    };
  }
}

export function mcpCommand(): CommandEntry {
  return {
    name: 'mcp',
    description: 'MCP servers: status / reconnect',
    usage: '/mcp [reconnect <name>]',
    run: (args, ctx) => runMcpCommand(args, ctx),
  };
}
