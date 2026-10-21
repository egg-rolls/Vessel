import { describe, expect, it } from 'bun:test';
import { buildSubagentLines, MAX_SUBAGENT_LINES } from '../src/components/SubagentActivity.js';
import type { AgentNode } from '../src/repl/agent-registry.js';

function node(overrides: Partial<AgentNode> & { id: string }): AgentNode {
  return {
    role: 'agent',
    parentRunId: 'r1',
    depth: 0,
    state: 'running',
    startedAt: 1,
    ...overrides,
  };
}

describe('buildSubagentLines（agent-registry 派生）', () => {
  it('只显示 running / waiting_permission', () => {
    const lines = buildSubagentLines([
      node({ id: 'a', state: 'running' }),
      node({ id: 'b', state: 'completed' }),
      node({ id: 'c', state: 'failed' }),
      node({ id: 'd', state: 'waiting_permission' }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('agent d · waiting_permission');
    expect(lines[1]).toContain('agent a · running');
  });

  it('头行包含 agent <id> · state，并带当前工具与任务', () => {
    const [line] = buildSubagentLines([
      node({ id: 'a', state: 'running', currentTool: 'bash', task: '查资料' }),
    ]);
    expect(line).toContain('agent a · running');
    expect(line).toContain('· bash');
    expect(line).toContain('· 查资料');
  });

  it('按 depth 树形缩进', () => {
    const lines = buildSubagentLines([
      node({ id: 'root', depth: 0, startedAt: 2 }),
      node({ id: 'child', depth: 1, startedAt: 1 }),
    ]);
    expect(lines[0]).toContain('↳ agent root');
    expect(lines[1]?.startsWith('  ↳')).toBe(true);
  });

  it('最多显示 MAX_SUBAGENT_LINES 条，新节点在前', () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      node({ id: `a${index}`, startedAt: index }),
    );
    const lines = buildSubagentLines(nodes);
    expect(lines).toHaveLength(MAX_SUBAGENT_LINES);
    expect(lines[0]).toContain('agent a5');
  });

  it('无活跃成员时返回空数组', () => {
    expect(buildSubagentLines([node({ id: 'a', state: 'completed' })])).toEqual([]);
  });
});
