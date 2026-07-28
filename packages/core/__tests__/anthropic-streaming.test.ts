/**
 * AnthropicProvider SSE 流式测试（MECH-3）
 *
 * 当前仓库只有 OpenAI SSE mock（见 provider.test.ts）。本文件补 Anthropic SSE：
 * 覆盖 message_start / content_block_start / content_block_delta(text_delta + input_json_delta)
 * / message_delta / message_stop 的解析与累积。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { AnthropicProvider } from '../src/provider/providers';
import type { ChatRequest, StreamChunk } from '../src/types/provider';

function mockFetchSse(sseChunks: string[]): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;

describe('AnthropicProvider streaming', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('流式 text_delta 拼装为完整响应，finish=stop', async () => {
    mockFetchSse([
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);

    const provider = new AnthropicProvider({ api_key: 'sk-ant-test', model: 'claude-test' });
    const chunks: StreamChunk[] = [];

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      stream: true,
      on_chunk: (c) => chunks.push(c),
    } as ChatRequest);

    expect(response.content).toBe('Hello world');
    expect(response.finish_reason).toBe('stop');
    expect(response.usage?.prompt_tokens).toBe(5);
    expect(response.usage?.completion_tokens).toBe(2);
    expect(response.usage?.total_tokens).toBe(7);

    const textDeltas = chunks.filter((c) => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas.map((c) => c.delta ?? '').join('')).toBe('Hello world');
    expect(chunks[chunks.length - 1]?.type).toBe('finish');
  });

  it('流式 tool_use：input_json_delta 累积成完整 arguments，finish=tool_calls', async () => {
    mockFetchSse([
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"get_weather"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"Beijing\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);

    const provider = new AnthropicProvider({ api_key: 'sk-ant-test', model: 'claude-test' });
    const chunks: StreamChunk[] = [];

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'weather?' }],
      model: 'claude-test',
      stream: true,
      on_chunk: (c) => chunks.push(c),
    } as ChatRequest);

    expect(response.finish_reason).toBe('tool_calls');
    expect(response.tool_calls).toHaveLength(1);
    const tc = response.tool_calls?.[0];
    expect(tc?.id).toBe('tool_1');
    expect(tc?.function.name).toBe('get_weather');
    // 累积的 arguments 必须是合法 JSON
    expect(JSON.parse(tc?.function.arguments ?? '{}')).toEqual({ city: 'Beijing' });

    // 首片 tool_call_delta 含 id+name，后续片含 arguments_delta
    const tcChunks = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(tcChunks[0]?.tool_call_id).toBe('tool_1');
    expect(tcChunks[0]?.tool_call_name).toBe('get_weather');
    const reassembled = tcChunks.map((c) => c.arguments_delta ?? '').join('');
    expect(reassembled).toBe('{"city":"Beijing"}');
  });

  it('max_tokens stop_reason -> finish=length', async () => {
    mockFetchSse([
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"部分"}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);

    const provider = new AnthropicProvider({ api_key: 'sk-ant-test', model: 'claude-test' });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'claude-test',
      stream: true,
      on_chunk: () => {},
    } as ChatRequest);

    expect(response.finish_reason).toBe('length');
    expect(response.content).toBe('部分');
  });

  it('非流式（无 on_chunk）走整段 JSON 路径，不受 SSE mock 影响', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'plain answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    const provider = new AnthropicProvider({ api_key: 'sk-ant-test', model: 'claude-test' });
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
    } as ChatRequest);

    expect(response.content).toBe('plain answer');
    expect(response.finish_reason).toBe('stop');
    expect(response.usage?.total_tokens).toBe(3);
  });
});
