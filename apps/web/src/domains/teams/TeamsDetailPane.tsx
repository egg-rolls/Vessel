/**
 * Team 详情 pane：无选中时的空态 / 节点缺失提示 / TeamDetailRoute；窄屏顶部带抽屉开关。
 */
import type { ReactNode } from 'react';
import { EmptyState, NotEnabledState } from '../../components/States';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { TeamDetailRoute } from './TeamDetailRoute';
import type { TeamsViewState } from './useTeamsView';

interface TeamsDetailPaneProps {
  state: TeamsViewState;
}

export function TeamsDetailPane({ state }: TeamsDetailPaneProps) {
  const { isDetail, detailNode, detailRoute, navigate, compact, drawerOpen, setDrawerOpen } = state;

  let detail: ReactNode;
  if (!isDetail) {
    detail = (
      <div className="teams-detail-empty">
        <EmptyState
          title={t('teams.detail.emptyTitle')}
          description={t('teams.detail.emptyDesc')}
        />
      </div>
    );
  } else if (detailNode && detailRoute) {
    detail = <TeamDetailRoute node={detailNode} route={detailRoute} navigate={navigate} />;
  } else {
    detail = (
      <div className="teams-detail-empty">
        <NotEnabledState
          title={t('teams.nodeMissing')}
          action={
            <Button onClick={() => navigate({ domain: 'teams' })}>
              {t('team.chat.backToList')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <section
      className="teams-detail-pane"
      aria-label={t('teams.title')}
      inert={compact && drawerOpen ? true : undefined}
    >
      <h1 className="sr-only">{t('teams.title')}</h1>
      {compact && (
        <div className="teams-detail-toolbar">
          <Button
            id="teams-list-toggle"
            size="small"
            aria-expanded={drawerOpen}
            aria-controls="teams-column"
            onClick={() => setDrawerOpen(true)}
          >
            {t('teams.openList')}
          </Button>
        </div>
      )}
      <div className="teams-detail-body">{detail}</div>
    </section>
  );
}
