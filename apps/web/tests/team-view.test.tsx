import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberDetail } from '../src/domains/team/MemberDetail';
import { TeamChat } from '../src/domains/team/TeamChat';
import { matchesQuery, TeamList } from '../src/domains/team/TeamList';
import type {
  SessionDetail,
  TeamDetail,
  TeamMember,
  TeamMessage,
  TeamPostResult,
  TeamSummary,
} from '../src/gateway/types';
import { t } from '../src/i18n';

const summary: TeamSummary = {
  team_id: 'core',
  name: 'Core Team',
  tenant_id: 'default',
  workspace: '/work/core',
  member_count: 3,
  online_count: 1,
  created_at: 1_700_000_000_000,
};

const members: TeamMember[] = [
  {
    agent_id: 'agent-aaaa1111',
    name: 'Alice',
    session_id: 'session-a',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'running',
    epoch: 2,
  },
  {
    agent_id: 'agent-bbbb2222',
    name: 'Bob',
    session_id: 'session-b',
    membership: 'present',
    presence: 'gone',
    visibility: 'team',
    state: 'idle',
    epoch: 1,
    body_history: [
      {
        session_id: 'old-1',
        epoch: 0,
        started_at: 1_690_000_000_000,
        retired_at: 1_695_000_000_000,
      },
    ],
  },
  {
    agent_id: 'agent-cccc3333',
    name: 'Carol',
    membership: 'left',
    presence: 'gone',
    visibility: 'team',
    state: 'closed',
  },
];

const messages: TeamMessage[] = [
  {
    message_id: 'm1',
    team_id: 'core',
    from: 'human',
    to: [],
    mentions: [],
    content: 'hello team',
    ts: 1_700_000_000_000,
    kind: 'post',
  },
  {
    message_id: 'm2',
    team_id: 'core',
    from: 'agent-aaaa1111',
    to: ['human'],
    mentions: [],
    content: 'reply **done**',
    ts: 1_700_000_001_000,
    kind: 'reply',
  },
  {
    message_id: 'm3',
    team_id: 'core',
    from: 'agent-bbbb2222',
    to: [],
    mentions: [],
    content: 'raw system content',
    ts: 1_700_000_002_000,
    kind: 'system',
    system_event: 'join',
  },
  {
    message_id: 'm4',
    team_id: 'core',
    from: 'agent-aaaa1111',
    to: [],
    mentions: [],
    content: 'agent log line',
    ts: 1_700_000_003_000,
    kind: 'post',
  },
];

const detail: TeamDetail = { team: summary, members, messages };
const emptyDetail: TeamDetail = { team: summary, members, messages: [] };

const postResult: TeamPostResult = {
  message_id: 'm5',
  team_id: 'core',
  kind: 'post',
  mentions: [],
  delivered: [],
  ts: 1_700_000_004_000,
};

const session: SessionDetail = {
  session_id: 'old-1',
  messages: [
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: 'old assistant' },
  ],
};

const client = {
  listTeams: async () => [summary],
  getTeam: async () => detail,
  postTeam: async () => postResult,
  getSession: async () => session,
};

function renderList(overrides: Partial<Parameters<typeof TeamList>[0]> = {}): string {
  return renderToStaticMarkup(
    <TeamList
      client={client}
      hasToken
      epoch={1}
      tenantEpoch={0}
      tenantId="default"
      onOpen={() => undefined}
      {...overrides}
    />,
  );
}

function renderChat(overrides: Partial<Parameters<typeof TeamChat>[0]> = {}): string {
  return renderToStaticMarkup(
    <TeamChat
      client={client}
      hasToken
      connectionState="open"
      epoch={1}
      tenantEpoch={0}
      teamId="core"
      permissions={[]}
      asks={[]}
      events={[]}
      onOpenMember={() => undefined}
      onOpenSession={() => undefined}
      onBackToList={() => undefined}
      initialDetail={detail}
      {...overrides}
    />,
  );
}

function renderMember(overrides: Partial<Parameters<typeof MemberDetail>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemberDetail
      client={client}
      hasToken
      epoch={1}
      tenantEpoch={0}
      teamId="core"
      memberId="agent-bbbb2222"
      events={[]}
      onBack={() => undefined}
      onBackToMember={() => undefined}
      onOpenSession={() => undefined}
      onOpenBody={() => undefined}
      initialDetail={detail}
      {...overrides}
    />,
  );
}

describe('TeamList', () => {
  test('renders teams with counts, workspace and online_count', () => {
    const markup = renderList({ initialTeams: [summary] });
    expect(markup).toContain('team-list-item');
    expect(markup).toContain('Core Team');
    expect(markup).toContain('/work/core');
    expect(markup).toContain(t('team.list.memberCount', { count: 3 }));
    expect(markup).toContain(t('team.list.onlineCount', { count: 1 }));
  });

  test('tolerates a team without workspace and keeps search working', () => {
    const withoutWorkspace: TeamSummary = {
      team_id: 'core',
      name: 'Core Team',
      tenant_id: 'default',
      member_count: 3,
      created_at: 1_700_000_000_000,
    };

    const markup = renderList({ initialTeams: [withoutWorkspace] });
    expect(markup).toContain('team-list-item');
    expect(markup).toContain('—');

    expect(matchesQuery(summary, '/work/core')).toBe(true);
    expect(matchesQuery(withoutWorkspace, 'core')).toBe(true);
    expect(matchesQuery(withoutWorkspace, '/work')).toBe(false);
  });

  test('shows an em dash when online_count is missing', () => {
    const markup = renderList({
      initialTeams: [{ ...summary, online_count: undefined }],
    });
    expect(markup).toContain('—');
  });

  test('renders the empty state', () => {
    const markup = renderList({ initialTeams: [] });
    expect(markup).toContain('state-empty');
    expect(markup).toContain(t('team.list.empty'));
  });

  test('renders the error state', () => {
    const markup = renderList({ initialError: { message: 'boom' } });
    expect(markup).toContain('state-error');
    expect(markup).toContain('boom');
  });

  test('renders not-enabled for teams not_found', () => {
    const markup = renderList({ initialError: { message: 'missing', code: 'not_found' } });
    expect(markup).toContain('state-not-enabled');
    expect(markup).toContain(t('team.error.notEnabled'));
  });
});

