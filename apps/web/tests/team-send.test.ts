import { describe, expect, test } from 'bun:test';
import {
  buildTeamRows,
  type LocalSend,
  matchWrittenMessage,
  shouldFetchTeam,
} from '../src/domains/team/team-send';
import type { TeamMessage } from '../src/gateway/types';

const TEAM = 'team-alpha';

function message(overrides: Partial<TeamMessage> & { message_id: string }): TeamMessage {
  return {
    team_id: TEAM,
    from: 'human',
    to: [],
    mentions: [],
    content: '',
    ts: 1,
    kind: 'post',
    ...overrides,
  };
}

function send(overrides: Partial<LocalSend> & { localId: string }): LocalSend {
  return {
    content: '',
    mentions: [],
    ts: 1,
    status: 'sending',
    ...overrides,
  };
}

describe('buildTeamRows', () => {
  test('renders one optimistic row until the server message arrives', () => {
    const rows = buildTeamRows([], [send({ localId: 'local:1', content: 'hello', ts: 5 })], TEAM);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe('local:1');
    expect(rows[0]?.content).toBe('hello');
    expect(rows[0]?.sendStatus).toBe('sending');
  });

  test('server message replaces the optimistic row and keeps deliveries', () => {
    const sends = [
      send({
        localId: 'local:1',
        messageId: 'm-1',
        content: 'hello',
        ts: 5,
        status: 'sent',
        deliveries: [{ agent_id: 'agent-alpha', status: 'rejected', code: 'agent_left' }],
      }),
    ];
    const rows = buildTeamRows([message({ message_id: 'm-1', content: 'hello', ts: 5 })], sends, TEAM);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe('m-1');
    expect(rows[0]?.sendStatus).toBe('sent');
    expect(rows[0]?.deliveries?.[0]?.code).toBe('agent_left');
    // 反向验证：同 message_id 不能再渲染 local:1。
    expect(rows.some((row) => row.message_id === 'local:1')).toBe(false);
  });

  test('a different pending send stays alongside server history', () => {
    const rows = buildTeamRows(
      [message({ message_id: 'm-1', ts: 1 })],
      [send({ localId: 'local:2', content: 'later', ts: 9 })],
      TEAM,
    );
    expect(rows.map((row) => row.message_id)).toEqual(['m-1', 'local:2']);
  });

  test('failed local row keeps its error', () => {
    const rows = buildTeamRows(
      [],
      [send({ localId: 'local:3', content: 'nope', ts: 2, status: 'failed', error: 'internal' })],
      TEAM,
    );
    expect(rows[0]?.sendStatus).toBe('failed');
    expect(rows[0]?.sendError).toBe('internal');
  });
});

describe('shouldFetchTeam', () => {
  test('pauses network only while sending with a cached detail', () => {
    expect(shouldFetchTeam(true, true)).toBe(false);
    expect(shouldFetchTeam(true, false)).toBe(true);
    expect(shouldFetchTeam(false, true)).toBe(true);
    // 反例：发送期间没有缓存时必须继续拉取。
    expect(shouldFetchTeam(true, false)).not.toBe(false);
  });
});

describe('matchWrittenMessage', () => {
  test('matches content + mentions after the attempt timestamp', () => {
    const history = [
      message({ message_id: 'old', content: 'hello', ts: 1 }),
      message({ message_id: 'new', content: 'hello', ts: 10, mentions: ['agent-alpha'], kind: 'mention' }),
    ];
    expect(matchWrittenMessage(history, 'hello', ['agent-alpha'], 5)?.message_id).toBe('new');
    expect(matchWrittenMessage(history, 'hello', ['agent-alpha'], 11)).toBeUndefined();
    expect(matchWrittenMessage(history, 'hello', ['agent-beta'], 5)).toBeUndefined();
  });
});
