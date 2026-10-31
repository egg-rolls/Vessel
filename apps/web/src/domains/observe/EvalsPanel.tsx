import { useEffect, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NotEnabledState,
  StaleNotice,
} from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, Input } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { EvalReport } from '../../gateway/types';
import { t } from '../../i18n';
import { resourceData, useResource } from '../../state/useResource';
import { EvalReportView } from './EvalReportView';
import { errorMessage } from './errors';

const EVAL_SUITES_KEY = 'vessel.eval-suites';
const EVAL_CASE_PAGE = 100;

function readSuites(): string[] {
  try {
    const raw = localStorage.getItem(EVAL_SUITES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function EvalsPanel() {
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const toast = useToast();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('evals');
  const [suite, setSuite] = useState('smoke');
  const [requested, setRequested] = useState(0);
  const [runReport, setRunReport] = useState<EvalReport | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [suites, setSuites] = useState<string[]>(readSuites);
  const [caseLimit, setCaseLimit] = useState(EVAL_CASE_PAGE);
  const [caseFilter, setCaseFilter] = useState<'all' | 'failed'>('all');

  const latest = useResource({
    load: () => client.getLatestEval(suite),
    enabled: available && requested > 0,
    deps: [epoch, suite, requested],
  });
  useRefreshSignal(latest.reload);
  // suite 切换后旧响应仍可能留在 resource 里：只接受当前 suite 的报告。
  const latestData = resourceData(latest.state);
  const latestReport = latestData && latestData.suite === suite ? latestData : undefined;
  const report = runReport ?? latestReport ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: suite 变化时清空上一次报告
  useEffect(() => {
    setRunReport(null);
    setRunError(null);
    setCaseLimit(EVAL_CASE_PAGE);
    setCaseFilter('all');
  }, [suite, requested]);

  const rememberSuite = (value: string) => {
    const next = [value, ...suites.filter((item) => item !== value)].slice(0, 8);
    setSuites(next);
    try {
      localStorage.setItem(EVAL_SUITES_KEY, JSON.stringify(next));
    } catch {
      // 最近使用存不下不影响评测。
    }
  };

  if (!hasToken) {
    return (
      <NotEnabledState title={t('common.notConnected')} reason={t('observe.evals.noTokenReason')} />
    );
  }
  if (!features.includes('evals')) {
    return (
      <NotEnabledState
        title={t('observe.evals.disabledTitle')}
        reason={t('observe.evals.disabledReason')}
        hint={t('observe.evals.disabledHint')}
      />
    );
  }

  const loadLatest = () => {
    setRunReport(null);
    setRunError(null);
    rememberSuite(suite);
    setRequested((value) => value + 1);
  };

  const run = async () => {
    if (!connected) {
      toast.error(t('observe.evals.disconnectedRun'));
      return;
    }
    setRunBusy(true);
    setRunError(null);
    try {
      const result = await client.runEval(suite);
      setRunReport(result);
      rememberSuite(suite);
      toast.success(t('observe.evals.completed', { suite: result.suite }));
    } catch (error) {
      setRunError(errorMessage(error));
    } finally {
      setRunBusy(false);
    }
  };

  const notFound =
    latest.state.status === 'error' &&
    (latest.state.error.includes('not_found') ||
      latest.state.error.includes('eval_not_found') ||
      latest.state.error.includes('Eval report not found'));
  const latestError = latest.state.status === 'error' ? latest.state.error : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.evals.intro')}
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Input
          className="grow basis-60 max-w-search"
          value={suite}
          onChange={(event) => setSuite(event.target.value)}
          placeholder={t('observe.evals.suitePlaceholder')}
          aria-label={t('observe.evals.suiteLabel')}
          list="eval-suites"
          spellCheck={false}
        />
        <datalist id="eval-suites">
          {suites.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <Button
          size="small"
          onClick={loadLatest}
          disabled={!suite.trim() || latest.state.status === 'loading'}
        >
          {t('observe.evals.loadLatest')}
        </Button>
        <Button
          size="small"
          variant="primary"
          onClick={() => void run()}
          disabled={!connected || !suite.trim() || runBusy}
          title={!connected ? t('common.writesDisabled') : undefined}
        >
          {runBusy ? t('observe.evals.running') : t('observe.evals.run')}
        </Button>
      </div>
      {suites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted">{t('observe.evals.recent')}</span>
          {suites.map((item) => (
            <Button
              key={item}
              variant="chip"
              size="small"
              aria-pressed={item === suite}
              onClick={() => setSuite(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      )}

      {runError && (
        <ErrorState
          message={runError}
          onRetry={() => void run()}
          retryLabel={t('observe.evals.retry')}
        />
      )}
      {!connected && report && <StaleNotice message={t('observe.evals.disconnectedReport')} />}
      {!runReport && notFound && (
        <NotEnabledState
          title={t('observe.evals.notFoundTitle')}
          reason={latestError ?? undefined}
          hint={t('observe.evals.notFoundHint')}
        />
      )}
      {!runReport && !notFound && latestError && (
        <ErrorState message={latestError} onRetry={latest.reload} />
      )}
      {!report && !runError && !notFound ? (
        latest.state.status === 'loading' ? (
          <LoadingState label={t('observe.evals.loadingReport')} />
        ) : (
          <EmptyState
            title={t('observe.evals.emptyTitle')}
            description={t('observe.evals.emptyDesc')}
          />
        )
      ) : report ? (
        <EvalReportView
          report={report}
          caseLimit={caseLimit}
          caseFilter={caseFilter}
          onCaseFilter={setCaseFilter}
          onShowMore={() => setCaseLimit((value) => value + EVAL_CASE_PAGE)}
        />
      ) : null}
    </div>
  );
}
