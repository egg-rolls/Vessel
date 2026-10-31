/**
 * RunDetail 容器：头部、元信息、取消/恢复、timeline/output/raw 三个视图。
 *
 * S3：trace 数据/分页在 useRunTrace；timeline 渲染在 RunTimeline。
 */

import { useEffect, useRef } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { EmptyState, LoadingState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { SegmentedTabs } from '../../components/Tabs';
import { iconButtonClass } from '../../components/Tooltip';
import { Button, KeyValueList, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { DurableRunSummary, RunStatus } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { isCancellableRun, isResumableRun } from '../../state/runs';
import { RunTimeline } from './RunTimeline';
import { durationLabel, exportJson, pretty } from './run-detail-format';
import { type DetailTab, useRunTrace } from './useRunTrace';

const DETAIL_TABS: readonly { id: DetailTab; labelKey: string }[] = [
  { id: 'timeline', labelKey: 'runs.detail.tab.timeline' },
  { id: 'output', labelKey: 'runs.detail.tab.output' },
  { id: 'raw', labelKey: 'runs.detail.tab.raw' },
];

export function RunDetail({
  runId,
  tab,
  run,
  durable,
  active,
  canWrite,
  onCancel,
  onResume,
  onClose,
  busy = false,
}: {
  /** 路由里的 id：live 为引擎 run id，durable 为 checkpoint id。 */
  runId: string;
  tab: 'live' | 'durable';
  run: RunStatus | null;
  durable: DurableRunSummary | null;
  active: boolean;
  canWrite: boolean;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  useLocale();
  const runTrace = useRunTrace(runId, tab, run, durable, active);
  const { view, setView, connected, loadFirstPage, coreRunId } = runTrace;

  const sectionRef = useRef<HTMLElement | null>(null);
  // 选中 run 后把详情滚入视野（桌面为内联面板；移动端是整页）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId 变化是滚动触发条件
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sectionRef.current?.scrollIntoView({
      block: 'start',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [runId]);

  const status = run?.status ?? durable?.status;
  const sessionId = run?.session_id ?? durable?.session_id;
  const startedAt = run?.started_at;
  const completedAt = run?.completed_at;
  const usage = run?.usage;
  const raw = run ?? durable;
  const lastCheckpointMessage =
    run?.messages && run.messages.length > 0
      ? run.messages[run.messages.length - 1]?.content
      : undefined;
  const cancellable = tab === 'live' && status !== undefined && isCancellableRun(status);
  const resumable = tab === 'durable' && status !== undefined && isResumableRun(status);

  return (
    <Section
      ref={sectionRef}
      className="mt-1"
      aria-label={t('runs.detail.label')}
      title={t('runs.detail.title')}
      actions={
        <>
          <StatusChip status={status} />
          <span className="min-w-0 wrap-anywhere font-mono text-muted" title={runId}>
            {runId}
          </span>
          <CopyButton
            text={runId}
            label={t('runs.detail.copyId')}
            toast={t('runs.detail.copiedId')}
            className="ml-auto"
          />
          <Button size="small" onClick={() => exportJson(raw, runId)}>
            {t('runs.detail.exportJson')}
          </Button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={t('runs.detail.close')}
            onClick={onClose}
          >
            ×
          </button>
        </>
      }
    >
      <KeyValueList
        items={[
          {
            key: 'session',
            label: t('runs.detail.session'),
            value: sessionId ? (
              <a
                className="font-mono text-accent underline underline-offset-2 hover:text-accent-ink"
                href={`#/chat/${encodeURIComponent(sessionId)}`}
              >
                {sessionId}
              </a>
            ) : (
              <span className="font-mono">—</span>
            ),
          },
          {
            key: 'started',
            label: t('runs.detail.started'),
            value: <span className="font-mono tabular-nums">{formatTimestamp(startedAt)}</span>,
          },
          {
            key: 'ended',
            label: t('runs.detail.ended'),
            value: <span className="font-mono tabular-nums">{formatTimestamp(completedAt)}</span>,
          },
          {
            key: 'duration',
            label: t('runs.detail.duration'),
            value: (
              <span className="font-mono tabular-nums">
                {durationLabel(startedAt, completedAt, status === 'running' || status === 'queued')}
              </span>
            ),
          },
          ...(run?.iteration !== undefined || durable?.iteration !== undefined
            ? [
                {
                  key: 'iteration',
                  label: 'Iteration',
                  value: (
                    <span className="font-mono tabular-nums">
                      {run?.iteration ?? durable?.iteration}
                    </span>
                  ),
                },
              ]
            : []),
          ...(run?.agent_id || durable?.agent_id
            ? [
                {
                  key: 'agent',
                  label: 'Agent',
                  value: <span className="font-mono">{run?.agent_id ?? durable?.agent_id}</span>,
                },
              ]
            : []),
          ...(usage
            ? [
                {
                  key: 'tokens',
                  label: 'Tokens',
                  value: (
                    <span className="font-mono tabular-nums">
                      {usage.prompt_tokens ?? 0} + {usage.completion_tokens ?? 0} ={' '}
                      {usage.total_tokens ?? 0}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      <div className="mt-2.5 flex flex-wrap gap-2">
        {cancellable && (
          <Button
            size="small"
            variant="dangerGhost"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onCancel(runId)}
          >
            {busy ? t('runs.detail.cancelling') : t('runs.detail.cancel')}
          </Button>
        )}
        {resumable && (
          <Button
            size="small"
            disabled={!canWrite || busy}
            title={!canWrite ? t('common.writesDisabled') : undefined}
            onClick={() => onResume(runId)}
          >
            {busy ? t('runs.detail.resuming') : t('runs.detail.resume')}
          </Button>
        )}
      </div>

      {!connected && (
        <StaleNotice message={t('runs.detail.disconnected')} onRetry={loadFirstPage} />
      )}

      <SegmentedTabs
        label={t('runs.detail.tabsLabel')}
        tabs={DETAIL_TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) }))}
        value={view}
        onChange={setView}
        panelId="run-detail-panel"
      />

      {view === 'timeline' && <RunTimeline trace={runTrace} tab={tab} coreRunId={coreRunId} />}

      {view === 'output' && (
        <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.outputLabel')}>
          {run?.error && (
            <>
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.errorTitle')}</h3>
              <pre className="run-output text-danger">{run.error}</pre>
            </>
          )}
          {run?.output ? (
            <>
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.outputTitle')}</h3>
              <pre className="run-output">{run.output}</pre>
            </>
          ) : durable?.preview ? (
            <>
              <h3 className="text-md font-semibold text-ink">
                {t('runs.detail.checkpointPreview')}
              </h3>
              <pre className="run-output">{durable.preview}</pre>
            </>
          ) : lastCheckpointMessage ? (
            <>
              <h3 className="text-md font-semibold text-ink">{t('runs.detail.checkpoint')}</h3>
              <pre className="run-output">{lastCheckpointMessage}</pre>
            </>
          ) : (
            <EmptyState
              title={t('runs.detail.emptyOutputTitle')}
              description={t('runs.detail.emptyOutputDesc')}
            />
          )}
        </div>
      )}

      {view === 'raw' && (
        <div id="run-detail-panel" role="tabpanel" aria-label={t('runs.detail.rawLabel')}>
          {raw ? (
            <>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <CopyButton
                  text={pretty(raw)}
                  label={t('runs.detail.copyJson')}
                  toast={t('runs.detail.copiedJson')}
                />
                <Button size="small" onClick={() => exportJson(raw, runId)}>
                  {t('runs.detail.exportJson')}
                </Button>
              </div>
              <JsonView value={raw} label={t('runs.detail.rawJsonLabel')} open maxHeight={520} />
            </>
          ) : (
            <LoadingState label={t('runs.detailLoading')} />
          )}
        </div>
      )}
    </Section>
  );
}
