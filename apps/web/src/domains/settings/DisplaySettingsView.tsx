/**
 * Settings → Display：经 canonical `config.set` 写白名单键（0.15 E6）。
 *
 * 值从 `configStore` 派生，本地只有按 key 的 `displayPending` overlay；
 * 写成功后 await 一次 config 刷新，服务端值等于 pending 才清 overlay。
 * gateway 未注入 writer 时显示只读。
 */
import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, Field, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { setLocale, t, useLocale } from '../../i18n';
import {
  confirmedDisplayKeys,
  DISPLAY_SETTINGS,
  type DisplaySettingDef,
  readDisplayValue,
  resolveDisplayValues,
  toConfigValue,
} from '../../state/display-settings';
import { RUNTIME_MESSAGE_KINDS, useRuntimeVisibility } from '../../state/runtime-visibility';
import { resourceData } from '../../state/useResource';
import { useUiStore } from '../../stores/uiStore';
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

/**
 * 可写键的控件网格（纯展示）：布尔用 checkbox、枚举用 radio。
 * 单独导出便于静态渲染断言；不依赖 connection / store。
 */
export function DisplaySettingsFields({
  display,
  disabledFor,
  onChange,
}: {
  display: Record<string, string>;
  disabledFor?: (setting: DisplaySettingDef) => boolean;
  onChange: (setting: DisplaySettingDef, raw: string) => void;
}) {
  return (
    <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {DISPLAY_SETTINGS.map((setting) => {
        const current = display[setting.key] ?? '';
        const disabled = disabledFor?.(setting) ?? false;
        return (
          <fieldset
            key={setting.key}
            disabled={disabled}
            className="min-w-0 rounded-md border border-transparent bg-raised p-3 transition-colors hover:border-line hover:bg-surface-hover hover:shadow-elev-1"
          >
            <legend className="px-1 font-mono text-xs tracking-wide text-faint">
              {setting.key}
            </legend>
            <div className="text-md text-ink">{t(`settings.display.field.${setting.id}`)}</div>
            {setting.id === 'askUser' && (
              <div className="mt-0.5 text-sm text-muted">
                {t('settings.display.field.askUser.hint')}
              </div>
            )}
            {setting.type === 'boolean' ? (
              <label className="mt-2.5 flex items-center gap-2 text-md">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={current === 'true'}
                  disabled={disabled}
                  onChange={(event) => onChange(setting, event.target.checked ? 'true' : 'false')}
                />
                <span>{t('settings.display.booleanOn')}</span>
              </label>
            ) : (
              <div
                className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5"
                role="radiogroup"
                aria-label={setting.key}
              >
                {(setting.options ?? []).map((option) => (
                  <label key={option} className="flex items-center gap-1.5 text-md">
                    <input
                      type="radio"
                      name={setting.key}
                      value={option}
                      className="h-4 w-4 accent-accent"
                      checked={current === option}
                      disabled={disabled}
                      onChange={() => onChange(setting, option)}
                    />
                    <span className="font-mono">{option}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

export function DisplaySettingsView() {
  useLocale();
  const toast = useToast();
  const { client, connectionState, hasToken, features } = useConnection();
  const connected = hasToken && connectionState === 'open';
  const available = hasToken && features.includes('config');

  const { config, reloadConfig, reloadConfigAsync } = useConfigStoreApi();
  useRefreshSignal(reloadConfig);
  const data = resourceData(config);

  const pending = useUiStore((state) => state.displayPending);
  const setDisplayPending = useUiStore((state) => state.setDisplayPending);
  const clearDisplayPending = useUiStore((state) => state.clearDisplayPending);
  const [saving, setSaving] = useState<string | undefined>();
  const [readOnly, setReadOnly] = useState(false);

  // 服务端快照是唯一真相；本地只叠一层按 key 的乐观 overlay。
  const display = useMemo(() => resolveDisplayValues(data, pending), [data, pending]);

  // 服务端确认后清除 overlay；旧快照（值与 pending 不同）不会覆盖用户选择。
  useEffect(() => {
    if (!data) return;
    const confirmed = confirmedDisplayKeys(data, pending);
    if (confirmed.length > 0) clearDisplayPending(confirmed);
  }, [data, pending, clearDisplayPending]);

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
    // 乐观 overlay：旧快照到达时仍显示用户选择，直到服务端值确认。
    setDisplayPending({ [setting.key]: raw });
    setSaving(setting.key);
    try {
      // 只有 config.set 失败才算“保存失败”；刷新失败不影响已写入的事实。
      try {
        await client.setConfigValue(setting.key, value);
      } catch (error) {
        // 失败只清本次写入值，回到服务端值；不恢复更早的未确认选择。
        clearDisplayPending([{ key: setting.key, value: raw }]);
        if (isUnavailable(error)) {
          setReadOnly(true);
          toast.error(t('settings.display.writeUnavailable'));
        } else {
          toast.error(t('settings.display.saveFailed', { detail: errorMessage(error) }));
        }
        return;
      }

      if (setting.key === 'ui.language' && (value === 'zh-CN' || value === 'en')) {
        setLocale(value);
      }
      // 刷新失败/被竞态抢先时 fresh 为 undefined：保留 pending，等轮询确认。
      const fresh = await reloadConfigAsync().catch(() => undefined);
      if (fresh) {
        const serverValue = readDisplayValue(fresh, setting.key);
        // 只有服务端值真的等于 pending 才清除；且只清本次写入的值（快速 A→B 不清 B）。
        if (serverValue === raw) clearDisplayPending([{ key: setting.key, value: raw }]);
      }
      toast.success(t('settings.display.saved', { key: setting.key }));
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
        <DisplaySettingsFields
          display={display}
          disabledFor={(setting) => !connected || saving === setting.key || readOnly}
          onChange={(setting, raw) => void change(setting, raw)}
        />
      </Section>
      {runtimeSection}
    </div>
  );
}
