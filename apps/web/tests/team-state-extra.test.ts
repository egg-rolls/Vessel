import { describe, expect, test } from 'bun:test';
import {
  applyTeamEvent,
  createTeamEventState,
  latestRotateFailure,
  preferBodyHistory,
  type TeamEventLike,
} from '../src/state/teams';
import { TEAM_ID } from './team-fixtures';

function event(
  type: string,
  seq: number,
  ts: number,
  data: Record<string, unknown>,
): TeamEventLike {
  return { type, seq, ts, data };
}

describe('preferBodyHistory (T8 single source)', () => {
  test('server field wins and observed history is dropped', () => {
    const selected = preferBodyHistory(
      [{ session_id: 'sess-server', epoch: 1, started_at: 10, retired_at: 11 }],
      [{ session_id: 'sess-observed', epoch: 2, observed_at: 20 }],
    );
    expect(selected.source).toBe('server');
    expect(selected.server.map((entry) => entry.session_id)).toEqual(['sess-server']);
    expect(selected.observed).toEqual([]);
  });

  test('missing server field falls back to observed history only', () => {
    const selected = preferBodyHistory(null, [
      { session_id: 'sess-observed', epoch: 2, observed_at: 20 },
    ]);
    expect(selected.source).toBe('observed');
    expect(selected.server).toEqual([]);
    expect(selected.observed.map((entry) => entry.session_id)).toEqual(['sess-observed']);
  });
});

describe('latestRotateFailure (T8 rotate notice)', () => {
  function entry(seq: number, type: string, data: Record<string, unknown>) {
    return { seq, event: event(type, seq, seq * 10, { team_id: TEAM_ID, ...data }) };
  }

  test('shows the latest failure until a later successful rotate', () => {
    const failed = entry(5, 'agent.rotate.failed', {
      agent_id: 'agent-alpha',
      code: 'rotate_failed',
      reason: 'spawn failed',
    });
    expect(latestRotateFailure([failed], TEAM_ID)?.code).toBe('rotate_failed');

    const success = entry(6, 'agent.rotated', { agent_id: 'agent-alpha' });
    expect(latestRotateFailure([failed, success], TEAM_ID)).toBeNull();
  });

  test('ignores failures from another team or without team_id', () => {
    const other = entry(5, 'agent.rotate.failed', {
      team_id: 'team-other',
      code: 'rotate_failed',
    });
    const missing = {
      seq: 6,
      event: event('agent.rotate.failed', 6, 60, { code: 'rotate_failed' }),
    };
    expect(latestRotateFailure([other, missing], TEAM_ID)).toBeNull();
  });

  test('another agent success does not clear this agent failure', () => {
    const failedA = entry(5, 'agent.rotate.failed', {
      agent_id: 'agent-a',
      code: 'rotate_failed',
    });
    const successB = entry(6, 'agent.rotated', { agent_id: 'agent-b' });
    expect(latestRotateFailure([failedA, successB], TEAM_ID)?.agent_id).toBe('agent-a');
  });
});

describe('stale turn guard (T8)', () => {
  test('old-body stale turn never creates messages or body history', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.turn.completed', 7, 70, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        stale: true,
        content: 'must not become a message',
      }),
      TEAM_ID,
    );
    expect(state.messages).toEqual([]);
    expect(state.fallbackBodyHistory).toEqual({});
    // A stale turn must not even request a roster invalidation.
    expect(state.rosterDirty).toBe(false);
  });

  test('a current turn still requests a roster invalidation', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.turn.completed', 8, 80, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
      }),
      TEAM_ID,
    );
    expect(state.messages).toEqual([]);
    expect(state.rosterDirty).toBe(true);
  });
});
