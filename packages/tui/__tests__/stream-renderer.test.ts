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
import { EventType, MemoryEventStream, type RunEvent } from '@vessel/core';
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
    it('RunStarted resets streamedAny state', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // First trigger a text_delta to set streamedAny
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hello' } },
        ts: Date.now(),
      } as RunEvent);

      // Trigger RunStarted should reset
      eventStream.publish({
        type: EventType.RunStarted,
        run_id: 'r2',
        data: { run_id: 'r2', input: 'test' },
        ts: Date.now(),
      } as RunEvent);

      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('LlmStreamChunk calls handleChunk', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'Hello' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello');
    });

    it('ToolCallStarted renders tool card', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('file_read'));
    });

    it('ToolCallCompleted renders completion marker', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallCompleted,
        run_id: 'r1',
        data: { tool_name: 'file_read', duration_ms: 42 },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('42ms'));
    });

    it('ToolCallFailed renders error', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallFailed,
        run_id: 'r1',
        data: { tool_name: 'file_read', error: 'File not found', duration_ms: 10 },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
    });

    it('GuardrailBlocked renders block message', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.GuardrailBlocked,
        run_id: 'r1',
        data: { guardrail_name: 'pii', stage: 'output', reason: 'PII detected' },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('Blocked: PII detected'));
    });

    it('RunCompleted sets lastRunStreamed and adds newline', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // First send text_delta
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hello' } },
        ts: Date.now(),
      } as RunEvent);

      // Send RunCompleted
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hello', duration_ms: 100, iterations: 1 },
        ts: Date.now(),
      } as RunEvent);

      expect(renderer.didStreamLastRun()).toBe(true);
    });

    it('RunFailed renders error message', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.RunFailed,
        run_id: 'r1',
        data: { run_id: 'r1', error: 'API rate limit', duration_ms: 50 },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining('Run failed: API rate limit'),
      );
    });
  });

  describe('handleChunk parsing', () => {
    it('text_delta outputs delta text', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'Hello World' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Hello World');
    });

    it('tool_call_delta does not output', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: {
          run_id: 'r1',
          chunk: { type: 'tool_call_delta', tool_call_index: 0, arguments_delta: '{"' },
        },
        ts: Date.now(),
      } as RunEvent);

      // tool_call_delta should not be printed directly
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('empty delta does not output', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: '' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('didStreamLastRun state', () => {
    it('initial state is false', () => {
      renderer = new StreamRenderer();
      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('true after text_delta', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hi' } },
        ts: Date.now(),
      } as RunEvent);
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hi', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      } as RunEvent);

      expect(renderer.didStreamLastRun()).toBe(true);
    });

    it('false without text_delta', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: '', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      } as RunEvent);

      expect(renderer.didStreamLastRun()).toBe(false);
    });

    it('RunStarted resets streamedAny (next run without output makes lastRunStreamed false)', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);

      // First run has streaming output
      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'hi' } },
        ts: Date.now(),
      } as RunEvent);
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r1',
        data: { run_id: 'r1', output: 'hi', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      } as RunEvent);

      expect(renderer.didStreamLastRun()).toBe(true);

      // Second run starts (resets streamedAny) + completes (no streaming output)
      eventStream.publish({
        type: EventType.RunStarted,
        run_id: 'r2',
        data: { run_id: 'r2', input: 'test' },
        ts: Date.now(),
      } as RunEvent);
      eventStream.publish({
        type: EventType.RunCompleted,
        run_id: 'r2',
        data: { run_id: 'r2', output: 'no stream', duration_ms: 10, iterations: 1 },
        ts: Date.now(),
      } as RunEvent);

      // Second run has no streaming output, so lastRunStreamed should be false
      expect(renderer.didStreamLastRun()).toBe(false);
    });
  });

  describe('color toggle', () => {
    it('enableColors=false does not add ANSI escape codes', () => {
      renderer = new StreamRenderer({ enableColors: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'test', arguments: {} },
        ts: Date.now(),
      } as RunEvent);

      const call = stdoutWriteSpy.mock.calls[0];
      expect(call?.[0]).not.toContain('\x1b[');
    });

    it('enableColors=true adds ANSI escape codes', () => {
      renderer = new StreamRenderer({ enableColors: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'test', arguments: {} },
        ts: Date.now(),
      } as RunEvent);

      const call = stdoutWriteSpy.mock.calls[0];
      expect(call?.[0]).toContain('\x1b[');
    });
  });

  describe('tool card rendering', () => {
    it('showToolDetails=true shows arguments', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test.txt' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining('/test.txt'));
    });

    it('showToolDetails=false does not show arguments', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: false });
      renderer.start(eventStream);

      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'file_read', arguments: { path: '/test.txt' } },
        ts: Date.now(),
      } as RunEvent);

      // Should only show tool name and ellipsis, not arguments
      const calls = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(calls).toContain('file_read');
      expect(calls).not.toContain('/test.txt');
    });

    it('long arguments truncated to 120 characters', () => {
      renderer = new StreamRenderer({ enableColors: false, showToolDetails: true });
      renderer.start(eventStream);

      const longArgs = { content: 'a'.repeat(200) };
      eventStream.publish({
        type: EventType.ToolCallStarted,
        run_id: 'r1',
        data: { tool_name: 'write_file', arguments: longArgs },
        ts: Date.now(),
      } as RunEvent);

      const calls = stdoutWriteSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(calls).toContain('\u2026');
    });
  });

  describe('start/stop lifecycle', () => {
    it('duplicate start does not duplicate subscription', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);
      renderer.start(eventStream); // Second time should be ignored

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'test' } },
        ts: Date.now(),
      } as RunEvent);

      // Should only output once
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
    });

    it('stop prevents receiving events', () => {
      renderer = new StreamRenderer();
      renderer.start(eventStream);
      renderer.stop();

      eventStream.publish({
        type: EventType.LlmStreamChunk,
        run_id: 'r1',
        data: { chunk: { type: 'text_delta', delta: 'test' } },
        ts: Date.now(),
      } as RunEvent);

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });
});
