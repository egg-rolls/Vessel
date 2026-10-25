// biome-ignore-all lint/suspicious/noArrayIndexKey: diff 行没有稳定 id，顺序即语义
import { useId, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { ModalShell } from '../../components/Modal';
import { Badge, Button } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { t } from '../../i18n';
import { formatErrorMeta } from '../../state/error-visibility';
import type { Verbosity } from '../../state/visibility';
import {
  type DiffLine,
  editDiffOf,
  PAYLOAD_CHUNK_BYTES,
  PREVIEW_LINES,
  previewPayload,
  type ToolCardView,
  toolSummary,
} from './tool-cards';
import { useToolDescription } from './tool-catalog';

const STATUS_GLYPH: Record<ToolCardView['status'], string> = {
  running: '●',
  done: '✓',
  error: '✗',
};

const STATUS_LABEL: Record<ToolCardView['status'], string> = {
  running: 'chat.tool.status.running',
  done: 'chat.tool.status.done',
  error: 'chat.tool.status.error',
};

const STATUS_BADGE_TONE: Record<ToolCardView['status'], 'info' | 'success' | 'danger'> = {
  running: 'info',
  done: 'success',
  error: 'danger',
};

const STATUS_TONE: Record<ToolCardView['status'], string> = {
  running: 'tone-info',
  done: 'tone-ok',
  error: 'tone-danger',
};

function valueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface SectionProps {
  label: string;
  value: unknown;
  defaultOpen?: boolean;
  tone?: 'error';
  verbosity: Verbosity;
}

/**
 * 独立折叠的 payload 分区：折叠时只渲染 20 行 / 8KB 预览，不挂载完整 DOM；
 * 展开后超过 200KB 分段加载。保留原始换行与行首空格。
 */
function PayloadSection({ label, value, defaultOpen = false, tone, verbosity }: SectionProps) {
  const text = valueText(value);
  const [open, setOpen] = useState(defaultOpen);
  const [loadedBytes, setLoadedBytes] = useState(PAYLOAD_CHUNK_BYTES);
  const id = useId();
  if (!text) return null;

  const preview = previewPayload(text);
  const shown = open ? text.slice(0, loadedBytes) : preview.preview;
  const hasMore = open && text.length > loadedBytes;
  const hiddenLines = preview.truncated && !open;

  return (
    <section className={`tool-section ${tone === 'error' ? 'tool-section-error' : ''}`.trim()}>
      <div className="tool-section-head">
        <button
          type="button"
          className="tool-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="tool-section-label">{label}</span>
          {!open && hiddenLines && (
            <span className="tool-section-meta">
              {t('chat.tool.previewLines', {
                shown: Math.min(preview.totalLines, PREVIEW_LINES),
                total: preview.totalLines,
              })}
            </span>
          )}
        </button>
        <CopyButton text={text} label={t('chat.tool.copy')} className="tool-section-copy" />
      </div>
      <pre className={`tool-section-body ${open ? '' : 'tool-section-preview'}`.trim()} id={id}>
        {shown}
      </pre>
      {hasMore && (
        <Button
          variant="link"
          className="tool-section-more"
          onClick={() => setLoadedBytes((value) => value + PAYLOAD_CHUNK_BYTES)}
        >
          {t('chat.tool.loadMore', {
            loaded: Math.round(loadedBytes / 1024),
            total: Math.round(text.length / 1024),
          })}
        </Button>
      )}
      {!open && preview.truncated && (
        <Button variant="link" className="tool-section-more" onClick={() => setOpen(true)}>
          {t('chat.tool.showAll', { total: preview.totalLines })}
        </Button>
      )}
      {verbosity === 'debug' && (
        <div className="tool-section-debug font-mono tabular-nums">
          {preview.totalLines} lines · {preview.totalBytes} bytes
        </div>
      )}
    </section>
  );
}

function DiffSection({ lines, path }: { lines: DiffLine[]; path?: string }) {
  if (lines.length === 0) return null;
  return (
    <section className="tool-section">
      <div className="tool-section-head">
        <span className="tool-section-label">
          {t('chat.tool.diff')}
          {path ? ` · ${path}` : ''}
        </span>
      </div>
      <pre className="tool-section-body whitespace-pre wrap-normal">
        {lines.map((line, index) => (
          <span
            key={index}
            className={`block ${
              line.kind === 'add'
                ? 'text-success'
                : line.kind === 'remove'
                  ? 'text-danger'
                  : 'text-faint'
            }`}
          >
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </section>
  );
}

/** 工具卡：Codex 式单行 header；点击打开详情弹窗（描述 + 输入，其余分区折叠）。 */
export function ToolCard({
  card,
  verbosity = 'normal',
}: {
  card: ToolCardView;
  verbosity?: Verbosity;
}) {
  const [open, setOpen] = useState(false);
  const description = useToolDescription(card.name);
  const summary = toolSummary(card.name, card.args);
  const diff = card.name === 'edit' ? editDiffOf(card.args) : null;
  const errorText = card.error !== undefined ? valueText(card.error) : '';
  const meta = formatErrorMeta(card.errorMeta);

  return (
    <div className="tool-card" data-status={card.status}>
      <button
        type="button"
        className="flex min-h-9 w-full items-center gap-2 rounded-md bg-transparent px-2.5 text-left text-muted hover:bg-hover"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span
          className={`tool-card-glyph ${STATUS_TONE[card.status]}`}
          role="img"
          aria-label={t(STATUS_LABEL[card.status])}
        >
          {STATUS_GLYPH[card.status]}
        </span>
        <span className="flex-none font-mono text-sm text-ink">{card.name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-faint">{summary}</span>
        )}
        {card.durationMs != null && (
          <span className="ml-auto flex-none font-mono text-xs tabular-nums text-faint">
            {formatDuration(card.durationMs)}
          </span>
        )}
        <span className="flex-none text-2xs text-faint" aria-hidden="true">
          ›
        </span>
      </button>

      {/* 失败不能静默：卡片收起时也保留错误摘要（完整内容在详情弹窗）。 */}
      {card.status === 'error' && errorText && (
        <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-xs text-danger">
          {errorText}
        </p>
      )}

      {open && (
        <ModalShell
          label={t('chat.tool.dialogLabel', { name: card.name })}
          onClose={() => setOpen(false)}
          closeLabel={t('common.close')}
          size="md"
        >
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <h2 className="font-serif text-xl font-semibold text-ink">{card.name}</h2>
            <Badge tone={STATUS_BADGE_TONE[card.status]}>{t(STATUS_LABEL[card.status])}</Badge>
            {card.durationMs != null && (
              <span className="font-mono text-xs tabular-nums text-faint">
                {formatDuration(card.durationMs)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide text-faint">
              {t('chat.tool.description')}
            </span>
            <p className="m-0 text-md leading-relaxed text-muted">
              {description ?? t('chat.tool.descriptionUnavailable')}
            </p>
          </div>

          <PayloadSection
            label={t('chat.tool.input')}
            value={card.args}
            defaultOpen
            verbosity={verbosity}
          />
          <PayloadSection label={t('chat.tool.output')} value={card.result} verbosity={verbosity} />
          {diff && <DiffSection lines={diff.lines} path={diff.path} />}
          <PayloadSection
            label={t('chat.tool.error')}
            value={errorText || undefined}
            defaultOpen={card.status === 'error'}
            tone="error"
            verbosity={verbosity}
          />
          {meta && (
            <p className="error-meta font-mono tabular-nums">
              {meta}
              {card.errorMeta?.retryable === true ? ` · ${t('chat.tool.retryable')}` : ''}
            </p>
          )}
          {card.errorMeta?.httpStatus !== undefined && (
            <p className="error-meta font-mono tabular-nums">HTTP {card.errorMeta.httpStatus}</p>
          )}
          {card.truncated && <p className="text-xs text-warn">{t('chat.tool.truncated')}</p>}
          {verbosity === 'debug' && (
            <section className="tool-section">
              <div className="tool-section-label">{t('chat.tool.meta')}</div>
              <dl className="tool-meta-list font-mono tabular-nums">
                {card.callId && (
                  <>
                    <dt>call</dt>
                    <dd>{card.callId}</dd>
                  </>
                )}
                <dt>status</dt>
                <dd>{card.status}</dd>
                <dt>started</dt>
                <dd>{formatTimestamp(card.startedAt)}</dd>
              </dl>
            </section>
          )}
        </ModalShell>
      )}
    </div>
  );
}
