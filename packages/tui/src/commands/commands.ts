/**
 * 斜杠命令处理（层次化子命令模式）
 * @module @vessel/tui
 *
 * 命令格式: /<domain> [action] [args...]
 * 示例: /session list, /session switch <id>, /trace replay <id>
 */

import { EventType } from '@vessel/core';
import type {
  AgentRuntime,
  EventStream,
  RunEvent,
  SessionBackend,
  ToolRegistry,
} from '@vessel/core';

// ── 类型 ──────────────────────────────────────────

/** 子命令定义 */
export interface SubCommand {
  /** 子命令名（如 "list", "switch"） */
  name: string;
  /** 描述 */
  description: string;
  /** 用法提示 */
  usage?: string;
  /** 执行函数 */
  execute: (args: string[]) => Promise<void> | void;
}

/** 命令处理器（支持子命令） */
export interface CommandHandler {
  /** 命令名（域） */
  name: string;
  /** 命令描述 */
  description: string;
  /** 用法提示 */
  usage?: string;
  /** 默认执行（不带子命令时调用） */
  execute: (args: string[]) => Promise<void> | void;
  /** 子命令映射 */
  subcommands?: Map<string, SubCommand>;
}

/** 命令注册表 */
export class CommandRegistry {
  private commands: Map<string, CommandHandler> = new Map();

  /**
   * 注册命令
   */
  register(handler: CommandHandler): void {
    this.commands.set(handler.name, handler);
  }

  /**
   * 批量注册
   */
  registerAll(handlers: CommandHandler[]): void {
    for (const h of handlers) {
      this.register(h);
    }
  }

  /**
   * 执行命令。支持 /domain action args 格式。
   * @returns 是否找到并执行了命令
   */
  async execute(command: string): Promise<boolean> {
    // 移除开头的 / 并按空格分割
    const trimmed = command.startsWith('/') ? command.slice(1) : command;
    const parts = trimmed.split(/\s+/);
    const domain = parts[0];
    if (!domain) {
      return false;
    }
    const action = parts[1];
    const args = parts.slice(2);

    const handler = this.commands.get(domain);
    if (!handler) {
      return false;
    }

    // 有子命令且 action 匹配子命令
    if (action && handler.subcommands?.has(action)) {
      await handler.subcommands.get(action)?.execute(args);
      return true;
    }

    // 无 action 或 action 不匹配子命令 → 默认执行
    // 把 action 和 args 作为整体传给默认执行
    const allArgs = action ? [action, ...args] : [];
    await handler.execute(allArgs);
    return true;
  }

  /**
   * 获取所有命令（用于帮助）
   */
  list(): CommandHandler[] {
    return Array.from(this.commands.values());
  }

  /**
   * 检查命令是否存在
   */
  has(name: string): boolean {
    return this.commands.has(name);
  }
}

// ── 命令上下文 ────────────────────────────────────

export interface CommandContext {
  runtime?: AgentRuntime;
  tools?: ToolRegistry;
  session?: SessionBackend;
  /** 当前 session ID 的可变引用 */
  currentSessionId: { value: string };
  events?: EventStream & { getHistory(runId?: string): RunEvent[] };
}

// ── 默认命令工厂 ──────────────────────────────────

export function createDefaultCommands(ctx: CommandContext): CommandHandler[] {
  return [
    createSessionCommands(ctx),
    createTraceCommands(ctx),
    createToolsCommand(ctx),
    createHelpCommand(ctx),
    createClearCommand(),
    createExitCommand(),
  ];
}

// ── /session ──────────────────────────────────────

