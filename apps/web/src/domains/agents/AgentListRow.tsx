/**
 * Agents 卡片（纯展示）。
 *
 * 整卡就是一个按钮：点击进入该成员的智能体详情面板；
 * 不再单列「打开成员」按钮，卡片本身即入口。
 */
import { StatusChip } from '../../components/StatusChip';
import { Badge } from '../../components/ui';
import { CARD_SURFACE_CLASS } from '../../components/ui/card-surface';
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
    <li className="min-w-0">
      <button type="button" className={CARD_SURFACE_CLASS} onClick={onOpen}>
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2 wrap-anywhere text-md font-semibold text-ink">
            {name}
            <Badge>{t(roleLabelKey(roleOf(member)))}</Badge>
          </span>
          <StatusChip status={member.state} />
        </span>
        <span className="min-w-0 wrap-anywhere text-xs text-faint">
          {nodeName}
          {agent.team ? ` · ${agent.team.name || agent.team.team_id}` : ''}
        </span>
        <span className="mt-auto inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted">
          <span
            className={`size-1.75 rounded-full ${
              member.presence === 'live' ? 'bg-success' : 'bg-faint'
            }`}
            aria-hidden="true"
          />
          {presence}
        </span>
      </button>
    </li>
  );
}
