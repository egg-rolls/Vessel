/**
 * StreamRenderer 单元测试
 *
 * 测试覆盖：
 * - handleEvent switch：各事件类型的处理
 * - handleChunk 解析：text_delta 输出
 * - didStreamLastRun 状态：流式状态跟踪
 * - 颜色开关：enableColors 配置
 * - 工具卡片渲染：showToolDetails 配置
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventType, MemoryEventStream } from '@vessel/core';
import { StreamRenderer } from '../src/renderer/stream-renderer.js';

describe('StreamRenderer', () => {
  let renderer: StreamRenderer;
  let eventStream: MemoryEventStream;
  let stdoutWriteSpy: ReturnType<typeof mock>;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    eventStream = new MemoryEventStream();
    // Mock process.stdout.write
    originalStdoutWrite = process.stdout.write;
    stdoutWriteSpy = mock(() => true);
    process.stdout.write = stdoutWriteSpy as typeof process.stdout.write;
  });

  afterEach(() => {
    renderer?.stop();
    // Restore original stdout.write
    process.stdout.write = originalStdoutWrite;
  });

  describe('handleEvent switch', () => {
    it('RunStarted 重置 streamedAny 状态', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // 先触发一个 text_delta 设置 streamedAny
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hello' } },
        ts: Date.now(),
      });

      // 触发 RunStarted 应该重置
      eventStream.publish({
        type: EventType.RunStarted,
        run_id: 'r2',
        data: { run_id: 'r2', input: 'test' },
        ts: Date.now(),
      });

      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('LlmStreamChunk 调用 handleChunk', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'Hello' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello');
    });

    it('ToolCallStarted 渲染工具卡片', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('file_read'));
    });

    it('ToolCallCompleted 渲染完成标记', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallCompleted,
        run_id: 'r1',
        data: { tool_name: 'file_read', duration_ms: 42 },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('42ms'));
    });

    it('ToolCallFailed 渲染错误', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallFailed,
        run_id: 'r1',
        data: { tool_name: 'file_read', error: 'File not found', duration_ms: 10 },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
    });

    it('GuardrailBlocked 渲染阻止消息', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.GuardrailBlocked,
        run_id: 'r1',
        data: { guardrail_name: 'pii', stage: 'output', reason: 'PII detected' },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('Blocked: PII detected'));
    });

    it('RunCompleted 设置 lastRunStreamed 并换行', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // 先发送 text_delta
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hello' } },
        ts: Date.now(),
      });

      // 发送 RunCompleted
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hello', duration_ms: 100, iterations: 1 },
        ts: Date.now(),
      });

      expect(renderer.didStreamLastRun()).toBe(true);
    });

    it('RunFailed 渲染错误消息', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.RunFailed,
        run_id: 'r1',
        data: { run_id: 'r1', error: 'API rate limit', duration_ms: 50 },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('Run failed: API rate limit'),
      );
    });
  });

  describe('handleChunk 解析', () => {
    it('text_delta 输出 delta 文本', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'Hello World' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello World');
    });

    it('tool_call_delta 不输出', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'tool_call_delta', index: 0, delta: { arguments: '{"' } } },
        ts: Date.now(),
      });

      // tool_call_delta 不应该直接打印
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('空 delta 不输出', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: '' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('didStreamLastRun 状态', () => {
    it('初始状态为 false', () => {
      renderer = new StreamRenderer();
      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('有 text_delta 后为 true', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hi' } },
        ts: Date.now(),
      });
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hi', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      });

      expect(renderer.didStreamLastRun()).toBe(true);
    });

    it('无 text_delta 后为 false', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: '', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      });

      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('RunStarted 重置 streamedAny（下个 run 无输出时 lastRunStreamed 为 false）', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // 第一个 run 有流式输出
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hi' } },
        ts: Date.now(),
      });
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hi', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      });

      expect(renderer.didStreamLastRun()).toBe(true);

      // 第二个 run 开始（重置 streamedAny）+ 完成（无流式输出）
      eventStream.publish({
        type: EventType.RunStarted,
        run_id: 'r2',
        data: { run_id: 'r2', input: 'test' },
        ts: Date.now(),
      });
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r2',
        data: { run_id: 'r2', output: 'no stream', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      });

      // 第二个 run 没有流式输出，所以 lastRunStreamed 应该是 false
      expect(renderer.didStreamLastRun()).toBe(false);
    });
  });

  describe('颜色开关', () => {
    it('enableColors=false 不添加 ANSI 转义码', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'test', arguments: {} },
        ts: Date.now(),
      });

      const call = stdoutWriteSpy.mock.calls[0];
      expect(call?.[0]).not.toContain('\x1b[');
    });

    it('enableColors=true 添加 ANSI 转义码', () => {
      renderer = new StreamRenderer({ enableColors: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'test', arguments: {} },
        ts: Date.now(),
      });

      const call = stdoutWriteSpy.mock.calls[0];
      expect(call?.[0]).toContain('\x1b[');
    });
  });

  describe('工具卡片渲染', () => {
    it('showToolDetails=true 显示参数', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test.txt' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('/test.txt'));
    });

    it('showToolDetails=false 不显示参数', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test.txt' } },
        ts: Date.now(),
      });

      // 应该只显示工具名和省略号，不显示参数
      const calls = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(calls).toContain('file_read');
      expect(calls).not.toContain('/test.txt');
    });

    it('长参数截断到 120 字符', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      const longArgs = { content: 'a'.repeat(200) };
      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'write_file', arguments: longArgs },
        ts: Date.now(),
      });

      const calls = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(calls).toContain('…');
    });
  });

  describe('start/stop 生命周期', () => {
    it('重复 start 不重复订阅', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);
      renderer.start(eventStream); // 第二次应该忽略

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'test' } },
        ts: Date.now(),
      });

      // 应该只输出一次
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
    });

    it('stop 后不再接收事件', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);
      renderer.stop();

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'test' } },
        ts: Date.now(),
      });

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });
});
