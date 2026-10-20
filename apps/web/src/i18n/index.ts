import { useSyncExternalStore } from 'react';
import { messages as en } from './messages/en';
import { messages as zhCN } from './messages/zh-CN';

/**
 * Web 轻量 i18n：无依赖、无 RPC。
 *
 * - locale 只影响壳层 / Settings 文案；未收录的 key 回退 zh-CN，再回退 key 本身。
 * - 初始值：`localStorage['vessel.ui.language']` > `navigator.language`（`en*` → en，其余 zh-CN）。
 * - `setLocale` 同步写 localStorage 与 `<html lang>`，并通知订阅者立即重渲染。
 */
export type Locale = 'zh-CN' | 'en';

export const LOCALE_STORAGE_KEY = 'vessel.ui.language';
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const SUPPORTED_LOCALES: readonly { id: Locale; labelKey: string }[] = [
  { id: 'zh-CN', labelKey: 'appearance.language.zh' },
  { id: 'en', labelKey: 'appearance.language.en' },
];

const CATALOGS: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en,
};

const listeners = new Set<() => void>();
let current: Locale | null = null;

/** 只接受受支持的标签；`en-US` / `zh-Hans` 归一到两个 catalog。 */
export function parseLocale(raw: string | null | undefined): Locale | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'en' || value.startsWith('en-') || value.startsWith('en_')) return 'en';
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh-CN';
  return null;
}

/** 纯函数：stored 优先，其次 navigator.language；非法 / 缺失回退 zh-CN。 */
export function resolveLocale(
  stored: string | null | undefined,
  navigatorLanguage?: string | null,
): Locale {
  return parseLocale(stored) ?? parseLocale(navigatorLanguage) ?? DEFAULT_LOCALE;
}

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function detectLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = readStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const navigatorLanguage =
    typeof navigator === 'undefined' ? undefined : (navigator.language ?? undefined);
  return resolveLocale(stored, navigatorLanguage);
}

export function getLocale(): Locale {
  if (current === null) current = detectLocale();
  return current;
}

/** 切换语言：持久化（best-effort）+ 同步 `<html lang>` + 通知订阅者。 */
export function setLocale(next: Locale): void {
  if (next !== 'zh-CN' && next !== 'en') return;
  const changed = getLocale() !== next;
  current = next;
  try {
    readStorage()?.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // 隐私模式 / 配额满：语言仍在本会话内生效。
  }
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = next;
  } catch {
    // 非浏览器环境（SSR / 测试）忽略。
  }
  if (!changed) return;
  for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React 绑定：locale 变化时触发所在组件重渲染。 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 翻译；未命中回退 zh-CN，再回退 key。永不抛错。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = getLocale();
  const template = CATALOGS[locale][key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, params);
}
