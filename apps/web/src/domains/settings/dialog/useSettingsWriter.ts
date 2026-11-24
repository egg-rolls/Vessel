/**
 * 设置通用写路径（vscode-settings-design §3.6，S1）。
 *
 * 按 scope 分流：
 * - user/project 核心键 → client.setConfigValue + 轮询 reloadConfigAsync 确认
 *   （8 次 × 250ms，覆盖热应用 debounce；常量原样搬自 DisplaySettingsView）。
 * - local 键 → 既有唯一写者（storeTheme 经 uiStore.setTheme / writeNavPreference /
 *   localStorage），同步写、无确认窗口；主题绝不直接写 DOM（R10）。
 * - 插件键 → S4 经 plugins.config.set 接入同一 overlay/确认机制。
 *
 * 失败语义沿用现状：只有写 RPC 失败才算保存失败（清本次 overlay 回服务端值）；
 * 确认超时 → 明确 toast「已写入但未确认」，不静默。overlay 在全局 uiStore，
 * 弹窗关闭不丢未确认写入。
 */
import { useCallback, useState } from 'react';
import { writeNavPreference } from '../../../app/nav-preference';
import { useToast } from '../../../components/ToastProvider';
import { useConnection } from '../../../gateway/ConnectionProvider';
import { setLocale, t } from '../../../i18n';
import { readDisplayValue } from '../../../state/display-settings';
import type { SettingDef } from '../../../state/settings-registry';
import { normalizeTheme, type Theme } from '../../../state/theme';
import { useUiStore } from '../../../stores/uiStore';
import { useConfigStoreApi } from '../../../stores/useConfigStoreApi';

const WRITE_CONFIRM_ATTEMPTS = 8;
const WRITE_CONFIRM_DELAY_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'not_found' || code === 'method_not_allowed';
}

/** 表单值 → config.set value；非法返回 undefined（布尔/整数/枚举/非空字符串校验）。 */
export function toSettingConfigValue(
  def: SettingDef,
  raw: string,
): string | boolean | number | undefined {
  if (def.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (def.type === 'number') {
    const value = Number(raw);
    const min = def.min ?? Number.NEGATIVE_INFINITY;
    const max = def.max ?? Number.POSITIVE_INFINITY;
    if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      return undefined;
    }
    return value;
  }
  if (def.type === 'string') {
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
  }
  if (def.type === 'enum') {
    return def.options?.includes(raw) === true ? raw : undefined;
  }
  return undefined;
}

/** local 项当前存储值（theme 由 uiStore 反应式提供，不走这里）。 */
export function readLocalSetting(def: SettingDef): string {
  try {
    return localStorage.getItem(def.key) ?? def.fallback ?? '';
  } catch {
    return def.fallback ?? '';
  }
}

/** S4 确认：plugins.list config 快照值 === 本次写入的表单文本。 */
function pluginValueMatches(raw: unknown, expected: string): boolean {
  if (typeof raw === 'boolean') return (raw ? 'true' : 'false') === expected;
  if (typeof raw === 'number') return String(raw) === expected;
  if (typeof raw === 'string') return raw === expected;
  return false;
}

export interface SettingsWriter {
  /** S5：scope 透传核心写路径（project = 工作区覆盖层）；local/插件分支忽略。 */
  save: (def: SettingDef, raw: string, scope?: 'user' | 'project') => Promise<void>;
  /** 恢复默认：核心 = 写 default；local = 移除存储键回内置默认（R8）。 */
  reset: (def: SettingDef, scope?: 'user' | 'project') => Promise<void>;
  savingKey: string | undefined;
  /** 写面未注入（not_found）→ 只读 + 原因；refresh 给一次复位。 */
  writeUnavailable: boolean;
  refresh: () => void;
  /** local 写入后自增，驱动弹窗重读 localStorage。 */
  localRevision: number;
  /** S4：child 插件写后需重载（restartRequired）；reloadPlugin 显式重载。 */
  restartPluginId: string | undefined;
  reloadPlugin: () => Promise<void>;
}