function createSessionCommands(ctx: CommandContext): CommandHandler {
  const subcommands = new Map<string, SubCommand>();

  subcommands.set('list', {
    name: 'list',
    description: '列出所有会话',
    usage: '/session list',
    execute: async () => {
      if (!ctx.session) {
        console.log('Session backend not available.');
        return;
      }
      const ids = await ctx.session.list();
      if (ids.length === 0) {
        console.log('No sessions found.');
        return;
      }
      console.log(`\nSessions (${ids.length}):`);
      for (const id of ids) {
        const marker = id === ctx.currentSessionId.value ? ' * (current)' : '';
        const state = await ctx.session.load(id);
        const msgCount = state?.messages.length ?? 0;
        const status = state?.status ?? 'unknown';
        console.log(`  ${id} — ${msgCount} messages, ${status}${marker}`);
      }
    },
  });

  subcommands.set('switch', {
    name: 'switch',
    description: '切换到指定会话',
    usage: '/session switch <session_id>',
    execute: async (args: string[]) => {
      const sessionId = args[0];
      if (!sessionId) {
        console.log('Usage: /session switch <session_id>');
        return;
      }
      if (!ctx.session) {
        console.log('Session backend not available.');
        return;
      }
      const state = await ctx.session.load(sessionId);
      if (!state) {
        console.log(`Session "${sessionId}" not found.`);
        return;
      }
      ctx.currentSessionId.value = sessionId;
      console.log(`Switched to session "${sessionId}" (${state.messages.length} messages)`);
    },
  });

  subcommands.set('delete', {
    name: 'delete',
    description: '删除指定会话',
    usage: '/session delete <session_id>',
    execute: async (args: string[]) => {
      const sessionId = args[0];
      if (!sessionId) {
        console.log('Usage: /session delete <session_id>');
        return;
      }
      if (!ctx.session) {
        console.log('Session backend not available.');
        return;
      }
      if (sessionId === ctx.currentSessionId.value) {
        console.log(
          'Cannot delete the current session. Switch to another first (/session switch <id>).',
        );
        return;
      }
      await ctx.session.delete(sessionId);
      console.log(`Session "${sessionId}" deleted.`);
    },
  });

  subcommands.set('reset', {
    name: 'reset',
    description: '重置当前会话',
    usage: '/session reset',
    execute: async () => {
      if (!ctx.session) {
        console.log('Session backend not available.');
        return;
      }
      const id = ctx.currentSessionId.value;
      await ctx.session.delete(id);
      console.log(`Session "${id}" has been reset.`);
    },
  });

  subcommands.set('history', {
    name: 'history',
    description: '显示当前会话的对话历史',
    usage: '/session history',
    execute: async () => {
      if (!ctx.session) {
        console.log('Session backend not available.');
        return;
      }
      const id = ctx.currentSessionId.value;
      const state = await ctx.session.load(id);
      if (!state || state.messages.length === 0) {
        console.log('No conversation history.');
        return;
      }
      console.log('\nConversation history:');
      for (const msg of state.messages) {
        const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        console.log(`\n[${role}]:`);
        console.log(msg.content);
      }
    },
  });

  return {
    name: 'session',
    description: '会话管理：查看/切换/删除/重置会话',
    usage: '/session [list|switch|delete|reset|history]',
    execute: async () => {
      // 默认：显示当前会话信息
      const id = ctx.currentSessionId.value ?? 'default';
      console.log(`\nSession: ${id}`);

      if (ctx.session) {
        const state = await ctx.session.load(id);
        if (state) {
          console.log(`Status: ${state.status}`);
          console.log(`Messages: ${state.messages.length}`);
          console.log(`Started: ${new Date(state.started_at).toLocaleString()}`);
          if (state.completed_at) {
            console.log(`Completed: ${new Date(state.completed_at).toLocaleString()}`);
          }
          if (state.usage) {
            console.log(`Tokens: ${state.usage.total_tokens}`);
          }
        } else {
          console.log('No session data found.');
        }
      }

      // 显示可用子命令
      console.log('\nSubcommands:');
      for (const [name, sub] of subcommands) {
        console.log(`  /session ${name.padEnd(8)} — ${sub.description}`);
      }
    },
    subcommands,
  };
}

// ── /trace ────────────────────────────────────────

