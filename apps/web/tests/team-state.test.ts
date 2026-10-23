import { describe, expect, test } from 'bun:test';
import type { TeamMessage } from '../src/gateway/types';
import type { TeamEventLike } from '../src/state/teams';
import {
  applyTeamEvent,
  createTeamEventState,
  latestRotateFailure,
  mergeMessages,
  observedBodyHistory,
  preferBodyHistory,
  serverBodyHistory,
  sortMessages,
} from '../src/state/teams';
import { TEAM_ID, teamMember, teamMessages } from './team-fixtures';

function message(overrides: Partial<TeamMessage> & { message_id: string }): TeamMessage {
  return {
    team_id: TEAM_ID,
    from: 'human',
    to: [],
    mentions: [],
    content: '',
    ts: 1,
    kind: 'post',
    ...overrides,
  };
}

function event(
  type: string,
  seq: number,
  ts: number,
  data: Record<string, unknown>,
): TeamEventLike {
  return { type, seq, ts, data };
}

function replyEvent(seq: number, data: Record<string, unknown>, ts = 500): TeamEventLike {
  return event('agent.reply.posted', seq, ts, { team_id: TEAM_ID, ...data });
}

describe('mergeMessages / sortMessages', () => {
  test('dedupes by message_id and sorts by ts then message_id', () => {
    const base = [
      message({ message_id: 'b', ts: 20, content: 'old b' }),
      message({ message_id: 'a', ts: 10 }),
    ];
    const incoming = [
      message({ message_id: 'b', ts: 20, content: 'new b' }),
      message({ message_id: 'c', ts: 20 }),
    ];
    const merged = mergeMessages(base, incoming);

    // 反向验证：去掉去重会出现 4 条；去掉排序会保持输入顺序 b,a,c。
    expect(merged.map((entry) => entry.message_id)).toEqual(['a', 'b', 'c']);
    expect(merged).toHaveLength(3);
    expect(merged.find((entry) => entry.message_id === 'b')?.content).toBe('new b');
  });

  test('sorts same ts by message_id and does not mutate the input', () => {
    const base = [
      message({ message_id: 'm-2', ts: 5 }),
      message({ message_id: 'm-10', ts: 5 }),
      message({ message_id: 'm-1', ts: 1 }),
    ];
    const snapshot = [...base];

    expect(sortMessages(base).map((entry) => entry.message_id)).toEqual(['m-1', 'm-10', 'm-2']);
    expect(base).toEqual(snapshot);
  });

  test('merges reply and post kinds without special-casing kind', () => {
    const base = teamMessages();
    const merged = mergeMessages(base, [
      message({ message_id: 'm-post', ts: 6_000, content: 'updated post' }),
      message({ message_id: 'm-new-reply', ts: 7_000, kind: 'reply', from: 'agent-beta' }),
    ]);

    expect(merged).toHaveLength(5);
    expect(merged.find((entry) => entry.message_id === 'm-post')?.content).toBe('updated post');
    expect(merged.filter((entry) => entry.kind === 'reply').map((e) => e.message_id)).toEqual([
      'm-reply',
      'm-new-reply',
    ]);
  });
});

