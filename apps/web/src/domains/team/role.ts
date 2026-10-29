/**
 * Agent role v3 display helpers (CONTRACT-role-model §7).
 *
 * 0.28: `single` no longer exists. Old gateways may still send it, so this module
 * is the single place that downgrades it — everything downstream only ever sees
 * `member` | `temporary`.
 *
 * Old gateways that omit `role` are inferred from `owner`: missing owner = member,
 * present owner = temporary.
 */
import type { AgentRole, TeamMember } from '../../gateway/types';

/** Legacy role values a pre-0.28 gateway may still send. */
type LegacyRole = AgentRole | 'single';

export function roleOf(member: Pick<TeamMember, 'role' | 'owner'>): AgentRole {
  const role = member.role as LegacyRole | undefined;
  if (role !== undefined) return role === 'single' ? 'member' : role;
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
    if (roleOf(member) === 'temporary') temporaryGroup.push(member);
    else membersGroup.push(member);
  }
  return [...membersGroup, ...temporaryGroup];
}

export type RoleConversion = AgentRole;

/**
 * Actions shown for a member's current role (no-op conversion omitted).
 *
 * `temporary → member` needs a Team (already true for every roster member);
 * `member → temporary` demotes and is available for any member, `main` included.
 */
export function conversionActions(role: AgentRole): RoleConversion[] {
  return (['member', 'temporary'] as const).filter((target) => target !== role);
}

/** Member conversion requires a Team; inline validation mirrors the server. */
export function conversionError(
  target: RoleConversion,
  teamId: string | undefined,
): 'member_requires_team' | undefined {
  return target === 'member' && (teamId?.trim() ?? '') === '' ? 'member_requires_team' : undefined;
}
