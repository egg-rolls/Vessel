import { useMemo } from 'react';
import { EmptyState } from '../../components/States';
import { StatusChip } from '../../components/StatusChip';
import { Badge, Button, DataTable, Section, Stat } from '../../components/ui';
import { formatTimestamp } from '../../format';
import type { EvalCaseResult, EvalReport } from '../../gateway/types';
import { t } from '../../i18n';

export function EvalReportView({
  report,
  caseLimit,
  caseFilter,
  onCaseFilter,
  onShowMore,
}: {
  report: EvalReport;
  caseLimit: number;
  caseFilter: 'all' | 'failed';
  onCaseFilter: (value: 'all' | 'failed') => void;
  onShowMore: () => void;
}) {
  const filteredCases = useMemo(
    () =>
      caseFilter === 'failed'
        ? report.cases.filter((item) => item.status === 'failed' || item.status === 'error')
        : report.cases,
    [report.cases, caseFilter],
  );
  const cases = filteredCases.slice(0, caseLimit);

  return (
    <>
      <div className="my-3 flex flex-wrap gap-2.5">
        <Stat
          className="min-w-40 flex-1"
          value={report.total}
          label={t('observe.evals.stat.total')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.passed}
          label={t('observe.evals.stat.passed')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.failed}
          label={t('observe.evals.stat.failed')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.errors}
          label={t('observe.evals.stat.errors')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.skipped}
          label={t('observe.evals.stat.skipped')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={`${report.duration_ms}ms`}
          label={t('observe.evals.stat.duration')}
        />
        <Stat
          className="min-w-40 flex-1"
          value={report.network ? 'on' : 'off'}
          label={t('observe.evals.stat.network')}
        />
      </div>
      <p className="mt-1.5 max-w-prose text-md leading-relaxed text-muted">
        {t('observe.evals.generatedAt', {
          time: formatTimestamp(report.finished_at),
          network: report.network ? t('observe.evals.networkOn') : t('observe.evals.offline'),
        })}
      </p>

      <Section
        title={t('observe.evals.casesTitle')}
        actions={
          <>
            <Button
              variant="chip"
              size="small"
              aria-pressed={caseFilter === 'failed'}
              onClick={() => onCaseFilter(caseFilter === 'failed' ? 'all' : 'failed')}
            >
              {t('observe.evals.failedOnly')}
            </Button>
            <Badge>
              {filteredCases.length}/{report.cases.length}
            </Badge>
          </>
        }
      >
        {filteredCases.length === 0 ? (
          <EmptyState
            title={t(
              caseFilter === 'failed' ? 'observe.evals.emptyFailed' : 'observe.evals.emptyCases',
            )}
          />
        ) : (
          <DataTable<EvalCaseResult>
            columns={[
              {
                key: 'status',
                header: t('observe.evals.col.status'),
                cell: (item) => <StatusChip status={item.status} />,
              },
              {
                key: 'case',
                header: t('observe.evals.col.case'),
                cellClassName: 'font-mono',
                cell: (item) => item.id,
              },
              {
                key: 'duration',
                header: t('observe.evals.col.duration'),
                hide: 'wide',
                cellClassName: 'font-mono tabular-nums',
                cell: (item) => `${item.duration_ms}ms`,
              },
              {
                key: 'assertions',
                header: t('observe.evals.col.assertions'),
                hide: 'wide',
                cellClassName: 'font-mono tabular-nums',
                cell: (item) =>
                  `${item.assertions.filter((assertion) => assertion.ok).length}/${item.assertions.length}`,
              },
              {
                key: 'output',
                header: t('observe.evals.col.output'),
                cell: (item) => (
                  <>
                    {item.error ? (
                      <span className="text-danger">{item.error}</span>
                    ) : (
                      <span className="text-muted">{item.output ?? '—'}</span>
                    )}
                    {item.assertions.length > 0 && (
                      <details className="mt-1" open={item.status === 'failed'}>
                        <summary className="cursor-pointer font-mono text-xs text-muted">
                          {t('observe.evals.assertions')}
                        </summary>
                        <ul className="plain-list">
                          {item.assertions.map((assertion, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 断言顺序稳定
                            <li key={`${assertion.type}-${index}`}>
                              <span className={assertion.ok ? 'text-success' : 'text-danger'}>
                                {assertion.ok ? '✓' : '✗'} {assertion.type}
                              </span>
                              {assertion.detail && (
                                <span className="text-muted"> — {assertion.detail}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ),
              },
            ]}
            rows={cases}
            rowKey={(item) => item.id}
          />
        )}
        {cases.length < filteredCases.length && (
          <Button
            variant="plain"
            className="mx-auto mt-2 rounded-full px-3.5 py-2 text-xs text-muted"
            onClick={onShowMore}
          >
            {t('observe.evals.showMore', { count: filteredCases.length - cases.length })}
          </Button>
        )}
      </Section>
    </>
  );
}
