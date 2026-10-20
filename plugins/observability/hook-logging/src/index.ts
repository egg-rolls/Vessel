/**
 * @vessel/hook-logging - 日志 Hook 插件
 * @module @vessel/hook-logging
 *
 * 记录 Agent 运行过程中的所有操作日志。默认写 stderr（stdout 留给命令结果），
 * 可注入 sink 替换输出目标；不记录 payload / 完整 ctx。
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
  /** 内存中最多保留的日志条数（默认 1000，超出丢最旧） */
  maxEntries?: number;
  /** 自定义日志格式器 */
  formatter?: (entry: LogEntry) => string;
  /** 输出 sink；缺省写 stderr（一行一条）。注入后不再写 stderr */
  sink?: (line: string) => void;
}

/** 默认保留条数 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * 日志文本脱敏：hook 不经过 guardrail，密钥必须在写日志前处理。
 * 只覆盖最常见的高置信模式，宁可少遮也不破坏正常文本。
 */
const LOG_REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-ant-***REDACTED***' },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-***REDACTED***' },
  { pattern: /bearer\s+[A-Za-z0-9._=~+/-]{16,}/gi, replacement: 'Bearer ***REDACTED***' },
  {
    pattern: /(api[_-]?key|password|secret)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
    replacement: '$1=***REDACTED***',
  },
  { pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g, replacement: '***REDACTED***' },
  {
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '***JWT-REDACTED***',
  },
];

/** 对日志文本做最小脱敏 */
function redactForLog(text: string): string {
  return LOG_REDACTION_RULES.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement),
    text,
  );
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
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      formatter: config.formatter,
      sink: config.sink,
    };
  }

  async run(ctx: HookContext): Promise<void> {
    // 不记录整个 ctx：HookContext 是开放字段，可能含 systemPrompt / 工具参数等敏感内容
    const entry: LogEntry = {
      level: 'info',
      message: 'LLM request initiated',
      timestamp: new Date(),
      run_id: ctx.run_id,
      session_id: ctx.session_id,
    };

    this.log(entry);
  }

  /**
   * 记录日志（写前脱敏；内存保留最近 maxEntries 条）
   */
  log(entry: LogEntry): void {
    if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[this.config.level ?? 'info']) {
      return;
    }

    const safeEntry: LogEntry = {
      ...entry,
      message: redactForLog(entry.message),
      data: undefined,
    };
    this.logs.push(safeEntry);

    const maxEntries = this.config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.logs.length > maxEntries) {
      this.logs.splice(0, this.logs.length - maxEntries);
    }

    const formatted = this.config.formatter
      ? this.config.formatter(safeEntry)
      : this.formatEntry(safeEntry);

    try {
      if (this.config.sink) {
        this.config.sink(formatted);
      } else {
        // stdout 只放 UX/结果/JSON；诊断日志固定走 stderr
        process.stderr.write(`${formatted}\n`);
      }
    } catch {
      // 日志 sink 故障不得影响 hook / run
    }
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
      run: async (ctx: HookContext): Promise<void> => {
        const entry: LogEntry = {
          level: 'info',
          message: 'Before LLM request',
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
      },
    },
    {
      ...hook,
      type: HookType.AfterLlm,
      name: 'logging-after-llm',
      run: async (ctx: HookContext): Promise<void> => {
        const entry: LogEntry = {
          level: 'info',
          message: 'After LLM response',
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
      },
    },
    {
      ...hook,
      type: HookType.BeforeTool,
      name: 'logging-before-tool',
      run: async (ctx: HookContext): Promise<void> => {
        const entry: LogEntry = {
          level: 'debug',
          message: `Before tool execution: ${(ctx as { tool_name?: string }).tool_name ?? 'unknown'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
      },
    },
    {
      ...hook,
      type: HookType.AfterTool,
      name: 'logging-after-tool',
      run: async (ctx: HookContext): Promise<void> => {
        const entry: LogEntry = {
          level: 'debug',
          message: `After tool execution: ${(ctx as { tool_name?: string }).tool_name ?? 'unknown'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
      },
    },
    {
      ...hook,
      type: HookType.OnError,
      name: 'logging-on-error',
      run: async (ctx: HookContext): Promise<void> => {
        const entry: LogEntry = {
          level: 'error',
          message: `Error: ${(ctx as { error?: string }).error ?? 'unknown error'}`,
          timestamp: new Date(),
          run_id: ctx.run_id,
          session_id: ctx.session_id,
        };
        hook.log(entry);
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
