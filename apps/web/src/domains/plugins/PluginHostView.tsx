/**
 * Plugin Host（E10）：宿主页面，不属于插件贡献页，marketplace 禁用时仍可见。
 * 展示 marketplace 运行时元数据，并提供 registry_url（write RPC）配置。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, LoadingState, NotEnabledState } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import {
  Badge,
  type BadgeTone,
  Button,
  Field,
  Input,
  KeyValueList,
  Section,
} from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import type { PluginRuntimeStatus } from '../../gateway/types';
import { t, useLocale } from '../../i18n';
import { resourceData } from '../../state/useResource';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';
import {
  canEditRegistry,
  configureMarketplace,
  isValidRegistryUrl,
  marketplaceOf,
  registryUrlOf,
} from './plugin-host-state';
import { usePluginContributions } from './usePluginContributions';

const STATUS_TONE: Record<PluginRuntimeStatus, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  unhealthy: 'danger',
  disabled: 'warn',
  invalid: 'danger',
};

export function PluginHostView() {
  useLocale();
  const { client, hasToken, connectionState, tenantId } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const toast = useToast();
  const { plugins, state, reload } = usePluginContributions();
  const { config, reloadConfig } = useConfigStoreApi();
  const gatewayVersion = resourceData(config)?.version;

  const marketplace = useMemo(() => marketplaceOf(plugins), [plugins]);
  const storedRegistryUrl = registryUrlOf(marketplace);
  const [registryUrl, setRegistryUrl] = useState(storedRegistryUrl);
  const lastStoredUrl = useRef(storedRegistryUrl);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 轮询刷新时只在“存储值变化”后回填，避免覆盖用户正在输入的内容。
  useEffect(() => {
    if (lastStoredUrl.current === storedRegistryUrl) return;
    lastStoredUrl.current = storedRegistryUrl;
    setRegistryUrl(storedRegistryUrl);
  }, [storedRegistryUrl]);

  const editable = canEditRegistry(marketplace, connected);

  const save = async () => {
    if (!isValidRegistryUrl(registryUrl)) {
      setFormError(t('pluginHost.registry.invalid'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await configureMarketplace(client, registryUrl);
      toast.success(t('pluginHost.registry.saved'));
      reload();
      reloadConfig();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!hasToken) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
        <PageHeader title={t('nav.domain.pluginHost')} tenantId={tenantId} />
        <div className="mt-5">
          <NotEnabledState
            variant="page"
            title={t('common.notConnected')}
            reason={t('pluginHost.noTokenReason')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto overscroll-contain p-6 pb-10 max-compact:px-3 max-compact:pt-4 max-compact:pb-7 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[var(--content-max)]">
      <PageHeader title={t('nav.domain.pluginHost')} tenantId={tenantId} />
      <div className="mt-5 flex flex-col gap-4">
        {!connected && plugins.length === 0 ? (
          <NotEnabledState
            variant="page"
            title={t('common.notConnected')}
            reason={t('pluginHost.disconnectedReason')}
          />
        ) : state.status === 'error' && plugins.length === 0 ? (
          <ErrorState message={state.error} onRetry={reload} />
        ) : state.status === 'loading' && plugins.length === 0 ? (
          <LoadingState label={t('pluginHost.loading')} />
        ) : (
          <>
            <Section title={t('pluginHost.status.title')}>
              {marketplace ? (
                <KeyValueList
                  items={[
                    {
                      label: t('pluginHost.field.enabled'),
                      value: (
                        <Badge tone={marketplace.enabled ? 'success' : 'neutral'}>
                          {t(
                            marketplace.enabled
                              ? 'pluginHost.enabled.on'
                              : 'pluginHost.enabled.off',
                          )}
                        </Badge>
                      ),
                    },
                    {
                      label: t('pluginHost.field.status'),
                      value: marketplace.status ? (
                        <Badge tone={STATUS_TONE[marketplace.status]}>
                          {t(`pluginHost.status.${marketplace.status}`)}
                        </Badge>
                      ) : (
                        '—'
                      ),
                    },
                    {
                      label: t('pluginHost.field.version'),
                      value: marketplace.version ?? '—',
                    },
                    {
                      label: t('pluginHost.field.mode'),
                      value: marketplace.mode ? t(`pluginHost.mode.${marketplace.mode}`) : '—',
                    },
                    {
                      label: t('pluginHost.field.plugins'),
                      value: plugins.length,
                    },
                    {
                      label: t('pluginHost.field.gatewayVersion'),
                      value: gatewayVersion ? `v${gatewayVersion}` : '—',
                    },
                  ]}
                />
              ) : (
                <p className="m-0 text-md text-muted">{t('pluginHost.marketplaceMissing')}</p>
              )}
            </Section>

            <Section
              title={t('pluginHost.registry.title')}
              description={t('pluginHost.registry.hint')}
            >
              <Field
                label={t('pluginHost.registry.label')}
                htmlFor="plugin-host-registry-url"
                error={formError ?? undefined}
              >
                <Input
                  id="plugin-host-registry-url"
                  value={registryUrl}
                  placeholder={t('pluginHost.registry.placeholder')}
                  disabled={!editable || saving}
                  onChange={(event) => {
                    setRegistryUrl(event.target.value);
                    setFormError(null);
                  }}
                />
              </Field>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="small"
                  disabled={!editable || saving}
                  onClick={() => void save()}
                >
                  {saving ? t('pluginHost.registry.saving') : t('pluginHost.registry.save')}
                </Button>
                {!editable && (
                  <span className="text-sm text-faint">
                    {marketplace === undefined
                      ? t('pluginHost.marketplaceMissing')
                      : !marketplace.enabled
                        ? t('pluginHost.registry.disabledHint')
                        : t('pluginHost.registry.disconnectedHint')}
                  </span>
                )}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