export function useSettingsWriter(): SettingsWriter {
  const toast = useToast();
  const { client } = useConnection();
  const { reloadConfig, reloadConfigAsync } = useConfigStoreApi();
  const setSettingsPending = useUiStore((state) => state.setSettingsPending);
  const clearSettingsPending = useUiStore((state) => state.clearSettingsPending);
  const setTheme = useUiStore((state) => state.setTheme);
  const [savingKey, setSavingKey] = useState<string | undefined>();
  const [writeUnavailable, setWriteUnavailable] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const [restartPluginId, setRestartPluginId] = useState<string | undefined>();

  const bumpLocal = useCallback(() => setLocalRevision((revision) => revision + 1), []);

  const saveLocal = useCallback(
    (def: SettingDef, raw: string) => {
      if (def.id === 'local.theme') {
        // 唯一写者：uiStore.setTheme → storeTheme（写存储 + DOM + store）。
        setTheme(normalizeTheme(raw));
      } else if (def.id === 'local.nav.collapsed') {
        writeNavPreference(raw === 'true');
      } else {
        try {
          localStorage.setItem(def.key, raw);
        } catch {
          // 隐私模式/配额满：本会话内生效（沿用既有降级）。
        }
      }
      bumpLocal();
      toast.success(t('settings.dialog.saved', { key: def.id }));
    },
    [bumpLocal, setTheme, toast],
  );

  const save = useCallback(
    async (def: SettingDef, raw: string, scope?: 'user' | 'project') => {
      if (def.readOnly || def.type === 'view' || def.type === 'object' || def.type === 'array') {
        return;
      }
      if (def.scope === 'local') {
        saveLocal(def, raw);
        return;
      }
      // S4：插件键 → plugins.config.set；确认源 = plugins.list[].config（E10）。
      if (def.pluginId !== undefined) {
        const pluginValue = toSettingConfigValue(def, raw);
        if (pluginValue === undefined) return;
        setSettingsPending({ [def.id]: raw });
        setSavingKey(def.id);
        try {
          let result: { restartRequired: boolean };
          try {
            result = await client.setPluginConfigValue(def.pluginId, def.key, pluginValue);
          } catch (error) {
            clearSettingsPending([{ key: def.id, value: raw }]);
            if (isUnavailable(error)) {
              setWriteUnavailable(true);
              toast.error(t('settings.dialog.writeUnavailable'));
            } else {
              toast.error(t('settings.dialog.saveFailed', { detail: errorMessage(error) }));
            }
            return;
          }
          let confirmed = false;
          for (let attempt = 0; attempt < WRITE_CONFIRM_ATTEMPTS; attempt += 1) {
            const fresh = await client.listPlugins().catch(() => undefined);
            const entry = fresh?.find((plugin) => plugin.name === def.pluginId);
            if (entry !== undefined && pluginValueMatches(entry.config?.[def.key], raw)) {
              confirmed = true;
              break;
            }
            if (attempt < WRITE_CONFIRM_ATTEMPTS - 1) {
              await new Promise((resolve) => setTimeout(resolve, WRITE_CONFIRM_DELAY_MS));
            }
          }
          clearSettingsPending([{ key: def.id, value: raw }]);
          if (confirmed) {
            toast.success(t('settings.dialog.saved', { key: def.id }));
          } else {
            toast.error(t('settings.dialog.saveUnconfirmed', { key: def.id }));
          }
          if (result.restartRequired) setRestartPluginId(def.pluginId);
        } finally {
          setSavingKey(undefined);
        }
        return;
      }
      const value = toSettingConfigValue(def, raw);
      if (value === undefined) return;
      // 乐观 overlay：旧快照到达时仍显示用户选择，直到服务端值确认。
      setSettingsPending({ [def.key]: raw });
      setSavingKey(def.id);
      try {
        try {
          await client.setConfigValue(def.key, value, scope);
        } catch (error) {
          // 失败只清本次写入值，回到服务端值；不恢复更早的未确认选择。
          clearSettingsPending([{ key: def.key, value: raw }]);
          if (isUnavailable(error)) {
            setWriteUnavailable(true);
            toast.error(t('settings.dialog.writeUnavailable'));
          } else {
            toast.error(t('settings.dialog.saveFailed', { detail: errorMessage(error) }));
          }
          return;
        }

        if (def.key === 'ui.language' && (value === 'zh-CN' || value === 'en')) {
          setLocale(value);
        }
        // 写入成功 ≠ gateway 已回报新值（热应用 debounce）：分批重拉直到确认。
        let confirmed = false;
        for (let attempt = 0; attempt < WRITE_CONFIRM_ATTEMPTS; attempt += 1) {
          const fresh = await reloadConfigAsync().catch(() => undefined);
          if (fresh !== undefined && readDisplayValue(fresh, def.key) === raw) {
            confirmed = true;
            break;
          }
          if (attempt < WRITE_CONFIRM_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, WRITE_CONFIRM_DELAY_MS));
          }
        }
        clearSettingsPending([{ key: def.key, value: raw }]);
        if (confirmed) {
          toast.success(t('settings.dialog.saved', { key: def.id }));
        } else {
          toast.error(t('settings.dialog.saveUnconfirmed', { key: def.id }));
        }
      } finally {
        setSavingKey(undefined);
      }
    },
    [clearSettingsPending, client, reloadConfigAsync, saveLocal, setSettingsPending, toast],
  );

  const reset = useCallback(
    async (def: SettingDef, scope?: 'user' | 'project') => {
      if (def.scope === 'local') {
        if (def.id === 'local.theme') {
          setTheme((def.default ?? 'dark') as Theme);
        } else {
          try {
            localStorage.removeItem(def.key);
          } catch {
            // 忽略：与写失败同降级。
          }
        }
        bumpLocal();
        toast.success(t('settings.dialog.resetDone', { key: def.id }));
        return;
      }
      if (def.default === undefined) return;
      await save(def, def.default, scope);
    },
    [bumpLocal, save, setTheme, toast],
  );

  const refresh = useCallback(() => {
    setWriteUnavailable(false);
    reloadConfig();
  }, [reloadConfig]);

  // S4：child 插件显式重载（不谎报热应用）；errors[] 逐项展示。
  const reloadPlugin = useCallback(async () => {
    try {
      const result = await client.reloadPlugins();
      if (result.errors.length > 0) {
        for (const entry of result.errors) {
          toast.error(`${entry.id}: ${entry.message}`);
        }
        return;
      }
      setRestartPluginId(undefined);
      toast.success(t('settings.dialog.pluginReloaded'));
    } catch (error) {
      toast.error(t('settings.dialog.saveFailed', { detail: errorMessage(error) }));
    }
  }, [client, toast]);

  return {
    save,
    reset,
    savingKey,
    writeUnavailable,
    refresh,
    localRevision,
    restartPluginId,
    reloadPlugin,
  };
}
