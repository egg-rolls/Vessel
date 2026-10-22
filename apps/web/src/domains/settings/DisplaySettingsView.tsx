/**
 * Settings → Display：经 canonical `config.set` 写白名单键（0.15 E6）。
 *
 * 写入的是用户配置；gateway 未注入 writer 时显示只读并提示重启 / 注入。
 */
import { useEffect, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { useConnection } from '../../gateway/ConnectionProvider';
import { t, useLocale } from '../../i18n';
import {
  DISPLAY_SETTINGS,
  type DisplaySettingDef,
  readDisplayValue,
  toConfigValue,
} from '../../state/display-settings';
import { resourceData, useResource } from '../../state/useResource';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'not_found' || code === 'method_not_allowed';
}

export function DisplaySettingsView() {
  useLocale();
  const toast = useToast();
  const { client, connectionState, hasToken, features, epoch } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('config');

  const resource = useResource({
    load: () => client.getConfig(),
    enabled: available,
    deps: [epoch],
  });
  useRefreshSignal(resource.reload);
  const data = resourceData(resource.state);

  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | undefined>();
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const setting of DISPLAY_SETTINGS) {
      next[setting.key] = readDisplayValue(data, setting.key);
    }
    setValues(next);
  }, [data]);

  if (!hasToken) {
    return (
      <NotEnabledState
        title={t('settings.display.noToken')}
        reason={t('settings.display.noTokenReason')}
      />
    );
  }
  if (!available) {
    return (
      <NotEnabledState
        title={t('settings.display.unavailableTitle')}
        reason={t('settings.display.unavailableReason')}
      />
    );
  }
  if (!data) {
    return resource.state.status === 'error' ? (
      <ErrorState message={resource.state.error} onRetry={resource.reload} />
    ) : (
      <LoadingState label={t('settings.display.loading')} />
    );
  }

  const change = async (setting: DisplaySettingDef, raw: string) => {
    const value = toConfigValue(setting, raw);
    if (value === undefined) return;
    const previous = values[setting.key] ?? '';
    setValues((current) => ({ ...current, [setting.key]: raw }));
    setSaving(setting.key);
    try {
      await client.setConfigValue(setting.key, value);
      toast.success(t('settings.display.saved', { key: setting.key }));
    } catch (error) {
      setValues((current) => ({ ...current, [setting.key]: previous }));
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
    <div className="settings-section">
      {!connected && (
        <StaleNotice message={t('settings.display.disconnected')} onRetry={resource.reload} />
      )}
      {readOnly && <p className="dim">{t('settings.display.writeUnavailable')}</p>}
      <section className="panel">
        <div className="panel-header">
          <h2 className="section-title">{t('settings.display.title')}</h2>
          <button type="button" className="btn btn-small" onClick={resource.reload}>
            {t('settings.display.refresh')}
          </button>
        </div>
        <p className="dim">{t('settings.display.description')}</p>
        <dl className="diag-list">
          {DISPLAY_SETTINGS.map((setting) => {
            const current = values[setting.key] ?? '';
            const options =
              setting.type === 'boolean' ? ['true', 'false'] : (setting.options ?? []);
            return (
              <div key={setting.key} className="display-setting-row">
                <dt>
                  <span className="mono">{setting.key}</span>
                  <div className="dim">{t(`settings.display.field.${setting.id}`)}</div>
                </dt>
                <dd>
                  <select
                    className="input"
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
                  </select>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
    </div>
  );
}
