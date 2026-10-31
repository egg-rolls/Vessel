/**
 * Teams 域弹窗：创建 Team 与归档确认。
 */
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t } from '../../i18n';
import { TeamFormDialog } from './TeamFormDialog';
import type { TeamsViewState } from './useTeamsView';

interface TeamsViewDialogsProps {
  state: TeamsViewState;
}

export function TeamsViewDialogs({ state }: TeamsViewDialogsProps) {
  const {
    createOpen,
    setCreateOpen,
    writableNodes,
    nodeFilter,
    reloadLists,
    archiveTarget,
    setArchiveTarget,
    archiving,
    archiveError,
    setArchiveError,
    confirmArchive,
  } = state;

  return (
    <>
      {createOpen && (
        <TeamFormDialog
          nodes={writableNodes}
          {...(nodeFilter ? { initialNodeKey: nodeFilter } : {})}
          onClose={() => setCreateOpen(false)}
          onSaved={reloadLists}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={t('nodes.teams.archiveTitle')}
          body={
            <>
              <p>{t('nodes.teams.archiveBody')}</p>
              <p className="font-mono">{archiveTarget.team.name || archiveTarget.team.team_id}</p>
              {archiveError && (
                <p className="text-xs text-danger leading-snug" role="alert">
                  {archiveError}
                </p>
              )}
            </>
          }
          confirmLabel={t('common.archive')}
          danger
          busy={archiving}
          onConfirm={() => {
            void confirmArchive();
          }}
          onCancel={() => {
            if (archiving) return;
            setArchiveTarget(null);
            setArchiveError(null);
          }}
        />
      )}
    </>
  );
}
