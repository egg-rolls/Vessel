import { describe, expect, it } from 'bun:test';
import type { RunEvent } from '@vessel-agent/core';
import { createAgentRegistry } from '../src/agents-registry';

function event(type: string, runId: string, data: Record<string, unknown>, ts = 1000): RunEvent {
  return { type, run_id: runId, data, ts };
}

describe('agent registry', () => {
  it('derives delegate nodes with parent, depth, session and usage', () => {
    const registry = createAgentRegistry();
    for (const item of [
      event('run.started', 'parent', { run_id: 'parent', session_id: 's1' }, 1),
      event(
        'subagent.delegate.started',
        'parent',
        { delegateId: 'd1', depth: 0, task: 'research' },
        2,
      ),
      event('subagent.run.started', 'r1', { agentId: 'd1', run_id: 'r1', session_id: 's1' }, 3),
      event('subagent.tool.call.started', 'r1', { agentId: 'd1', tool_name: 'bash' }, 4),
      event('subagent.delegate.started', 'r1', { delegateId: 'd2', depth: 1, task: 'nested' }, 5),
      event('subagent.run.started', 'r2', { agentId: 'd2', run_id: 'r2', session_id: 's2' }, 6),
      event(
        'subagent.run.completed',
        'r2',
        { agentId: 'd2', run_id: 'r2', session_id: 's2', usage: { total_tokens: 7 } },
        7,
      ),
      event(
        'subagent.delegate.completed',
        'parent',
        { delegateId: 'd1', duration_ms: 10, usage: { total_tokens: 11 } },
        8,
      ),
    ]) {
      registry.ingest(item);
    }

    const list = registry.list();
    expect(list.map((entry) => entry.id)).toEqual(['d1', 'd2']);
    const d1 = registry.get('d1');
    expect(d1).toMatchObject({
      id: 'd1',
      role: 'subagent',
      depth: 0,
      state: 'completed',
      session_id: 's1',
      task: 'research',
      usage: { total_tokens: 11 },
    });
    expect(d1?.parent_id).toBeUndefined();
    expect(d1?.current_tool).toBeUndefined();
    const d2 = registry.get('d2');
    expect(d2).toMatchObject({ id: 'd2', depth: 1, state: 'completed', parent_id: 'd1' });
    expect(registry.list({ session_id: 's2' }).map((entry) => entry.id)).toEqual(['d2']);
    expect(registry.list({ state: 'running' })).toEqual([]);
  });

  it('tracks current tool until completion and filters by state', () => {
    const registry = createAgentRegistry();
    registry.ingest(
      event('subagent.delegate.started', 'root', { delegateId: 'a', depth: 0, task: 't' }),
    );
    registry.ingest(event('subagent.tool.call.started', 'ra', { agentId: 'a', tool_name: 'read' }));
    expect(registry.get('a')?.current_tool).toBe('read');
    expect(registry.list({ state: 'running' })).toHaveLength(1);
    registry.ingest(
      event('subagent.tool.call.completed', 'ra', { agentId: 'a', tool_name: 'read' }),
    );
    expect(registry.get('a')?.current_tool).toBeUndefined();
  });

  it('records failures even without a preceding delegate.started', () => {
    const registry = createAgentRegistry();
    registry.ingest(
      event('subagent.delegate.failed', 'root', { delegateId: 'orphan', error: 'boom' }),
    );
    expect(registry.get('orphan')).toMatchObject({
      id: 'orphan',
      state: 'failed',
      last_error: 'boom',
    });
  });

  it('ignores non-subagent events and malformed payloads', () => {
    const registry = createAgentRegistry();
    registry.ingest(event('tool.call.started', 'r1', { tool_name: 'bash' }));
    registry.ingest(event('subagent.delegate.started', 'r1', {}));
    registry.ingest(event('subagent.tool.call.started', 'r1', { tool_name: 'bash' }));
    expect(registry.list()).toEqual([]);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('does not duplicate nodes on repeated lifecycle events', () => {
    const registry = createAgentRegistry();
    const started = event('subagent.delegate.started', 'root', {
      delegateId: 'a',
      depth: 0,
      task: 't',
    });
    registry.ingest(started);
    registry.ingest(started);
    expect(registry.list()).toHaveLength(1);
    registry.ingest(event('subagent.delegate.completed', 'root', { delegateId: 'a' }));
    registry.ingest(event('subagent.delegate.completed', 'root', { delegateId: 'a' }));
    expect(registry.list()).toHaveLength(1);
  });
});
