/**
 * 历史工具卡：sessions.get 里 assistant tool_calls + role:'tool' 配对后的展示。
 *
 * 与运行态的 ToolCard 共用同一张 StreamCard（标题 / 单行摘要 / 可展开体），差别只有：
 * 历史没有 success / error 状态（tone=neutral、不显示 duration）；结果缺失时显式
 * 提示而不是空白。
 */
import { t } from '../../i18n';
import type { HistoryToolItem } from './history-tools';
import { StreamCard } from './StreamCard';
import { parseToolArgs, toolSummary } from './tool-cards';
import { useToolDescription } from './tool-catalog';

export function HistoryToolCard({
  item,
  defaultOpen = false,
}: {
  item: HistoryToolItem;
  /** 默认展开（ui.expandCards || verbosity === 'debug'）；手动开合优先。 */
  defaultOpen?: boolean;
}) {
  const description = useToolDescription(item.name);
  const summary = toolSummary(item.name, parseToolArgs(item.args));
  const missingOutput = !item.paired || item.output === undefined;

  return (
    <StreamCard
      className="tool-card"
      defaultOpen={defaultOpen}
      title={
        <>
          <span className="tool-card-glyph tone-neutral" role="img" aria-label={t('chat.tool.status.history')}>
            ·
          </span>
          <span className="font-mono text-sm text-ink">{item.name}</span>
        </>
      }
      summary={summary.length > 0 ? summary : undefined}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wide text-faint">
          {t('chat.tool.description')}
        </span>
        <p className="m-0 text-md leading-relaxed text-muted">
          {description ?? t('chat.tool.descriptionUnavailable')}
        </p>
      </div>
      <section className="tool-section">
        <div className="tool-section-head">
          <span className="tool-section-label">{t('chat.tool.input')}</span>
        </div>
        <pre className="tool-section-body tool-section-preview">
          {typeof item.args === 'string' ? item.args : JSON.stringify(item.args ?? {}, null, 2)}
        </pre>
      </section>
      <section className="tool-section">
        <div className="tool-section-head">
          <span className="tool-section-label">{t('chat.tool.output')}</span>
        </div>
        {missingOutput ? (
          <p className="m-0 px-2.5 pb-2 text-sm text-muted">{t('chat.tool.outputMissing')}</p>
        ) : (
          <pre className="tool-section-body tool-section-preview">{item.output}</pre>
        )}
      </section>
    </StreamCard>
  );
}
