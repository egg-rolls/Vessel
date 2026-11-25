/**
 * 任务看板查看器（q-kanban-view：真缺口——board.json 此前全仓无 UI 消费）。
 *
 * 数据面 = canonical kanban.*（packages/serve gateway/methods/kanban.ts）：
 * - kanban.get 读板（宽进严出归一化，warnings 随板返回）；
 * - kanban.archive 用户验收归档（勾选 → 确认弹窗 → 移板 + append-only archive.json）。
 *
 * 刷新：手动刷新无条件读；可见期 30s 轮询带 if_mtime_ms/if_size_bytes 双条件
 * （命中只 stat 不读文件），document.hidden 暂停（useResource 内建）。
 *
 * 列 = board.columns 序（待办/进行中/阻塞）+「未分类」兜底列（未知 column 不丢任务）。
 * GHOST 样式对齐工具页（ghost-control utilities，无新色板）。
 */
import { PageScaffold } from '@vessel-agent/plugin-ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, CountBadge } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import { GHOST_BUTTON_CLASS, GHOST_PANEL_CLASS } from '../../components/ui/ghost-control';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { KanbanCard } from './KanbanCard';
import type {
  KanbanArchiveResult,
  KanbanBoardData,
  KanbanGetResult,
  KanbanTask,
} from './kanban-types';

/** 可见期轮询间隔（一次条件 RPC ≈ 一次 stat，廉价）。 */
const POLL_MS = 30_000;
/** 兜底列的 React key（成员判定按 board.columns 集合，不靠 key 比对）。 */
const UNCATEGORIZED_KEY = '__uncategorized__';

interface KanbanColumnGroup {
  key: string;
  title: string;
  tasks: KanbanTask[];
}

/** updated 时间展示：ISO → 本地短格式；非法值原样显示。 */
function formatUpdated(updated: string | undefined): string | undefined {
  if (!updated) return undefined;
  const date = new Date(updated);
  return Number.isNaN(date.getTime()) ? updated : date.toLocaleString();
}

