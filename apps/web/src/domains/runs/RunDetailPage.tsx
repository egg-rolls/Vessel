/**
 * 运行详情页（#/runs/<runId>）：整页布局，不再塞在运行列表下面。
 *
 * 两段式：顶部运行元信息（状态 / 耗时 / usage / 错误），下面是原始事件日志
 * （RunEventLog：一行一事件 + 展开完整 JSON）。输出与原始 JSON 留在页尾的
 * 折叠区，默认不占视线。
 *
 * 为什么是子页面而不是弹窗：日志要能复制、搜索、新窗口打开、贴给别人回看，
 * 深链路由此唯一确定；弹窗层还会把「复制 / 新窗口」变成两次点击。
 */

import { PageScaffold } from '@vessel-agent/plugin-ui';
import { formatRoute } from '../../app/router';
import { CopyButton } from '../../components/CopyButton';
import { JsonView } from '../../components/JsonView';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Button, KeyValueList, Section } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { DurableRunSummary, RunStatus } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { isCancellableRun, isResumableRun } from '../../state/runs';
import { PluginPanels } from '../plugins/PluginPanels';
import { RunEventLog } from './RunEventLog';
import { durationLabel, exportJson } from './run-detail-format';
import { useRunTrace } from './useRunTrace';

export function RunDetailPage({
  runId,
  tab,
  run,
  durable,
  active,
  canWrite,
  connected,
  loading,
  missing,
  detailError,
  busy = false,
  onBack,
  onCancel,
  onResume,
  onRetry,
}: {
  /** 路由里的 id：live 为引擎 run id，durable 为 checkpoint id。 */
  runId: string;
  tab: 'live' | 'durable';
  run: RunStatus | null;
  durable: DurableRunSummary | null;
  active: boolean;
  canWrite: boolean;
  connected: boolean;
  /** 详情还没到、也没有列表摘要可代打。 */
  loading: boolean;
  /** 详情取不到（run 不存在或读取失败）。 */
  missing: boolean;
  detailError: string | null;
  busy?: boolean;
  /** 回列表：不依赖 history，固定落到同 tab 的运行列表。 */
  onBack: () => void;
  onCancel: (runId: string) => void;
  onResume: (runId: string) => void;
  onRetry: () => void;
}) {
  useLocale();
  const runTrace = useRunTrace(runId, tab, run, durable, active);
  const { coreRunId } = runTrace;

  const status = run?.status ?? durable?.status;
  const sessionId = run?.session_id ?? durable?.session_id;
  const startedAt = run?.started_at;
  const completedAt = run?.completed_at;
  const usage = run?.usage;
  const raw = run ?? durable;
  const cancellable = tab === 'live' && status !== undefined && isCancellableRun(status);
  const resumable = tab === 'durable' && status !== undefined && isResumableRun(status);
  const lastCheckpointMessage =
    run?.messages && run.messages.length > 0
      ? run.messages[run.messages.length - 1]?.content
      : undefined;
  const output = run?.output;
  const checkpointText = durable?.preview ?? lastCheckpointMessage;

  return (
    <PageScaffold title={t('runs.detail.title')} subtitle={t('runs.detailPage.subtitle')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="small" onClick={onBack}>
          {t('runs.detailPage.back')}
        </Button>
        <StatusChip status={status} />
        <span className="min-w-0 wrap-anywhere font-mono text-muted" title={runId}>
          {runId}
        </span>
        <CopyButton
          text={runId}
          label={t('runs.detail.copyId')}
          toast={t('runs.detail.copiedId')}
        />
        {raw !== null && (
          <Button size="small" onClick={() => exportJson(raw, runId)}>
            {t('runs.detail.exportJson')}
          </Button>
        )}
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

      {!connected && <StaleNotice message={t('runs.detail.disconnected')} onRetry={onRetry} />}

      {missing ? (
        <ErrorState message={detailError ?? t('runs.notFound')} onRetry={onRetry} />
      ) : loading && raw === null ? (
        <LoadingState label={t('runs.detailLoading')} />
      ) : (
        <>
          <Section title={t('runs.detail.metaTitle')}>
            <KeyValueList
              items={[
                {
                  key: 'session',
                  label: t('runs.detail.session'),
                  value: sessionId ? (
                    <a
                      className="font-mono text-accent underline underline-offset-2 hover:text-accent-ink"
                      href={formatRoute({ domain: 'chat', sessionId })}
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
                  value: (
                    <span className="font-mono tabular-nums">{formatTimestamp(startedAt)}</span>
                  ),
                },
                {
                  key: 'ended',
                  label: t('runs.detail.ended'),
                  value: (
                    <span className="font-mono tabular-nums">{formatTimestamp(completedAt)}</span>
                  ),
                },
                {
                  key: 'duration',
                  label: t('runs.detail.duration'),
                  value: (
                    <span className="font-mono tabular-nums">
                      {durationLabel(
                        startedAt,
                        completedAt,
                        status === 'running' || status === 'queued',
                      )}
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
                        value: (
                          <span className="font-mono">{run?.agent_id ?? durable?.agent_id}</span>
                        ),
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
            {run?.error !== undefined && run.error.length > 0 && (
              <>
                <h3 className="mt-3 text-md font-semibold text-danger">
                  {t('runs.detail.errorTitle')}
                </h3>
                <pre className="run-output text-danger">{run.error}</pre>
              </>
            )}
          </Section>

          <Section title={t('runs.log.title')} description={t('runs.log.hint')}>
            <RunEventLog trace={runTrace} tab={tab} coreRunId={coreRunId} />
          </Section>

          <details className="json-view">
            <summary>{t('runs.detail.outputTitle')}</summary>
            {output !== undefined && output.length > 0 ? (
              <pre className="json-body">{output}</pre>
            ) : checkpointText !== undefined && checkpointText.length > 0 ? (
              <div className="px-3 py-2">
                <span className="font-mono text-2xs text-faint uppercase">
                  {t('runs.detail.checkpointPreview')}
                </span>
                <pre className="json-body mt-1 rounded-sm bg-deep">{checkpointText}</pre>
              </div>
            ) : (
              <div className="px-3 py-2">
                <EmptyState
                  title={t('runs.detail.emptyOutputTitle')}
                  description={t('runs.detail.emptyOutputDesc')}
                />
              </div>
            )}
          </details>

          {raw !== null && (
            <JsonView value={raw} label={t('runs.detail.rawLabel')} maxHeight={520} />
          )}

          <PluginPanels
            slot="run-detail"
            context={{ run: runId, session: sessionId }}
            className="mt-1"
          />
        </>
      )}
    </PageScaffold>
  );
}
