/**
 * @vessel/provider-mistral - Mistral AI Provider 插件
 * @module @vessel/provider-mistral
 *
 * 支持 Mistral AI API（OpenAI 兼容模式）。
 */

import type {
  ChatRequest,
  LLMProvider,
  LLMResponse,
  Plugin,
  PluginHost,
  ToolCall,
} from '@vessel/core';

export interface MistralProviderConfig {
  api_key: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export class MistralProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: MistralProviderConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.mistral.ai/v1';
    this.model = config.model ?? 'mistral-large-latest';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.max_tokens ?? 4096;
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error('No response from Mistral API');

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      content: choice.message.content ?? '',
      tool_calls: toolCalls,
      finish_reason: choice.finish_reason as 'stop' | 'tool_calls' | 'length',
      usage: data.usage,
    };
  }
}

export const mistralPlugin: Plugin = {
  name: 'provider-mistral',
  version: '0.1.0',
  description: 'Mistral AI provider plugin',
  install(host: PluginHost) {
    host.registerProvider(
      'mistral',
      (config) => new MistralProvider(config as MistralProviderConfig),
    );
  },
};

export default mistralPlugin;