export function KanbanView() {
  const locale = useLocale();
  const { client, hasToken, epoch } = useConnection();
  const toast = useToast();

  // 轮询水位与上次成功数据：条件轮询命中 unchanged 时直接复用，不重读文件。
  const watermarkRef = useRef<{ mtimeMs: number; sizeBytes: number } | undefined>(undefined);
  const lastDataRef = useRef<KanbanBoardData | undefined>(undefined);
  // 手动刷新 / 归档后刷新置 false（无条件读，必达）；轮询走 true。
  const conditionalRef = useRef(true);

  const resource = useResource<KanbanBoardData>({
    load: async () => {
      const conditional = conditionalRef.current;
      conditionalRef.current = true;
      const adopt = (result: Extract<KanbanGetResult, { unchanged: false }>): KanbanBoardData => {
        const data: KanbanBoardData = {
          board: result.board,
          path: result.path,
          mtimeMs: result.mtime_ms,
          sizeBytes: result.size_bytes,
        };
        watermarkRef.current = { mtimeMs: result.mtime_ms, sizeBytes: result.size_bytes };
        lastDataRef.current = data;
        return data;
      };
      const watermark = watermarkRef.current;
      if (conditional && watermark) {
        const result = await client.rpc<KanbanGetResult>('kanban.get', {
          if_mtime_ms: watermark.mtimeMs,
          if_size_bytes: watermark.sizeBytes,
        });
        if (result.unchanged) {
          const last = lastDataRef.current;
          if (last) return { ...last, mtimeMs: result.mtime_ms, sizeBytes: result.size_bytes };
          // 有水位但无旧数据（理论不可达）：落回无条件读。
        } else {
          return adopt(result);
        }
      }
      const full = await client.rpc<KanbanGetResult>('kanban.get', {});
      if (full.unchanged) {
        // 无条件读不可能 unchanged（服务端只在双条件命中时回 true）。
        throw new Error('kanban.get: unexpected unchanged on unconditional read');
      }
      return adopt(full);
    },
    enabled: hasToken,
    pollMs: POLL_MS,
    pauseWhenHidden: true,
    deps: [epoch],
  });

  const manualRefresh = useCallback(() => {
    conditionalRef.current = false;
    resource.reload();
  }, [resource.reload]);
  useRefreshSignal(manualRefresh);

  // 验收归档：勾选 → 确认弹窗 → kanban.archive（用户裁定：绝不自动归档）。
  const [confirmTask, setConfirmTask] = useState<KanbanTask | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archiveTask = useCallback(async () => {
    const task = confirmTask;
    if (!task || archiving) return;
    setArchiving(true);
    try {
      const result = await client.rpc<KanbanArchiveResult>('kanban.archive', { id: task.id });
      const data: KanbanBoardData = {
        board: result.board,
        path: lastDataRef.current?.path ?? '',
        mtimeMs: result.mtime_ms,
        sizeBytes: result.size_bytes,
      };
      watermarkRef.current = { mtimeMs: result.mtime_ms, sizeBytes: result.size_bytes };
      lastDataRef.current = data;
      setConfirmTask(null);
      toast.success(t('kanban.archived', { title: task.title }));
      conditionalRef.current = false;
      resource.reload();
    } catch (error) {
      toast.error(
        t('kanban.archiveFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setArchiving(false);
    }
  }, [confirmTask, archiving, client, toast, resource.reload]);

  const data = resourceData(resource.state);
  const board = data?.board;

  // 按 board.columns 序分组；未知 column 的任务归「未分类」兜底列（不丢任务）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale 变化需要重算兜底列标题（t()）
  const groups = useMemo<KanbanColumnGroup[]>(() => {
    if (!board) return [];
    const known = new Set(board.columns);
    const result: KanbanColumnGroup[] = board.columns.map((title) => ({
      key: title,
      title,
      tasks: board.tasks.filter((task) => task.column === title),
    }));
    const rest = board.tasks.filter((task) => !known.has(task.column));
    if (rest.length > 0) {
      result.push({ key: UNCATEGORIZED_KEY, title: t('kanban.uncategorized'), tasks: rest });
    }
    return result;
  }, [board, locale]);

  if (!hasToken) {
    return (
      <NotEnabledState
        variant="page"
        title={t('common.notConnected')}
        reason={t('kanban.noTokenReason')}
      />
    );
  }

  const error = resource.state.status === 'error' ? resource.state.error : null;
  const errorCode = resource.state.status === 'error' ? resource.state.code : undefined;
  const updatedText = formatUpdated(board?.updated);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain">
      <PageScaffold title={t('nav.domain.kanban')} subtitle={t('kanban.subtitle')}>
        {resource.state.status === 'loading' && !data && <LoadingState />}
        {error && !data && errorCode === 'not_found' && (
          <EmptyState
            title={t('kanban.notFound')}
            description={error}
            action={<Button onClick={manualRefresh}>{t('common.retry')}</Button>}
          />
        )}
        {error && !data && errorCode !== 'not_found' && (
          <ErrorState message={error} onRetry={manualRefresh} />
        )}
        {board && (
          <>
            {error && <StaleNotice message={error} onRetry={manualRefresh} />}
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-md font-medium text-ink">{board.board}</span>
              {updatedText && (
                <span className="text-sm text-faint">
                  {t('kanban.updated', { time: updatedText })}
                </span>
              )}
              <CountBadge
                count={board.tasks.length}
                label={t('kanban.taskCount', { count: board.tasks.length })}
              />
              <span className="flex-1" />
              <Button
                className={GHOST_BUTTON_CLASS}
                onClick={manualRefresh}
                disabled={resource.state.status === 'loading'}
              >
                {t('kanban.refresh')}
              </Button>
            </div>
            {board.warnings.length > 0 && (
              <details className={cn('rounded-md p-3 text-sm text-warn', GHOST_PANEL_CLASS)}>
                <summary className="cursor-pointer">
                  {t('kanban.warnings', { count: board.warnings.length })}
                </summary>
                <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted">
                  {board.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {board.tasks.length === 0 ? (
              <EmptyState title={t('kanban.empty')} description={t('kanban.emptyHint')} />
            ) : (
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-3">
                {groups.map((group) => (
                  <section key={group.key} className="flex min-w-0 flex-col gap-2.5">
                    <header className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-ink">{group.title}</h2>
                      <CountBadge count={group.tasks.length} />
                    </header>
                    <div className="flex flex-col gap-2.5">
                      {group.tasks.length === 0 ? (
                        <p className={cn('rounded-md p-3 text-sm text-faint', GHOST_PANEL_CLASS)}>
                          {t('kanban.emptyColumn')}
                        </p>
                      ) : (
                        group.tasks.map((task) => (
                          <KanbanCard
                            key={task.id}
                            task={task}
                            archiving={archiving}
                            onAccept={setConfirmTask}
                          />
                        ))
                      )}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        {confirmTask && (
          <ConfirmDialog
            title={t('kanban.confirmTitle')}
            body={t('kanban.confirmBody', { title: confirmTask.title })}
            confirmLabel={t('kanban.confirmAction')}
            busy={archiving}
            onConfirm={() => void archiveTask()}
            onCancel={() => setConfirmTask(null)}
          />
        )}
      </PageScaffold>
    </div>
  );
}
