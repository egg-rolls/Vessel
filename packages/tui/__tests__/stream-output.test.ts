/**
 * StreamOutput segment ordering 单元测试
 *
 * 测试覆盖：
 * - 纯文本：连续 text_delta 追加到同一文本段落
 * - 文本 → 工具调用 → 文本：按时间顺序交替
 * - 多个工具调用：各自独立段落
 * - RunStarted 清空分段
 * - 工具调用失败保留位置
 * - getResponseText 提取文本
 * - makeToolCallSegment 工厂
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MAX_SEGMENTS,
  getResponseText,
  getTranscriptText,
  limitSegments,
  makeToolCallSegment,
  reduceSegments,
  type Segment,
  tailLines,
} from '../src/components/StreamOutput.js';
import { asTuiEvent } from '../src/types/events.js';

/** 模拟 ID 生成器 */
function makeNextId(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

/** 构造精简的 RunEvent，只需要 reduceSegments 实际读取的字段 */
function textDelta(delta: string) {
  return asTuiEvent({
    type: 'llm.stream.chunk',
    run_id: 'r',
    data: { chunk: { type: 'text_delta', delta } },
    ts: 0,
  });
}

function toolStarted(id: string, name: string, args: unknown = {}) {
  return asTuiEvent({
    type: 'tool.call.started',
    run_id: 'r',
    data: { tool_call_id: id, tool_name: name, arguments: args },
    ts: 0,
  });
}

function toolCompleted(id: string, durationMs = 42, result = 'ok') {
  return asTuiEvent({
    type: 'tool.call.completed',
    run_id: 'r',
    data: { tool_call_id: id, tool_name: 'read', duration_ms: durationMs, result },
    ts: 0,
  });
}

function toolFailed(id: string, error: string, durationMs = 100) {
  return asTuiEvent({
    type: 'tool.call.failed',
    run_id: 'r',
    data: { tool_call_id: id, error, duration_ms: durationMs },
    ts: 0,
  });
}

function runStarted() {
  return asTuiEvent({
    type: 'run.started',
    run_id: 'r',
    data: { run_id: 'r', input: 'test' },
    ts: 0,
  });
}

describe('StreamOutput segment ordering', () => {
  describe('纯文本流', () => {
    it('连续 text_delta 追加到同一文本段落', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];
      segs = reduceSegments(segs, textDelta('Hello'), nextId);
      segs = reduceSegments(segs, textDelta(' '), nextId);
      segs = reduceSegments(segs, textDelta('World'), nextId);

      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({ type: 'text', text: 'Hello World' });
    });

    it('无输入时 segments 为空', () => {
      const nextId = makeNextId();
      const segs: Segment[] = [];
      // 空 delta 不产生 segment
      const result = reduceSegments(segs, textDelta(''), nextId);
      expect(result).toHaveLength(0);
    });
  });

  describe('工具调用交替', () => {
    it('文本 → 工具调用 → 文本按时间顺序交替', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Let me read the file.'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'read', { path: '/test.txt' }), nextId);
      segs = reduceSegments(segs, toolCompleted('tc1', 42), nextId);
      segs = reduceSegments(segs, textDelta('File contents: hello'), nextId);

      expect(segs).toHaveLength(3); // text, tool_call, text
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read' });
      expect(segs[2]).toMatchObject({ type: 'text', text: 'File contents: hello' });
    });

    it('工具调用在文本之间产生独立文本段落（非合并）', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('First.'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'search'), nextId);
      segs = reduceSegments(segs, textDelta('Second.'), nextId);

      expect(segs).toHaveLength(3);
      expect(segs[0]).toMatchObject({ type: 'text', text: 'First.' });
      expect(segs[1]).toMatchObject({ type: 'tool_call' });
      expect(segs[2]).toMatchObject({ type: 'text', text: 'Second.' });
    });
  });

  describe('多工具调用', () => {
    it('多个工具调用各自独立段落', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Doing work...'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'read'), nextId);
      segs = reduceSegments(segs, toolStarted('tc2', 'edit'), nextId);
      segs = reduceSegments(segs, textDelta('Done.'), nextId);

      expect(segs).toHaveLength(4);
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read' });
      expect(segs[2]).toMatchObject({ type: 'tool_call', name: 'edit' });
      expect(segs[3]).toMatchObject({ type: 'text', text: 'Done.' });
    });

    it('并行工具调用的 running → completed 状态转换不影响顺序', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, toolStarted('tc1', 'read'), nextId);
      segs = reduceSegments(segs, toolStarted('tc2', 'search'), nextId);
      // tc2 先完成
      segs = reduceSegments(segs, toolCompleted('tc2', 10), nextId);
      // tc1 后完成
      segs = reduceSegments(segs, toolCompleted('tc1', 50), nextId);

      expect(segs).toHaveLength(2);
      expect(segs[0]).toMatchObject({ id: 'tc1', name: 'read', status: 'completed' });
      expect(segs[1]).toMatchObject({ id: 'tc2', name: 'search', status: 'completed' });
    });
  });

  describe('状态重置', () => {
    it('RunStarted 清空所有分段', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Hello'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'read'), nextId);
      segs = reduceSegments(segs, runStarted(), nextId);

      expect(segs).toHaveLength(0);
    });

    it('RunResumed 清空所有分段（0.3 durable resume）', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Before resume'), nextId);
      segs = reduceSegments(
        segs,
        asTuiEvent({ type: 'run.resumed', run_id: 'r', data: {}, ts: 0 }),
        nextId,
      );

      expect(segs).toHaveLength(0);
    });
  });

  describe('工具调用失败', () => {
    it('失败的工具调用保留位置并显示错误', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Trying...'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'read'), nextId);
      segs = reduceSegments(segs, toolFailed('tc1', 'File not found', 100), nextId);
      segs = reduceSegments(segs, textDelta('Sorry, failed.'), nextId);

      expect(segs).toHaveLength(3);
      expect(segs[1]).toMatchObject({
        type: 'tool_call',
        name: 'read',
        status: 'failed',
        error: 'File not found',
      });
    });
  });

  describe('工具结果', () => {
    it('completed 携带 result 字符串供 StreamOutput 渲染', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];
      segs = reduceSegments(segs, toolStarted('tc1', 'read'), nextId);
      segs = reduceSegments(segs, toolCompleted('tc1', 42, 'file contents'), nextId);

      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({
        type: 'tool_call',
        id: 'tc1',
        status: 'completed',
        result: 'file contents',
        duration: 42,
      });
    });
  });

  describe('工厂函数', () => {
    it('makeToolCallSegment 创建正确的 running 状态 segment', () => {
      const seg = makeToolCallSegment('t1', 'search', { query: 'hello' });
      expect(seg).toMatchObject({
        type: 'tool_call',
        id: 't1',
        name: 'search',
        arguments: { query: 'hello' },
        status: 'running',
      });
    });
  });

  describe('getResponseText', () => {
    it('提取所有 text segment 的拼接文本', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];
      segs = reduceSegments(segs, textDelta('Hello '), nextId);
      segs = reduceSegments(segs, toolStarted('t1', 'search'), nextId);
      segs = reduceSegments(segs, textDelta('World'), nextId);

      expect(getResponseText(segs)).toBe('Hello World');
    });

    it('无 text segment 时返回空字符串', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];
      segs = reduceSegments(segs, toolStarted('t1', 'search'), nextId);
      segs = reduceSegments(segs, toolCompleted('t1'), nextId);

      expect(getResponseText(segs)).toBe('');
    });
  });
});

