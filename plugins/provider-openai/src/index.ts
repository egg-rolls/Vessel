/**
 * @vessel/provider-openai - OpenAI 兼容 Provider 插件
 * @module @vessel/provider-openai
 *
 * 支持 OpenAI API 及兼容的 API（如 Azure OpenAI、本地模型等）
 */

import type { Plugin, PluginHost, LLMProvider, ChatRequest, LLMResponse, ToolCall } from '@vessel/core';

/** OpenAI Provider 配置 */
export interface OpenAIProviderConfig {
  api_key: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  organization?: string;
}

/**
 * OpenAI 兼容 Provider 实现
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private organization?: string;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.max_tokens ?? 4096;
    this.organization = config.organization;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: req.model ?? this.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      tools: req.tools,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.max_tokens ?? this.maxTokens,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
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
 * OpenAI Provider 插件
 */
export const openaiPlugin: Plugin = {
  name: 'provider-openai',
  version: '0.1.0',
  description: 'OpenAI compatible provider plugin',
  install(host: PluginHost) {
    host.registerProvider('openai', (config) => {
      return new OpenAIProvider(config as OpenAIProviderConfig);
    });
  },
};

export default openaiPlugin;
