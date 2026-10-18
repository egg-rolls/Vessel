/**
 * 脚本化 mock provider：按顺序回放 responses；耗尽后返回空内容并标记 exhausted。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '@vessel/core';
import type { EvalMockResponse } from './types.js';

const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

export class ScriptedProvider implements LLMProvider {
  exhausted = false;
  private index = 0;

  constructor(private readonly responses: EvalMockResponse[] = []) {}

  get callCount(): number {
    return this.index;
  }

  async chat(_req: ChatRequest): Promise<LLMResponse> {
    const response = this.responses[this.index];
    this.index += 1;

    if (response === undefined) {
      this.exhausted = true;
      return { content: '', finish_reason: 'stop', usage: { ...ZERO_USAGE } };
    }

    if (response.tool_calls !== undefined && response.tool_calls.length > 0) {
      return {
        content: response.content,
        tool_calls: response.tool_calls,
        finish_reason: 'tool_calls',
        usage: { ...ZERO_USAGE },
      };
    }

    return {
      content: response.content,
      finish_reason: 'stop',
      usage: { ...ZERO_USAGE },
    };
  }
}

/** shared 模式下按 case 切换脚本 provider。 */
export class SwitchableProvider implements LLMProvider {
  current: LLMProvider = new ScriptedProvider([]);
  private active?: ScriptedProvider;

  set(responses: EvalMockResponse[]): ScriptedProvider {
    this.active = new ScriptedProvider(responses);
    this.current = this.active;
    return this.active;
  }

  get exhausted(): boolean {
    return this.active?.exhausted ?? false;
  }

  chat(req: ChatRequest): Promise<LLMResponse> {
    return this.current.chat(req);
  }
}
