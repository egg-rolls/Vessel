/**
 * Agents 列表行（纯展示）。
 *
 * Team 行显示 `node · team`；没有 Team 归属时只显示 node，不伪造 Team 列，
 * 也没有 Team 入口。单独成文件便于渲染测试。
 */
import { StatusChip } from '../../components/StatusChip';
import { Badge, Button } from '../../components/ui';
import type { RosterAgent } from '../../gateway/team-roster';
import { t } from '../../i18n';
import { roleLabelKey, roleOf } from '../team/role';
import { agentDisplayName } from './agent-search';

export function AgentListRow({
  agent,
  nodeName,
  onOpen,
}: {
  agent: RosterAgent;
  nodeName: string;
  onOpen: () => void;
}) {
  const member = agent.member;
  const name = agentDisplayName(member);
  const presence =
    member.presence === 'live' ? t('agents.presence.live') : t('agents.presence.gone');
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-raised px-4 py-3">
      <div className="flex min-w-0 flex-1 basis-55 flex-col gap-0.5">
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-md font-semibold text-ink">
          {name}
          <Badge>{t(roleLabelKey(roleOf(member)))}</Badge>
        </span>
        <span className="min-w-0 wrap-anywhere text-xs text-faint">
          {nodeName}
          {agent.team ? ` · ${agent.team.name || agent.team.team_id}` : ''}
        </span>
      </div>
      <StatusChip status={member.state} />
      <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap text-sm text-muted">
        <span
          className={`size-1.75 rounded-full ${
            member.presence === 'live' ? 'bg-success' : 'bg-faint'
          }`}
          aria-hidden="true"
        />
        {presence}
      </span>
      <div className="ml-auto inline-flex flex-none flex-wrap items-center gap-2">
        <Button size="small" onClick={onOpen}>
          {t('agents.open')}
        </Button>
      </div>
    </li>
  );
}
