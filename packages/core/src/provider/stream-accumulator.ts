/**
 * 流式 SSE 累积器
 * @module @vessel/core/provider
 *
 * 负责 SSE 流式响应的状态累积，供 OpenAI 和 Anthropic provider 共用：
 *  - 文本增量累积 + text_delta 回调
 *  - 工具调用按 index 累积 arguments 片段 + tool_call_delta 回调
 *  - Usage 支持两种模式：直接赋值（OpenAI）与增量累加（Anthropic）
 *  - finalize()：排序 Map → ToolCall[]、发出 finish chunk、返回完整 LLMResponse
 *
 * 不负责任何 HTTP/SSE 解析——那部分由各 provider 的 streamChat 方法处理。
 */

import type { FinishReason, LLMResponse, StreamChunk, Usage } from '../types/provider.js';
import type { ToolCall } from '../types/tool.js';

/** 工具调用累积条目（统一字段名，消除 OpenAI .arguments vs Anthropic .inputJson 差异） */
interface ToolCallEntry {
  id: string;
  name: string;
  argumentsJson: string;
}

export class StreamAccumulator {
  private content = '';
  private toolCallsMap = new Map<number, ToolCallEntry>();
  private finishReason: FinishReason = 'stop';

  /** OpenAI 模式：直接赋值（末尾 SSE chunk） */
  private directUsage: Usage | undefined;

  /** Anthropic 模式：message_start / message_delta 各自累加 */
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly incrementalUsage: boolean;

  /**
   * @param onChunk  流式回调——累积器内部发出 text_delta / tool_call_delta / finish
   * @param incrementalUsage  true=Anthropic 模式（prompt/completion token 分别累加），
   *                          false=OpenAI 模式（直接 setUsage，默认）
   */
  constructor(
    private readonly onChunk: (chunk: StreamChunk) => void,
    incrementalUsage = false,
  ) {
    this.incrementalUsage = incrementalUsage;
  }

  // ── 文本 ──────────────────────────────────────────

  /** 累积文本增量，发出 text_delta chunk */
  appendText(delta: string): void {
    this.content += delta;
    this.onChunk({ type: 'text_delta', delta });
  }

  // ── 工具调用 ──────────────────────────────────────

  /**
   * 累积工具调用片段，发出 tool_call_delta chunk。
   *
   * 首次出现该 index 时用传入的 id/name 初始化；后续调用可覆盖 id/name（OpenAI 模式）。
   * argumentsDelta 每次增量拼接到 argumentsJson 中。
   */
  appendToolCall(index: number, id?: string, name?: string, argumentsDelta?: string): void {
    let entry = this.toolCallsMap.get(index);
    if (!entry) {
      entry = { id: id ?? '', name: name ?? '', argumentsJson: '' };
      this.toolCallsMap.set(index, entry);
    } else {
      if (id) entry.id = id;
      if (name) entry.name = name;
    }
    if (argumentsDelta) entry.argumentsJson += argumentsDelta;

    this.onChunk({
      type: 'tool_call_delta',
      tool_call_index: index,
      tool_call_id: id,
      tool_call_name: name,
      arguments_delta: argumentsDelta,
    });
  }

  // ── finish_reason ────────────────────────────────

  setFinishReason(reason: FinishReason): void {
    this.finishReason = reason;
  }

  // ── Usage（两种模式）──────────────────────────────

  /** OpenAI 模式：直接赋值完整 Usage 对象 */
  setUsage(usage: Usage): void {
    this.directUsage = usage;
  }

  /** Anthropic 模式：记录 prompt tokens */
  addPromptTokens(n: number): void {
    this.promptTokens = n;
  }

  /** Anthropic 模式：记录 completion tokens */
  addCompletionTokens(n: number): void {
    this.completionTokens = n;
  }

  // ── 最终组装 ──────────────────────────────────────

  /**
   * 结束累积：排序工具调用 Map → ToolCall[]，组装 Usage，发出 finish chunk，
   * 返回完整的 LLMResponse。
   */
  finalize(): LLMResponse {
    const toolCalls: ToolCall[] | undefined =
      this.toolCallsMap.size > 0
        ? Array.from(this.toolCallsMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, e]) => ({
              id: e.id,
              type: 'function' as const,
              function: { name: e.name, arguments: e.argumentsJson || '{}' },
            }))
        : undefined;

    const usage: Usage | undefined = this.incrementalUsage
      ? {
          prompt_tokens: this.promptTokens,
          completion_tokens: this.completionTokens,
          total_tokens: this.promptTokens + this.completionTokens,
        }
      : this.directUsage;

    this.onChunk({ type: 'finish', finish_reason: this.finishReason, usage });

    return {
      content: this.content,
      tool_calls: toolCalls,
      finish_reason: this.finishReason,
      usage,
    };
  }
}
