import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel-agent/core';
import {
  buildAgentRegistry,
  MAX_AGENT_NODES,
  matchAgents,
  reduceAgentRegistry,
  sortAgentNodes,
  toAgentSummary,
} from '../src/repl/agent-registry.js';

function ev(type: string, runId: string, data: Record<string, unknown>, ts = 1000): RunEvent {
  return { type, run_id: runId, data, ts } as RunEvent;
}

describe('agent registry reducer', () => {
  it('creates a running node from subagent.delegate.started', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'd1',
        depth: 0,
        task: 'research',
        session_id: 's1',
      }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'd1',
      role: 'subagent',
      parentRunId: 'run-parent',
      depth: 0,
      task: 'research',
      sessionId: 's1',
      state: 'running',
    });
  });

  it('maps child run and current tool, then clears the tool on completion', () => {
    let nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }),
    ]);
    nodes = reduceAgentRegistry(
      nodes,
      ev('subagent.run.started', 'run-child', { delegateId: 'd1', session_id: 's1' }, 1100),
    );
    nodes = reduceAgentRegistry(
      nodes,
      ev('subagent.tool.call.started', 'run-child', { delegateId: 'd1', tool_name: 'bash' }, 1200),
    );

    expect(nodes[0]).toMatchObject({
      childRunId: 'run-child',
      currentTool: 'bash',
      state: 'running',
    });

    nodes = reduceAgentRegistry(
      nodes,
      ev(
        'subagent.tool.call.completed',
        'run-child',
        { delegateId: 'd1', tool_name: 'bash' },
        1300,
      ),
    );
    expect(nodes[0]?.currentTool).toBeUndefined();
    expect(nodes[0]?.state).toBe('running');
  });

  it('applies terminal states, duration and usage', () => {
    let nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }),
    ]);
    nodes = reduceAgentRegistry(
      nodes,
      ev(
        'subagent.delegate.completed',
        'run-parent',
        {
          delegateId: 'd1',
          duration_ms: 1500,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        2500,
      ),
    );

    expect(nodes[0]).toMatchObject({
      state: 'completed',
      endedAt: 2500,
      durationMs: 1500,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it('marks failed subagents with the error text', () => {
    let nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }),
    ]);
    nodes = reduceAgentRegistry(
      nodes,
      ev('subagent.run.failed', 'run-child', { delegateId: 'd1', error: 'boom' }, 2000),
    );

    expect(nodes[0]).toMatchObject({ state: 'failed', error: 'boom', endedAt: 2000 });
  });

  it('closes still-running children when the parent run fails or is cancelled', () => {
    const started = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }),
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd2', depth: 0 }),
    ]);
    const failed = reduceAgentRegistry(
      started,
      ev('run.failed', 'run-parent', { error: 'parent died' }, 3000),
    );
    expect(failed.every((node) => node.state === 'failed')).toBe(true);
    expect(failed[0]?.error).toBe('parent died');

    const cancelled = reduceAgentRegistry(started, ev('run.cancelled', 'run-parent', {}, 4000));
    expect(cancelled.every((node) => node.state === 'cancelled')).toBe(true);
  });

  it('reads nested parent_delegate_id and session fields', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'root',
        depth: 0,
        session_id: 's1',
      }),
      ev('subagent.delegate.started', 'run-child', {
        delegateId: 'nested',
        parent_delegate_id: 'root',
        depth: 1,
        parent_session_id: 's1',
      }),
    ]);

    expect(nodes[1]).toMatchObject({
      id: 'nested',
      parentId: 'root',
      depth: 1,
      sessionId: 's1',
    });
  });

  it('degrades events without delegateId instead of inventing a parent', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { depth: 0, task: 'x' }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.degraded).toBe(true);
    expect(nodes[0]?.id.startsWith('delegate:run-parent:')).toBe(true);
    expect(nodes[0]?.parentId).toBeUndefined();
  });

  it('returns canonical agents.list field names', () => {
    const [node] = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', {
        delegateId: 'd1',
        depth: 2,
        session_id: 's1',
      }),
    ]);
    if (!node) throw new Error('expected node');

    expect(toAgentSummary({ ...node, currentTool: 'read' })).toEqual({
      id: 'd1',
      role: 'subagent',
      depth: 2,
      state: 'running',
      current_tool: 'read',
      session_id: 's1',
    });
  });

  it('matches exact ids first, then unique prefixes; ambiguity is reported', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'r', { delegateId: 'abc1' }),
      ev('subagent.delegate.started', 'r', { delegateId: 'abc2' }),
      ev('subagent.delegate.started', 'r', { delegateId: 'abd3' }),
    ]);

    expect(matchAgents(nodes, 'abc1').exact.map((node) => node.id)).toEqual(['abc1']);
    expect(matchAgents(nodes, 'abd').prefix.map((node) => node.id)).toEqual(['abd3']);
    expect(matchAgents(nodes, 'abc').prefix).toHaveLength(2);
    expect(matchAgents(nodes, 'zzz')).toEqual({ exact: [], prefix: [] });
  });

  it('caps the registry and sorts newest first', () => {
    const events: RunEvent[] = [];
    for (let index = 0; index < MAX_AGENT_NODES + 5; index += 1) {
      events.push(ev('subagent.delegate.started', 'run', { delegateId: `d${index}` }, index + 1));
    }
    const nodes = buildAgentRegistry(events);
    expect(nodes).toHaveLength(MAX_AGENT_NODES);
    expect(nodes[0]?.id).toBe('d5');

    const sorted = sortAgentNodes(nodes);
    expect(sorted[0]?.id).toBe(`d${MAX_AGENT_NODES + 4}`);
    expect(sorted.at(-1)?.id).toBe('d5');
  });
});
