import {
  Badge,
  Button,
  Field,
  type KeyValueItem,
  KeyValueList,
  SearchInput,
  Section,
  Select,
} from '@vessel-agent/plugin-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeError,
  type MarketplaceApi,
  type RegistryFailure,
  registryFailureOf,
  urlInMessage,
} from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PermissionList } from '../components/Permissions';
import { RegistryBanners } from '../components/RegistryBanners';
import { RegistrySetup, RegistryUnreachable } from '../components/RegistrySetup';
import { Banner, EmptyState, ErrorState, LoadingState } from '../components/States';
import { SCOPE_MESSAGE_KEY, type Translator } from '../i18n';
import type {
  DetailResult,
  RegistryMeta,
  RegistryPermissions,
  RegistryPlugin,
  RegistryVersion,
  SearchItem,
  StartJobResult,
} from '../types';

interface PendingInstall {
  plugin: RegistryPlugin;
  version: RegistryVersion;
  registry?: RegistryMeta;
}

function packageItems(version: RegistryVersion, t: Translator): KeyValueItem[] {
  return [
    {
      key: 'sha256',
      label: 'sha256',
      value: <span className="font-mono text-xs">{version.asset.sha256}</span>,
    },
    {
      key: 'size',
      label: t('package.size'),
      value: t('package.bytes', { size: version.asset.size.toLocaleString('en-US') }),
    },
  ];
}

function Disclosure({
  plugin,
  version,
  registry,
  t,
}: {
  plugin: RegistryPlugin;
  version: RegistryVersion;
  registry: RegistryMeta | undefined;
  t: Translator;
}) {
  const permissions: RegistryPermissions | undefined = version.permissions;
  return (
    <div className="flex flex-col gap-3">
      {registry?.trusted === false ? (
        <Banner tone="danger">{t('registry.custom.install', { url: registry.url })}</Banner>
      ) : null}
      <p className="text-md text-ink">
        {t('disclosure.install', {
          name: plugin.name || plugin.id,
          version: version.version,
        })}
      </p>
      <div>
        <h3 className="font-mono text-2xs tracking-widest text-faint uppercase">
          {t('permissions.declared')}
        </h3>
        <PermissionList permissions={permissions} t={t} />
      </div>
      <div>
        <h3 className="font-mono text-2xs tracking-widest text-faint uppercase">
          {t('permissions.package')}
        </h3>
        <KeyValueList items={packageItems(version, t)} />
      </div>
      <p className="text-sm text-muted">{t('disclosure.inactive')}</p>
    </div>
  );
}

