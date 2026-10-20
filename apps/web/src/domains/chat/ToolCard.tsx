import { useState } from 'react';
import { statusMeta } from '../../components/StatusChip';
import { payloadText, truncate } from './EventRow';
import type { ToolCardView } from './tool-cards';

function ToolSection({
  label,
  value,
  open = false,
}: {
  label: string;
  value: unknown;
  open?: boolean;
}) {
  const text = payloadText(value);
  if (!text) return null;
  return (
    <details className="tool-section" open={open}>
      <summary className="tool-section-label">{label}</summary>
      <pre className="tool-section-body">{text}</pre>
    </details>
  );
}

/** 工具卡：单行 header，参数/结果/错误默认按状态展开。 */
export function ToolCard({ card }: { card: ToolCardView }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? card.status === 'error';
  const meta = statusMeta(
    card.status === 'error' ? 'failed' : card.status === 'done' ? 'completed' : 'running',
  );
  const args =
    card.args === undefined ? '' : truncate(payloadText(card.args).replace(/\s+/g, ' '), 96);

  return (
    <div className="tool-card" data-status={card.status}>
      <button
        type="button"
        className="tool-card-header"
        aria-expanded={expanded}
        onClick={() => setManual(!expanded)}
      >
        <span className={`tool-card-glyph tone-${meta.tone}`} aria-hidden="true">
          {meta.glyph}
        </span>
        <span className="tool-card-name">{card.name}</span>
        {args && <span className="tool-card-args">{args}</span>}
        {card.durationMs != null && <span className="tool-card-duration">{card.durationMs}ms</span>}
        <span className="tool-card-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="tool-card-body">
          <ToolSection label="参数" value={card.args} open={card.status === 'running'} />
          <ToolSection label="结果" value={card.result} open={card.status === 'done'} />
          <ToolSection label="错误" value={card.error} open={card.status === 'error'} />
          {card.truncated && <p className="tool-card-note">输出已截断</p>}
        </div>
      )}
    </div>
  );
}
