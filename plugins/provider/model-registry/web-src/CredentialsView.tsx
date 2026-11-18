import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  Input,
  PageScaffold,
  Section,
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
import type { CredentialMeta } from './types';

/**
 * 凭证管理页。明文纪律（契约 §2 / §5）：
 * - 列表只有 id / createdAt / updatedAt / usedBy，无值、无片段、无指纹；
 * - 添加/轮换 = write-only 输入（type=password + autocomplete=off），提交后
 *   立即清空本地值，永不回显；credential_set 的 value 是唯一明文输入时刻；
 * - 删除两步确认；被 vendor 引用时后端拒绝，错误原文（含引用清单）展示。
 */
export function CredentialsView({ client, refreshKey, t }: ViewProps) {
  const [state, setState] = useState<LoadState<CredentialMeta[]>>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ id: string; editing: boolean } | null>(null);
  const [value, setValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await client.call<CredentialMeta[]>('credentials_list');
      setState({ status: 'ready', data });
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

  async function saveCredential(): Promise<void> {
    if (form === null) return;
    const id = form.id.trim();
    if (id === '') {
      setNotice({ kind: 'error', text: t('credentials.form.needId') });
      return;
    }
    if (value === '') {
      setNotice({ kind: 'error', text: t('credentials.form.needValue') });
      return;
    }
    // value 只在写入瞬间存在：RPC 尝试后（无论成败）立即清空本地明文。
    const secret = value;
    setValue('');
    const ok = await runWrite(() => client.call('credential_set', { id, value: secret }));
    if (ok) setForm(null);
  }

  async function removeCredential(id: string): Promise<void> {
    const ok = await runWrite(() => client.call('credential_remove', { id }));
    if (ok) setConfirmDelete(null);
  }

  function openForm(id: string, editing: boolean): void {
    setForm({ id, editing });
    setValue('');
    setNotice(null);
  }

  if (state.status === 'loading') {
    return (
      <PageScaffold title={t('credentials.title')} subtitle={t('credentials.subtitle')}>
        <LoadingState label={t('common.loading')} />
      </PageScaffold>
    );
  }
  if (state.status === 'error') {
    return (
      <PageScaffold title={t('credentials.title')} subtitle={t('credentials.subtitle')}>
        <ErrorState
          error={state.error}
          onRetry={() => void load()}
          title={t('common.loadError')}
          retryLabel={t('common.retry')}
        />
      </PageScaffold>
    );
  }

  const columns: readonly DataTableColumn<CredentialMeta>[] = [
    {
      key: 'id',
      header: t('credentials.th.id'),
      cell: (row) => <span className="font-mono text-xs">{row.id}</span>,
    },
    {
      key: 'createdAt',
      header: t('credentials.th.createdAt'),
      hide: 'compact',
      cell: (row) => <span className="font-mono text-xs">{row.createdAt}</span>,
    },
    {
      key: 'updatedAt',
      header: t('credentials.th.updatedAt'),
      cell: (row) => <span className="font-mono text-xs">{row.updatedAt}</span>,
    },
    {
      key: 'usedBy',
      header: t('credentials.th.usedBy'),
      cell: (row) =>
        row.usedBy.length === 0 ? (
          <span className="text-xs text-faint">{t('credentials.unused')}</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {row.usedBy.map((vendorId) => (
              <Badge key={vendorId} tone="accent">
                {vendorId}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      cell: (row) =>
        confirmDelete === row.id ? (
          <ConfirmDelete
            question={t('credentials.deleteConfirm', { id: row.id })}
            busy={busy}
            t={t}
            onConfirm={() => void removeCredential(row.id)}
            onCancel={() => setConfirmDelete(null)}
          />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Button size="small" disabled={busy} onClick={() => openForm(row.id, true)}>
              {t('credentials.rotate')}
            </Button>
            <Button
              size="small"
              variant="dangerGhost"
              disabled={busy}
              onClick={() => setConfirmDelete(row.id)}
            >
              {t('common.delete')}
            </Button>
          </span>
        ),
    },
  ];

  return (
    <PageScaffold title={t('credentials.title')} subtitle={t('credentials.subtitle')}>
      <NoticeLine notice={notice} t={t} />

      {form !== null ? (
        <Section
          title={
            form.editing
              ? t('credentials.form.rotateTitle', { id: form.id })
              : t('credentials.form.addTitle')
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCredential();
            }}
          >
            <div className="grid gap-4 compact:grid-cols-2">
              <Field label={t('credentials.form.id')} required>
                <Input
                  value={form.id}
                  onChange={(event) =>
                    setForm((current) =>
                      current === null ? null : { ...current, id: event.target.value },
                    )
                  }
                  disabled={busy || form.editing}
                  placeholder="arcostudio-key"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t('credentials.form.value')}
                hint={t('credentials.form.valueHint')}
                required
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={busy}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" disabled={busy}>
                {t('common.save')}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setForm(null);
                  setValue('');
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </Section>
      ) : null}

      <Section
        title={t('credentials.title')}
        actions={
          <span className="inline-flex items-center gap-1.5">
            <Button size="small" disabled={busy} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={busy}
              onClick={() => openForm('', false)}
            >
              {t('credentials.add')}
            </Button>
          </span>
        }
      >
        {state.data.length === 0 ? (
          <EmptyState
            title={t('credentials.empty.title')}
            description={t('credentials.empty.description')}
          />
        ) : (
          <div className="overflow-hidden rounded-md">
            <DataTable columns={columns} rows={state.data} rowKey={(row) => row.id} />
          </div>
        )}
      </Section>
    </PageScaffold>
  );
}