describe('applyTeamEvent sequencing and filtering', () => {
  test('applies only increasing seq and returns the same state for stale events', () => {
    const initial = createTeamEventState();
    const first = applyTeamEvent(
      initial,
      event('agent.reply.posted', 5, 10, {
        team_id: TEAM_ID,
        message_id: 'm-1',
        content: 'hello',
      }),
      TEAM_ID,
    );
    expect(first.lastAppliedSeq).toBe(5);
    expect(first.messages).toHaveLength(1);

    // 反向验证：去掉 seq 去重会再次插入同一事件。
    const replay = applyTeamEvent(
      first,
      replyEvent(5, { message_id: 'm-1', content: 'hello' }),
      TEAM_ID,
    );
    expect(replay).toBe(first);
    expect(replay.messages).toHaveLength(1);

    const older = applyTeamEvent(
      first,
      replyEvent(4, { message_id: 'm-old', content: 'old' }),
      TEAM_ID,
    );
    expect(older).toBe(first);
    expect(older.messages.map((entry) => entry.message_id)).toEqual(['m-1']);
  });

  test('updates seq but ignores events for other teams', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.rotated', 3, 20, {
        team_id: 'team-other',
        agent_id: 'agent-alpha',
        from_session_id: 'sess-x',
        epoch: 1,
      }),
      TEAM_ID,
    );

    expect(state.lastAppliedSeq).toBe(3);
    expect(state.messages).toEqual([]);
    expect(state.fallbackBodyHistory).toEqual({});
    expect(state.rosterDirty).toBe(false);
  });

  test('ignores events without team_id (never treats undefined as current team)', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.spawned', 2, 30, { agent_id: 'agent-alpha' }),
      TEAM_ID,
    );

    // 反向验证：去掉 team_id 过滤会让未绑定 agent 的事件污染当前 Team。
    expect(state.lastAppliedSeq).toBe(2);
    expect(state.rosterDirty).toBe(false);
  });

  test('marks rosterDirty only for matching other agent.* events', () => {
    const dirty = applyTeamEvent(
      createTeamEventState(),
      event('agent.spawned', 1, 40, { team_id: TEAM_ID, agent_id: 'agent-beta' }),
      TEAM_ID,
    );
    expect(dirty.rosterDirty).toBe(true);

    const untouched = applyTeamEvent(
      createTeamEventState(),
      event('run.started', 1, 41, { team_id: TEAM_ID }),
      TEAM_ID,
    );
    expect(untouched.rosterDirty).toBe(false);
  });
});

describe('agent.reply.posted (T11)', () => {
  test('inserts a reply message with runtime-coerced fields', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      replyEvent(1, {
        message_id: 'm-reply-event',
        agent_id: 'agent-alpha',
        content: 'finished',
        to: ['human', 42],
        mentions: ['human'],
        ts: 450,
      }),
      TEAM_ID,
    );

    expect(state.messages).toEqual([
      {
        message_id: 'm-reply-event',
        team_id: TEAM_ID,
        from: 'agent-alpha',
        to: ['human'],
        mentions: ['human'],
        content: 'finished',
        ts: 450,
        kind: 'reply',
      },
    ]);
  });

  test('ignores replies without message_id but still advances seq', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      replyEvent(7, { agent_id: 'agent-alpha', content: 'no id' }),
      TEAM_ID,
    );

    expect(state.messages).toEqual([]);
    expect(state.lastAppliedSeq).toBe(7);
  });

  test('merges by message_id with an already polled reply without duplicating', () => {
    const polled = teamMessages();
    const base = { ...createTeamEventState(), messages: polled };

    const state = applyTeamEvent(
      base,
      replyEvent(8, {
        message_id: 'm-reply',
        from: 'agent-alpha',
        content: 'done (event)',
        ts: 4_000,
      }),
      TEAM_ID,
    );

    // 反向验证：去掉 message_id 去重会变成 5 条、回复出现两次。
    expect(state.messages).toHaveLength(polled.length);
    expect(state.messages.filter((entry) => entry.message_id === 'm-reply')).toHaveLength(1);
    expect(state.messages.find((entry) => entry.message_id === 'm-reply')?.content).toBe(
      'done (event)',
    );
  });

  test('replaying the same reply event does not duplicate the message', () => {
    const first = applyTeamEvent(
      createTeamEventState(),
      replyEvent(1, { message_id: 'm-reply', content: 'once' }),
      TEAM_ID,
    );
    const replay = applyTeamEvent(
      first,
      replyEvent(1, { message_id: 'm-reply', content: 'once' }),
      TEAM_ID,
    );

    expect(replay).toBe(first);
    expect(replay.messages).toHaveLength(1);
  });
});

