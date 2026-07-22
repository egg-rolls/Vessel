/**
 * Provider 实现
 * @module @vessel/core/provider
 */

import type { ChatRequest, LLMProvider, LLMResponse, ToolCall } from '../types/provider.js';

/**
 * 内存 Provider 实现
 * 用于测试和开发，不实际调用 LLM API
 */
export class MemoryLLMProvider implements LLMProvider {
  private responses: Map<string, LLMResponse> = new Map();
  private callCount: number = 0;
  private pendingToolResponses: Map<string, LLMResponse> = new Map(); // 按 session_id 存储待返回的工具响应

  /**
   * 预设响应
   * @param input 输入模式（用于匹配）
   * @param response 预设响应
   */
  setResponse(input: string, response: LLMResponse): void {
    this.responses.set(input, response);
  }

  /**
   * 调用 LLM
   * @param req 聊天请求
   * @returns LLM 响应
   */
  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.callCount++;

    const sessionId = req.session_id || 'default';

    // 获取最后一条消息
    const lastMessage = req.messages[req.messages.length - 1];
    
    // 如果最后一条消息是工具结果，直接返回工具结果作为响应
    if (lastMessage?.role === 'tool') {
      return {
        content: lastMessage.content,
        finish_reason: 'stop',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };
    }

    // 获取最后一条用户消息
    const userMessages = req.messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const userInput = lastUserMessage?.content ?? '';

    // 检查是否有预设响应（只匹配最后一条用户消息）
    for (const [pattern, response] of this.responses) {
      if (userInput.includes(pattern)) {
        return response;
      }
    }

    // 默认响应
    return {
      content: `Echo: ${userInput}`,
      finish_reason: 'stop',
      usage: {
        prompt_tokens: userInput.length,
        completion_tokens: userInput.length + 10,
        total_tokens: userInput.length * 2 + 10,
      },
    };
  }

  /**
   * 获取调用次数
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * 重置调用次数
   */
  resetCallCount(): void {
    this.callCount = 0;
  }

  /**
   * 清除指定会话的待返回响应
   */
  clearPendingResponse(sessionId: string): void {
    this.pendingToolResponses.delete(sessionId);
  }

  /**
   * 清除所有待返回响应
   */
  clearAllPendingResponses(): void {
    this.pendingToolResponses.clear();
  }
}

/**
 * OpenAI 兼容 Provider
 * 用于连接 OpenAI API 或兼容的 API
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: { api_key: string; base_url?: string; model?: string }) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4';
  }

  /**
   * 调用 OpenAI 兼容 API
   * @param req 聊天请求
   * @returns LLM 响应
   */
  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: req.model ?? this.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0];
    if (!choice) {
      throw new Error('No response from OpenAI API');
    }

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    return {
      content: choice.message.content ?? '',
      tool_calls: toolCalls,
      finish_reason: choice.finish_reason as 'stop' | 'tool_calls' | 'length',
      usage: data.usage,
    };
  }
}

/**
 * Anthropic 兼容 Provider
 * 用于连接 Anthropic API
 */
export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: { api_key: string; base_url?: string; model?: string }) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.anthropic.com';
    this.model = config.model ?? 'claude-3-opus-20240229';
  }

  /**
   * 调用 Anthropic API
   * @param req 聊天请求
   * @returns LLM 响应
   */
  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/v1/messages`;

    // 转换消息格式
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const systemMessage = req.messages.find((m) => m.role === 'system');

    const body = {
      model: req.model ?? this.model,
      max_tokens: req.max_tokens ?? 4096,
      messages,
      system: systemMessage?.content,
      tools: req.tools?.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      content: Array<{
        type: 'text' | 'tool_use';
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    // 处理响应内容
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text ?? '';
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }
}
