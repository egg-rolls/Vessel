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
import type { CredentialDto } from './types';

/**
 * 凭证面（两面重构 §9.1）。明文纪律不变：
 * - 列表只有 id / baseUrl / apiKeyEnv / hasValue / updatedAt / usedBy，无值、无片段；
 * - API key = write-only 输入（type=password + autocomplete=off），提交后立即清空本地值；
 *   编辑态留空 = 不改值；credential_set 一次写两处（先加密库值、后 yaml 元数据）；
 * - 删除两步确认；被模型条目引用时后端拒绝，错误原文（含引用清单）展示。
 */
interface CredentialForm {
  id: string;
  editing: boolean;
  baseUrl: string;
  apiKeyEnv: string;
}

export function CredentialsView({ client, refreshKey, t }: ViewProps) {
  const [state, setState] = useState<LoadState<CredentialDto[]>>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<CredentialForm | null>(null);
  const [value, setValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await client.call<CredentialDto[]>('credentials_list');
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
    const baseUrl = form.baseUrl.trim();
    if (baseUrl === '') {
      setNotice({ kind: 'error', text: t('credentials.form.needBaseUrl') });
      return;
    }
    if (!form.editing && value === '') {
      setNotice({ kind: 'error', text: t('credentials.form.needValue') });
      return;
    }
    // value 只在写入瞬间存在：RPC 尝试后（无论成败）立即清空本地明文。
    const secret = value;
    setValue('');
    const apiKeyEnv = form.apiKeyEnv.trim();
    const ok = await runWrite(() =>
      client.call('credential_set', {
        id,
        baseUrl,
        ...(secret !== '' ? { apiKey: secret } : {}),
        ...(apiKeyEnv !== '' ? { apiKeyEnv } : {}),
      }),
    );
    if (ok) setForm(null);
  }

  async function removeCredential(id: string): Promise<void> {
    const ok = await runWrite(() => client.call('credential_remove', { id }));
    if (ok) setConfirmDelete(null);
  }

  function openForm(row: CredentialDto | null): void {
    setForm(
      row === null
        ? { id: '', editing: false, baseUrl: '', apiKeyEnv: '' }
        : {
            id: row.id,
            editing: true,
            baseUrl: row.baseUrl ?? '',
            apiKeyEnv: row.apiKeyEnv ?? '',
          },
    );
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

  const columns: readonly DataTableColumn<CredentialDto>[] = [
    {
      key: 'id',
      header: t('credentials.th.id'),
      cell: (row) => <span className="font-mono text-xs">{row.id}</span>,
    },
    {
      key: 'baseUrl',
      header: t('credentials.th.baseUrl'),
      cell: (row) => <span className="font-mono text-xs wrap-anywhere">{row.baseUrl ?? '—'}</span>,
    },
    {
      key: 'hasValue',
      header: t('credentials.th.hasValue'),
      cell: (row) =>
        row.hasValue ? (
          <Badge tone="success">{t('credentials.valueSet')}</Badge>
        ) : (
          <Badge tone="warn">{t('credentials.valueMissing')}</Badge>
        ),
    },
    {
      key: 'updatedAt',
      header: t('credentials.th.updatedAt'),
      hide: 'compact',
      cell: (row) => <span className="font-mono text-xs">{row.updatedAt ?? '—'}</span>,
    },
    {
      key: 'usedBy',
      header: t('credentials.th.usedBy'),
      cell: (row) =>
        row.usedBy.length === 0 ? (
          <span className="text-xs text-faint">{t('credentials.unused')}</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {row.usedBy.map((entryId) => (
              <Badge key={entryId} tone="accent">
                {entryId}
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
            <Button size="small" disabled={busy} onClick={() => openForm(row)}>
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
              ? t('credentials.form.editTitle', { id: form.id })
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
              <Field label={t('credentials.form.id')} hint={t('credentials.form.idHint')} required>
                <Input
                  value={form.id}
                  onChange={(event) =>
                    setForm((current) =>
                      current === null ? null : { ...current, id: event.target.value },
                    )
                  }
                  disabled={busy || form.editing}
                  placeholder="soulkiller-gw"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t('credentials.form.baseUrl')}
                hint={t('credentials.form.baseUrlHint')}
                required
              >
                <Input
                  value={form.baseUrl}
                  onChange={(event) =>
                    setForm((current) =>
                      current === null ? null : { ...current, baseUrl: event.target.value },
                    )
                  }
                  disabled={busy}
                  placeholder="https://gw.example.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t('credentials.form.value')}
                hint={t('credentials.form.valueHint')}
                required={!form.editing}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={busy}
                  placeholder={
                    form.editing ? t('credentials.form.valuePlaceholderEdit') : undefined
                  }
                />
              </Field>
              <Field
                label={`${t('credentials.form.apiKeyEnv')} (${t('common.optional')})`}
                hint={t('credentials.form.apiKeyEnvHint')}
              >
                <Input
                  value={form.apiKeyEnv}
                  onChange={(event) =>
                    setForm((current) =>
                      current === null ? null : { ...current, apiKeyEnv: event.target.value },
                    )
                  }
                  disabled={busy}
                  placeholder="DASHSCOPE_API_KEY"
                  autoComplete="off"
                  spellCheck={false}
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
            <Button size="small" variant="primary" disabled={busy} onClick={() => openForm(null)}>
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