describe('fallback Body history (T8 fallback path)', () => {
  test('agent.rotated appends observed bodies, dedupes by session_id', () => {
    const first = applyTeamEvent(
      createTeamEventState(),
      event('agent.rotated', 1, 100, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        from_session_id: 'sess-old',
        to_session_id: 'sess-current',
        epoch: 1,
      }),
      TEAM_ID,
    );
    expect(observedBodyHistory(first, 'agent-alpha')).toEqual([
      { session_id: 'sess-old', epoch: 1, observed_at: 100 },
    ]);

    const duplicate = applyTeamEvent(
      first,
      event('agent.rotated', 2, 200, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        from_session_id: 'sess-old',
        epoch: 1,
      }),
      TEAM_ID,
    );
    expect(duplicate.lastAppliedSeq).toBe(2);
    expect(observedBodyHistory(duplicate, 'agent-alpha')).toEqual([
      { session_id: 'sess-old', epoch: 1, observed_at: 100 },
    ]);
  });

  test('agent.retired records body_id and optional reason', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.retired', 1, 300, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        body_id: 'sess-retired',
        epoch: 3,
        reason: 'rotate',
      }),
      TEAM_ID,
    );
    expect(observedBodyHistory(state, 'agent-alpha')).toEqual([
      { session_id: 'sess-retired', epoch: 3, observed_at: 300, reason: 'rotate' },
    ]);

    const noReason = applyTeamEvent(
      createTeamEventState(),
      event('agent.retired', 1, 301, {
        team_id: TEAM_ID,
        agent_id: 'agent-beta',
        body_id: 'sess-retired-2',
        epoch: 1,
      }),
      TEAM_ID,
    );
    expect(observedBodyHistory(noReason, 'agent-beta')[0]?.reason).toBeUndefined();
  });

  test('caps observed history at 20 and keeps the newest entries', () => {
    let state = createTeamEventState();
    for (let index = 0; index < 25; index += 1) {
      state = applyTeamEvent(
        state,
        event('agent.rotated', index + 1, index, {
          team_id: TEAM_ID,
          agent_id: 'agent-alpha',
          from_session_id: `sess-${index}`,
          epoch: index,
        }),
        TEAM_ID,
      );
    }

    const history = observedBodyHistory(state, 'agent-alpha');
    // 反向验证：去掉上限会保留 25 条；去掉去重/裁剪会留下最旧的 sess-0。
    expect(history).toHaveLength(20);
    expect(history[0]?.session_id).toBe('sess-5');
    expect(history.at(-1)?.session_id).toBe('sess-24');
  });

  test('returns a copy sorted by observed_at and [] for unknown agents', () => {
    const state = applyTeamEvent(
      createTeamEventState(),
      event('agent.retired', 1, 50, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        body_id: 'sess-b',
        epoch: 2,
      }),
      TEAM_ID,
    );
    const applied = applyTeamEvent(
      state,
      event('agent.retired', 2, 10, {
        team_id: TEAM_ID,
        agent_id: 'agent-alpha',
        body_id: 'sess-a',
        epoch: 1,
      }),
      TEAM_ID,
    );

    const history = observedBodyHistory(applied, 'agent-alpha');
    expect(history.map((entry) => entry.session_id)).toEqual(['sess-a', 'sess-b']);
    history.push({ session_id: 'mutated', epoch: 9, observed_at: 99 });
    expect(observedBodyHistory(applied, 'agent-alpha')).toHaveLength(2);
    expect(observedBodyHistory(applied, 'agent-missing')).toEqual([]);
  });
});

describe('serverBodyHistory (T8 main path)', () => {
  test('prefers server body_history and sorts by epoch ascending', () => {
    const member = teamMember({
      body_history: [
        { session_id: 'sess-3', epoch: 3, started_at: 30, retired_at: 31 },
        { session_id: 'sess-1', epoch: 1, started_at: 10, retired_at: 11 },
      ],
    });

    const history = serverBodyHistory(member);
    expect(history?.map((entry) => entry.epoch)).toEqual([1, 3]);

    history?.push({ session_id: 'sess-x', epoch: 9, started_at: 1, retired_at: 2 });
    expect(member.body_history).toHaveLength(2);
  });

  test('returns an empty array when body_history exists but is empty', () => {
    expect(serverBodyHistory(teamMember({ body_history: [] }))).toEqual([]);
  });

  test('returns null when body_history is absent', () => {
    // 反向验证：若把缺失当成空数组，调用方就永远不会走事件回退分支。
    expect(serverBodyHistory(teamMember({ body_history: undefined }))).toBeNull();
    expect(serverBodyHistory(undefined)).toBeNull();
  });
});
