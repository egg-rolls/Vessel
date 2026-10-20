/**
 * /settings —— 界面设置（当前：语言）
 * @module @vessel/tui
 *
 * 语言写入用户配置 `ui.language`（DECISION-021 §3.2）：asm 注入 `ctx.settings` 时
 * 先 await setLanguage，成功后才 setLocale；未注入时只读展示解析结果。
 * 命令纯函数：不直接 dispatch；Ink 层按 `localeChanged` 重建命令并重渲染。
 */

import { getLocale, type Locale, setLocale, t } from '../i18n/index.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { CommandEntry } from './commands.js';

const LOCALES: readonly Locale[] = ['zh-CN', 'en'];

function usage(): string {
  return `\n${t('settings.usage')}\n`;
}

function showCurrent(ctx: ReplContext): string {
  const language = getLocale();
  const lines = ['', t('settings.current', { language })];
  if (!ctx.settings) lines.push(t('settings.readOnly', { language }));
  lines.push('', t('settings.usage'), '');
  return lines.join('\n');
}

function parseLocale(value: string | undefined): Locale | null {
  return LOCALES.includes(value as Locale) ? (value as Locale) : null;
}

export function settingsCommand(): CommandEntry {
  return {
    name: 'settings',
    description: t('command.settings.description'),
    usage: '/settings [language <zh-CN|en>]',
    category: 'config',
    keywords: ['settings', 'language', 'locale', 'i18n'],
    run: async (args, ctx, _state) => {
      if (args.length === 0 || (args[0] === 'language' && args.length === 1)) {
        return { handled: true, output: showCurrent(ctx) };
      }
      if (args[0] !== 'language' || args.length > 2) {
        return { handled: true, output: usage() };
      }

      const requested = args[1];
      const locale = parseLocale(requested);
      if (!locale) {
        return {
          handled: true,
          output: `\n${t('settings.invalid', { value: requested ?? '' })}\n${t('settings.usage')}\n`,
        };
      }

      // 未注入控制面：只读，不改变运行中 locale。
      if (!ctx.settings) {
        return {
          handled: true,
          output: `\n${t('settings.readOnly', { language: getLocale() })}\n${t('settings.usage')}\n`,
        };
      }

      try {
        await ctx.settings.setLanguage(locale);
      } catch (error) {
        return {
          handled: true,
          output: `\n${t('error.command.settings')}\n${formatRpcError(error)}\n`,
        };
      }

      // 只有持久化成功后才切换运行中 locale；重渲染由 Ink 层收到 localeChanged 触发。
      setLocale(locale);
      return {
        handled: true,
        output: `\n${t('settings.switched', { language: locale })}\n`,
        localeChanged: true,
      };
    },
  };
}
