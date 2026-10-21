import { describe, expect, it } from 'bun:test';
import { buildTrail } from '../src/components/ToolTrail.js';
import type { ToolCallView } from '../src/repl/project/ui-item.js';

function tool(overrides: Partial<ToolCallView> & { id: string }): ToolCallView {
  return {
    name: 'read',
    args: { path: 'src/a.ts' },
    status: 'completed',
    title: 'read',
    subtitle: 'src/a.ts',
    result: 'ok',
    ...overrides,
  };
}

describe('buildTrail（ToolCallView）', () => {
  it('hidden 不渲染 tool trail', () => {
    expect(buildTrail([tool({ id: 'a' })], 'hidden')).toBeNull();
  });

  it('collapsed 只留头 + 最后一条明细', () => {
    const view = buildTrail(
      [
        tool({ id: 'a', title: 'read', subtitle: 'a.ts' }),
        tool({ id: 'b', title: 'bash', subtitle: 'ls', durationMs: 12 }),
      ],
      'collapsed',
    );

    expect(view?.header).toContain('tools (2)');
    expect(view?.lines).toHaveLength(1);
    expect(view?.lines[0]?.text).toContain('└─');
    expect(view?.lines[0]?.text).toContain('bash');
    expect(view?.lines[0]?.text).toContain('ls');
    expect(view?.lines[0]?.text).toContain('12ms');
  });

  it('expanded 最多 8 条并显示更早的条数', () => {
    const views = Array.from({ length: 10 }, (_, index) => tool({ id: `t${index}` }));
    const view = buildTrail(views, 'expanded');

    expect(view?.lines).toHaveLength(9);
    expect(view?.lines[0]?.text).toContain('and 2 earlier');
  });

  it('失败工具在折叠态仍显示首行错误', () => {
    const view = buildTrail(
      [tool({ id: 'a', title: 'bash', status: 'failed', error: 'command failed\nstack trace' })],
      'collapsed',
    );

    expect(view?.lines[0]?.text).toContain('FAILED: command failed');
    expect(view?.lines[0]?.text).not.toContain('stack trace');
  });
});
