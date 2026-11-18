import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  Input,
  PageScaffold,
  Section,
  Select,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useState } from 'react';
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
import { isLegacyVendor, type ListResult, type TestResult, type VendorDto } from './types';
import { VendorForm } from './VendorForm';

/** 测试面板状态：RPC 层错误（unknown_vendor / no_credential 等）与连通性结果分开。 */
type TestState = { vendorId: string; result: TestResult } | { vendorId: string; error: string };

interface RefOption {
  value: string;
  label: string;
}

/** 全部 vendor/model ref（含 legacy 合成条目）；别名目标只能用这些（不允许别名→别名）。 */
function vendorModelRefs(data: ListResult): RefOption[] {
  return data.vendors.flatMap((vendor) =>
    Object.keys(vendor.models).map((model) => {
      const ref = `${vendor.id}/${model}`;
      return { value: ref, label: ref };
    }),
  );
}

/** 默认 ref 候选 = 别名 + vendor/model；悬空当前值补一项以便显示与修复。 */
function defaultRefOptions(data: ListResult, current: string): RefOption[] {
  const options: RefOption[] = [
    ...Object.entries(data.aliases).map(([alias, target]) => ({
      value: alias,
      label: `${alias} → ${target}`,
    })),
    ...vendorModelRefs(data),
  ];
  if (current !== '' && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

export function VendorsView({ client, refreshKey, t }: ViewProps) {
  const [state, setState] = useState<LoadState<ListResult>>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ vendor: VendorDto | null; importModels?: string[] } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  const [aliasForm, setAliasForm] = useState<{
    alias: string;
    ref: string;
    editing: boolean;
  } | null>(null);
  const [confirmDeleteAlias, setConfirmDeleteAlias] = useState<string | null>(null);
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await client.call<ListResult>('list');
      setState({ status: 'ready', data });
    } catch (error) {
      setState({ status: 'error', error: toError(error) });
    }
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an explicit refetch trigger.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** 写路径统一口径：写 → 读回快照 → 生效文案；失败保留现场并展示错误原文。 */
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

  async function runTest(vendorId: string): Promise<void> {
    setTesting(vendorId);
    setTest(null);
    setNotice(null);
    try {
      const result = await client.call<TestResult>('test', { vendor: vendorId });
      setTest({ vendorId, result });
    } catch (error) {
      setTest({ vendorId, error: toError(error).message });
    } finally {
      setTesting(null);
    }
  }

  async function removeVendor(id: string): Promise<void> {
    const ok = await runWrite(() => client.call('vendor_remove', { id }));
    if (ok) setConfirmDelete(null);
  }

  async function saveDefault(ref: string): Promise<void> {
    if (ref === '') return;
    const ok = await runWrite(() => client.call('default_set', { ref }));
    if (ok) setDefaultChoice(null);
  }

  async function saveAlias(): Promise<void> {
    if (aliasForm === null) return;
    const alias = aliasForm.alias.trim();
    if (alias === '') {
      setNotice({ kind: 'error', text: t('aliases.needAlias') });
      return;
    }
    if (alias.includes('/')) {
      setNotice({ kind: 'error', text: t('aliases.noSlash') });
      return;
    }
    if (aliasForm.ref === '') {
      setNotice({ kind: 'error', text: t('aliases.needRef') });
      return;
    }
    const ok = await runWrite(() => client.call('alias_set', { alias, ref: aliasForm.ref }));
    if (ok) setAliasForm(null);
  }

  async function removeAlias(alias: string): Promise<void> {
    const ok = await runWrite(() => client.call('alias_remove', { alias }));
    if (ok) setConfirmDeleteAlias(null);
  }

  function importModelsIntoForm(vendorId: string, models: readonly string[]): void {
    if (state.status !== 'ready') return;
    const vendor = state.data.vendors.find((item) => item.id === vendorId);
    if (vendor === undefined || isLegacyVendor(vendorId)) return;
    setForm({ vendor, importModels: [...models] });
  }

  if (state.status === 'loading') {
    return (
      <PageScaffold title={t('vendors.title')} subtitle={t('vendors.subtitle')}>
        <LoadingState label={t('common.loading')} />
      </PageScaffold>
    );
  }
  if (state.status === 'error') {
    return (
      <PageScaffold title={t('vendors.title')} subtitle={t('vendors.subtitle')}>
        <ErrorState
          error={state.error}
          onRetry={() => void load()}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      </PageScaffold>
    );
  }

  const data = state.data;
  const testResult = test !== null && 'result' in test ? test.result : undefined;
  const testError = test !== null && 'error' in test ? test.error : undefined;
  const testModels = testResult?.models;
  const modelRefs = vendorModelRefs(data);
  const currentDefault = defaultChoice ?? data.default ?? '';
  const aliasRefOptions =
    aliasForm !== null &&
    aliasForm.ref !== '' &&
    !modelRefs.some((option) => option.value === aliasForm.ref)
      ? [{ value: aliasForm.ref, label: aliasForm.ref }, ...modelRefs]
      : modelRefs;

  const vendorColumns: readonly DataTableColumn<VendorDto>[] = [
    {
      key: 'id',
      header: t('vendors.th.id'),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs">
          {row.id}
          {isLegacyVendor(row.id) ? (
            <Badge tone="info" title={t('vendors.legacyHint')}>
              legacy
            </Badge>
          ) : null}
          {row.inUse ? <Badge tone="accent">{t('vendors.inUse')}</Badge> : null}
        </span>
      ),
    },
    { key: 'protocol', header: t('vendors.th.protocol'), cell: (row) => row.protocol },
    {
      key: 'baseUrl',
      header: t('vendors.th.baseUrl'),
      hide: 'compact',
      cell: (row) => <span className="font-mono text-xs">{row.baseUrl ?? '—'}</span>,
    },
    {
      key: 'credential',
      header: t('vendors.th.credential'),
      cell: (row) => <span className="font-mono text-xs">{row.credentialRef ?? '—'}</span>,
    },
    {
      key: 'models',
      header: t('vendors.th.models'),
      cell: (row) => t('vendors.modelCount', { n: Object.keys(row.models).length }),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cell: (row) =>
        confirmDelete === row.id ? (
          <ConfirmDelete
            question={t('vendors.deleteConfirm', { id: row.id })}
            busy={busy}
            t={t}
            onConfirm={() => void removeVendor(row.id)}
            onCancel={() => setConfirmDelete(null)}
          />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {!isLegacyVendor(row.id) ? (
              <Button size="small" disabled={busy} onClick={() => setForm({ vendor: row })}>
                {t('common.edit')}
              </Button>
            ) : null}
            <Button
              size="small"
              disabled={busy || testing !== null}
              onClick={() => void runTest(row.id)}
            >
              {testing === row.id ? t('vendors.testRunning') : t('vendors.test')}
            </Button>
            {!isLegacyVendor(row.id) ? (
              <Button
                size="small"
                variant="dangerGhost"
                disabled={busy}
                onClick={() => setConfirmDelete(row.id)}
              >
                {t('common.delete')}
              </Button>
            ) : null}
          </span>
        ),
    },
  ];

  const aliasRows = Object.entries(data.aliases).map(([alias, ref]) => ({ alias, ref }));
  const aliasColumns: readonly DataTableColumn<{ alias: string; ref: string }>[] = [
    {
      key: 'alias',
      header: t('aliases.th.alias'),
      cell: (row) => <span className="font-mono text-xs">{row.alias}</span>,
    },
    {
      key: 'ref',
      header: t('aliases.th.ref'),
      cell: (row) => <span className="font-mono text-xs">{row.ref}</span>,
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cell: (row) =>
        confirmDeleteAlias === row.alias ? (
          <ConfirmDelete
            question={t('aliases.deleteConfirm', { alias: row.alias })}
            busy={busy}
            t={t}
            onConfirm={() => void removeAlias(row.alias)}
            onCancel={() => setConfirmDeleteAlias(null)}
          />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Button
              size="small"
              disabled={busy}
              onClick={() => setAliasForm({ alias: row.alias, ref: row.ref, editing: true })}
            >
              {t('common.edit')}
            </Button>
            <Button
              size="small"
              variant="dangerGhost"
              disabled={busy}
              onClick={() => setConfirmDeleteAlias(row.alias)}
            >
              {t('common.delete')}
            </Button>
          </span>
        ),
    },
  ];

  return (
    <PageScaffold title={t('vendors.title')} subtitle={t('vendors.subtitle')}>
      <NoticeLine notice={notice} t={t} />

      <Section title={t('default.title')} description={t('default.description')}>
        <div className="flex flex-col gap-2.5">
          <p className="text-sm text-muted">
            {t('default.current')}:{' '}
            <span className="font-mono text-ink">
              {data.effective !== undefined
                ? `${data.effective.vendorId}/${data.effective.wireModel}`
                : t('default.none')}
            </span>
          </p>
          {data.legacy.present ? (
            <p className="text-xs text-faint">
              {t('default.legacy')}: <span className="font-mono">{data.legacy.ref ?? '—'}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2.5">
            <Field label={t('default.ref')} className="min-w-64 flex-1">
              <Select
                value={currentDefault}
                onChange={(event) => setDefaultChoice(event.target.value)}
                disabled={busy}
              >
                <option value="">{t('default.choose')}</option>
                {defaultRefOptions(data, currentDefault).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="primary"
              disabled={busy || currentDefault === ''}
              onClick={() => void saveDefault(currentDefault)}
            >
              {t('default.save')}
            </Button>
          </div>
        </div>
      </Section>

      {form !== null ? (
        <VendorForm
          key={form.vendor?.id ?? 'new'}
          initial={form.vendor}
          importModels={form.importModels}
          busy={busy}
          t={t}
          onCancel={() => setForm(null)}
          onSave={async (id, entry) => {
            const ok = await runWrite(() => client.call('vendor_set', { id, entry }));
            if (ok) setForm(null);
          }}
        />
      ) : null}

      <Section
        title={t('vendors.section')}
        description={t('vendors.testHint')}
        actions={
          <span className="inline-flex items-center gap-1.5">
            <Button size="small" disabled={busy} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={busy}
              onClick={() => setForm({ vendor: null })}
            >
              {t('vendors.add')}
            </Button>
          </span>
        }
      >
        {data.vendors.length === 0 ? (
          <EmptyState
            title={t('vendors.empty.title')}
            description={t('vendors.empty.description')}
          />
        ) : (
          <div className="overflow-hidden rounded-md">
            <DataTable columns={vendorColumns} rows={data.vendors} rowKey={(row) => row.id} />
          </div>
        )}
      </Section>

      {test !== null ? (
        <Section title={t('vendors.testResult')}>
          <div className="flex flex-col gap-2 text-sm">
            <p className="inline-flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{test.vendorId}</span>
              <Badge tone={testResult?.ok === true ? 'success' : 'danger'}>
                {testResult?.ok === true ? t('vendors.testOk') : t('vendors.testFailed')}
              </Badge>
              {testResult !== undefined ? (
                <span className="text-muted">
                  {t('vendors.latency', { ms: testResult.latencyMs })}
                </span>
              ) : null}
            </p>
            {testError !== undefined ? (
              <p role="alert" className="text-danger wrap-anywhere">
                {testError}
              </p>
            ) : null}
            {testResult?.error !== undefined ? (
              <p role="alert" className="text-danger wrap-anywhere">
                {testResult.error.code}: {testResult.error.message}
              </p>
            ) : null}
            {testModels !== undefined && testModels.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-muted">
                  {t('vendors.testModels', { n: testModels.length })}
                </span>
                <span className="inline-flex flex-wrap gap-1">
                  {testModels.map((model) => (
                    <Badge key={model}>{model}</Badge>
                  ))}
                </span>
                {!isLegacyVendor(test.vendorId) ? (
                  <span>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => importModelsIntoForm(test.vendorId, testModels)}
                    >
                      {t('vendors.importModels')}
                    </Button>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section
        title={t('aliases.title')}
        description={t('aliases.description')}
        actions={
          <Button
            size="small"
            variant="primary"
            disabled={busy}
            onClick={() => setAliasForm({ alias: '', ref: '', editing: false })}
          >
            {t('aliases.add')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {aliasForm !== null ? (
            <form
              className="flex flex-wrap items-end gap-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                void saveAlias();
              }}
            >
              <Field label={t('aliases.form.alias')} className="min-w-40 flex-1" required>
                <Input
                  value={aliasForm.alias}
                  onChange={(event) =>
                    setAliasForm((current) =>
                      current === null ? null : { ...current, alias: event.target.value },
                    )
                  }
                  disabled={busy || aliasForm.editing}
                  placeholder="fast"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label={t('aliases.form.ref')} className="min-w-64 flex-1" required>
                <Select
                  value={aliasForm.ref}
                  onChange={(event) =>
                    setAliasForm((current) =>
                      current === null ? null : { ...current, ref: event.target.value },
                    )
                  }
                  disabled={busy}
                >
                  <option value="">{t('default.choose')}</option>
                  {aliasRefOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="primary" disabled={busy}>
                {t('common.save')}
              </Button>
              <Button disabled={busy} onClick={() => setAliasForm(null)}>
                {t('common.cancel')}
              </Button>
            </form>
          ) : null}
          {aliasRows.length === 0 ? (
            <p className="text-sm text-muted">{t('aliases.empty')}</p>
          ) : (
            <div className="overflow-hidden rounded-md">
              <DataTable columns={aliasColumns} rows={aliasRows} rowKey={(row) => row.alias} />
            </div>
          )}
        </div>
      </Section>
    </PageScaffold>
  );
}
