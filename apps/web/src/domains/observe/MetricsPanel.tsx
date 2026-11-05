import { useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { SegmentedTabs } from '../../components/Tabs';
import { Button, Stat } from '../../components/ui';
import { formatTimestamp } from '../../format';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { cacheStatTexts } from './cache-metrics';

export function MetricsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('metrics');
  const [source, setSource] = useState<'live' | 'trace'>('live');

  const resource = useResource({
    load: () => client.getMetricsSnapshot(source),
    enabled: available,
    pollMs: 10_000,
    deps: [epoch, source],
  });
  const data = resourceData(resource.state);
  const metrics = data?.metrics;
  useRefreshSignal(resource.reload);

  // CONTRACT-0.29 §2.2：比率是展示层派生量，不进 wire。
  const cache = useMemo(() => (metrics ? cacheStatTexts(metrics.llm) : undefined), [metrics]);
  // 本进程还没有 LLM 响应时，缓存统计没有意义：两张卡片整体不显示，
  // 避免把「还没请求过」误读成「provider 不支持缓存」。
  const hasLlmResponses = metrics !== undefined && metrics.llm.requests > 0;
  // 有响应但全部事件都没有缓存字段 → 「不可用」，绝不渲染 0%。
  // 单侧缺失时该侧画 `—`（`cacheStatTexts` 已处理），不在这里兜底成 0。
  const cacheHint = cache?.available
    ? t('observe.metrics.stat.cacheHint', {
        read: cache.cacheReadText,
        write: cache.cacheCreationText,
        prompt: cache.promptTokensText,
      })
    : t('observe.metrics.stat.cacheNoFieldsHint');

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('common.notConnected')}
        reason={t('observe.metrics.noTokenReason')}
      />
    );
  }
  if (!features.includes('metrics')) {
    return (
      <NotEnabledState
        title={t('observe.metrics.disabledTitle')}
        reason={t('observe.metrics.disabledReason')}
        hint={t('observe.metrics.disabledHint')}
      />
    );
  }
  if (source === 'trace' && resource.state.status === 'error') {
    return (
      <NotEnabledState
        title={t('observe.metrics.traceDisabledTitle')}
        reason={resource.state.error}
        hint={t('observe.metrics.traceDisabledHint')}
        action={
          <Button onClick={() => setSource('live')}>{t('observe.metrics.switchLive')}</Button>
        }
      />
    );
  }

  const error = resource.state.status === 'error' ? resource.state.error : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <SegmentedTabs
          label={t('observe.metrics.sourceLabel')}
          tabs={[
            { id: 'live', label: t('observe.metrics.source.live') },
            { id: 'trace', label: t('observe.metrics.source.trace') },
          ]}
          value={source}
          onChange={setSource}
          panelId="metrics-source-panel"
        />
        <Button size="small" onClick={resource.reload}>
          {t('observe.metrics.refresh')}
        </Button>
      </div>

      <div id="metrics-source-panel" role="tabpanel" aria-label={t('observe.metrics.panelLabel')}>
        {!connected && metrics && (
          <StaleNotice message={t('observe.metrics.stale')} onRetry={resource.reload} />
        )}
        {error && metrics && (
          <StaleNotice
            message={t('common.staleData', { detail: error })}
            onRetry={resource.reload}
          />
        )}
        {!metrics ? (
          error ? (
            <ErrorState message={error} onRetry={resource.reload} />
          ) : (
            <LoadingState label={t('observe.metrics.loading')} />
          )
        ) : (
          <>
            <div className="my-3 flex flex-wrap gap-2.5">
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.started}
                label={t('observe.metrics.stat.runsStarted')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.completed}
                label={t('observe.metrics.stat.completed')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.failed}
                label={t('observe.metrics.stat.failed')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.runs.cancelled}
                label={t('observe.metrics.stat.cancelled')}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.tool_calls.total}
                label={t('observe.metrics.stat.toolCalls', { failed: metrics.tool_calls.failed })}
              />
              <Stat
                className="min-w-40 flex-1"
                value={metrics.llm.total_tokens}
                label={t('observe.metrics.stat.tokens', {
                  prompt: metrics.llm.prompt_tokens,
                  completion: metrics.llm.completion_tokens,
                })}
              />
              {hasLlmResponses && (
                <>
                  <Stat
                    className="min-w-40 flex-1"
                    value={cache?.inputShareText ?? t('observe.metrics.stat.cacheUnavailable')}
                    label={t('observe.metrics.stat.cacheInputShare')}
                    hint={cacheHint}
                  />
                  <Stat
                    className="min-w-40 flex-1"
                    value={cache?.prefixHealthText ?? t('observe.metrics.stat.cacheUnavailable')}
                    label={t('observe.metrics.stat.cachePrefixHealth')}
                    hint={cacheHint}
                  />
                </>
              )}
              <Stat
                className="min-w-40 flex-1"
                value={`${Math.round(metrics.duration_ms.avg)}ms`}
                label={t('observe.metrics.stat.avgDuration', {
                  max: Math.round(metrics.duration_ms.max),
                })}
              />
              <Stat
                className="min-w-40 flex-1"
                value={formatTimestamp(metrics.updated_at)}
                label={t('observe.metrics.stat.updatedAt')}
              />
            </div>
            <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
              {t('observe.metrics.sourceDesc', {
                source:
                  data?.source === 'trace'
                    ? t('observe.metrics.source.trace')
                    : t('observe.metrics.source.live'),
              })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
