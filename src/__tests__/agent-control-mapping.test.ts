/**
 * app 侧 AgentService → canonical `agents.create` 适配（0.27 S2b）。
 *
 * 守：kind / team_id / owner / parent_id / spawnedBy 的批量映射；peer 结果没有
 * owner 时仍按契约产出（owner 可选）。
 */

import { describe, expect, it } from 'bun:test';
import type { AgentService, CreateMemberInput, MemberStatus } from '@vessel-agent/agent';
import { createAgentControl } from '../agent-control';

function member(id: string, overrides: Partial<MemberStatus> = {}): MemberStatus {
  return {
    id,
    session_id: id,
    role: 'member',
    visibility: 'team',
    state: 'idle',
    ...overrides,
  };
}

describe('createAgentControl.create', () => {
  it('maps peer / contractor batch entries to CreateMemberInput', async () => {
    const seen: CreateMemberInput[] = [];
    const service = {
      async create(input: { members: CreateMemberInput[] }) {
        seen.push(...input.members);
        return {
          results: input.members.map((entry, index) => ({
            ok: true as const,
            status: member(`id-${index + 1}`, {
              ...(typeof entry.owner === 'string' ? { owner: entry.owner } : {}),
              ...(entry.teamId !== undefined ? { team_id: entry.teamId } : {}),
              ...(entry.name !== undefined ? { name: entry.name } : {}),
            }),
          })),
        };
      },
    } as unknown as AgentService;

    const control = createAgentControl(service, 'default');
    const result = await control.create([
      { kind: 'peer', team_id: 'alpha', name: 'peer-one' },
      {
        kind: 'contractor',
        team_id: 'alpha',
        name: 'contractor-one',
        owner: 'owner-1',
        parent_id: 'owner-1',
        spawnedBy: 'owner-1',
      },
      { kind: 'contractor', name: 'unbound', spawnedBy: 'human' },
    ]);

    expect(seen).toEqual([
      { kind: 'peer', teamId: 'alpha', name: 'peer-one' },
      {
        kind: 'contractor',
        teamId: 'alpha',
        name: 'contractor-one',
        owner: 'owner-1',
        parentId: 'owner-1',
        spawnedBy: 'owner-1',
      },
      { kind: 'contractor', name: 'unbound', spawnedBy: 'human' },
    ]);
    expect(result.results.map((entry) => entry.ok)).toEqual([true, true, true]);
    const first = result.results[0];
    expect(first?.ok && first.agent.owner).toBeUndefined();
  });
});
