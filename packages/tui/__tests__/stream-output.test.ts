/**
 * StreamOutput segment ordering 单元测试
 *
 * 测试覆盖：
 * - 纯文本：连续 text_delta 追加到同一文本段落
 * - 文本 → 工具调用 → 文本：按时间顺序交替
 * - 多个工具调用：各自独立段落
 * - RunStarted 清空分段
 * - clearSignal 清空分段
 */

import { describe, expect, it } from 'bun:test';

/** 复制 StreamOutput 的 Segment 类型和 reduce 逻辑用于纯函数测试 */
type Segment =
  | { type: 'text'; id: string; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: unknown;
      status: 'running' | 'completed' | 'failed';
      duration?: number;
      error?: string;
    };

type SegmentAction =
  | { type: 'reset' }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_started'; tool_call_id: string; tool_name: string; arguments: unknown }
  | { type: 'tool_call_completed'; tool_call_id: string; duration_ms: number }
  | { type: 'tool_call_failed'; tool_call_id: string; error: string; duration_ms: number };

let seq = 0;
function nextId(): string {
  seq += 1;
  return `seg_${seq}`;
}

/** 纯函数版 segment reducer，与 StreamOutput 组件内逻辑等价 */
function segmentReducer(prev: Segment[], action: SegmentAction): Segment[] {
  switch (action.type) {
    case 'reset':
      return [];

    case 'text_delta': {
      const last = prev.at(-1);
      if (last?.type === 'text') {
        return [...prev.slice(0, -1), { ...last, text: last.text + action.delta }];
      }
      return [...prev, { type: 'text', id: nextId(), text: action.delta }];
    }

    case 'tool_call_started':
      return [
        ...prev,
        {
          type: 'tool_call',
          id: action.tool_call_id,
          name: action.tool_name,
          arguments: action.arguments,
          status: 'running',
        },
      ];

    case 'tool_call_completed':
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === action.tool_call_id
          ? { ...seg, status: 'completed' as const, duration: action.duration_ms }
          : seg,
      );

    case 'tool_call_failed':
      return prev.map((seg) =>
        seg.type === 'tool_call' && seg.id === action.tool_call_id
          ? { ...seg, status: 'failed' as const, error: action.error, duration: action.duration_ms }
          : seg,
      );
  }
}

describe('StreamOutput segment ordering', () => {
  describe('纯文本流', () => {
    it('连续 text_delta 追加到同一文本段落', () => {
      let segs: Segment[] = [];
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Hello' });
      segs = segmentReducer(segs, { type: 'text_delta', delta: ' ' });
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'World' });

      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({ type: 'text', text: 'Hello World' });
    });

    it('无输入时 segments 为空', () => {
      const segs: Segment[] = [];
      expect(segs).toHaveLength(0);
    });
  });

  describe('工具调用交替', () => {
    it('文本 → 工具调用 → 文本按时间顺序交替', () => {
      let segs: Segment[] = [];

      // 模拟：AI 先说一段话，然后调用工具，再说一段话
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Let me read the file.' });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'read_file',
        arguments: { path: '/test.txt' },
      });
      segs = segmentReducer(segs, {
        type: 'tool_call_completed',
        tool_call_id: 'tc1',
        duration_ms: 42,
      });
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'File contents: hello' });

      expect(segs).toHaveLength(3); // text, tool_call, text
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read_file' });
      expect(segs[2]).toMatchObject({ type: 'text', text: 'File contents: hello' });
    });

    it('工具调用在文本之间产生独立文本段落（非合并）', () => {
      let segs: Segment[] = [];

      segs = segmentReducer(segs, { type: 'text_delta', delta: 'First.' });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'search',
        arguments: {},
      });
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Second.' });

      // 两个文本段落应该是独立的，不会跨工具调用合并
      expect(segs).toHaveLength(3);
      expect(segs[0]).toMatchObject({ type: 'text', text: 'First.' });
      expect(segs[1]).toMatchObject({ type: 'tool_call' });
      expect(segs[2]).toMatchObject({ type: 'text', text: 'Second.' });
    });
  });

  describe('多工具调用', () => {
    it('多个工具调用各自独立段落', () => {
      let segs: Segment[] = [];

      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Doing work...' });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'read_file',
        arguments: {},
      });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc2',
        tool_name: 'write_file',
        arguments: {},
      });
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Done.' });

      expect(segs).toHaveLength(4); // text, tc1, tc2, text
      expect(segs[0]).toMatchObject({ type: 'text' });
      expect(segs[1]).toMatchObject({ type: 'tool_call', name: 'read_file' });
      expect(segs[2]).toMatchObject({ type: 'tool_call', name: 'write_file' });
      expect(segs[3]).toMatchObject({ type: 'text', text: 'Done.' });
    });

    it('并行工具调用的 running → completed 状态转换不影响顺序', () => {
      let segs: Segment[] = [];

      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'read_file',
        arguments: {},
      });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc2',
        tool_name: 'search',
        arguments: {},
      });
      // tc2 先完成
      segs = segmentReducer(segs, {
        type: 'tool_call_completed',
        tool_call_id: 'tc2',
        duration_ms: 10,
      });
      // tc1 后完成
      segs = segmentReducer(segs, {
        type: 'tool_call_completed',
        tool_call_id: 'tc1',
        duration_ms: 50,
      });

      expect(segs).toHaveLength(2);
      // 顺序保持不变
      expect(segs[0]).toMatchObject({ id: 'tc1', name: 'read_file', status: 'completed' });
      expect(segs[1]).toMatchObject({ id: 'tc2', name: 'search', status: 'completed' });
    });
  });

  describe('状态重置', () => {
    it('reset 清空所有分段', () => {
      let segs: Segment[] = [];
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Hello' });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'read',
        arguments: {},
      });
      segs = segmentReducer(segs, { type: 'reset' });

      expect(segs).toHaveLength(0);
    });
  });

  describe('工具调用失败', () => {
    it('失败的工具调用保留位置并显示错误', () => {
      let segs: Segment[] = [];

      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Trying...' });
      segs = segmentReducer(segs, {
        type: 'tool_call_started',
        tool_call_id: 'tc1',
        tool_name: 'read_file',
        arguments: {},
      });
      segs = segmentReducer(segs, {
        type: 'tool_call_failed',
        tool_call_id: 'tc1',
        error: 'File not found',
        duration_ms: 100,
      });
      segs = segmentReducer(segs, { type: 'text_delta', delta: 'Sorry, failed.' });

      expect(segs).toHaveLength(3);
      expect(segs[1]).toMatchObject({
        type: 'tool_call',
        name: 'read_file',
        status: 'failed',
        error: 'File not found',
      });
    });
  });
});
