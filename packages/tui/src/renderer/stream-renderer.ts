/**
 * 流式渲染器
 * @module @vessel/tui
 */

import type { EventStream, RunEvent } from '@vessel/core';
import { EventType } from '@vessel/core';

/** 渲染器配置 */
export interface StreamRendererConfig {
  /** 是否显示时间戳 */
  showTimestamp?: boolean;
  /** 是否显示事件类型 */
  showEventType?: boolean;
  /** 是否显示工具调用详情 */
  showToolDetails?: boolean;
  /** 是否启用颜色 */
  enableColors?: boolean;
}

/** 默认配置 */
const DEFAULT_CONFIG: StreamRendererConfig = {
  showTimestamp: false,
  showEventType: false,
  showToolDetails: true,
  enableColors: true,
};

/**
 * 流式渲染器
 * 订阅事件流并实时渲染到控制台
 */
export class StreamRenderer {
  private config: StreamRendererConfig;
  private unsubscribe?: () => void;
  private isRendering = false;

  constructor(config: StreamRendererConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 开始渲染事件流
   */
  start(eventStream: EventStream): void {
    if (this.isRendering) {
      return;
    }

    this.isRendering = true;
    this.unsubscribe = eventStream.subscribe((event) => this.handleEvent(event));
  }

  /**
   * 停止渲染
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.isRendering = false;
  }

  /**
   * 处理事件
   */
  private handleEvent(event: RunEvent): void {
    switch (event.type) {
      case EventType.RunStarted:
        this.renderRunStarted(event);
        break;
      case EventType.LlmRequest:
        this.renderLlmRequest(event);
        break;
      case EventType.LlmResponse:
        this.renderLlmResponse(event);
        break;
      case EventType.ToolCallStarted:
        this.renderToolCallStarted(event);
        break;
      case EventType.ToolCallCompleted:
        this.renderToolCallCompleted(event);
        break;
      case EventType.ToolCallFailed:
        this.renderToolCallFailed(event);
        break;
      case EventType.GuardrailBlocked:
        this.renderGuardrailBlocked(event);
        break;
      case EventType.RunCompleted:
        this.renderRunCompleted(event);
        break;
      case EventType.RunFailed:
        this.renderRunFailed(event);
        break;
    }
  }

  /**
   * 渲染 Run 开始事件
   */
  private renderRunStarted(event: RunEvent): void {
    const data = event.data as { run_id: string; input: string };
    console.log(`\n${this.colorize('cyan', '━━━ Run Started ━━━')}`);
    if (this.config.showEventType) {
      console.log(this.colorize('gray', `[${event.type}]`));
    }
    console.log(this.colorize('white', `Input: ${data.input}`));
  }

  /**
   * 渲染 LLM 请求事件
   */
  private renderLlmRequest(event: RunEvent): void {
    if (this.config.showEventType) {
      console.log(this.colorize('gray', `[${event.type}] Sending request to LLM...`));
    } else {
      console.log(this.colorize('yellow', '⏳ Sending request to LLM...'));
    }
  }

  /**
   * 渲染 LLM 响应事件
   */
  private renderLlmResponse(event: RunEvent): void {
    const data = event.data as { content?: string; tool_calls?: unknown[]; finish_reason: string };

    if (data.finish_reason === 'tool_calls') {
      console.log(this.colorize('yellow', '🔧 LLM requested tool calls'));
    } else if (data.content) {
      console.log(this.colorize('green', '\nAssistant:'));
      console.log(this.colorize('white', data.content));
    }
  }

  /**
   * 渲染工具调用开始事件
   */
  private renderToolCallStarted(event: RunEvent): void {
    const data = event.data as { tool_name: string; arguments: unknown };
    if (this.config.showToolDetails) {
      console.log(this.colorize('blue', `\n🔧 Calling tool: ${data.tool_name}`));
      console.log(this.colorize('gray', `   Arguments: ${JSON.stringify(data.arguments)}`));
    } else {
      console.log(this.colorize('blue', `🔧 ${data.tool_name}...`));
    }
  }

  /**
   * 渲染工具调用完成事件
   */
  private renderToolCallCompleted(event: RunEvent): void {
    const data = event.data as { tool_name: string; result: string; duration_ms: number };
    if (this.config.showToolDetails) {
      console.log(
        this.colorize('green', `   ✓ ${data.tool_name} completed in ${data.duration_ms}ms`),
      );
    }
  }

  /**
   * 渲染工具调用失败事件
   */
  private renderToolCallFailed(event: RunEvent): void {
    const data = event.data as { tool_name: string; error: string };
    console.log(this.colorize('red', `   ✗ ${data.tool_name} failed: ${data.error}`));
  }

  /**
   * 渲染 Guardrail 阻止事件
   */
  private renderGuardrailBlocked(event: RunEvent): void {
    const data = event.data as { guardrail_name: string; reason: string };
    console.log(this.colorize('red', `🚫 Guardrail blocked: ${data.reason}`));
  }

  /**
   * 渲染 Run 完成事件
   */
  private renderRunCompleted(event: RunEvent): void {
    const data = event.data as {
      duration_ms: number;
      iterations: number;
      usage?: { total_tokens?: number };
    };
    console.log(this.colorize('cyan', '\n━━━ Run Completed ━━━'));
    console.log(
      this.colorize('gray', `Duration: ${data.duration_ms}ms | Iterations: ${data.iterations}`),
    );
    if (data.usage?.total_tokens) {
      console.log(this.colorize('gray', `Tokens used: ${data.usage.total_tokens}`));
    }
  }

  /**
   * 渲染 Run 失败事件
   */
  private renderRunFailed(event: RunEvent): void {
    const data = event.data as { error: string; duration_ms: number };
    console.log(this.colorize('red', '\n━━━ Run Failed ━━━'));
    console.log(this.colorize('red', `Error: ${data.error}`));
    console.log(this.colorize('gray', `Duration: ${data.duration_ms}ms`));
  }

  /**
   * 应用颜色
   */
  private colorize(color: string, text: string): string {
    if (!this.config.enableColors) {
      return text;
    }

    const colors: Record<string, string> = {
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      gray: '\x1b[90m',
      reset: '\x1b[0m',
    };

    return `${colors[color] ?? ''}${text}${colors.reset}`;
  }
}
