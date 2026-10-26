import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { roleFromKind } from '../src/domains/agents/agent-form';
import { MemberDetail } from '../src/domains/team/MemberDetail';
import {
  conversionActions,
  conversionError,
  groupMembersByRole,
  roleLabelKey,
  roleOf,
} from '../src/domains/team/role';
import { groupTeamMembers } from '../src/domains/team/TeamMemberSidebar';
import type { SessionDetail, TeamDetail, TeamMember } from '../src/gateway/types';
import { t } from '../src/i18n';

const member = (overrides: Partial<TeamMember>): TeamMember => ({
  agent_id: 'a1',
  name: 'Alice',
  membership: 'present',
  presence: 'live',
  visibility: 'team',
  ...overrides,
});

const teamDetail = (roleMember: TeamMember): TeamDetail => ({
  team: {
    team_id: 'core',
    name: 'Core',
    tenant_id: 'default',
    workspace: '/work/core',
    member_count: 1,
    created_at: 1,
  },
  members: [roleMember],
  messages: [],
});

const client = {
  listTeams: async () => [],
  getTeam: async () => teamDetail(member({})),
  postTeam: async () => ({
    message_id: 'm',
    team_id: 'core',
    kind: 'post' as const,
    mentions: [],
    delivered: [],
    ts: 1,
  }),
  getSession: async () => ({ session_id: 's', messages: [] }) as SessionDetail,
  updateAgent: async () => ({ agent_id: 'a1' }),
};

function renderMember(roleMember: TeamMember): string {
  return renderToStaticMarkup(
    <MemberDetail
      client={client}
      hasToken
      epoch={1}
      tenantEpoch={0}
      teamId="core"
      memberId={roleMember.agent_id}
      events={[]}
      onBack={() => undefined}
      onBackToMember={() => undefined}
      onOpenSession={() => undefined}
      onOpenBody={() => undefined}
      initialDetail={teamDetail(roleMember)}
    />,
  );
}

describe('roleOf', () => {
  test('uses role when present and infers from owner for old gateways', () => {
    expect(roleOf({ role: 'single' })).toBe('single');
    expect(roleOf({ role: 'member', owner: 'self' })).toBe('member');
    expect(roleOf({ owner: undefined })).toBe('member');
    expect(roleOf({ owner: 'owner-1' })).toBe('temporary');
  });

  test('maps i18n labels for all roles', () => {
    expect(roleLabelKey('single')).toBe('team.role.single');
    expect(roleLabelKey('member')).toBe('team.role.member');
    expect(roleLabelKey('temporary')).toBe('team.role.temporary');
  });
});

describe('roster grouping', () => {
  test('members first, temporary after, single excluded', () => {
    const ordered = groupMembersByRole([
      member({ agent_id: 'tmp', role: 'temporary' }),
      member({ agent_id: 'single', role: 'single' }),
      member({ agent_id: 'm1', role: 'member' }),
      member({ agent_id: 'tmp2', role: 'temporary' }),
    ]);
    expect(ordered.map((entry) => entry.agent_id)).toEqual(['m1', 'tmp', 'tmp2']);
    expect(groupTeamMembers(ordered)).toEqual(ordered);
  });

  test('legacy owner-based grouping still works', () => {
    const ordered = groupTeamMembers([
      member({ agent_id: 'tmp', owner: 'owner-1' }),
      member({ agent_id: 'peer' }),
    ]);
    expect(ordered.map((entry) => entry.agent_id)).toEqual(['peer', 'tmp']);
  });
});

describe('conversion helpers', () => {
  test('omits the current role and requires a Team for member', () => {
    expect(conversionActions('member')).toEqual(['temporary', 'single']);
    expect(conversionActions('temporary')).toEqual(['member', 'single']);
    expect(conversionActions('single')).toEqual(['member', 'temporary']);
    expect(conversionError('member', '')).toBe('member_requires_team');
    expect(conversionError('member', 'core')).toBeUndefined();
    expect(conversionError('temporary', '')).toBeUndefined();
  });

  test('create kind maps to member/temporary roles', () => {
    expect(roleFromKind('peer')).toBe('member');
    expect(roleFromKind('contractor')).toBe('temporary');
    expect(roleFromKind(undefined)).toBe('member');
  });
});

describe('MemberDetail conversion UI', () => {
  test('temporary member offers convert-to-member and convert-to-single', () => {
    const markup = renderMember(member({ role: 'temporary', owner: 'owner-1' }));
    expect(markup).toContain(t('team.role.convert'));
    expect(markup).toContain(t('team.role.toMember'));
    expect(markup).toContain(t('team.role.toSingle'));
    expect(markup).not.toContain(t('team.role.toTemporary'));
    expect(markup).toContain(t('team.role.memberTeam'));
  });

  test('member offers temporary and single conversions without a Team select', () => {
    const markup = renderMember(member({ role: 'member', owner: 'self' }));
    expect(markup).toContain(t('team.role.toTemporary'));
    expect(markup).toContain(t('team.role.toSingle'));
    expect(markup).not.toContain(t('team.role.toMember'));
    expect(markup).not.toContain(t('team.role.memberTeam'));
  });

  test('single agents show member and temporary conversions', () => {
    const markup = renderMember(member({ role: 'single' }));
    expect(markup).toContain(t('team.role.single'));
    expect(markup).toContain(t('team.role.toMember'));
    expect(markup).toContain(t('team.role.toTemporary'));
    expect(markup).not.toContain(t('team.role.toSingle'));
  });
});
