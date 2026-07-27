/**
 * @vessel/hook-logging - 日志 Hook 插件
 * @module @vessel/hook-logging
 *
 * 记录 Agent 运行过程中的所有操作日志
 */

import type { Hook, HookContext, Plugin, PluginHost } from '@vessel/core';
import { HookType } from '@vessel/core';

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志 Hook 配置 */
export interface LoggingHookConfig {
  /** 最小日志级别 */
  level?: LogLevel;
  /** 是否记录时间戳 */
  timestamp?: boolean;
  /** 是否记录 run_id */
  includeRunId?: boolean;
  /** 自定义日志格式器 */
  formatter?: (entry: LogEntry) => string;
}

/** 日志条目 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  run_id?: string;
  session_id?: string;
  data?: unknown;
}

/** 日志级别优先级 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 日志 Hook 实现
 */
export class LoggingHook implements Hook {
  name = 'logging-hook';
  type = HookType.BeforeLlm;
  priority = 200;

  private config: LoggingHookConfig;
  private logs: LogEntry[] = [];

  constructor(config: LoggingHookConfig = {}) {
    this.config = {
      level: config.level ?? 'info',
      timestamp: config.timestamp ?? true,
      includeRunId: config.includeRunId ?? true,
      formatter: config.formatter,
    };
  }

  async run(ctx: HookContext): Promise<HookContext | null> {
    const entry: LogEntry = {
      level: 'info',
      message: 'LLM request initiated',
      timestamp: new Date(),
      run_id: ctx.run_id,
      session_id: ctx.session_id,
      data: ctx,
    };

    this.log(entry);
    return ctx;
  }

  /**
   * 记录日志
   */
  private log(entry: LogEntry): void {
    if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[this.config.level!]) {
      return;
    }

    this.logs.push(entry);

    const formatted = this.config.formatter
      ? this.config.formatter(entry)
      : this.formatEntry(entry);

    console.log(formatted);
  }

  /**
   * 格式化日志条目
   */
  private formatEntry(entry: LogEntry): string {
    const parts: string[] = [];

    if (this.config.timestamp) {
      parts.push(`[${entry.timestamp.toISOString()}]`);
    }

    parts.push(`[${entry.level.toUpperCase()}]`);

    if (this.config.includeRunId && entry.run_id) {
      parts.push(`[run:${entry.run_id.substring(0, 8)}]`);
    }

    parts.push(entry.message);

    return parts.join(' ');
  }

  /**
   * 获取所有日志
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * 清空日志
   */
  clearLogs(): void {
    this.logs = [];
  }
}

/**
 * 创建所有日志 Hooks
 */
export function createLoggingHooks(config: LoggingHookConfig = {}): Hook[] {
  const hook = new LoggingHook(config);

  return [
    {
      ...hook,
      type: HookType.BeforeLlm,
      name: 'logging-before-llm',
      run: async (ctx: HookContext) => {
        const entry: LogEntry = {
          level: 'info',
          message: 'Before LLM request',
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
        return ctx;
      },
    },
    {
      ...hook,
      type: HookType.AfterLlm,
      name: 'logging-after-llm',
      run: async (ctx: HookContext) => {
        const entry: LogEntry = {
          level: 'info',
          message: 'After LLM response',
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
        return ctx;
      },
    },
    {
      ...hook,
      type: HookType.BeforeTool,
      name: 'logging-before-tool',
      run: async (ctx: HookContext) => {
        const entry: LogEntry = {
          level: 'debug',
          message: `Before tool execution: ${(ctx as { tool_name?: string }).tool_name ?? 'unknown'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
        return ctx;
      },
    },
    {
      ...hook,
      type: HookType.AfterTool,
      name: 'logging-after-tool',
      run: async (ctx: HookContext) => {
        const entry: LogEntry = {
          level: 'debug',
          message: `After tool execution: ${(ctx as { tool_name?: string }).tool_name ?? 'unknown'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
        return ctx;
      },
    },
    {
      ...hook,
      type: HookType.OnError,
      name: 'logging-on-error',
      run: async (ctx: HookContext) => {
        const entry: LogEntry = {
          level: 'error',
          message: `Error: ${(ctx as { error?: string }).error ?? 'unknown error'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
        return ctx;
      },
    },
  ];
}

/**
 * 日志 Hook 插件
 */
export const loggingHookPlugin: Plugin = {
  name: 'hook-logging',
  version: '0.1.0',
  description: 'Logging hooks for debugging and monitoring',
  install(host: PluginHost) {
    const hooks = createLoggingHooks();
    for (const hook of hooks) {
      host.registerHook(hook);
    }
  },
};

export default loggingHookPlugin;
