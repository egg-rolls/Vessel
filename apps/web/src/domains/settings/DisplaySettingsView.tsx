/**
 * Settings → Display：经 canonical `config.set` 写白名单键（0.15 E6）。
 *
 * 写入的是用户配置；gateway 未注入 writer 时显示只读并提示重启 / 注入。
 */
import { useEffect, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, KeyValueList, Section, Select } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import {
  DISPLAY_SETTINGS,
  type DisplaySettingDef,
  readDisplayValue,
  toConfigValue,
} from '../../state/display-settings';
import { RUNTIME_MESSAGE_KINDS, useRuntimeVisibility } from '../../state/runtime-visibility';
import { resourceData } from '../../state/useResource';
import { useDisplaySettings } from '../../stores/uiStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'not_found' || code === 'method_not_allowed';
}

/** Local-only preference; does not depend on the gateway config API. */
function RuntimeContextSection() {
  const { visibility, setKind, setAll } = useRuntimeVisibility();
  const allVisible = RUNTIME_MESSAGE_KINDS.every((kind) => visibility[kind]);

  return (
    <Section
      title={t('settings.display.runtimeTitle')}
      description={t('settings.display.runtimeDescription')}
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('settings.display.runtimeShowAll')}
          htmlFor="runtime-context-show-all"
          hint={t('settings.display.runtimeShowAllHint')}
        >
          <input
            id="runtime-context-show-all"
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={allVisible}
            onChange={(event) => setAll(event.target.checked)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RUNTIME_MESSAGE_KINDS.map((kind) => (
            <Field
              key={kind}
              label={t(`settings.display.runtimeKind.${kind}`)}
              htmlFor={`runtime-context-${kind}`}
              hint={t(`settings.display.runtimeKind.${kind}.hint`)}
            >
              <input
                id={`runtime-context-${kind}`}
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={visibility[kind]}
                onChange={(event) => setKind(kind, event.target.checked)}
              />
            </Field>
          ))}
        </div>
      </div>
    </Section>
  );
}

export function DisplaySettingsView() {
  useLocale();
  const toast = useToast();
  const { client, connectionState, hasToken, features } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('config');

  const { config, reloadConfig } = useConfigStoreApi();
  useRefreshSignal(reloadConfig);
  const data = resourceData(config);

  const { display, setDisplay } = useDisplaySettings();
  const [saving, setSaving] = useState<string | undefined>();
  const [readOnly, setReadOnly] = useState(false);

  // Mirror the gateway snapshot into the shared store (and localStorage) so the
  // form values survive a reload and every consumer sees the same state.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const setting of DISPLAY_SETTINGS) {
      next[setting.key] = readDisplayValue(data, setting.key);
    }
    setDisplay(next);
  }, [data, setDisplay]);

  // The runtime context group is local-only: keep it available even when the
  // gateway config API is missing or disconnected.
  const runtimeSection = <RuntimeContextSection />;

  if (!hasToken) {
    return (
      <div className="flex flex-col gap-6">
        <NotEnabledState
          title={t('settings.display.noToken')}
          reason={t('settings.display.noTokenReason')}
        />
        {runtimeSection}
      </div>
    );
  }
  if (!available) {
    return (
      <div className="flex flex-col gap-6">
        <NotEnabledState
          title={t('settings.display.unavailableTitle')}
          reason={t('settings.display.unavailableReason')}
        />
        {runtimeSection}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        {config.status === 'error' ? (
          <ErrorState message={config.error} onRetry={reloadConfig} />
        ) : (
          <LoadingState label={t('settings.display.loading')} />
        )}
        {runtimeSection}
      </div>
    );
  }

  const change = async (setting: DisplaySettingDef, raw: string) => {
    const value = toConfigValue(setting, raw);
    if (value === undefined) return;
    const previous = display[setting.key] ?? '';
    setDisplay({ [setting.key]: raw });
    setSaving(setting.key);
    try {
      await client.setConfigValue(setting.key, value);
      toast.success(t('settings.display.saved', { key: setting.key }));
    } catch (error) {
      setDisplay({ [setting.key]: previous });
      if (isUnavailable(error)) {
        setReadOnly(true);
        toast.error(t('settings.display.writeUnavailable'));
      } else {
        toast.error(t('settings.display.saveFailed', { detail: errorMessage(error) }));
      }
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {!connected && (
        <StaleNotice message={t('settings.display.disconnected')} onRetry={reloadConfig} />
      )}
      {readOnly && <p className="text-muted">{t('settings.display.writeUnavailable')}</p>}
      <Section
        title={t('settings.display.title')}
        description={t('settings.display.description')}
        actions={
          <Button size="small" onClick={reloadConfig}>
            {t('settings.display.refresh')}
          </Button>
        }
      >
        <KeyValueList
          items={DISPLAY_SETTINGS.map((setting) => {
            const current = display[setting.key] ?? '';
            const options =
              setting.type === 'boolean' ? ['true', 'false'] : (setting.options ?? []);
            return {
              key: setting.key,
              label: (
                <>
                  <span className="font-mono">{setting.key}</span>
                  <div className="text-muted">{t(`settings.display.field.${setting.id}`)}</div>
                </>
              ),
              value: (
                <Select
                  aria-label={setting.key}
                  value={options.includes(current) ? current : ''}
                  disabled={!connected || saving === setting.key || readOnly}
                  onChange={(event) => void change(setting, event.target.value)}
                >
                  {!options.includes(current) && <option value="">—</option>}
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              ),
            };
          })}
        />
      </Section>
      {runtimeSection}
    </div>
  );
}
