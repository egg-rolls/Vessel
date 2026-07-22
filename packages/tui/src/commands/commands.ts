/**
 * 斜杠命令处理
 * @module @vessel/tui
 */

import type { AgentRuntime, ToolRegistry, SessionBackend } from '@vessel/core';

/** 命令处理器 */
export interface CommandHandler {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[]) => Promise<void> | void;
}

/** 命令注册表 */
export class CommandRegistry {
  private commands: Map<string, CommandHandler> = new Map();

  /**
   * 注册命令
   * @param handler 命令处理器
   */
  register(handler: CommandHandler): void {
    this.commands.set(handler.name, handler);
  }

  /**
   * 执行命令
   * @param command 命令字符串（以 / 开头）
   * @returns 是否找到并执行了命令
   */
  async execute(command: string): Promise<boolean> {
    const [name, ...args] = command.split(' ');
    
    // 移除开头的 /
    const cmdName = name.startsWith('/') ? name.substring(1) : name;
    
    const handler = this.commands.get(cmdName);
    if (!handler) {
      return false;
    }

    await handler.execute(args);
    return true;
  }

  /**
   * 获取所有命令
   * @returns 命令处理器数组
   */
  list(): CommandHandler[] {
    return Array.from(this.commands.values());
  }

  /**
   * 检查命令是否存在
   * @param name 命令名称
   * @returns 是否存在
   */
  has(name: string): boolean {
    return this.commands.has(name);
  }
}

/**
 * 创建默认命令
 */
export function createDefaultCommands(context: {
  runtime?: AgentRuntime;
  tools?: ToolRegistry;
  session?: SessionBackend;
  sessionId?: string;
}): CommandHandler[] {
  return [
    {
      name: 'help',
      description: 'Show available commands',
      usage: '/help [command]',
      execute: (args) => {
        if (args.length > 0) {
          console.log(`Help for command: ${args[0]}`);
          // TODO: 显示特定命令的帮助
        } else {
          console.log('\nAvailable commands:');
          console.log('  /help     - Show this help message');
          console.log('  /tools    - List available tools');
          console.log('  /session  - Show session information');
          console.log('  /clear    - Clear the screen');
          console.log('  /history  - Show conversation history');
          console.log('  /reset    - Reset current session');
          console.log('  /exit     - Exit the application');
          console.log('\nType /help <command> for more info on a specific command.');
        }
      },
    },
    {
      name: 'tools',
      description: 'List available tools',
      execute: () => {
        if (!context.tools) {
          console.log('No tools available.');
          return;
        }

        const toolList = context.tools.list();
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
    },
    {
      name: 'session',
      description: 'Show session information',
      execute: async () => {
        const sessionId = context.sessionId ?? 'default';
        console.log(`\nSession: ${sessionId}`);
        
        if (context.session) {
          const state = await context.session.load(sessionId);
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
      },
    },
    {
      name: 'clear',
      description: 'Clear the screen',
      execute: () => {
        console.clear();
      },
    },
    {
      name: 'history',
      description: 'Show conversation history',
      execute: async () => {
        const sessionId = context.sessionId ?? 'default';
        
        if (context.session) {
          const state = await context.session.load(sessionId);
          if (state && state.messages.length > 0) {
            console.log('\nConversation history:');
            for (const msg of state.messages) {
              const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
              console.log(`\n[${role}]:`);
              console.log(msg.content);
            }
          } else {
            console.log('No conversation history.');
          }
        }
      },
    },
    {
      name: 'reset',
      description: 'Reset current session',
      execute: async () => {
        const sessionId = context.sessionId ?? 'default';
        
        if (context.session) {
          await context.session.delete(sessionId);
          console.log(`Session ${sessionId} has been reset.`);
        }
      },
    },
    {
      name: 'exit',
      description: 'Exit the application',
      execute: () => {
        console.log('Goodbye!');
        process.exit(0);
      },
    },
  ];
}
