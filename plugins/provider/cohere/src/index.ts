/**
 * @vessel/provider-cohere - Cohere Provider 插件
 * @module @vessel/provider-cohere
 *
 * 支持 Cohere API。
 */

import type { Plugin, PluginHost, LLMProvider, ChatRequest, LLMResponse, ToolCall } from '@vessel/core';

export interface CohereProviderConfig {
  api_key: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export class CohereProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: CohereProviderConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.cohere.com/v2';
    this.model = config.model ?? 'command-r-plus';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.max_tokens ?? 4096;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat`;
    const body = {
      model: req.model ?? this.model,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
          message: m.content,
        })),
      preamble: req.messages.find((m) => m.role === 'system')?.content,
      tools: req.tools?.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameter_definitions: Object.entries(
          (t.function.parameters as { properties?: Record<string, unknown> })
            ?.properties ?? {}
        ).reduce(
          (acc, [key, val]) => ({
            ...acc,
            [key]: {
              description: (val as Record<string, unknown>)?.description ?? '',
              type: (val as Record<string, unknown>)?.type ?? 'string',
              required: (
                (t.function.parameters as { required?: string[] })
                  ?.required ?? []
              ).includes(key),
            },
          }),
          {},
        ),
      })),
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.max_tokens ?? this.maxTokens,
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
      throw new Error(`Cohere API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      text?: string;
      tool_calls?: Array<{
        name: string;
        parameters: Record<string, unknown>;
      }>;
      finish_reason?: string;
      meta?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };

    const toolCalls: ToolCall[] | undefined = data.tool_calls?.map((tc, i) => ({
      id: `call_${i}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.parameters),
      },
    }));

    return {
      content: data.text ?? '',
      tool_calls: toolCalls?.length ? toolCalls : undefined,
      finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      usage: data.meta?.tokens
        ? {
            prompt_tokens: data.meta.tokens.input_tokens ?? 0,
            completion_tokens: data.meta.tokens.output_tokens ?? 0,
            total_tokens:
              (data.meta.tokens.input_tokens ?? 0) +
              (data.meta.tokens.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}

export const coherePlugin: Plugin = {
  name: 'provider-cohere',
  version: '0.1.0',
  description: 'Cohere provider plugin',
  install(host: PluginHost) {
    host.registerProvider('cohere', (config) => new CohereProvider(config as CohereProviderConfig));
  },
};

export default coherePlugin;
