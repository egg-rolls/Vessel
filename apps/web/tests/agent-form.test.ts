import { describe, expect, test } from 'bun:test';
import {
  type AgentDraft,
  buildAgentCreateInput,
  buildAgentUpdateInput,
} from '../src/domains/agents/agent-form';
import {
  agentDetailHash,
  agentEditHash,
  agentHashTarget,
  withQuery,
} from '../src/domains/agents/agent-url';
import { AgentActionResultError, unwrapAgentResult } from '../src/gateway/agent-result';

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  name: '',
  model: '',
  systemPrompt: '',
  teamId: '',
  ...overrides,
});

describe('buildAgentCreateInput', () => {
  test('omits empty fields and binds a team only when selected', () => {
    expect(buildAgentCreateInput(draft())).toEqual({});
    expect(
      buildAgentCreateInput(
        draft({ name: ' Alice ', model: ' m1 ', systemPrompt: ' be nice ', teamId: 'core' }),
      ),
    ).toEqual({ name: 'Alice', model: 'm1', system_prompt: 'be nice', team_id: 'core' });
  });
});

describe('buildAgentUpdateInput', () => {
  const initial = { name: 'Alice', model: 'm1', systemPrompt: 'old' };

  test('reports no change instead of sending an empty update', () => {
    expect(buildAgentUpdateInput('a1', initial, draft())).toEqual({
      ok: false,
      error: 'no_change',
    });
    expect(buildAgentUpdateInput('a1', initial, draft({ name: ' Alice ', model: 'm1' }))).toEqual({
      ok: false,
      error: 'no_change',
    });
  });

  test('sends only changed fields and trims them', () => {
    expect(buildAgentUpdateInput('a1', initial, draft({ name: ' Alice 2 ', model: 'm2' }))).toEqual(
      { ok: true, input: { agent_id: 'a1', name: 'Alice 2', model: 'm2' } },
    );
    expect(buildAgentUpdateInput('a1', initial, draft({ systemPrompt: 'new prompt' }))).toEqual({
      ok: true,
      input: { agent_id: 'a1', system_prompt: 'new prompt' },
    });
  });

  test('blank fields are treated as “keep unchanged”, not as clearing', () => {
    expect(
      buildAgentUpdateInput('a1', initial, draft({ name: '', model: '', systemPrompt: '' })),
    ).toEqual({ ok: false, error: 'no_change' });
  });
});

describe('unwrapAgentResult', () => {
  test('returns the single successful entry', () => {
    expect(
      unwrapAgentResult({ results: [{ ok: true, agent: { agent_id: 'a1', name: 'Alice' } }] }),
    ).toEqual({ agent_id: 'a1', name: 'Alice' });
  });

  test('turns a failed result entry into a typed error', () => {
    // 反向验证：批量响应里的 ok:false 不能被当成成功。
    expect(() =>
      unwrapAgentResult({
        results: [{ ok: false, code: 'forbidden', error: 'team-scoped token' }],
      }),
    ).toThrow(AgentActionResultError);
    try {
      unwrapAgentResult({ results: [{ ok: false, code: 'forbidden', error: 'denied' }] });
    } catch (error) {
      expect((error as AgentActionResultError).code).toBe('forbidden');
      expect((error as AgentActionResultError).message).toBe('denied');
    }
  });

  test('rejects an empty or missing result list', () => {
    expect(() => unwrapAgentResult({ results: [] })).toThrow('agents.* returned no results');
    expect(() => unwrapAgentResult({})).toThrow('agents.* returned no results');
  });
});

describe('agent hash helpers', () => {
  test('round-trips detail and edit hashes', () => {
    const detail = agentDetailHash('node/1', 'agent 1');
    expect(detail).toBe('#/agents/node%2F1/agent%201');
    expect(agentHashTarget(detail)).toEqual({
      nodeKey: 'node/1',
      agentId: 'agent 1',
      mode: 'detail',
    });

    const edit = agentEditHash('node/1', 'agent 1');
    expect(edit).toBe('#/agents/node%2F1/agent%201/edit');
    expect(agentHashTarget(edit)).toEqual({
      nodeKey: 'node/1',
      agentId: 'agent 1',
      mode: 'edit',
    });
  });

  test('ignores the list, query-only routes and other domains', () => {
    expect(agentHashTarget('#/agents')).toBeUndefined();
    expect(agentHashTarget('#/agents?node=n')).toBeUndefined();
    expect(agentHashTarget('#/agents/n')).toBeUndefined();
    expect(agentHashTarget('#/teams/n/a')).toBeUndefined();
  });

  test('keeps list filters when appending a query', () => {
    expect(withQuery('#/agents/n/a', 'node=n&state=running')).toBe(
      '#/agents/n/a?node=n&state=running',
    );
    expect(withQuery('#/agents/n/a', '')).toBe('#/agents/n/a');
  });
});
