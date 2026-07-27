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

/**
 * startRepl — 交互式 REPL 入口（emma 实现）
 *
 * 契约（与 egg-rolls 的接缝）：
 * 壳（cli.ts）构造 ReplContext → 调 startRepl(ctx) → 阻塞至 /exit。
 * REPL 从 ctx 拿 runtime/session/events/tools，实现所有交互。
 *
 * emma 负责：
 * - readline/Ink REPL 循环 + 历史 + 行编辑 + 多行
 * - CC 风格 slash 命令（/ 弹菜单 + 模糊过滤 + autocomplete）
 * - StreamRenderer 订阅 ctx.events（token-by-token + 工具卡片 + spinner）
 * - 首启向导 UX 打磨、工具权限弹窗 UI
 * - 状态栏（banner / provider / model / session / plugins）
 * - 保留 Hermes /resume 的 pending one-shot 模式
 * - /help、/sessions、/new、/history、/clear、/setup、/exit
 *
 * egg-rolls 负责（壳，不在此函数内）：
 * - CLI arg 解析、config 加载、provider 构造
 * - runtime 组件（tools/context/events/session）构造 + 插件加载
 * - 构造 ReplContext → 调本函数
 * - Headless --run 路径（不经过本函数）
 * - 工具权限 guardrail 注册（ToolPermissionChecker，弹窗 UI 由 emma 做）
 *
 * 调用示例（壳）：
 *   const ctx = { runtime, tools, session, events,
 *     currentSessionId,
 *     onSessionChange: (id) => { currentSessionId = id; },
 *     provider: { name, model, baseUrl },
 *     plugins: plugins.map(p => p.name),
 *     config, newSessionId,
 *     onExit: () => { runtime.dispose(); process.exit(0); },
 *   };
 *   await startRepl(ctx);
 */
export async function startRepl(_ctx: import('../repl-context.js').ReplContext): Promise<void> {
  // TODO: emma 实现 REPL 循环
  throw new Error('startRepl: not implemented — emma owns this function');
}
