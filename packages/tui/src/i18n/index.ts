/**
 * TUI i18n：locale 解析与 catalog 查表。
 * @module @vessel-agent/tui/i18n
 *
 * locale 在 REPL 启动时解析一次，运行中不切换。
 * 缺失 key 回退 zh-CN，再回退 key 本身；不抛错、不打印。
 */

import { en } from './messages/en.js';
import { type MessageKey, zhCN } from './messages/zh-CN.js';

export type { MessageKey };

export type Locale = 'zh-CN' | 'en';

const CATALOGS: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  en,
};

let currentLocale: Locale = 'zh-CN';

/** `zh` / `zh-*` / `zh_*`（可带 `.UTF-8`）→ zh-CN；`en` / `en-*` → en；其它 undefined */
function normalizeLocale(value: string | undefined): Locale | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const [base = ''] = trimmed.toLowerCase().split('.');
  const tag = base.replace(/_/g, '-');
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN';
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return undefined;
}

/** 优先级：VESSEL_LANG > configLanguage > LANG > LC_ALL > zh-CN；非法值跳过该层。 */
export function resolveLocale(input: {
  env?: Record<string, string | undefined>;
  configLanguage?: string;
}): Locale {
  const env = input.env ?? {};
  const candidates = [env.VESSEL_LANG, input.configLanguage, env.LANG, env.LC_ALL];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return 'zh-CN';
}

export function setLocale(locale: Locale): void {
  currentLocale = locale in CATALOGS ? locale : 'zh-CN';
}

export function getLocale(): Locale {
  return currentLocale;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/** 查表并插值；缺参数保留 `{name}` 原文。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const template = CATALOGS[currentLocale][key] ?? zhCN[key as MessageKey] ?? key;
  return params ? interpolate(template, params) : template;
}
