import { describe, expect, it } from 'bun:test';
import type { Segment } from '../src/components/StreamOutput.js';
import { buildTrail, groupSegments, type ToolSegment } from '../src/components/ToolTrail.js';

function text(id: string, value: string): Segment {
  return { type: 'text', id, text: value };
}

function tool(
  id: string,
  name: string,
  status: 'running' | 'completed' | 'failed' = 'completed',
  extra: Partial<ToolSegment> = {},
): ToolSegment {
  return {
    type: 'tool_call',
    id,
    name,
    arguments: { path: 'src/a.ts', command: 'bun test' },
    status,
    result: status === 'completed' ? 'ok' : undefined,
    ...extra,
  };
}

describe('groupSegments', () => {
  it('聚合连续工具段但不改变文本段顺序', () => {
    const groups = groupSegments([
      text('t1', 'first'),
      tool('a', 'read'),
      tool('b', 'bash'),
      text('t2', 'second'),
    ]);

    expect(groups.map((group) => group.type)).toEqual(['text', 'tools', 'text']);
    const tools = groups[1];
    expect(tools?.type).toBe('tools');
    if (tools?.type === 'tools') {
      expect(tools.segments.map((segment) => segment.id)).toEqual(['a', 'b']);
    }
  });
});

describe('buildTrail', () => {
  it('hidden 不渲染 tool trail', () => {
    expect(buildTrail([tool('a', 'read')], 'hidden')).toBeNull();
  });

  it('collapsed 只留头 + 最后一条明细', () => {
    const view = buildTrail([tool('a', 'read'), tool('b', 'bash')], 'collapsed');

    expect(view?.header).toContain('tools (2)');
    expect(view?.lines).toHaveLength(1);
    expect(view?.lines[0]?.text).toContain('└─');
    expect(view?.lines[0]?.text).toContain('bash');
  });

  it('expanded 最多 8 条并显示更早的条数', () => {
    const segments = Array.from({ length: 10 }, (_, index) => tool(`t${index}`, 'read'));
    const view = buildTrail(segments, 'expanded');

    expect(view?.lines).toHaveLength(9);
    expect(view?.lines[0]?.text).toContain('and 2 earlier');
  });

  it('失败工具在折叠态仍显示首行错误', () => {
    const view = buildTrail(
      [tool('a', 'bash', 'failed', { error: 'command failed\nstack trace' })],
      'collapsed',
    );

    expect(view?.lines[0]?.text).toContain('FAILED: command failed');
    expect(view?.lines[0]?.text).not.toContain('stack trace');
  });
});
