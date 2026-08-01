/**
 * StreamAccumulator 单元测试
 *
 * 覆盖：text 累积、tool call 累积（单个/多个/分片）、
 * finish_reason、两种 Usage 模式、finalize 输出。
 */
import { describe, expect, it } from 'bun:test';
import { StreamAccumulator } from '../src/provider/stream-accumulator';
import type { StreamChunk } from '../src/types/provider';

/** 创建带 chunk 捕获的 accumulator */
function makeAcc(incrementalUsage = false): {
  acc: StreamAccumulator;
  chunks: StreamChunk[];
} {
  const chunks: StreamChunk[] = [];
  const acc = new StreamAccumulator((c) => chunks.push(c), incrementalUsage);
  return { acc, chunks };
}

describe('StreamAccumulator', () => {
  // ── 文本累积 ────────────────────────────────────

  it('appendText 累积 content 并发出 text_delta', () => {
    const { acc, chunks } = makeAcc();
    acc.appendText('Hello');
    acc.appendText(' world');
    const resp = acc.finalize();

    expect(resp.content).toBe('Hello world');
    const textChunks = chunks.filter((c) => c.type === 'text_delta');
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0]?.delta).toBe('Hello');
    expect(textChunks[1]?.delta).toBe(' world');
  });

  it('无文本时 content 为空字符串', () => {
    const { acc } = makeAcc();
    const resp = acc.finalize();
    expect(resp.content).toBe('');
  });

  // ── 工具调用累积 ────────────────────────────────

  it('appendToolCall 首次调用发出 id + name，后续累积 arguments', () => {
    const { acc, chunks } = makeAcc();

    // 首片：携带 id + name + 首段 arguments
    acc.appendToolCall(0, 'call_1', 'get_weather', '{"city"');
    // 后续片：仅 arguments
    acc.appendToolCall(0, undefined, undefined, ':"Beijing"}');

    const resp = acc.finalize();
    expect(resp.tool_calls).toHaveLength(1);
    expect(resp.tool_calls?.[0]?.id).toBe('call_1');
    expect(resp.tool_calls?.[0]?.function.name).toBe('get_weather');
    expect(JSON.parse(resp.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      city: 'Beijing',
    });

    // 首片 tool_call_delta 含 id + name
    const tcChunks = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(tcChunks[0]?.tool_call_id).toBe('call_1');
    expect(tcChunks[0]?.tool_call_name).toBe('get_weather');
    expect(tcChunks[0]?.arguments_delta).toBe('{"city"');
    expect(tcChunks[1]?.arguments_delta).toBe(':"Beijing"}');
  });

  it('appendToolCall(Anthropic 模式) content_block_start 不含 arguments', () => {
    const { acc, chunks } = makeAcc(true);

    // Anthropic: 先 content_block_start（id + name，无 arguments）
    acc.appendToolCall(0, 'toolu_1', 'read_file');
    // 然后 content_block_delta（partial_json 片段）
    acc.appendToolCall(0, undefined, undefined, '{"path":');
    acc.appendToolCall(0, undefined, undefined, '"/etc/hosts"}');

    const resp = acc.finalize();
    expect(resp.tool_calls?.[0]?.function.arguments).toBe('{"path":"/etc/hosts"}');

    // 首片有 id + name，无 arguments_delta
    const tcChunks = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(tcChunks[0]?.tool_call_id).toBe('toolu_1');
    expect(tcChunks[0]?.tool_call_name).toBe('read_file');
    expect(tcChunks[0]?.arguments_delta).toBeUndefined();
  });

  it('多个工具调用按 index 排序', () => {
    const { acc } = makeAcc();

    acc.appendToolCall(2, 'c3', 'tool_c', '{}');
    acc.appendToolCall(0, 'c1', 'tool_a', '{}');
    acc.appendToolCall(1, 'c2', 'tool_b', '{}');

    const resp = acc.finalize();
    expect(resp.tool_calls).toHaveLength(3);
    expect(resp.tool_calls?.[0]?.id).toBe('c1');
    expect(resp.tool_calls?.[1]?.id).toBe('c2');
    expect(resp.tool_calls?.[2]?.id).toBe('c3');
  });

  it('无工具调用时 tool_calls 为 undefined', () => {
    const { acc } = makeAcc();
    acc.appendText('no tools here');
    const resp = acc.finalize();
    expect(resp.tool_calls).toBeUndefined();
  });

  it('空 arguments 回退为 "{}"', () => {
    const { acc } = makeAcc();
    acc.appendToolCall(0, 'empty_call', 'no_args');
    const resp = acc.finalize();
    expect(resp.tool_calls?.[0]?.function.arguments).toBe('{}');
  });

  // ── finish_reason ────────────────────────────────

  it('默认 finish_reason 为 stop', () => {
    const { acc } = makeAcc();
    const resp = acc.finalize();
    expect(resp.finish_reason).toBe('stop');
  });

  it('setFinishReason 覆盖默认值', () => {
    const { acc } = makeAcc();
    acc.setFinishReason('tool_calls');
    const resp = acc.finalize();
    expect(resp.finish_reason).toBe('tool_calls');
  });

  // ── Usage（OpenAI 直接模式）──────────────────────

  it('OpenAI 模式：setUsage 直接生效', () => {
    const { acc } = makeAcc(/* incrementalUsage */ false);
    acc.setUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    const resp = acc.finalize();
    expect(resp.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });

  it('OpenAI 模式：未调用 setUsage 时 usage 为 undefined', () => {
    const { acc } = makeAcc(false);
    const resp = acc.finalize();
    expect(resp.usage).toBeUndefined();
  });

  // ── Usage（Anthropic 增量模式）────────────────────

  it('Anthropic 模式：token 分开累积后自动组装 total', () => {
    const { acc } = makeAcc(/* incrementalUsage */ true);
    acc.addPromptTokens(15);
    acc.addCompletionTokens(8);
    const resp = acc.finalize();
    expect(resp.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 8,
      total_tokens: 23,
    });
  });

  it('Anthropic 模式：未调用 add*Tokens 时仍组装全零 usage', () => {
    const { acc } = makeAcc(true);
    const resp = acc.finalize();
    expect(resp.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  // ── finalize ─────────────────────────────────────

  it('finalize 发出 finish chunk 在最后', () => {
    const { acc, chunks } = makeAcc();
    acc.appendText('some text');
    acc.finalize();

    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('finish');
  });

  it('finish chunk 携带 finish_reason 和 usage', () => {
    const { acc, chunks } = makeAcc();
    acc.setUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    acc.finalize();

    const finish = chunks[chunks.length - 1];
    expect(finish?.type).toBe('finish');
    expect(finish?.finish_reason).toBe('stop');
    expect(finish?.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  // ── 综合场景 ─────────────────────────────────────

  it('文本 + 工具调用交错累积', () => {
    const { acc } = makeAcc();

    acc.appendText('I will check the weather.');
    acc.appendToolCall(0, 'call_w', 'get_weather', '{"location":"NYC"}');
    acc.appendText('Done.');

    const resp = acc.finalize();
    expect(resp.content).toBe('I will check the weather.Done.');
    expect(resp.tool_calls).toHaveLength(1);
    expect(resp.tool_calls?.[0]?.function.name).toBe('get_weather');
  });
});
