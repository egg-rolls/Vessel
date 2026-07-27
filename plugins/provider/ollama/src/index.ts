/**
 * @vessel/provider-ollama - Ollama 本地模型 Provider 插件
 * @module @vessel/provider-ollama
 *
 * 支持本地 Ollama 模型（OpenAI 兼容模式）。
 * 默认 base_url: http://localhost:11434/v1
 */

import type { Plugin, PluginHost, LLMProvider, ChatRequest, LLMResponse, ToolCall } from '@vessel/core';

export interface OllamaProviderConfig {
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Ollama 不需要 API Key，此字段可选 */
  api_key?: string;
}

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.base_url ?? 'http://localhost:11434/v1';
    this.model = config.model ?? 'llama3';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.max_tokens ?? 4096;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    // Ollama 不原生支持 tool_calls，但提供原始工具 schema
    const body: Record<string, unknown> = {
      model: req.model ?? this.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.max_tokens ?? this.maxTokens,
      stream: false,
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string;
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
    if (!choice) throw new Error('No response from Ollama API');

    const content = choice.message.content ?? '';
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      content,
      tool_calls: toolCalls?.length ? toolCalls : undefined,
      finish_reason: (choice.finish_reason as 'stop' | 'tool_calls' | 'length') ?? 'stop',
      usage: data.usage,
    };
  }
}

export const ollamaPlugin: Plugin = {
  name: 'provider-ollama',
  version: '0.1.0',
  description: 'Ollama local model provider plugin',
  install(host: PluginHost) {
    host.registerProvider('ollama', (config) => new OllamaProvider(config as OllamaProviderConfig));
  },
};

export default ollamaPlugin;
