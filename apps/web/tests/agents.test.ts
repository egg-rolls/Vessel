import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '../src/gateway/types';
import {
  agentBreadcrumb,
  agentsForSession,
  agentTree,
  findAgent,
  reduceAgents,
} from '../src/state/agents';
import type { StoredEvent } from '../src/state/events';

let nextSeq = 1;

function stored(
  type: string,
  runId: string,
  data: Record<string, unknown> = {},
  ts = 1,
): StoredEvent {
  const event: RunEvent = { type, run_id: runId, data, ts };
  return { event, seq: nextSeq++ };
}

function nestedEvents(): StoredEvent[] {
  return [
    stored('run.started', 'parent', { session_id: 's1' }, 1),
    stored(
      'subagent.delegate.started',
      'parent',
      { delegateId: 'd1', depth: 0, task: 'research' },
      2,
    ),
    stored('subagent.run.started', 'r1', { agentId: 'd1', run_id: 'r1', session_id: 's1' }, 3),
    stored('subagent.tool.call.started', 'r1', { agentId: 'd1', tool_name: 'bash' }, 4),
    stored('subagent.delegate.started', 'r1', { delegateId: 'd2', depth: 1, task: 'nested' }, 5),
    stored('subagent.run.started', 'r2', { agentId: 'd2', run_id: 'r2', session_id: 's2' }, 6),
    stored(
      'subagent.run.completed',
      'r2',
      { agentId: 'd2', run_id: 'r2', session_id: 's2', usage: { total_tokens: 5 } },
      7,
    ),
    stored(
      'subagent.delegate.completed',
      'parent',
      { delegateId: 'd1', usage: { total_tokens: 9 } },
      8,
    ),
  ];
}

describe('reduceAgents queue fields', () => {
  test('applies agent.queue.entered and clears on leave', () => {
    const base = [
      stored('subagent.delegate.started', 'root', { delegateId: 'd1', task: 'research' }, 1),
      stored(
        'agent.queue.entered',
        'root',
        { agent_id: 'd1', position: 2, wait_reason: 'model_slot' },
        2,
      ),
    ];
    const queued = findAgent(reduceAgents(base), 'd1');
    expect(queued).toMatchObject({
      state: 'queued',
      queuePosition: 2,
      waitReason: 'model_slot',
      lastSeen: 2,
    });

    const left = findAgent(
      reduceAgents([...base, stored('agent.queue.left', 'root', { agent_id: 'd1' }, 3)]),
      'd1',
    );
    expect(left).toMatchObject({ state: 'running', lastSeen: 3 });
    expect(left?.queuePosition).toBeUndefined();
    expect(left?.waitReason).toBeUndefined();
  });
});

describe('reduceAgents', () => {
  test('derives nested nodes, session, usage and terminal state', () => {
    const nodes = reduceAgents(nestedEvents());
    expect(nodes.map((node) => node.id)).toEqual(['d1', 'd2']);
    const d1 = findAgent(nodes, 'd1');
    expect(d1).toMatchObject({
      id: 'd1',
      depth: 0,
      state: 'completed',
      sessionId: 's1',
      task: 'research',
      usage: { total_tokens: 9 },
      runId: 'r1',
    });
    expect(d1?.parentId).toBeUndefined();
    expect(d1?.currentTool).toBeUndefined();
    expect(findAgent(nodes, 'd2')).toMatchObject({
      depth: 1,
      parentId: 'd1',
      state: 'completed',
      sessionId: 's2',
    });
  });

  test('keeps nodes scoped to the session, including orphaned children', () => {
    const nodes = reduceAgents(nestedEvents());
    expect(agentsForSession(nodes, 's1').map((node) => node.id)).toEqual(['d1', 'd2']);
    expect(agentsForSession(nodes, 's2').map((node) => node.id)).toEqual(['d2']);
    expect(agentsForSession(nodes, 'other')).toEqual([]);
  });

  test('records failures and clears the current tool', () => {
    const nodes = reduceAgents([
      stored('run.started', 'root', { session_id: 's1' }),
      stored('subagent.delegate.started', 'root', { delegateId: 'a', depth: 0 }),
      stored('subagent.tool.call.started', 'ra', { agentId: 'a', tool_name: 'read' }),
      stored('subagent.run.failed', 'ra', { agentId: 'a', error: 'boom' }),
    ]);
    expect(nodes[0]).toMatchObject({ state: 'failed', lastError: 'boom' });
    expect(nodes[0]?.currentTool).toBeUndefined();
  });

  test('ignores malformed and non-subagent events', () => {
    expect(
      reduceAgents([
        stored('tool.call.started', 'r', { tool_name: 'bash' }),
        stored('subagent.delegate.started', 'r', {}),
        stored('subagent.run.started', 'r', { session_id: 's' }),
      ]),
    ).toEqual([]);
  });
});

describe('agentTree / agentBreadcrumb', () => {
  test('builds nested tree and breadcrumb', () => {
    const nodes = reduceAgents(nestedEvents());
    const tree = agentTree(nodes);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.id).toBe('d1');
    expect(tree[0]?.children.map((entry) => entry.node.id)).toEqual(['d2']);
    expect(agentBreadcrumb(nodes, 'd2').map((node) => node.id)).toEqual(['d1', 'd2']);
  });

  test('keeps orphaned / cyclic nodes visible', () => {
    const orphan = { id: 'x', parentId: 'missing', depth: 0, state: 'running' };
    const a = { id: 'a', parentId: 'b', depth: 0, state: 'running' };
    const b = { id: 'b', parentId: 'a', depth: 1, state: 'running' };
    const ids: string[] = [];
    const walk = (entries: ReturnType<typeof agentTree>) => {
      for (const entry of entries) {
        ids.push(entry.node.id);
        walk(entry.children);
      }
    };
    walk(agentTree([orphan, a, b]));
    expect(ids.sort()).toEqual(['a', 'b', 'x']);
    // 纯环没有真正 root：返回终止的祖先链，不重复起点。
    expect(agentBreadcrumb([a, b], 'a').map((node) => node.id)).toEqual(['b', 'a']);
  });
});