function createTraceCommands(ctx: CommandContext): CommandHandler {
  const subcommands = new Map<string, SubCommand>();

  subcommands.set('replay', {
    name: 'replay',
    description: '回放指定 run 的事件',
    usage: '/trace replay <run_id>',
    execute: (args: string[]) => {
      const runId = args[0];
      if (!runId) {
        console.log('Usage: /trace replay <run_id>');
        return;
      }
      if (!ctx.events) {
        console.log('Event stream not available.');
        return;
      }
      const events = ctx.events.getHistory(runId);
      if (events.length === 0) {
        console.log(`No events found for run "${runId}".`);
        return;
      }

      console.log(`\nReplaying ${events.length} events for run "${runId}":\n`);

      for (const event of events) {
        const time = new Date(event.ts).toISOString().slice(11, 23);
        const typeLabel = event.type.replace(/_/g, ' ').toLowerCase();

        console.log(`  [${time}] ${typeLabel}`);

        if (
          event.type === EventType.ToolCallStarted ||
          event.type === EventType.ToolCallCompleted
        ) {
          const data = event.data as {
            tool_name?: string;
            result?: string;
            error?: string;
          };
          if (data.tool_name) {
            console.log(`    tool: ${data.tool_name}`);
          }
          if (data.result && data.result.length < 200) {
            console.log(`    result: ${data.result}`);
          }
          if (data.error) {
            console.log(`    error: ${data.error}`);
          }
        }

        if (event.type === EventType.LlmResponse) {
          const data = event.data as {
            content?: string;
            finish_reason?: string;
          };
          if (data.content && data.content.length > 0) {
            const preview =
              data.content.length > 150 ? `${data.content.slice(0, 150)}...` : data.content;
            console.log(`    content: ${preview}`);
          }
          if (data.finish_reason) {
            console.log(`    finish: ${data.finish_reason}`);
          }
        }
      }

      console.log('\nReplay complete.');
    },
  });

  subcommands.set('export', {
    name: 'export',
    description: '导出 run trace 为 JSON 文件',
    usage: '/trace export <run_id> [file_path]',
    execute: async (args: string[]) => {
      const runId = args[0];
      if (!runId) {
        console.log('Usage: /trace export <run_id> [file_path]');
        return;
      }
      if (!ctx.events) {
        console.log('Event stream not available.');
        return;
      }
      const events = ctx.events.getHistory(runId);
      if (events.length === 0) {
        console.log(`No events found for run "${runId}".`);
        return;
      }

      const outputPath = args[1] ?? `trace-${runId}.json`;
      const traceData = {
        run_id: runId,
        exported_at: new Date().toISOString(),
        event_count: events.length,
        events: events.map((e) => ({
          type: e.type,
          ts: e.ts,
          data: e.data,
        })),
      };

      try {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(outputPath, JSON.stringify(traceData, null, 2), 'utf-8');
        console.log(`Trace exported: ${outputPath} (${events.length} events)`);
      } catch (err) {
        console.log(`Export failed: ${err}`);
      }
    },
  });

  return {
    name: 'trace',
    description: 'Trace 回放与导出',
    usage: '/trace [replay|export]',
    execute: async () => {
      console.log('\nTrace commands:');
      for (const [name, sub] of subcommands) {
        console.log(`  /trace ${name.padEnd(8)} — ${sub.description}`);
      }
    },
    subcommands,
  };
}

// ── /tools ────────────────────────────────────────

function createToolsCommand(ctx: CommandContext): CommandHandler {
  return {
    name: 'tools',
    description: '列出可用工具',
    execute: () => {
      if (!ctx.tools) {
        console.log('No tools available.');
        return;
      }
      const toolList = ctx.tools.list();
      if (toolList.length === 0) {
        console.log('No tools registered.');
        return;
      }
      console.log('\nAvailable tools:');
      for (const tool of toolList) {
        console.log(`  - ${tool.name}: ${tool.description}`);
      }
      console.log(`\nTotal: ${toolList.length} tool(s)`);
    },
  };
}

// ── /help ─────────────────────────────────────────

function createHelpCommand(_ctx: CommandContext): CommandHandler {
  return {
    name: 'help',
    description: '显示帮助信息',
    usage: '/help [command]',
    execute: (args: string[]) => {
      if (args.length > 0) {
        const domain = args[0];
        console.log(`Help for: ${domain}`);
        console.log('(detailed command help coming soon)');
        return;
      }

      console.log('\nAvailable commands:');
      console.log('  /session [list|switch|delete|reset|history]  — 会话管理');
      console.log('  /trace  [replay|export]                 — Trace 回放与导出');
      console.log('  /tools                                   — 列出可用工具');
      console.log('  /help  [command]                         — 显示帮助');
      console.log('  /clear                                   — 清屏');
      console.log('  /exit                                    — 退出');
      console.log('\nType /<command> for more details on subcommands.');
    },
  };
}

// ── /clear ────────────────────────────────────────

function createClearCommand(): CommandHandler {
  return {
    name: 'clear',
    description: '清屏',
    execute: () => {
      console.clear();
    },
  };
}

// ── /exit ─────────────────────────────────────────

function createExitCommand(): CommandHandler {
  return {
    name: 'exit',
    description: '退出应用',
    execute: () => {
      console.log('Goodbye!');
      process.exit(0);
    },
  };
}
