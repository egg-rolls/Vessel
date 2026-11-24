/**
 * Settings → Display：经 canonical `config.set` 写白名单键（0.15 E6）。
 *
 * 值从 `configStore` 派生，本地只有按 key 的 `displayPending` overlay；
 * 写成功后 await 一次 config 刷新，服务端值等于 pending 才清 overlay。
 * gateway 未注入 writer 时显示只读。
 *
 * 0.50：系统信息（运行期上下文 / 内部事件）不再是本地开关，统一由这里的
 * ui.showInternalEvents 一个键控制，写路径与其他 display 键完全相同。
 */
import { useEffect, useMemo, useState } from 'react';
import { useRefreshSignal } from '../../app/refresh';
import { ErrorState, LoadingState, NotEnabledState, StaleNotice } from '../../components/States';
import { useToast } from '../../components/ToastProvider';
import { Button, Section } from '../../components/ui';
import { useConnection } from '../../gateway/ConnectionProvider';
import { setLocale, t, useLocale } from '../../i18n';
import {
  confirmedDisplayKeys,
  DISPLAY_SETTINGS,
  type DisplaySettingDef,
  EMPTY_RESPONSE_SETTING_PREFIX,
  LOG_SETTING_PREFIX,
  readDisplayValue,
  readLogEnvOverrides,
  readLogModules,
  resolveDisplayValues,
  toConfigValue,
} from '../../state/display-settings';
import { resourceData } from '../../state/useResource';
import { useUiStore } from '../../stores/uiStore';
import { useConfigStoreApi } from '../../stores/useConfigStoreApi';

/**
 * config.set 之后等 gateway 回报新值的重试次数与间隔。
 *
 * 实测（本机 gateway 0.50，/v1/rpc 直连）：写入立即落盘，但 config.get 服务的
 * 是内存快照，要等文件监听热应用（debounce 300ms + reload）才更新，实测 300–800ms。
 * 因此确认窗口必须覆盖这段时间，否则开关会在“已写入但快照还是旧值”时误判失败。
 */
const WRITE_CONFIRM_ATTEMPTS = 8;
const WRITE_CONFIRM_DELAY_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'not_found' || code === 'method_not_allowed';
}

/**
 * 文本 / 数字输入（q-empty-response 起）：本地草稿，**blur / Enter 才提交**——
 * 逐键写 config.set 会把每个 keystroke 变成一次落盘。非法值（越界整数 / 空串）
 * 不提交并回落到服务端值。
 */