describe('TeamChat', () => {
  test('renders transcript, reply tag, system notice, members and composer', () => {
    const markup = renderChat();
    expect(markup).toContain('team-chat');
    expect(markup).toContain('hello team');
    expect(markup).toContain('agent log line');
    expect(markup).toContain(t('team.message.replyTag'));
    expect(markup).toContain(t('team.message.agentTag'));
    expect(markup).toContain(t('team.system.join', { name: 'Bob' }));
    expect(markup).toContain('team-member-row');
    expect(markup).toContain('Alice');
    expect(markup).toContain('team-composer');
    expect(markup).toContain(t('team.composer.noMention'));
  });

  test('does not render the removed default-principal label', () => {
    const markup = renderChat();
    expect(markup).not.toContain('默认接头人');
    expect(markup).not.toContain('Default principal');
    expect(markup).not.toContain('defaultPrincipal');
  });

  test('renders the empty chat state', () => {
    const markup = renderChat({ initialDetail: emptyDetail });
    expect(markup).toContain('state-empty');
    expect(markup).toContain(t('team.chat.empty'));
  });

  test('renders rotate failure notice with an interpolated member name', () => {
    const markup = renderChat({
      events: [
        {
          seq: 1,
          event: {
            type: 'agent.rotate.failed',
            run_id: 'run-1',
            ts: 1_700_000_007_000,
            data: {
              team_id: 'core',
              agent_id: 'agent-aaaa1111',
              code: 'rotate_failed',
            },
          },
        },
      ],
    });
    expect(markup).toContain('team-notice-danger');
    expect(markup).toContain('Alice');
    expect(markup).not.toContain('{name}');
  });

  test('renders not-enabled when the team endpoint is missing', () => {
    const markup = renderChat({
      initialDetail: undefined,
      initialError: { message: 'missing', code: 'not_found' },
    });
    expect(markup).toContain('state-not-enabled');
    expect(markup).toContain(t('team.error.notEnabled'));
  });
});

describe('MemberDetail', () => {
  test('renders current body and server body_history', () => {
    const markup = renderMember();
    expect(markup).toContain('team-body-card');
    expect(markup).toContain(t('team.member.currentBody'));
    expect(markup).toContain('session-b');
    expect(markup).toContain(t('team.member.retiredBodies'));
    expect(markup).toContain('old-1');
    expect(markup).toContain(t('team.member.viewTranscript'));
  });

  test('server body_history wins over observed events for the same member', () => {
    const observedEvents = [
      {
        seq: 1,
        event: {
          type: 'agent.retired',
          run_id: 'run-1',
          ts: 1_700_000_006_000,
          data: {
            team_id: 'core',
            agent_id: 'agent-bbbb2222',
            body_id: 'observed-2',
            epoch: 2,
          },
        },
      },
    ];
    const markup = renderMember({ memberId: 'agent-bbbb2222', events: observedEvents });
    expect(markup).toContain('old-1');
    expect(markup).not.toContain('observed-2');
    expect(markup).not.toContain(t('team.member.observedOnly'));
  });

  test('marks event-observed history when body_history is absent', () => {
    const observedEvents = [
      {
        seq: 1,
        event: {
          type: 'agent.retired',
          run_id: 'run-1',
          ts: 1_700_000_005_000,
          data: {
            team_id: 'core',
            agent_id: 'agent-aaaa1111',
            body_id: 'observed-1',
            epoch: 1,
          },
        },
      },
    ];
    const markup = renderMember({ memberId: 'agent-aaaa1111', events: observedEvents });
    expect(markup).toContain(t('team.member.retiredBodies'));
    expect(markup).toContain('observed-1');
    expect(markup).toContain(t('team.member.observedOnly'));
  });

  test('shows an empty retired-body state without history', () => {
    const markup = renderMember({ memberId: 'agent-aaaa1111' });
    expect(markup).toContain(t('team.member.retiredBodies'));
    expect(markup).toContain(t('team.member.empty'));
  });

  test('renders a read-only body transcript', () => {
    const markup = renderMember({
      bodyId: 'old-1',
      initialSession: session,
    });
    expect(markup).toContain('team-body-view');
    expect(markup).toContain('old user');
    expect(markup).toContain('old assistant');
    expect(markup).not.toContain('team-composer');
  });

  test('renders an empty state for an unknown member', () => {
    const markup = renderMember({ memberId: 'agent-missing' });
    expect(markup).toContain('state-empty');
    expect(markup).toContain(t('team.error.notFound'));
  });
});
