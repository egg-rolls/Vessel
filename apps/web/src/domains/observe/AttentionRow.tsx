/**
 * Attention 收件箱的单行（纯展示）。
 *
 * 纯搬移自 AttentionPanel.tsx，逻辑不变。
 */
import { formatTimestamp } from '../../format';
import type { ListedInteraction } from '../../gateway/interaction-hydration';
import { t } from '../../i18n';

export function AttentionRow({
  item,
  onOpen,
  readonly,
}: {
  item: ListedInteraction;
  onOpen?: () => void;
  readonly?: boolean;
}) {
  const createdAt = new Date(item.created_at);
  const iso = Number.isNaN(createdAt.getTime()) ? undefined : createdAt.toISOString();
  const cells = (
    <>
      <span className="attention-kind mono">{item.kind}</span>
      <span className="attention-request mono" title={item.request_id}>
        {item.request_id}
      </span>
      <span className="attention-cell mono">{item.tool ?? '—'}</span>
      <span className="attention-cell mono">{item.agent_id ?? '—'}</span>
      <span className="attention-cell mono">{item.team_id ?? '—'}</span>
      <time className="attention-time mono" {...(iso ? { dateTime: iso } : {})}>
        {formatTimestamp(item.created_at) || '—'}
      </time>
    </>
  );

  return (
    <li className="attention-item">
      {onOpen ? (
        <button type="button" className="attention-row attention-row-open" onClick={onOpen}>
          {cells}
        </button>
      ) : (
        <div
          className="attention-row"
          {...(readonly ? { title: t('observe.attention.remoteRowHint') } : {})}
        >
          {cells}
        </div>
      )}
    </li>
  );
}
