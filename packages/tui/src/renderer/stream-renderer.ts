/**
 * 流式渲染器（egg-rolls 基础版）
 * @module @vessel/tui
 *
 * 订阅 EventStream，token-by-token 打印 LlmStreamChunk.text_delta；
 * 打印工具调用卡片；RunCompleted 收尾换行。
 * REPL 用 didStreamLastRun() 判断是否需要兜底打印 run() 返回值（非流式 provider）。
 * emma 后续替换为 token 动画 + spinner + 富文本，订阅同一事件流。
 */

import type { EventStream, RunEvent, StreamChunk } from '@vessel/core';
import { EventType } from '@vessel/core';

/** 渲染器配置 */
export interface StreamRendererConfig {
  /** 是否启用颜色 */
  enableColors?: boolean;
  /** 是否显示工具调用详情（参数） */
  showToolDetails?: boolean;
}

const DEFAULT_CONFIG: StreamRendererConfig = {
  enableColors: true,
  showToolDetails: true,
};

const C = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
};

export class StreamRenderer {
  private cfg: StreamRendererConfig;
  private unsubscribe?: () => void;
  private streamedAny = false;
  private lastRunStreamed = false;

  constructor(config: StreamRendererConfig = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /** 开始订阅事件流 */
  start(eventStream: EventStream): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventStream.subscribe((e) => this.handleEvent(e));
  }

  /** 停止订阅 */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /** 上一个 run 是否流式输出了文本--供 REPL 决定是否兜底打印 run() 返回值 */
  didStreamLastRun(): boolean {
    return this.lastRunStreamed;
  }

  private handleEvent(event: RunEvent): void {
    switch (event.type) {
      case EventType.RunStarted: {
        this.streamedAny = false;
        break;
      }
      case EventType.LlmStreamChunk: {
        const data = event.data as { chunk: StreamChunk };
        this.handleChunk(data.chunk);
        break;
      }
      case EventType.ToolCallStarted: {
        this.renderToolCallStarted(event);
        break;
      }
      case EventType.ToolCallCompleted: {
        this.renderToolCallCompleted(event);
        break;
      }
      case EventType.ToolCallFailed: {
        this.renderToolCallFailed(event);
        break;
      }
      case EventType.GuardrailBlocked: {
        const data = event.data as { reason: string };
        process.stdout.write(`${this.color('red', `\n🚫 Blocked: ${data.reason}\n`)}`);
        break;
      }
      case EventType.RunCompleted: {
        this.lastRunStreamed = this.streamedAny;
        if (this.streamedAny) process.stdout.write('\n');
        break;
      }
      case EventType.RunFailed: {
        this.lastRunStreamed = this.streamedAny;
        const data = event.data as { error: string };
        if (!this.streamedAny) process.stdout.write('\n');
        process.stdout.write(this.color('red', `✗ Run failed: ${data.error}\n`));
        break;
      }
      default:
        break;
    }
  }

  private handleChunk(chunk: StreamChunk): void {
    if (chunk.type === 'text_delta' && chunk.delta) {
      process.stdout.write(chunk.delta);
      this.streamedAny = true;
    }
    // tool_call_delta / finish 不直接打印--工具卡片由 ToolCallStarted 渲染
  }

  private renderToolCallStarted(event: RunEvent): void {
    const data = event.data as { tool_name: string; arguments: unknown };
    if (this.cfg.showToolDetails) {
      const args = JSON.stringify(data.arguments);
      process.stdout.write(this.color('blue', `\n🔧 ${data.tool_name}`));
      process.stdout.write(
        this.color('gray', ` ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`),
      );
    } else {
      process.stdout.write(this.color('blue', `\n🔧 ${data.tool_name}…`));
    }
  }

  private renderToolCallCompleted(event: RunEvent): void {
    const data = event.data as { tool_name: string; duration_ms: number };
    process.stdout.write(this.color('green', ` ✓ ${data.duration_ms}ms\n`));
  }

  private renderToolCallFailed(event: RunEvent): void {
    const data = event.data as { tool_name: string; error: string };
    process.stdout.write(this.color('red', ` ✗ ${data.error}\n`));
  }

  private color(color: keyof typeof C, text: string): string {
    if (!this.cfg.enableColors) return text;
    return `${C[color]}${text}${C.reset}`;
  }
}
