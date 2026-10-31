import { useState } from 'react';
import { useOptionalToast } from '../../components/ToastProvider';
import { Badge, Button, Select } from '../../components/ui';
import type { AgentUpdateInput, TeamMember } from '../../gateway/types';
import { t } from '../../i18n';
import { teamListData, useTeamStore } from '../../stores/teamStore';
import type { MemberDetailClient } from './member-detail-types';
import { shortAgentId } from './mention';
import {
  conversionActions,
  conversionError,
  type RoleConversion,
  roleLabelKey,
  roleOf,
} from './role';

const CONVERSION_LABEL_KEYS: Record<RoleConversion, string> = {
  member: 'team.role.toMember',
  temporary: 'team.role.toTemporary',
};

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function RoleConversionSection({
  member,
  teamId,
  nodeKey,
  client,
  hasToken,
  onConverted,
}: {
  member: TeamMember;
  teamId: string;
  nodeKey: string;
  client: MemberDetailClient;
  hasToken: boolean;
  onConverted: () => void;
}) {
  const toast = useOptionalToast();
  const role = roleOf(member);
  const actions = conversionActions(role);
  const teamList = useTeamStore((state) => state.lists[nodeKey]);
  const teams = teamListData(teamList)?.teams ?? [];
  const teamOptions = teams.filter((team) => team.archived_at === undefined);
  const [targetTeamId, setTargetTeamId] = useState(teamId);
  const [busy, setBusy] = useState<RoleConversion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const needsTeam = actions.includes('member');
  const canWrite = hasToken && !denied;

  const convert = async (target: RoleConversion) => {
    if (!canWrite || busy) return;
    const invalid = conversionError(target, targetTeamId);
    if (invalid) {
      setError(t('team.role.memberRequiresTeam'));
      return;
    }
    setBusy(target);
    setError(null);
    const input: AgentUpdateInput = { agent_id: member.agent_id, role: target };
    if (target === 'member') input.team_id = targetTeamId.trim();
    try {
      await client.updateAgent(input);
      toast?.success(
        t('team.role.success', {
          name: member.name?.trim() || shortAgentId(member.agent_id),
          role: t(roleLabelKey(target)),
        }),
      );
      onConverted();
    } catch (caught) {
      if (errorCodeOf(caught) === 'forbidden') {
        setDenied(true);
        setError(t('team.role.forbidden'));
      } else {
        const detail = caught instanceof Error ? caught.message : String(caught);
        setError(`${t('team.role.failed')}: ${detail}`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-md font-semibold text-ink">{t('team.role.convert')}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{t('team.role.label')}</span>
        <Badge>{t(roleLabelKey(role))}</Badge>
      </div>
      {needsTeam && (
        <label
          className="flex flex-wrap items-center gap-2 text-sm text-muted"
          htmlFor="member-role-team"
        >
          <span>{t('team.role.memberTeam')}</span>
          <Select
            id="member-role-team"
            value={targetTeamId}
            onChange={(event) => setTargetTeamId(event.target.value)}
            aria-label={t('team.role.memberTeam')}
            disabled={!canWrite || busy !== null}
          >
            {teamOptions.length === 0 && (
              <option value={teamId}>
                {teams.find((team) => team.team_id === teamId)?.name || teamId}
              </option>
            )}
            {teamOptions.map((team) => (
              <option key={team.team_id} value={team.team_id}>
                {team.name || team.team_id}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((target) => (
          <Button
            key={target}
            size="small"
            disabled={!canWrite || busy !== null}
            onClick={() => {
              void convert(target);
            }}
          >
            {busy === target ? t('team.role.busy') : t(CONVERSION_LABEL_KEYS[target])}
          </Button>
        ))}
      </div>
      {!hasToken && <p className="m-0 text-xs text-muted">{t('common.writesDisabled')}</p>}
      {error && (
        <p className="m-0 rounded-sm bg-danger-soft px-2.5 py-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
