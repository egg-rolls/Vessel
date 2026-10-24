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
import { Button } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { type NodeView, useNodes } from '../../gateway/NodeProvider';
import type { RosterAgent } from '../../gateway/team-roster';
import { t, useLocale } from '../../i18n';
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
  onOpenTeam: () => void;
  onOpenSession: () => void;
}) {
  useLocale();
  const toast = useToast();
  const { tenantId } = useConnection();
  const { teamControl } = useNodes();
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
    <div className="domain-view">
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
      <div className="domain-content">
        <section className="panel">
          <div className="panel-header">
            <h2 className="section-title">{t('agents.detail.title')}</h2>
          </div>
          <dl className="diag-list">
            <dt>{t('agents.filter.node')}</dt>
            <dd>{node.name}</dd>
            <dt>{t('agents.filter.team')}</dt>
            <dd>
              <button type="button" className="link-btn" onClick={onOpenTeam}>
                {agent.team.name || agent.team.team_id}
              </button>
            </dd>
            <dt>{t('agents.filter.state')}</dt>
            <dd>
              <StatusChip status={member.state} />
            </dd>
            <dt>{t('agents.filter.presence')}</dt>
            <dd>{t(`agents.presence.${member.presence}`)}</dd>
            <dt>{t('agents.detail.membership')}</dt>
            <dd>{t(`team.membership.${member.membership}`)}</dd>
            <dt>{t('agents.detail.visibility')}</dt>
            <dd className="mono">{member.visibility}</dd>
            <dt>{t('agents.detail.session')}</dt>
            <dd>
              {member.session_id ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={onOpenSession}
                  disabled={!node.current}
                >
                  {t('team.member.currentSession')}
                </button>
              ) : (
                '—'
              )}
            </dd>
          </dl>
          <details className="net-advanced">
            <summary>{t('agents.detail.advanced')}</summary>
            <dl className="diag-list">
              <dt>{t('agents.detail.agentId')}</dt>
              <dd className="mono">{member.agent_id}</dd>
            </dl>
          </details>
        </section>
      </div>

      {closeOpen && (
        <ConfirmDialog
          title={t('agents.close.title')}
          body={
            <>
              <p>{t('agents.close.body')}</p>
              <p className="mono">{displayName}</p>
              {closeError && (
                <p className="field-error" role="alert">
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
