/**
 * 看板任务卡（GHOST 样式：透黑底细线，对齐工具页）。
 *
 * 勾选框 = 用户验收：勾选 → 上层确认弹窗 → kanban.archive（绝不自动归档）。
 * 卡片在归档成功前保持未勾选（任务仍在板上）；归档后整卡随刷新消失。
 * progress 长文默认 line-clamp-3，可展开/收起。
 */
import { useState } from 'react';
import { Badge } from '../../components/ui';
import { cn } from '../../components/ui/cn';
import { GHOST_BADGE_CLASS, GHOST_PANEL_CLASS } from '../../components/ui/ghost-control';
import { t } from '../../i18n';
import type { KanbanTask } from './kanban-types';

/** 超过该长度才出展开按钮（短进展直接全文显示）。 */
const PROGRESS_CLAMP_THRESHOLD = 120;

export function KanbanCard({
  task,
  archiving,
  onAccept,
}: {
  task: KanbanTask;
  /** 有归档请求在途：禁用全部勾选框，防重复提交。 */
  archiving: boolean;
  onAccept: (task: KanbanTask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longProgress = (task.progress?.length ?? 0) > PROGRESS_CLAMP_THRESHOLD;
  return (
    <article className={cn('flex flex-col gap-2 rounded-md p-3', GHOST_PANEL_CLASS)}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 size-4 flex-none accent-accent"
          checked={false}
          disabled={archiving}
          onChange={() => onAccept(task)}
          aria-label={t('kanban.acceptAria', { title: task.title })}
          title={t('kanban.accept')}
        />
        <h3 className="min-w-0 text-md font-medium leading-snug text-ink">{task.title}</h3>
      </div>
      {(task.owner || task.branch) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-6">
          {task.owner && <Badge className={GHOST_BADGE_CLASS}>{task.owner}</Badge>}
          {task.branch && <Badge className={GHOST_BADGE_CLASS}>{task.branch}</Badge>}
        </div>
      )}
      {task.progress && (
        <div className="pl-6">
          <p
            className={cn(
              'whitespace-pre-wrap text-sm leading-relaxed text-muted',
              !expanded && longProgress && 'line-clamp-3',
            )}
          >
            {task.progress}
          </p>
          {longProgress && (
            <button
              type="button"
              className="mt-1 text-xs text-faint underline-offset-2 hover:underline"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? t('kanban.collapseProgress') : t('kanban.expandProgress')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
