/**
 * 常驻 Team 栏：标题 / Create / 刷新、搜索、节点过滤、按节点分组的卡片与空态。
 * 窄屏下同一栏是抽屉，附带遮罩。
 */
import type { ReactNode } from 'react';
import type { PaneResizeApi } from '../../app/usePaneResize';
import { ResizeHandle } from '../../components/ResizeHandle';
import { EmptyState, LoadingState, NotEnabledState } from '../../components/States';
import { Button, SearchInput, Select, SidebarShell } from '../../components/ui';
import { nodeKeyOf } from '../../gateway/nodes';
import type { NodeTeams } from '../../gateway/team-roster';
import { t } from '../../i18n';
import { TeamCard } from './TeamCard';
import type { TeamsViewState } from './useTeamsView';

/** 节点级失败按稳定 code 映射；其它错误保留原始 message。 */
function nodeErrorText(result: NodeTeams): string {
  if (result.code === 'forbidden') return t('teams.error.forbidden');
  if (result.code === 'not_found') return t('teams.error.notEnabled');
  return result.error ?? t('common.loadFailed');
}

interface TeamsListColumnProps {
  state: TeamsViewState;
  panes: PaneResizeApi;
}

export function TeamsListColumn({ state, panes }: TeamsListColumnProps) {
  const {
    compact,
    drawerOpen,
    setDrawerOpen,
    drawerRef,
    writableNodes,
    setCreateOpen,
    refreshCurrent,
    loaded,
    query,
    setQuery,
    nodeFilter,
    changeNodeFilter,
    nodes,
    nodeNames,
    anyNodeToken,
    allFailed,
    data,
    allTeams,
    visibleTeams,
    hasSearchOrFilter,
    clearSearch,
    partial,
    visible,
    openTeam,
    isActiveTeam,
    menuItems,
  } = state;

  const createButton = (
    <Button
      variant="primary"
      size="small"
      onClick={() => setCreateOpen(true)}
      disabled={writableNodes.length === 0}
    >
      {t('nodes.teams.create')}
    </Button>
  );

  let body: ReactNode;
  if (!anyNodeToken) {
    body = (
      <NotEnabledState title={t('team.error.noToken')} reason={t('team.error.noTokenReason')} />
    );
  } else if (!loaded) {
    body = <LoadingState rows={3} />;
  } else if (allFailed && data[0]?.code === 'not_found') {
    body = (
      <NotEnabledState
        title={t('teams.error.notEnabled')}
        reason={t('team.error.notEnabledReason')}
        hint={t('team.error.notEnabledHint')}
      />
    );
  } else if (!allFailed && allTeams === 0) {
    body = (
      <EmptyState
        title={t('teams.empty')}
        action={writableNodes.length > 0 ? createButton : undefined}
      />
    );
  } else if (!allFailed && visibleTeams === 0 && hasSearchOrFilter) {
    body = (
      <EmptyState
        title={t('teams.empty')}
        action={<Button onClick={clearSearch}>{t('team.list.clearSearch')}</Button>}
      />
    );
  } else {
    body = (
      <>
        {partial && (
          <p
            className="m-0 rounded-sm border border-line-strong bg-warn-soft px-3 py-2 text-sm text-warn"
            role="status"
          >
            {t('teams.partialError')}
          </p>
        )}
        <div className="flex flex-col gap-5">
          {visible.map((result) => (
            <section
              className="flex min-w-0 flex-col gap-2"
              key={nodeKeyOf(result.node)}
              aria-label={nodeNames.get(nodeKeyOf(result.node)) ?? '—'}
            >
              {/* 分组头是祖先级（node = 列表的 scope），不是身份；只在多分组时显示“当前”标记。 */}
              <header className="sidebar-group-label">
                <span>{nodeNames.get(nodeKeyOf(result.node)) ?? '—'}</span>
                {result.node.current && visible.length > 1 && (
                  <span className="text-2xs" title={t('entity.currentNode')}>
                    <span aria-hidden="true">· </span>
                    {t('entity.currentNode')}
                  </span>
                )}
              </header>
              {!result.ok ? (
                <p
                  className="m-0 rounded-sm border border-line-strong bg-danger-soft px-3 py-2 text-sm text-danger"
                  role="alert"
                >
                  {nodeErrorText(result)}
                </p>
              ) : result.teams.length === 0 ? (
                <p className="m-0 py-2 text-sm text-muted">{t('teams.empty')}</p>
              ) : (
                <ul className="teams-grid">
                  {result.teams.map((team) => (
                    <TeamCard
                      key={team.team_id}
                      node={result.node}
                      team={team}
                      active={isActiveTeam(result.node, team)}
                      menuItems={menuItems}
                      onOpen={openTeam}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <SidebarShell
        as="aside"
        id="teams-column"
        label={t('teams.title')}
        title={t('teams.title')}
        actions={
          <>
            {createButton}
            <Button size="small" onClick={refreshCurrent} disabled={!loaded}>
              {t('common.refresh')}
            </Button>
          </>
        }
        controls={
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('team.list.search')}
              ariaLabel={t('team.list.search')}
            />
            <Select
              className="h-control w-full py-0"
              value={nodeFilter}
              onChange={(event) => changeNodeFilter(event.target.value)}
              aria-label={t('teams.filter.node')}
            >
              <option value="">{t('teams.filter.all')}</option>
              {nodes.map((node) => (
                <option key={nodeKeyOf(node)} value={nodeKeyOf(node)}>
                  {nodeNames.get(nodeKeyOf(node)) ?? '—'}
                </option>
              ))}
            </Select>
          </>
        }
        shellRef={drawerRef}
        drawer={
          compact
            ? {
                open: drawerOpen,
                onClose: () => setDrawerOpen(false),
                closeLabel: t('common.close'),
                backdropLabel: t('common.close'),
              }
            : undefined
        }
      >
        {body}
      </SidebarShell>
      {!compact && !panes.disabled('teamList') && (
        <ResizeHandle
          pane="teamList"
          api={panes}
          label={t('resize.teams')}
          className="resize-handle resize-handle-team-list"
        />
      )}
    </>
  );
}