function CommitTextInput({
  disabled,
  onCommit,
  setting,
  value,
}: {
  disabled: boolean;
  onCommit: (raw: string) => void;
  setting: DisplaySettingDef;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  // 服务端值变化（含写入确认后的快照）同步草稿；本地编辑中不被旧快照打断
  // （value 只在确认 / 刷新时变）。
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === value) return;
    if (toConfigValue(setting, draft) === undefined) {
      setDraft(value);
      return;
    }
    onCommit(draft);
  };
  return (
    <input
      type={setting.type === 'number' ? 'number' : 'text'}
      className="mt-2.5 w-full rounded-md border border-line bg-surface px-2 py-1 font-mono text-md text-ink focus:border-accent focus:outline-none"
      value={draft}
      min={setting.min}
      max={setting.max}
      step={setting.type === 'number' ? 1 : undefined}
      disabled={disabled}
      aria-label={setting.key}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

/**
 * 可写键的控件网格（纯展示）：布尔用 checkbox、枚举用 radio、数字/文本用输入框。
 * 单独导出便于静态渲染断言；不依赖 connection / store。
 */
export function DisplaySettingsFields({
  display,
  disabledFor,
  hintFor,
  onChange,
  settings,
}: {
  display: Record<string, string>;
  disabledFor?: (setting: DisplaySettingDef) => boolean;
  /** 额外提示（如「被环境变量覆盖」）；返回 undefined 不渲染。 */
  hintFor?: (setting: DisplaySettingDef) => string | undefined;
  onChange: (setting: DisplaySettingDef, raw: string) => void;
  /** 要渲染的键子集；缺省全量（Display 页拆「显示」与「日志」两个分组用）。 */
  settings?: readonly DisplaySettingDef[];
}) {
  return (
    <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(settings ?? DISPLAY_SETTINGS).map((setting) => {
        const current = display[setting.key] ?? '';
        const disabled = disabledFor?.(setting) ?? false;
        const extraHint = hintFor?.(setting);
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
            {setting.id === 'showInternalEvents' && (
              <div className="mt-0.5 text-sm text-muted">
                {t('settings.display.field.showInternalEvents.hint')}
              </div>
            )}
            {setting.id === 'showArchived' && (
              <div className="mt-0.5 text-sm text-muted">
                {t('settings.display.field.showArchived.hint')}
              </div>
            )}
            {(setting.id === 'emptyResponseEnabled' ||
              setting.id === 'emptyResponseSeamless' ||
              setting.id === 'emptyResponseMaxRetries' ||
              setting.id === 'emptyResponseNudge') && (
              <div className="mt-0.5 text-sm text-muted">
                {t(`settings.display.field.${setting.id}.hint`)}
              </div>
            )}
            {extraHint !== undefined && (
              <div className="mt-0.5 text-sm text-muted">{extraHint}</div>
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
            ) : setting.type === 'number' || setting.type === 'string' ? (
              <CommitTextInput
                setting={setting}
                value={current}
                disabled={disabled}
                onCommit={(raw) => onChange(setting, raw)}
              />
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
  // 日志中枢：环境变量覆盖（被压住的键只读 + 提示）与 modules 只读展示。
  const logOverrides = useMemo(() => readLogEnvOverrides(data), [data]);
  const logModules = useMemo(() => readLogModules(data), [data]);

  // 服务端确认后清除 overlay；旧快照（值与 pending 不同）不会覆盖用户选择。
  useEffect(() => {
    if (!data) return;
    const confirmed = confirmedDisplayKeys(data, pending);
    if (confirmed.length > 0) clearDisplayPending(confirmed);
  }, [data, pending, clearDisplayPending]);

  if (!hasToken) {
    return (
      <div className="flex flex-col gap-6">
        <NotEnabledState
          title={t('settings.display.noToken')}
          reason={t('settings.display.noTokenReason')}
        />
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
      </div>
    );
  }

  // 被环境变量压住的日志键（config.get 的 logEnvOverrides）：只读 + 提示。
  const logOverrideFor = (setting: DisplaySettingDef) => {
    if (!setting.key.startsWith(LOG_SETTING_PREFIX)) return undefined;
    const field = setting.key.slice(LOG_SETTING_PREFIX.length);
    return logOverrides.find((override) => override.key === field);
  };

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
      // 写入成功不等于 gateway 已回报新值： 可能仍返回热应用前的快照。
      // 分批重拉到服务端值等于本次写入为止，避免出现“开关显示开着、会话仍按旧值
      // 渲染”的错觉；仍不相等就明确报错，而不是让界面与服务端长期不一致。
      let confirmed = false;
      for (let attempt = 0; attempt < WRITE_CONFIRM_ATTEMPTS; attempt += 1) {
        const fresh = await reloadConfigAsync().catch(() => undefined);
        if (fresh !== undefined && readDisplayValue(fresh, setting.key) === raw) {
          confirmed = true;
          break;
        }
        if (attempt < WRITE_CONFIRM_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, WRITE_CONFIRM_DELAY_MS));
        }
      }
      // 无论是否确认都清本次 overlay：未确认时回落到服务端真值（清的是本次写入值，
      // 更快的 A→B 会保留 B）。
      clearDisplayPending([{ key: setting.key, value: raw }]);
      if (confirmed) {
        toast.success(t('settings.display.saved', { key: setting.key }));
      } else {
        toast.error(t('settings.display.saveUnconfirmed', { key: setting.key }));
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
          <Button
            size="small"
            onClick={() => {
              // 写能力只能靠一次真实写入判定；刷新给一次复位，避免 readOnly 一旦置位
              // 就永久禁用所有控件（用户表现为“点不动/关不掉”）。
              setReadOnly(false);
              reloadConfig();
            }}
          >
            {t('settings.display.refresh')}
          </Button>
        }
      >
        <DisplaySettingsFields
          settings={DISPLAY_SETTINGS.filter(
            (setting) =>
              !setting.key.startsWith(LOG_SETTING_PREFIX) &&
              !setting.key.startsWith(EMPTY_RESPONSE_SETTING_PREFIX),
          )}
          display={display}
          disabledFor={(setting) => !connected || saving === setting.key || readOnly}
          onChange={(setting, raw) => void change(setting, raw)}
        />
      </Section>
      <Section
        title={t('settings.display.runtime.title')}
        description={t('settings.display.runtime.description')}
      >
        <DisplaySettingsFields
          settings={DISPLAY_SETTINGS.filter((setting) =>
            setting.key.startsWith(EMPTY_RESPONSE_SETTING_PREFIX),
          )}
          display={display}
          disabledFor={(setting) => !connected || saving === setting.key || readOnly}
          onChange={(setting, raw) => void change(setting, raw)}
        />
      </Section>
      <Section
        title={t('settings.display.log.title')}
        description={t('settings.display.log.description')}
      >
        <DisplaySettingsFields
          settings={DISPLAY_SETTINGS.filter((setting) =>
            setting.key.startsWith(LOG_SETTING_PREFIX),
          )}
          display={display}
          disabledFor={(setting) =>
            !connected ||
            saving === setting.key ||
            readOnly ||
            logOverrideFor(setting) !== undefined
          }
          hintFor={(setting) => {
            const override = logOverrideFor(setting);
            return override !== undefined
              ? t('settings.display.log.overridden', { env: override.env })
              : undefined;
          }}
          onChange={(setting, raw) => void change(setting, raw)}
        />
        <div className="mt-3 rounded-md bg-raised p-3">
          <div className="font-mono text-xs tracking-wide text-faint">
            observability.log.modules
          </div>
          <div className="text-md text-ink">{t('settings.display.log.modules')}</div>
          <div className="mt-0.5 text-sm text-muted">{t('settings.display.log.modulesHint')}</div>
          {logModules.length === 0 ? (
            <div className="mt-2 text-sm text-muted">{t('settings.display.log.modulesEmpty')}</div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm">
              {logModules.map(([prefix, level]) => (
                <span key={prefix}>
                  {prefix}={level}
                </span>
              ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
