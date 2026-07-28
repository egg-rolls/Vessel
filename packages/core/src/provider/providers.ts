/**
 * Provider 实现
 * @module @vessel/core/provider
 */

// biome-ignore lint/style/useNamingConvention: LLM API protocol fields (OpenAI/Anthropic)

import type {
  ChatRequest,
  FinishReason,
  LLMProvider,
  LLMResponse,
  StreamChunk,
  Usage,
} from '../types/provider.js';
import type { ToolCall } from '../types/tool.js';

/** SSE 事件（解析自 HTTP 流） */
interface SseEvent {
  event?: string;
  data: string;
}

/**
 * 解析 SSE 流，逐事件 yield。
 * 事件以空行（\n\n）分隔；`data:` 多行拼接；`event:` 行可选（Anthropic 用，OpenAI 不用）。
 * 参照 Claude Code / Hermes 的逐行 SSE 解析模式。
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 兼容 \r\n\r\n（部分服务端）与 \n\n
      let sep = indexOfBlankLine(buffer);
      while (sep) {
        const raw = buffer.slice(0, sep.start);
        buffer = buffer.slice(sep.end);
        const evt = parseSseBlock(raw);
        if (evt) yield evt;
        sep = indexOfBlankLine(buffer);
      }
    }
    if (buffer.trim()) {
      const evt = parseSseBlock(buffer);
      if (evt) yield evt;
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 找到首个空行（\n\n 或 \r\n\r\n），返回其起止偏移；无则 null */
function indexOfBlankLine(buf: string): { start: number; end: number } | null {
  const i = buf.indexOf('\n\n');
  const j = buf.indexOf('\r\n\r\n');
  if (i === -1 && j === -1) return null;
  if (j !== -1 && (i === -1 || j < i)) return { start: j, end: j + 4 };
  return { start: i, end: i + 2 };
}

/** 解析单个 SSE 事件块为 {event?, data} */
function parseSseBlock(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('event:')) {
      event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** OpenAI 流式 chunk 形状（仅取用到的字段） */
type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: Usage;
};

