/**
 * Agent role v3 display helpers (CONTRACT-role-model §7).
 *
 * Old gateways only send `owner`; infer `member` when it is missing and
 * `temporary` when it is present. Never infer `single` from a Team roster —
 * single agents are not team members.
 */
import type { AgentRole, TeamMember } from '../../gateway/types';

export function roleOf(member: Pick<TeamMember, 'role' | 'owner'>): AgentRole {
  if (member.role !== undefined) return member.role;
  return member.owner === undefined ? 'member' : 'temporary';
}

export function roleLabelKey(role: AgentRole): string {
  return `team.role.${role}`;
}

/** Team roster only shows member + temporary; members first, temporaries after. */
export function groupMembersByRole(members: readonly TeamMember[]): TeamMember[] {
  const membersGroup: TeamMember[] = [];
  const temporaryGroup: TeamMember[] = [];
  for (const member of members) {
    const role = roleOf(member);
    if (role === 'single') continue;
    if (role === 'temporary') temporaryGroup.push(member);
    else membersGroup.push(member);
  }
  return [...membersGroup, ...temporaryGroup];
}

export type RoleConversion = 'member' | 'temporary' | 'single';

/** Actions shown for a member's current role (no-op conversion omitted). */
export function conversionActions(role: AgentRole): RoleConversion[] {
  return (['member', 'temporary', 'single'] as const).filter((target) => target !== role);
}

/** Member conversion requires a Team; inline validation mirrors the server. */
export function conversionError(
  target: RoleConversion,
  teamId: string | undefined,
): 'member_requires_team' | undefined {
  return target === 'member' && (teamId?.trim() ?? '') === '' ? 'member_requires_team' : undefined;
}
