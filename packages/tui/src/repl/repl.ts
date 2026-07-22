/**
 * REPL 实现
 * @module @vessel/tui
 */

import type { AgentRuntime } from '@vessel/core';
import type { RunEvent } from '@vessel/core';
import { EventType } from '@vessel/core';

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

  constructor(runtime: AgentRuntime, config: REPLConfig = {}) {
    this.runtime = runtime;
    this.config = {
      prompt: config.prompt ?? 'vessel> ',
      welcomeMessage: config.welcomeMessage ?? 'Welcome to Vessel! Type your message or /help for commands.',
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

    // 订阅事件流以显示进度
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

        // 检查斜杠命令
        if (input.startsWith('/')) {
          await this.handleCommand(input);
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
   * 处理斜杠命令
   */
  private async handleCommand(command: string): Promise<void> {
    const [cmd, ...args] = command.split(' ');

    switch (cmd) {
      case '/help':
        this.showHelp();
        break;
      case '/tools':
        this.showTools();
        break;
      case '/session':
        this.showSession();
        break;
      case '/clear':
        console.clear();
        break;
      case '/history':
        this.showHistory();
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type /help for available commands.`);
    }
  }

  /**
   * 显示帮助信息
   */
  private showHelp(): void {
    console.log(`
Available commands:
  /help     - Show this help message
  /tools    - List available tools
  /session  - Show session information
  /clear    - Clear the screen
  /history  - Show command history
  /exit     - Exit the REPL
    `);
  }

  /**
   * 显示可用工具
   */
  private showTools(): void {
    const { tools } = this.getRuntimeComponents();
    const toolList = tools.list();
    
    if (toolList.length === 0) {
      console.log('No tools available.');
      return;
    }

    console.log('Available tools:');
    for (const tool of toolList) {
      console.log(`  - ${tool.name}: ${tool.description}`);
    }
  }

  /**
   * 显示会话信息
   */
  private showSession(): void {
    console.log(`Session ID: ${this.state.sessionId}`);
    console.log(`History length: ${this.state.history.length}`);
  }

  /**
   * 显示历史记录
   */
  private showHistory(): void {
    if (this.state.history.length === 0) {
      console.log('No history yet.');
      return;
    }

    console.log('History:');
    for (const [index, entry] of this.state.history.entries()) {
      console.log(`  ${index + 1}. ${entry}`);
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
  private getRuntimeComponents(): { events: import('@vessel/core').EventStream; tools: import('@vessel/core').ToolRegistry } {
    // 这里需要从 runtime 中获取 events 和 tools
    // 由于 AgentRuntime 没有暴露这些，我们需要修改实现
    // 暂时返回模拟对象
    return {
      events: {
        subscribe: () => () => {},
        publish: () => {},
        clear: () => {},
      },
      tools: {
        register: () => {},
        invoke: async () => '',
        schemas: () => [],
        get: () => undefined,
        has: () => false,
        list: () => [],
      },
    };
  }
}
