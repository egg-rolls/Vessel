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
import { EventType } from '@vessel/core';
import {
  getResponseText,
  makeToolCallSegment,
  reduceSegments,
  type Segment,
} from '../src/components/StreamOutput.js';

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
  return {
    type: EventType.LlmStreamChunk,
    run_id: 'r',
    data: { chunk: { type: 'text_delta', delta } },
    ts: 0,
  };
}

function toolStarted(id: string, name: string, args: unknown = {}) {
  return {
    type: EventType.ToolCallStarted,
    run_id: 'r',
    data: { tool_call_id: id, tool_name: name, arguments: args },
    ts: 0,
  };
}

function toolCompleted(id: string, durationMs = 42) {
  return {
    type: EventType.ToolCallCompleted,
    run_id: 'r',
    data: { tool_call_id: id, duration_ms: durationMs },
    ts: 0,
  };
}

function toolFailed(id: string, error: string, durationMs = 100) {
  return {
    type: EventType.ToolCallFailed,
    run_id: 'r',
    data: { tool_call_id: id, error, duration_ms: durationMs },
    ts: 0,
  };
}

function runStarted() {
  return {
    type: EventType.RunStarted,
    run_id: 'r',
    data: { run_id: 'r', input: 'test' },
    ts: 0,
  };
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
      segs = reduceSegments(segs, toolStarted('tc1', 'read_file', { path: '/test.txt' }), nextId);
      segs = reduceSegments(segs, toolCompleted('tc1', 42), nextId);
      segs = reduceSegments(segs, textDelta('File contents: hello'), nextId);

      expect(segs).toHaveLength(3); // text, tool_call, text
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read_file' });
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
      segs = reduceSegments(segs, toolStarted('tc1', 'read_file'), nextId);
      segs = reduceSegments(segs, toolStarted('tc2', 'write_file'), nextId);
      segs = reduceSegments(segs, textDelta('Done.'), nextId);

      expect(segs).toHaveLength(4);
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read_file' });
      expect(segs[2]).toMatchObject({ type: 'tool_call', name: 'write_file' });
      expect(segs[3]).toMatchObject({ type: 'text', text: 'Done.' });
    });

    it('并行工具调用的 running → completed 状态转换不影响顺序', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, toolStarted('tc1', 'read_file'), nextId);
      segs = reduceSegments(segs, toolStarted('tc2', 'search'), nextId);
      // tc2 先完成
      segs = reduceSegments(segs, toolCompleted('tc2', 10), nextId);
      // tc1 后完成
      segs = reduceSegments(segs, toolCompleted('tc1', 50), nextId);

      expect(segs).toHaveLength(2);
      expect(segs[0]).toMatchObject({ id: 'tc1', name: 'read_file', status: 'completed' });
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
  });

  describe('工具调用失败', () => {
    it('失败的工具调用保留位置并显示错误', () => {
      const nextId = makeNextId();
      let segs: Segment[] = [];

      segs = reduceSegments(segs, textDelta('Trying...'), nextId);
      segs = reduceSegments(segs, toolStarted('tc1', 'read_file'), nextId);
      segs = reduceSegments(segs, toolFailed('tc1', 'File not found', 100), nextId);
      segs = reduceSegments(segs, textDelta('Sorry, failed.'), nextId);

      expect(segs).toHaveLength(3);
      expect(segs[1]).toMatchObject({
        type: 'tool_call',
        name: 'read_file',
        status: 'failed',
        error: 'File not found',
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