/** Anthropic 流式事件形状（仅取用到的字段） */
type AnthropicStreamEvent = {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * 内存 Provider 实现
 * 用于测试和开发，不实际调用 LLM API
 */
export class MemoryLLMProvider implements LLMProvider {
  private responses: Map<string, LLMResponse> = new Map();
  private callCount = 0;

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

    // 获取最后一条消息
    const lastMessage = req.messages[req.messages.length - 1];

    let resp: LLMResponse;

    // 如果最后一条消息是工具结果，直接返回工具结果作为响应
    if (lastMessage?.role === 'tool') {
      resp = {
        content: lastMessage.content,
        finish_reason: 'stop',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };
    } else {
      // 获取最后一条用户消息
      const userMessages = req.messages.filter((m) => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1];
      const userInput = lastUserMessage?.content ?? '';

      // 检查是否有预设响应（只匹配最后一条用户消息）
      let matched: LLMResponse | undefined;
      for (const [pattern, response] of this.responses) {
        if (userInput.includes(pattern)) {
          matched = response;
          break;
        }
      }

      resp = matched ?? {
        content: `Echo: ${userInput}`,
        finish_reason: 'stop',
        usage: {
          prompt_tokens: userInput.length,
          completion_tokens: userInput.length + 10,
          total_tokens: userInput.length * 2 + 10,
        },
      };
    }

    // 流式：on_chunk 在场时把 content 切成 text_delta 吐出（供 runtime 流式事件测试）。
    // 非流式（无 on_chunk）跳过本块，返回值与重构前完全一致。
    if (req.on_chunk) {
      const text = resp.content;
      if (text.length > 2) {
        const mid = Math.max(1, Math.floor(text.length / 2));
        req.on_chunk({ type: 'text_delta', delta: text.slice(0, mid) });
        req.on_chunk({ type: 'text_delta', delta: text.slice(mid) });
      } else if (text.length > 0) {
        req.on_chunk({ type: 'text_delta', delta: text });
      }
      if (resp.tool_calls) {
        for (let i = 0; i < resp.tool_calls.length; i++) {
          const tc = resp.tool_calls[i];
          if (!tc) continue;
          req.on_chunk({
            type: 'tool_call_delta',
            tool_call_index: i,
            tool_call_id: tc.id,
            tool_call_name: tc.function.name,
            arguments_delta: tc.function.arguments,
          });
        }
      }
      req.on_chunk({ type: 'finish', finish_reason: resp.finish_reason, usage: resp.usage });
    }

    return resp;
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
}

/**
 * OpenAI 兼容 Provider
 * 用于连接 OpenAI API 或兼容的 API
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature?: number;
  private maxTokens?: number;

  constructor(config: {
    api_key: string;
    base_url?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }) {
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4';
    this.temperature = config.temperature;
    this.maxTokens = config.max_tokens;
  }

  /**
   * 调用 OpenAI 兼容 API
   * @param req 聊天请求
   * @returns LLM 响应
   */
  async chat(req: ChatRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    // 转换消息格式（正确处理工具返回）
    const messages = req.messages.map((msg) => {
      if (msg.role === 'tool') {
        // 工具返回：使用正确的格式
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id ?? '',
          content: msg.content,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        // 助手消息包含工具调用
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }
      // 普通消息
      return {
        role: msg.role,
        content: msg.content,
      };
    });

    // 流式分支：stream=true 且提供 on_chunk 时走 SSE，边收边回调，最终返回拼装好的 LLMResponse。
    // 非流式（无 on_chunk 或 stream=false）落入下方既有整段逻辑，行为不变。
    if (req.stream && req.on_chunk) {
      return await this.streamChat(url, messages, req, req.on_chunk);
    }

    const body = {
      model: req.model ?? this.model,
      messages,
      tools: req.tools,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.max_tokens ?? this.maxTokens,
      stream: false,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
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

  /**
   * 流式调用 OpenAI 兼容 API（SSE）
   * 边解析 `data:` 行边经 onChunk 回调吐增量；本地按 tool_calls[].index 累积 arguments；
   * 最终返回拼装好的完整 LLMResponse（chat() 签名不变，ADR-007）。
   *
   * OpenAI 流式：`delta.content` 为文本片段；`delta.tool_calls[]` 带 index，
   * 首片含 id/function.name，后续片含 function.arguments 片段；`[DONE]` 结束；
   * usage 需 `stream_options.include_usage`，在末尾空 choices 片中给出。
   */
  private async streamChat(
    url: string,
    messages: Array<Record<string, unknown>>,
    req: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<LLMResponse> {
    const streamBody = {
      model: req.model ?? this.model,
      messages,
      tools: req.tools,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.max_tokens ?? this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const streamHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) streamHeaders['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: streamHeaders,
      signal: req.signal,
      body: JSON.stringify(streamBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }
    if (!response.body) {
      throw new Error('OpenAI API returned no stream body');
    }

    let content = '';
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: FinishReason = 'stop';
    let usage: Usage | undefined;

    for await (const evt of parseSse(response.body)) {
      if (evt.data === '[DONE]') break;
      let parsed: OpenAiStreamChunk;
      try {
        parsed = JSON.parse(evt.data) as OpenAiStreamChunk;
      } catch {
        continue; // 跳过非 JSON 行（心跳等）
      }

      const choice = parsed.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) {
        content += delta.content;
        onChunk({ type: 'text_delta', delta: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolCallsMap.get(idx);
          if (!entry) {
            entry = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' };
            toolCallsMap.set(idx, entry);
          } else {
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
          }
          const argsDelta = tc.function?.arguments ?? '';
          if (argsDelta) entry.arguments += argsDelta;
          onChunk({
            type: 'tool_call_delta',
            tool_call_index: idx,
            tool_call_id: tc.id,
            tool_call_name: tc.function?.name,
            arguments_delta: argsDelta,
          });
        }
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason as FinishReason;
      }
      if (parsed.usage) {
        usage = parsed.usage;
      }
    }

    const toolCalls: ToolCall[] | undefined =
      toolCallsMap.size > 0
        ? Array.from(toolCallsMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, e]) => ({
              id: e.id,
              type: 'function' as const,
              function: { name: e.name, arguments: e.arguments },
            }))
        : undefined;

    onChunk({ type: 'finish', finish_reason: finishReason, usage });

    return { content, tool_calls: toolCalls, finish_reason: finishReason, usage };
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

    // 转换消息格式（正确处理工具返回）
    const messages: Array<{
      role: 'user' | 'assistant';
      content:
        | string
        | Array<{
            type: string;
            [key: string]: unknown;
          }>;
    }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        continue; // system 消息单独处理
      }

      if (msg.role === 'tool') {
        // 工具返回：使用 tool_result 格式
        // 将工具返回作为 user 消息发送，包含 tool_result 块
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id ?? '',
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // 助手消息包含工具调用
        const content: Array<{
          type: string;
          [key: string]: unknown;
        }> = [];

        if (msg.content) {
          content.push({
            type: 'text',
            text: msg.content,
          });
        }

        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            // Invalid JSON in tool arguments — send empty object
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }

        messages.push({
          role: 'assistant',
          content,
        });
      } else {
        // 普通用户/助手消息
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    const systemMessage = req.messages.find((m) => m.role === 'system');

    // 流式分支：stream=true 且提供 on_chunk 时走 SSE，边收边回调，最终返回拼装好的 LLMResponse。
    // 非流式（无 on_chunk 或 stream=false）落入下方既有整段逻辑，行为不变。
    if (req.stream && req.on_chunk) {
      return await this.streamChat(url, messages, systemMessage?.content, req, req.on_chunk);
    }

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
      signal: req.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
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

  /**
   * 流式调用 Anthropic API（SSE）
   * Anthropic 流式事件：message_start（input_tokens）/ content_block_start（tool_use 的 id+name）
   * / content_block_delta（text_delta 或 input_json_delta 片段）/ message_delta（stop_reason + output_tokens）
   * / message_stop。本地累积，最终返回拼装好的完整 LLMResponse（chat() 签名不变，ADR-007）。
   */
  private async streamChat(
    url: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>,
    systemContent: string | undefined,
    req: ChatRequest,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<LLMResponse> {
    const streamBody = {
      model: req.model ?? this.model,
      max_tokens: req.max_tokens ?? 4096,
      messages,
      system: systemContent,
      tools: req.tools?.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
      stream: true,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: req.signal,
      body: JSON.stringify(streamBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }
    if (!response.body) {
      throw new Error('Anthropic API returned no stream body');
    }

    let content = '';
    const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    let finishReason: FinishReason = 'stop';
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const evt of parseSse(response.body)) {
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(evt.data) as AnthropicStreamEvent;
      } catch {
        continue; // 跳过非 JSON 行（ping 等）
      }

      switch (parsed.type) {
        case 'message_start': {
          const u = parsed.message?.usage;
          if (u) promptTokens = u.input_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const block = parsed.content_block;
          if (block?.type === 'tool_use' && block.id && block.name && parsed.index !== undefined) {
            toolBlocks.set(parsed.index, { id: block.id, name: block.name, inputJson: '' });
            onChunk({
              type: 'tool_call_delta',
              tool_call_index: parsed.index,
              tool_call_id: block.id,
              tool_call_name: block.name,
            });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta;
          if (!delta) break;
          if (delta.type === 'text_delta' && delta.text) {
            content += delta.text;
            onChunk({ type: 'text_delta', delta: delta.text });
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const idx = parsed.index ?? 0;
            const entry = toolBlocks.get(idx);
            if (entry) {
              entry.inputJson += delta.partial_json;
              onChunk({
                type: 'tool_call_delta',
                tool_call_index: idx,
                arguments_delta: delta.partial_json,
              });
            }
          }
          break;
        }
        case 'message_delta': {
          if (parsed.delta?.stop_reason === 'tool_use') {
            finishReason = 'tool_calls';
          } else if (parsed.delta?.stop_reason === 'max_tokens') {
            finishReason = 'length';
          }
          const u = parsed.usage;
          if (u) completionTokens = u.output_tokens ?? completionTokens;
          break;
        }
        case 'message_stop':
          break;
        default:
          break;
      }
    }

    const toolCalls: ToolCall[] | undefined =
      toolBlocks.size > 0
        ? Array.from(toolBlocks.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, e]) => ({
              id: e.id,
              type: 'function' as const,
              function: { name: e.name, arguments: e.inputJson || '{}' },
            }))
        : undefined;

    const usage: Usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    onChunk({ type: 'finish', finish_reason: finishReason, usage });

    return { content, tool_calls: toolCalls, finish_reason: finishReason, usage };
  }
}