export function MarketplaceView({
  api,
  t,
  refreshToken,
  busy,
  onJob,
}: {
  api: MarketplaceApi;
  t: Translator;
  refreshToken: number;
  busy: boolean;
  onJob: (label: string, start: () => Promise<StartJobResult>) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [applied, setApplied] = useState({ query: '', category: '' });
  const [data, setData] = useState<Awaited<ReturnType<MarketplaceApi['search']>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registryFailure, setRegistryFailure] = useState<RegistryFailure | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  const [pending, setPending] = useState<PendingInstall | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setError(null);
    try {
      const result = await api.search(applied);
      if (requestRef.current !== request) return;
      setData(result);
      setRegistryFailure(null);
      setActionError(null);
    } catch (caught) {
      if (requestRef.current !== request) return;
      setError(describeError(caught, t));
      setRegistryFailure(
        registryFailureOf(caught instanceof Error ? caught.message : String(caught)),
      );
      setData(null);
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [api, applied, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshToken` is an explicit host-refresh trigger, not a value the effect reads.
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `detailNonce` retries and `refreshToken` is the host-refresh trigger; neither is read in the body.
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .detail(detailId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setDetailError(describeError(caught, t));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, detailId, detailNonce, refreshToken, t]);

  const quickInstall = async (item: SearchItem) => {
    setActionError(null);
    try {
      const result = await api.detail(item.id);
      const versions = result.plugin.versions ?? [];
      const target =
        versions.find((version) => version.version === item.latest) ??
        versions[versions.length - 1];
      if (target === undefined) throw new Error(t('error.noVersion'));
      setPending({ plugin: result.plugin, version: target, registry: result.registry });
    } catch (caught) {
      setActionError(describeError(caught, t));
    }
  };

  const confirmInstall = () => {
    if (pending === null) return;
    const { plugin, version } = pending;
    setPending(null);
    void onJob(`${t('button.install')} ${plugin.name || plugin.id} ${version.version}`, () =>
      api.install(plugin.id, version.version),
    );
  };

  const listView = (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ query: query.trim(), category });
        }}
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('search.placeholder')}
          ariaLabel={t('search.aria')}
          className="grow basis-60 max-w-search"
        />
        <Field label={t('category.label')} htmlFor="marketplace-filter-category" className="w-44">
          <Select
            id="marketplace-filter-category"
            value={category}
            aria-label={t('category.label')}
            onChange={(event) => {
              const next = event.target.value;
              setCategory(next);
              setApplied((current) => ({ ...current, category: next }));
            }}
          >
            <option value="">{t('category.all')}</option>
            {(data?.categories ?? []).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit">{t('search.submit')}</Button>
        <Button onClick={() => void load()} disabled={loading}>
          {t('button.refresh')}
        </Button>
      </form>

      <RegistryBanners registry={data?.registry} t={t} />
      {actionError !== null ? <Banner tone="danger">{actionError}</Banner> : null}

      {loading ? (
        <LoadingState label={t('state.loading')} />
      ) : registryFailure === 'missing' ? (
        <RegistrySetup t={t} onRetry={() => void load()} />
      ) : registryFailure === 'unreachable' ? (
        <RegistryUnreachable
          message={error ?? ''}
          url={urlInMessage(error ?? '')}
          t={t}
          onRetry={() => void load()}
        />
      ) : error !== null ? (
        <ErrorState message={error} retryLabel={t('button.retry')} onRetry={() => void load()} />
      ) : data !== null && data.items.length === 0 ? (
        <EmptyState
          title={
            applied.query !== '' || applied.category !== ''
              ? t('state.noMatch')
              : t('state.registryEmpty')
          }
          detail={
            applied.query !== '' || applied.category !== ''
              ? t('state.tryDifferent')
              : t('state.registryEmptyDetail')
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(data?.items ?? []).map((item) => (
            <article
              key={item.id}
              className="flex min-w-0 flex-col gap-2 rounded-md bg-raised px-4 py-3 shadow-elev-1"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-md font-semibold text-ink wrap-anywhere">
                    {item.name || item.id}
                  </h3>
                  <p className="font-mono text-xs text-muted">{item.id}</p>
                </div>
                {item.installed_version !== undefined ? (
                  <Badge tone={item.update_available === true ? 'warn' : 'success'}>
                    {t('badge.installed')} {item.installed_version}
                  </Badge>
                ) : (
                  <Badge>{item.latest}</Badge>
                )}
              </div>
              <p className="text-md text-muted wrap-anywhere">
                {item.summary ?? item.description ?? ''}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {item.category ? <Badge>{item.category}</Badge> : null}
                {(item.tags ?? []).slice(0, 5).map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
              <div className="mt-auto flex flex-wrap justify-end gap-2 pt-1">
                <Button onClick={() => setDetailId(item.id)}>{t('button.details')}</Button>
                <Button variant="primary" disabled={busy} onClick={() => void quickInstall(item)}>
                  {item.installed_version !== undefined
                    ? t('button.reinstall')
                    : t('button.install')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );

  const versions = detail !== null ? [...detail.plugin.versions].reverse() : [];
  const installedVersion = detail?.installed;

  const detailView = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setDetailId(null)}>{t('button.back')}</Button>
        {detail !== null ? (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink wrap-anywhere">
              {detail.plugin.name || detail.plugin.id}
            </h2>
            <p className="font-mono text-xs text-muted">{detail.plugin.id}</p>
          </div>
        ) : null}
      </div>

      <RegistryBanners registry={detail?.registry} t={t} />

      {detailLoading ? (
        <LoadingState label={t('state.loading')} />
      ) : detailError !== null ? (
        <ErrorState
          message={detailError}
          retryLabel={t('button.retry')}
          onRetry={() => setDetailNonce((value) => value + 1)}
        />
      ) : detail !== null ? (
        <>
          <p className="text-md text-muted wrap-anywhere">
            {detail.plugin.description ?? detail.plugin.summary ?? ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.plugin.category ? <Badge>{detail.plugin.category}</Badge> : null}
            {(detail.plugin.tags ?? []).map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
            {detail.plugin.repo ? (
              <a href={detail.plugin.repo} target="_blank" rel="noopener noreferrer">
                <Badge tone="info">{t('link.repository')}</Badge>
              </a>
            ) : null}
            {detail.plugin.homepage ? (
              <a href={detail.plugin.homepage} target="_blank" rel="noopener noreferrer">
                <Badge tone="info">{t('link.homepage')}</Badge>
              </a>
            ) : null}
          </div>

          {installedVersion !== undefined ? (
            <Banner tone={installedVersion.enabled ? 'success' : 'warn'}>
              {t(
                installedVersion.enabled ? 'disclosure.installed' : 'disclosure.installedDisabled',
                {
                  version: installedVersion.version,
                  scope: t(SCOPE_MESSAGE_KEY[installedVersion.scope]),
                },
              )}
            </Banner>
          ) : null}

          <Section title={t('section.versions')}>
            <div className="flex flex-col gap-2">
              {versions.map((version) => (
                <div
                  key={version.version}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-sm bg-sunken px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-md text-ink">{version.version}</span>
                      {version.version === detail.plugin.latest ? (
                        <Badge tone="success">{t('badge.latest')}</Badge>
                      ) : null}
                      {version.version === installedVersion?.version ? (
                        <Badge>{t('badge.installed')}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted wrap-anywhere">
                      sha256 {version.asset.sha256.slice(0, 16)}… ·{' '}
                      {t('package.bytes', {
                        size: version.asset.size.toLocaleString('en-US'),
                      })}
                    </p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-sm text-muted">
                        {t('section.permissions')}
                      </summary>
                      <PermissionList permissions={version.permissions} t={t} />
                    </details>
                  </div>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      setPending({
                        plugin: detail.plugin,
                        version,
                        registry: detail.registry,
                      })
                    }
                  >
                    {t('button.install')}
                  </Button>
                </div>
              ))}
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      {detailId !== null ? detailView : listView}
      <ConfirmDialog
        open={pending !== null}
        title={t('dialog.install.title')}
        confirmLabel={t('dialog.install.confirm')}
        confirmText={t('dialog.install.check')}
        cancelLabel={t('button.cancel')}
        onCancel={() => setPending(null)}
        onConfirm={confirmInstall}
      >
        {pending !== null ? (
          <Disclosure
            plugin={pending.plugin}
            version={pending.version}
            registry={pending.registry}
            t={t}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}
