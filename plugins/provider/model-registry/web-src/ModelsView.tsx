import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  PageScaffold,
  Section,
  Select,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useState } from 'react';
import { ModelForm } from './ModelForm';
import {
  ConfirmDelete,
  EmptyState,
  ErrorState,
  LoadingState,
  type LoadState,
  type Notice,
  NoticeLine,
  toError,
  type ViewProps,
} from './shared';
import type { ListResult, ModelEntryDto, ModelSetEntry, TestResult } from './types';

/**
 * 模型面（两面重构 §9.1，替换 VendorsView）：扁平条目列表 + 默认模型 + 迁移报告。
 * 行操作 = 编辑 / 测试 / 删除；别称是条目字段（随 model_set 写入，无独立 RPC）。
 * legacy provider.* 合成条目只读显示。test 发真实请求（用户触发，成本提示先给）。
 */
export function ModelsView({ client, refreshKey, t }: ViewProps) {
  const [state, setState] = useState<LoadState<ListResult>>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ mode: 'add' } | { mode: 'edit'; entry: ModelEntryDto } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [defaultRef, setDefaultRef] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; result: TestResult } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await client.call<ListResult>('list');
      setState({ status: 'ready', data });
      setDefaultRef(data.default ?? '');
    } catch (error) {
      setState({ status: 'error', error: toError(error) });
    }
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an explicit refetch trigger.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function runWrite(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice({ kind: 'saved' });
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: toError(error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveModel(id: string, entry: ModelSetEntry): Promise<void> {
    const ok = await runWrite(() => client.call('model_set', { id, entry }));
    if (ok) setForm(null);
  }

  async function removeModel(id: string): Promise<void> {
    const ok = await runWrite(() => client.call('model_remove', { id }));
    if (ok) setConfirmDelete(null);
  }

  async function saveDefault(): Promise<void> {
    if (defaultRef === '') return;
    await runWrite(() => client.call('default_set', { ref: defaultRef }));
  }

  async function testEntry(id: string): Promise<void> {
    setTesting(id);
    setTestResult(null);
    setNotice(null);
    try {
      const result = await client.call<TestResult>('test', { entry: id });
      setTestResult({ id, result });
    } catch (error) {
      setNotice({ kind: 'error', text: toError(error).message });
    } finally {
      setTesting(null);
    }
  }

  if (state.status === 'loading') {
    return (
      <PageScaffold title={t('models.title')} subtitle={t('models.subtitle')}>
        <LoadingState label={t('common.loading')} />
      </PageScaffold>
    );
  }
  if (state.status === 'error') {
    return (
      <PageScaffold title={t('models.title')} subtitle={t('models.subtitle')}>
        <ErrorState
          error={state.error}
          onRetry={() => void load()}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      </PageScaffold>
    );
  }

  const { entries, credentials, effective, migration } = state.data;
  const refOptions = [
    ...entries.filter((entry) => !entry.legacy).map((entry) => entry.id),
    ...entries.flatMap((entry) => (entry.alias !== undefined ? [entry.alias] : [])),
  ];

  const columns: readonly DataTableColumn<ModelEntryDto>[] = [
    {
      key: 'id',
      header: t('models.th.id'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono text-xs">{row.id}</span>
          {row.inUse ? <Badge tone="accent">{t('models.inUse')}</Badge> : null}
          {row.legacy ? <Badge tone="neutral">legacy</Badge> : null}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('models.th.name'),
      cell: (row) => <span className="font-mono text-xs wrap-anywhere">{row.name}</span>,
    },
    {
      key: 'alias',
      header: t('models.th.alias'),
      hide: 'compact',
      cell: (row) =>
        row.alias !== undefined ? (
          <span className="font-mono text-xs">{row.alias}</span>
        ) : (
          <span className="text-xs text-faint">—</span>
        ),
    },
    {
      key: 'provider',
      header: t('models.th.provider'),
      cell: (row) => (
        <span className="text-xs">
          {row.provider}
          <span className="text-faint"> · {row.mode}</span>
        </span>
      ),
    },
    {
      key: 'credential',
      header: t('models.th.credential'),
      cell: (row) => <span className="font-mono text-xs">{row.credential ?? '—'}</span>,
    },
    {
      key: 'pricing',
      header: t('models.th.pricing'),
      hide: 'compact',
      cell: (row) =>
        row.pricing !== undefined ? (
          <span className="font-mono text-xs">
            {row.pricing.inputPerMillion} / {row.pricing.outputPerMillion}
          </span>
        ) : (
          <span className="text-xs text-faint">—</span>
        ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cell: (row) =>
        confirmDelete === row.id ? (
          <ConfirmDelete
            question={t('models.deleteConfirm', { id: row.id })}
            busy={busy}
            t={t}
            onConfirm={() => void removeModel(row.id)}
            onCancel={() => setConfirmDelete(null)}
          />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Button
              size="small"
              disabled={busy || row.legacy}
              title={row.legacy ? t('models.legacyHint') : undefined}
              onClick={() => setForm({ mode: 'edit', entry: row })}
            >
              {t('common.edit')}
            </Button>
            <Button
              size="small"
              disabled={busy || testing !== null}
              onClick={() => void testEntry(row.id)}
            >
              {testing === row.id ? t('models.testRunning') : t('models.test')}
            </Button>
            <Button
              size="small"
              variant="dangerGhost"
              disabled={busy || row.legacy}
              onClick={() => setConfirmDelete(row.id)}
            >
              {t('common.delete')}
            </Button>
          </span>
        ),
    },
  ];

  return (
    <PageScaffold title={t('models.title')} subtitle={t('models.subtitle')}>
      <NoticeLine notice={notice} t={t} />

      {form !== null ? (
        <ModelForm
          initial={form.mode === 'edit' ? form.entry : undefined}
          credentials={credentials}
          busy={busy}
          t={t}
          onSave={(id, entry) => void saveModel(id, entry)}
          onCancel={() => setForm(null)}
        />
      ) : null}

      {testResult !== null ? (
        <Section title={t('models.testResult')}>
          <p className="text-sm">
            <span className="font-mono text-xs">{testResult.id}</span>{' '}
            {testResult.result.ok ? (
              <Badge tone="success">{t('models.testOk')}</Badge>
            ) : (
              <Badge tone="danger">{t('models.testFailed')}</Badge>
            )}{' '}
            <span className="text-xs text-muted">
              {t('models.latency', { ms: testResult.result.latencyMs })}
            </span>
          </p>
          {testResult.result.error !== undefined ? (
            <p className="text-sm text-danger wrap-anywhere">
              {testResult.result.error.code}: {testResult.result.error.message}
            </p>
          ) : null}
          {testResult.result.models !== undefined ? (
            <p className="text-xs text-muted">
              {t('models.testModels', { n: testResult.result.models.length })}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title={t('default.title')} description={t('default.description')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('default.ref')}>
            <Select
              value={defaultRef}
              onChange={(event) => setDefaultRef(event.target.value)}
              disabled={busy}
            >
              <option value="">{t('default.choose')}</option>
              {refOptions.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={busy || defaultRef === ''}
            onClick={() => void saveDefault()}
          >
            {t('default.save')}
          </Button>
          <span className="text-sm text-muted">
            {t('default.current')}:{' '}
            {effective !== undefined ? (
              <span className="font-mono text-xs">
                {effective.entryId} ({effective.wireModel})
              </span>
            ) : (
              t('default.none')
            )}
          </span>
        </div>
      </Section>

      {migration !== undefined ? (
        <Section title={t('models.migration.title')}>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            <li>{t('models.migration.split', { n: migration.credentialsSplit.length })}</li>
            {migration.needsReRecord.length > 0 ? (
              <li className="text-danger">
                {t('models.migration.reRecord', { ids: migration.needsReRecord.join(', ') })}
              </li>
            ) : null}
            {migration.droppedAliases.length > 0 ? (
              <li>
                {t('models.migration.droppedAliases', {
                  ids: migration.droppedAliases.map((a) => a.alias).join(', '),
                })}
              </li>
            ) : null}
            {migration.unmatchedPricing.length > 0 ? (
              <li>
                {t('models.migration.unmatchedPricing', {
                  ids: migration.unmatchedPricing.join(', '),
                })}
              </li>
            ) : null}
            <li>{t('models.migration.pins', { n: migration.pinsRewritten.length })}</li>
            {migration.pinsFailed.length > 0 ? (
              <li className="text-danger">
                {t('models.migration.pinsFailed', { ids: migration.pinsFailed.join(', ') })}
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      <Section
        title={t('models.section')}
        actions={
          <span className="inline-flex items-center gap-1.5">
            <Button size="small" disabled={busy} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={busy}
              onClick={() => setForm({ mode: 'add' })}
            >
              {t('models.add')}
            </Button>
          </span>
        }
      >
        <p className="mb-2 text-xs text-faint">{t('models.testHint')}</p>
        {entries.length === 0 ? (
          <EmptyState title={t('models.empty.title')} description={t('models.empty.description')} />
        ) : (
          <div className="overflow-hidden rounded-md">
            <DataTable columns={columns} rows={entries} rowKey={(row) => row.id} />
          </div>
        )}
      </Section>
    </PageScaffold>
  );
}