describe('tailLines', () => {
  it('未超过行数时只 trim，不加省略提示', () => {
    expect(tailLines('  a\nb  ', 4)).toBe('a\nb');
  });

  it('超过行数时保留末尾 maxLines 行并加提示', () => {
    const text = 'l1\nl2\nl3\nl4\nl5';
    expect(tailLines(text, 2)).toBe('…（前文已折叠）\nl4\nl5');
  });

  it('空文本 / maxLines<=0 返回空字符串', () => {
    expect(tailLines('   ', 8)).toBe('');
    expect(tailLines('a\nb', 0)).toBe('');
  });
});

describe('limitSegments', () => {
  function textSeg(id: string, text: string): Segment {
    return { type: 'text', id, text };
  }

  it('只保留最后 maxSegments 段', () => {
    const segs: Segment[] = [textSeg('t1', 'one'), textSeg('t2', 'two'), textSeg('t3', 'three')];
    expect(limitSegments(segs, { maxSegments: 2 }).map((s) => s.id)).toEqual(['t2', 't3']);
  });

  it('默认保留 DEFAULT_MAX_SEGMENTS 段', () => {
    const segs: Segment[] = Array.from({ length: DEFAULT_MAX_SEGMENTS + 2 }, (_, i) =>
      textSeg(`t${i}`, `line ${i}`),
    );
    expect(limitSegments(segs)).toHaveLength(DEFAULT_MAX_SEGMENTS);
    expect(limitSegments(segs)[0]?.id).toBe('t2');
  });

  it('文本段按行截断，工具段保持原样', () => {
    const tool = makeToolCallSegment('c1', 'bash', { command: 'ls' });
    const segs: Segment[] = [textSeg('t1', 'a\nb\nc\nd'), tool];

    const limited = limitSegments(segs, { maxSegments: 6, maxLines: 2 });
    expect(limited[0]).toMatchObject({ type: 'text', text: '…（前文已折叠）\nc\nd' });
    expect(limited[1]).toEqual(tool);
  });
});

describe('getTranscriptText', () => {
  it('文本段原样拼接', () => {
    const segs: Segment[] = [
      { type: 'text', id: 't1', text: 'hello' },
      { type: 'text', id: 't2', text: 'world' },
    ];
    expect(getTranscriptText(segs)).toBe('hello\nworld');
  });

  it('completed 工具段生成紧凑摘要 + 结果', () => {
    const segs: Segment[] = [
      { type: 'text', id: 't1', text: 'Checking.' },
      {
        type: 'tool_call',
        id: 'c1',
        name: 'bash',
        arguments: { command: 'ls' },
        status: 'completed',
        duration: 12,
        result: 'a.txt\nb.txt',
      },
    ];
    expect(getTranscriptText(segs)).toBe('Checking.\n✓ bash (12ms)\na.txt\nb.txt');
  });

  it('failed 工具段生成 ✗ 摘要 + error', () => {
    const segs: Segment[] = [
      {
        type: 'tool_call',
        id: 'c1',
        name: 'bash',
        arguments: {},
        status: 'failed',
        error: 'permission denied',
      },
    ];
    expect(getTranscriptText(segs)).toBe('✗ bash\npermission denied');
  });

  it('超长工具结果只保留末尾 12 行', () => {
    const result = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const segs: Segment[] = [
      {
        type: 'tool_call',
        id: 'c1',
        name: 'bash',
        arguments: {},
        status: 'completed',
        duration: 5,
        result,
      },
    ];
    const transcript = getTranscriptText(segs);
    expect(transcript).toContain('…（前文已折叠）');
    expect(transcript).toContain('line 20');
    expect(transcript).not.toContain('line 7');
    expect(transcript).not.toContain('line 8\n');
  });

  it('running 工具段被跳过', () => {
    const segs: Segment[] = [makeToolCallSegment('c1', 'bash', { command: 'sleep 1' })];
    expect(getTranscriptText(segs)).toBe('');
  });
});
