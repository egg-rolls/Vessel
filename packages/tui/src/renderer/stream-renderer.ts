/**
 * 流式渲染器（egg-rolls 基础版）
 * @module @vessel/tui
 *
 * @deprecated 已废弃——与 React 版 `components/StreamOutput.tsx` 同构并存，
 * 双渲染器造成维护负担。Ink TTY 模式统一走 StreamOutput（React），
 * 本 ANSI 版仅保留供既有单元测试覆盖，不再接入任何渲染路径。
 *
 * 订阅 EventStream，token-by-token 打印 LlmStreamChunk.text_delta；
 * 打印工具调用卡片；RunCompleted 收尾换行。
 * REPL 用 didStreamLastRun() 判断是否需要兜底打印 run() 返回值（非流式 provider）。
 */

import type {
  EventStream,
  StreamChunk,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
} from '@vessel/core';
import { asTuiEvent, type TuiEvent } from '../types/events.js';

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
    this.unsubscribe = eventStream.subscribe((e) => this.handleEvent(asTuiEvent(e)));
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

  private handleEvent(event: TuiEvent): void {
    switch (event.type) {
      case 'run.started': {
        this.streamedAny = false;
        break;
      }
      case 'llm.stream.chunk': {
        this.handleChunk(event.data.chunk);
        break;
      }
      case 'tool.call.started': {
        this.renderToolCallStarted(event.data);
        break;
      }
      case 'tool.call.completed': {
        this.renderToolCallCompleted(event.data);
        break;
      }
      case 'tool.call.failed': {
        this.renderToolCallFailed(event.data);
        break;
      }
      case 'guardrail.blocked': {
        process.stdout.write(`${this.color('red', `\n🚫 Blocked: ${event.data.reason}\n`)}`);
        break;
      }
      case 'run.completed': {
        this.lastRunStreamed = this.streamedAny;
        if (this.streamedAny) process.stdout.write('\n');
        break;
      }
      case 'run.failed': {
        this.lastRunStreamed = this.streamedAny;
        if (!this.streamedAny) process.stdout.write('\n');
        process.stdout.write(this.color('red', `✗ Run failed: ${event.data.error}\n`));
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

  private renderToolCallStarted(data: ToolCallStartedPayload): void {
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

  private renderToolCallCompleted(data: ToolCallCompletedPayload): void {
    process.stdout.write(this.color('green', ` ✓ ${data.duration_ms}ms\n`));
  }

  private renderToolCallFailed(data: ToolCallFailedPayload): void {
    process.stdout.write(this.color('red', ` ✗ ${data.error}\n`));
  }

  private color(color: keyof typeof C, text: string): string {
    if (!this.cfg.enableColors) return text;
    return `${C[color]}${text}${C.reset}`;
  }
}
