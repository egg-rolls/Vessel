/**
 * 看板任务卡（默认表面：raised 被动卡，逐字对齐 McpPanel 来源卡）。
 *
 * 表面口径（q-kanban-visual 审计裁定）：GHOST 透黑底细线只供设置弹窗 /
 * 运行期事件日志域（ghost-control.ts 头注），看板是内容域，与工具页 /
 * 技能库同走共享默认表面——skills-style 先例（66d02d4f）同款纠偏。
 * 卡片非整卡可点（勾选框 / 展开按钮才是交互点），不用 CARD_SURFACE_CLASS
 * 的 cursor-pointer / hover 抬起，被动卡先例 = McpPanel 来源卡。
 *
 * 勾选框 = 用户验收：勾选 → 上层确认弹窗 → kanban.archive（绝不自动归档）。
 * 卡片在归档成功前保持未勾选（任务仍在板上）；归档后整卡随刷新消失。
 * progress 长文默认 line-clamp-3，可展开/收起。
 */
import { useState } from 'react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../components/ui/cn';
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
    <article className="flex flex-col gap-2 rounded-md bg-raised px-4 py-3.5 shadow-elev-1 forced-colors:border">
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
          {task.owner && <Badge>{task.owner}</Badge>}
          {task.branch && <Badge>{task.branch}</Badge>}
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
          {/* 展开/收起走预设 link 变体（MessageFold / payload-section 先例），
              不再手写裸 button 下划线样式。 */}
          {longProgress && (
            <Button
              variant="link"
              className="mt-1 text-xs"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? t('kanban.collapseProgress') : t('kanban.expandProgress')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
