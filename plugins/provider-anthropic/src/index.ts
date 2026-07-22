/**
 * @vessel/provider-anthropic - Anthropic Provider 插件
 * @module @vessel/provider-anthropic
 *
 * 支持 Anthropic Claude API
 */

import type { Plugin, PluginHost, LLMProvider, ChatRequest, LLMResponse, ToolCall } from '@vessel/core';

/** Anthropic Provider 配置 */
export interface AnthropicProviderConfig {
  api_key: string;
  base_url?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

/**
 * Anthropic Provider 实现
 */
export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.anthropic.com';
    this.model = config.model ?? 'claude-3-opus-20240229';
    this.maxTokens = config.max_tokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/v1/messages`;

    // 转换消息格式
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.role === 'tool' ? `[Tool Result: ${m.content}]` : m.content,
      }));

    const systemMessage = req.messages.find((m) => m.role === 'system');

    const body = {
      model: req.model ?? this.model,
      max_tokens: req.max_tokens ?? this.maxTokens,
      temperature: req.temperature ?? this.temperature,
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

/**
 * Anthropic Provider 插件
 */
export const anthropicPlugin: Plugin = {
  name: 'provider-anthropic',
  version: '0.1.0',
  description: 'Anthropic Claude provider plugin',
  install(host: PluginHost) {
    host.registerProvider('anthropic', (config) => {
      return new AnthropicProvider(config as AnthropicProviderConfig);
    });
  },
};

export default anthropicPlugin;
