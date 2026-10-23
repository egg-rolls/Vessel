import { describe, expect, it } from 'bun:test';
import {
  AgentError,
  canTransition,
  type MemberRecord,
  MemberRegistry,
  toMemberStatus,
  toPersistedRecord,
  toRuntimeMember,
} from '../src/index.js';

function record(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: 'm1',
    sessionId: 'm1',
    bodyHistory: [],
    owner: 'main',
    visibility: 'private',
    state: 'idle',
    presence: 'live',
    membership: 'present',
    rotation: 'stable',
    ...overrides,
  };
}

describe('MemberRegistry state machine', () => {
  it('rejects an illegal transition out of closed', () => {
    const registry = new MemberRegistry(() => 1);
    registry.add(record({ state: 'closed' }));

    const error = (() => {
      try {
        registry.setState('m1', 'running');
        return undefined;
      } catch (reason) {
        return reason;
      }
    })();

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('invalid_state_transition');
    expect(registry.get('m1')?.state).toBe('closed');
  });

  it('allows the documented terminal -> idle -> running path and no terminal -> running shortcut', () => {
    expect(canTransition('completed', 'idle')).toBe(true);
    expect(canTransition('failed', 'idle')).toBe(true);
    expect(canTransition('cancelled', 'idle')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('closed', 'idle')).toBe(false);
    expect(canTransition('stale', 'closed')).toBe(true);
  });

  it('rejects duplicate id or session instead of overwriting the existing member', () => {
    const registry = new MemberRegistry(() => 1);
    registry.add(record());
    registry.add(record({ id: 'other', sessionId: 'm1-other' }));

    expect(() => registry.add(record({ id: 'm1', sessionId: 'different' }))).toThrow(
      /duplicate member id/,
    );
    expect(() => registry.add(record({ id: 'another', sessionId: 'm1' }))).toThrow(
      /duplicate member id/,
    );
    expect(registry.get('m1')?.id).toBe('m1');
  });
});

describe('MemberRegistry team fields', () => {
  it('passes team_id through status / persisted / runtime member, and ignores unknown ids', () => {
    const registry = new MemberRegistry(() => 1);
    registry.add(record());

    registry.setTeamId('m1', 'team-alpha');
    const stored = registry.get('m1');
    expect(stored?.teamId).toBe('team-alpha');
    if (stored === undefined) throw new Error('member missing');
    expect(toMemberStatus(stored).team_id).toBe('team-alpha');
    expect(toPersistedRecord(stored).team_id).toBe('team-alpha');
    expect(toRuntimeMember(stored).team_id).toBe('team-alpha');

    registry.setMembership('m1', 'left');
    expect(registry.get('m1')?.membership).toBe('left');

    // 未知成员静默忽略（与 setPresence 一致）
    registry.setTeamId('missing', 'team-beta');
    registry.setMembership('missing', 'present');
    expect(registry.size).toBe(1);
    expect(registry.get('m1')?.membership).toBe('left');
  });
});
