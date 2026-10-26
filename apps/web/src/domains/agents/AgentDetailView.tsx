/**
 * Agent 只读详情 + Edit / Close 入口。
 *
 * 数据复用 Agents 列表已加载的 roster；agent_id 只在 Advanced details 出现一次。
 * Close 走警告确认，并严格处理 `{results:[{ok:false}]}` 的失败。
 */
import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { StatusChip } from '../../components/StatusChip';
import { useToast } from '../../components/ToastProvider';
import { Button, KeyValueList, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import type { RosterAgent } from '../../gateway/team-roster';
import { t, useLocale } from '../../i18n';
import { useNodeNames } from '../nodes/useNodeNames';
import { roleLabelKey, roleOf } from '../team/role';
import { agentErrorText } from './agent-errors';
import { agentDisplayName } from './agent-search';

export function AgentDetailView({
  node,
  agent,
  onBack,
  onEdit,
  onSaved,
  onOpenTeam,
  onOpenSession,
}: {
  node: NodeView;
  agent: RosterAgent;
  onBack: () => void;
  onEdit: () => void;
  onSaved: () => void;
  /** Team-less single 没有 Team 入口。 */
  onOpenTeam?: () => void;
  onOpenSession: () => void;
}) {
  useLocale();
  const toast = useToast();
  const { tenantId } = useConnection();
  const { teamControl } = useNodes();
  const nodeNames = useNodeNames();
  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const member = agent.member;
  const displayName = agentDisplayName(member);
  const alreadyLeft = member.membership === 'left';

  const confirmClose = async () => {
    setClosing(true);
    setCloseError(null);
    try {
      const saved = await teamControl(node).closeAgent(member.agent_id);
      toast.success(
        t('agents.close.success', {
          name: saved.name?.trim() || member.name?.trim() || displayName,
        }),
      );
      setCloseOpen(false);
      onSaved();
    } catch (caught) {
      setCloseError(agentErrorText(caught, 'agents.close.failed'));
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader
        title={displayName}
        tenantId={tenantId}
        actions={
          <>
            <Button onClick={onEdit} disabled={alreadyLeft}>
              {t('common.edit')}
            </Button>
            <Button
              variant="dangerGhost"
              disabled={alreadyLeft}
              onClick={() => {
                setCloseError(null);
                setCloseOpen(true);
              }}
            >
              {t('agents.close')}
            </Button>
            <Button onClick={onBack}>{t('agents.back')}</Button>
          </>
        }
      />
      <div className="mt-5 flex flex-col gap-4">
        <Section title={t('agents.detail.title')}>
          <KeyValueList
            items={[
              {
                key: 'node',
                label: t('agents.filter.node'),
                value: nodeNames.get(nodeKeyOf(node)) ?? '—',
              },
              {
                key: 'team',
                label: t('agents.filter.team'),
                value:
                  agent.team && onOpenTeam ? (
                    <Button variant="link" onClick={onOpenTeam}>
                      {agent.team.name || agent.team.team_id}
                    </Button>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'role',
                label: t('team.role.label'),
                value: t(roleLabelKey(roleOf(member))),
              },
              {
                key: 'state',
                label: t('agents.filter.state'),
                value: <StatusChip status={member.state} />,
              },
              {
                key: 'presence',
                label: t('agents.filter.presence'),
                value: t(`agents.presence.${member.presence}`),
              },
              {
                key: 'membership',
                label: t('agents.detail.membership'),
                value: t(`team.membership.${member.membership}`),
              },
              {
                key: 'visibility',
                label: t('agents.detail.visibility'),
                value: <span className="font-mono">{member.visibility}</span>,
              },
              {
                key: 'session',
                label: t('agents.detail.session'),
                value: member.session_id ? (
                  <Button variant="link" onClick={onOpenSession} disabled={!node.current}>
                    {t('team.member.currentSession')}
                  </Button>
                ) : (
                  '—'
                ),
              },
            ]}
          />
          <details className="mt-3 border-t border-line pt-2">
            <summary className="cursor-pointer text-sm text-faint">
              {t('agents.detail.advanced')}
            </summary>
            <KeyValueList
              className="mt-2"
              items={[
                {
                  key: 'agentId',
                  label: t('agents.detail.agentId'),
                  value: <span className="font-mono">{member.agent_id}</span>,
                },
              ]}
            />
          </details>
        </Section>
      </div>

      {closeOpen && (
        <ConfirmDialog
          title={t('agents.close.title')}
          body={
            <>
              <p>{t('agents.close.body')}</p>
              <p className="font-mono">{displayName}</p>
              {closeError && (
                <p className="text-xs text-danger leading-snug" role="alert">
                  {closeError}
                </p>
              )}
            </>
          }
          confirmLabel={t('agents.close')}
          danger
          busy={closing}
          onConfirm={() => {
            void confirmClose();
          }}
          onCancel={() => {
            if (closing) return;
            setCloseOpen(false);
            setCloseError(null);
          }}
        />
      )}
    </div>
  );
}
