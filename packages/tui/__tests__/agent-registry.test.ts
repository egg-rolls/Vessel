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

  it('creates an idle member node from agent.spawned with visibility', () => {
    const nodes = buildAgentRegistry([
      ev(
        'agent.spawned',
        'm1',
        {
          agent_id: 'm1',
          session_id: 's1',
          parent_id: 'main',
          visibility: 'team',
          state: 'idle',
        },
        1000,
      ),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'm1',
      role: 'agent',
      sessionId: 's1',
      parentId: 'main',
      visibility: 'team',
      state: 'idle',
    });
  });

  it('tracks turn state and does not leave current_tool behind after completion', () => {
    let nodes = buildAgentRegistry([
      ev('agent.spawned', 'm1', { agent_id: 'm1', state: 'idle' }, 1000),
    ]);
    nodes = reduceAgentRegistry(
      nodes,
      ev('agent.turn.started', 'm1', { agent_id: 'm1', state: 'running' }, 1100),
    );
    expect(nodes[0]?.state).toBe('running');

    nodes = reduceAgentRegistry(
      nodes,
      ev(
        'agent.permission.requested',
        'm1',
        { agent_id: 'm1', state: 'waiting_permission', tool: 'bash' },
        1200,
      ),
    );
    expect(nodes[0]).toMatchObject({ state: 'waiting_permission', currentTool: 'bash' });

    nodes = reduceAgentRegistry(
      nodes,
      ev('agent.permission.responded', 'm1', { agent_id: 'm1', state: 'running' }, 1300),
    );
    expect(nodes[0]?.state).toBe('running');
    expect(nodes[0]?.currentTool).toBeUndefined();

    nodes = reduceAgentRegistry(
      nodes,
      ev(
        'agent.turn.completed',
        'm1',
        { agent_id: 'm1', state: 'completed', usage: { total_tokens: 15 } },
        1400,
      ),
    );
    expect(nodes[0]).toMatchObject({
      state: 'completed',
      endedAt: 1400,
      usage: { total_tokens: 15 },
    });
  });

  it('keeps closed and stale members from being revived by late turn events', () => {
    const closed = buildAgentRegistry([
      ev('agent.spawned', 'm1', { agent_id: 'm1', state: 'idle' }, 1000),
      ev('agent.closed', 'm1', { agent_id: 'm1', state: 'closed' }, 1100),
      ev('agent.turn.failed', 'm1', { agent_id: 'm1', state: 'failed', reason: 'late' }, 1200),
    ]);
    expect(closed[0]?.state).toBe('closed');
    expect(closed[0]?.error).toBeUndefined();

    const stale = buildAgentRegistry([
      ev('agent.stale', 'm2', { agent_id: 'm2', session_id: 's2', state: 'stale' }, 1000),
      ev('agent.turn.started', 'm2', { agent_id: 'm2', state: 'running' }, 1100),
    ]);
    expect(stale[0]).toMatchObject({ id: 'm2', sessionId: 's2', state: 'stale' });
  });

  it('keeps legacy subagent nodes when agent.* events are also present', () => {
    const nodes = buildAgentRegistry([
      ev('subagent.delegate.started', 'run-parent', { delegateId: 'd1', depth: 0 }, 1000),
      ev('agent.spawned', 'm1', { agent_id: 'm1', state: 'idle' }, 1100),
    ]);

    expect(nodes.map((node) => node.id)).toEqual(['d1', 'm1']);
    expect(nodes[0]?.role).toBe('subagent');
    expect(nodes[1]?.role).toBe('agent');
  });

  it('marks still-running members completed when the parent run completes', () => {
    const nodes = buildAgentRegistry([
      ev(
        'agent.spawned',
        'root',
        { agent_id: 'm1', state: 'running', parent_run_id: 'root' },
        1000,
      ),
      ev('run.completed', 'root', {}, 1100),
    ]);

    expect(nodes[0]).toMatchObject({ id: 'm1', state: 'completed', endedAt: 1100 });
  });

  it('does not invent a member from core queue events without a spawn', () => {
    const nodes = buildAgentRegistry([
      ev(
        'agent.queue.entered',
        'r1',
        { agent_id: 'ghost', position: 1, wait_reason: 'capacity' },
        1000,
      ),
    ]);

    expect(nodes).toHaveLength(0);
  });
});
