/**
 * REPL 实现
 * @module @vessel/tui
 */

import type { AgentRuntime, EventStream, RunEvent, ToolRegistry } from '@vessel/core';
import { EventType } from '@vessel/core';
import type { CommandRegistry } from '../commands/commands.js';

/** REPL 配置 */
export interface REPLConfig {
  prompt?: string;
  welcomeMessage?: string;
  exitCommands?: string[];
}

/** REPL 状态 */
export interface REPLState {
  running: boolean;
  sessionId: string;
  history: string[];
}

/**
 * 命令行 REPL 实现
 */
export class CLI_REPL {
  private runtime: AgentRuntime;
  private config: REPLConfig;
  private state: REPLState;
  private commands: CommandRegistry;

  constructor(runtime: AgentRuntime, commands: CommandRegistry, config: REPLConfig = {}) {
    this.runtime = runtime;
    this.commands = commands;
    this.config = {
      prompt: config.prompt ?? 'vessel> ',
      welcomeMessage:
        config.welcomeMessage ?? 'Welcome to Vessel! Type your message or /help for commands.',
      exitCommands: config.exitCommands ?? ['/exit', '/quit', 'exit', 'quit'],
    };
    this.state = {
      running: false,
      sessionId: crypto.randomUUID(),
      history: [],
    };
  }

  /**
   * 启动 REPL
   */
  async start(): Promise<void> {
    this.state.running = true;
    console.log(this.config.welcomeMessage);

    const { events } = this.getRuntimeComponents();
    const unsubscribe = events.subscribe((event: RunEvent) => {
      this.handleEvent(event);
    });

    try {
      while (this.state.running) {
        const input = await this.prompt();

        if (!input.trim()) {
          continue;
        }

        // 检查退出命令
        if (this.config.exitCommands?.includes(input.toLowerCase())) {
          this.state.running = false;
          console.log('Goodbye!');
          break;
        }

        // 斜杠命令 → 委托给 CommandRegistry
        if (input.startsWith('/')) {
          const handled = await this.commands.execute(input);
          if (!handled) {
            console.log('Unknown command. Type /help for available commands.');
          }
          continue;
        }

        // 处理普通消息
        await this.handleMessage(input);
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * 停止 REPL
   */
  stop(): void {
    this.state.running = false;
  }

  /**
   * 显示提示符并获取输入
   */
  private async prompt(): Promise<string> {
    process.stdout.write(this.config.prompt ?? 'vessel> ');

    return new Promise((resolve) => {
      process.stdin.setEncoding('utf-8');
      process.stdin.once('data', (data: string) => {
        resolve(data.trim());
      });
    });
  }

  /**
   * 处理普通消息
   */
  private async handleMessage(input: string): Promise<void> {
    this.state.history.push(input);

    try {
      console.log('Thinking...');
      const response = await this.runtime.run(input, this.state.sessionId);
      console.log(`\n${response}\n`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 处理事件
   */
  private handleEvent(event: RunEvent): void {
    switch (event.type) {
      case EventType.LlmRequest:
        console.log('Sending request to LLM...');
        break;
      case EventType.LlmResponse:
        console.log('Received response from LLM.');
        break;
      case EventType.ToolCallStarted:
        console.log(`Calling tool: ${(event.data as { tool_name: string }).tool_name}...`);
        break;
      case EventType.ToolCallCompleted:
        console.log(`Tool completed: ${(event.data as { tool_name: string }).tool_name}`);
        break;
      case EventType.ToolCallFailed:
        console.log(`Tool failed: ${(event.data as { tool_name: string }).tool_name}`);
        break;
    }
  }

  /**
   * 获取运行时组件
   */
  private getRuntimeComponents(): {
    events: EventStream;
    tools: ToolRegistry;
  } {
    const rt = this.runtime as AgentRuntime & {
      _events?: EventStream;
      _tools?: ToolRegistry;
    };
    return {
      events:
        rt._events ??
        ({
          subscribe: () => () => {},
          publish: () => {},
          clear: () => {},
        } as unknown as EventStream),
      tools:
        rt._tools ??
        ({
          register: () => {},
          invoke: async () => '',
          schemas: () => [],
          get: () => undefined,
          has: () => false,
          list: () => [],
        } as unknown as ToolRegistry),
    };
  }
}
