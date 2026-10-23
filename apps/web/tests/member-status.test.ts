import { describe, expect, test } from 'bun:test';
import { isOnlineMember, memberStatus } from '../src/domains/team/member-status';
import type { TeamMember } from '../src/gateway/types';

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agent_id: 'agent-1',
    name: 'Alice',
    session_id: 'session-1',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'idle',
    epoch: 1,
    ...overrides,
  };
}

describe('memberStatus', () => {
  test('maps waiting_permission to waiting instead of pending', () => {
    const status = memberStatus(member({ state: 'waiting_permission' }));
    expect(status.kind).toBe('waiting');
    expect(status.chipStatus).toBe('waiting');
    expect(status.tone).toBe('warn');
  });

  test('maps created / idle to idle', () => {
    expect(memberStatus(member({ state: 'created' })).kind).toBe('idle');
    expect(memberStatus(member({ state: 'idle' })).kind).toBe('idle');
  });

  test('maps terminal states to idle with the previous result as title', () => {
    for (const state of ['completed', 'failed', 'cancelled']) {
      const status = memberStatus(member({ state }));
      expect(status.kind).toBe('idle');
      expect(status.titleKey).toBe(`team.state.${state}`);
    }
  });

  test('maps closed and unknown states without guessing', () => {
    expect(memberStatus(member({ state: 'closed' })).kind).toBe('closed');
    expect(memberStatus(member({ state: 'mystery' })).kind).toBe('unknown');
    expect(memberStatus(undefined).kind).toBe('unknown');
  });

  test('presence gone wins over engine state', () => {
    const status = memberStatus(member({ state: 'running', presence: 'gone' }));
    expect(status.kind).toBe('gone');
    expect(status.labelKey).toBe('team.presence.gone');
  });

  test('membership left wins over gone and engine state', () => {
    const status = memberStatus(member({ state: 'running', presence: 'gone', membership: 'left' }));
    expect(status.kind).toBe('left');
    expect(status.labelKey).toBe('team.membership.left');
  });

  test('isOnlineMember requires present and live', () => {
    expect(isOnlineMember(member())).toBe(true);
    expect(isOnlineMember(member({ presence: 'gone' }))).toBe(false);
    expect(isOnlineMember(member({ membership: 'left' }))).toBe(false);
  });
});
