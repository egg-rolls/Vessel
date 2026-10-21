/**
 * /settings —— 界面设置（语言 / 错误级别 / 输出详略）
 * @module @vessel-agent/tui
 *
 * 语言写入用户配置 `ui.language`（DECISION-021 §3.2）：asm 注入 `ctx.settings` 时
 * 先 await setLanguage，成功后才 setLocale；未注入时只读展示解析结果。
 * 0.15：`errorLevel` / `verbosity` 经注入的 setErrorLevel / setVerbosity 写 YAML。
 * 命令纯函数：不直接 dispatch；Ink 层按 `localeChanged` 重建命令并重渲染。
 */

import { getLocale, type Locale, setLocale, t } from '../i18n/index.js';
import type { ReplContext, ReplErrorLevel, ReplVerbosity } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { CommandEntry } from './commands.js';

const LOCALES: readonly Locale[] = ['zh-CN', 'en'];
const ERROR_LEVELS: readonly ReplErrorLevel[] = ['user', 'all'];
const VERBOSITIES: readonly ReplVerbosity[] = ['minimal', 'normal', 'debug'];

interface UiVisibilityConfig {
  errorLevel?: unknown;
  verbosity?: unknown;
}

function uiConfig(ctx: ReplContext): UiVisibilityConfig {
  return (ctx.config as unknown as { ui?: UiVisibilityConfig }).ui ?? {};
}

function usage(): string {
  return `\n${t('settings.usage')}\n`;
}

function currentErrorLevel(ctx: ReplContext): ReplErrorLevel {
  const injected = ctx.settings?.errorLevel;
  if (injected === 'user' || injected === 'all') return injected;
  return uiConfig(ctx).errorLevel === 'all' ? 'all' : 'user';
}

function currentVerbosity(ctx: ReplContext): ReplVerbosity {
  const injected = ctx.settings?.verbosity;
  if (injected !== undefined && VERBOSITIES.includes(injected)) return injected;
  const configured = uiConfig(ctx).verbosity;
  return configured === 'minimal' || configured === 'debug' ? configured : 'normal';
}

function showCurrent(ctx: ReplContext): string {
  const language = getLocale();
  const lines = [
    '',
    t('settings.current', { language }),
    t('settings.currentVisibility', {
      errorLevel: currentErrorLevel(ctx),
      verbosity: currentVerbosity(ctx),
    }),
  ];
  if (!ctx.settings) lines.push(t('settings.readOnlyUi'));
  lines.push('', t('settings.usage'), '');
  return lines.join('\n');
}

function parseLocale(value: string | undefined): Locale | null {
  return LOCALES.includes(value as Locale) ? (value as Locale) : null;
}

function parseErrorLevel(value: string | undefined): ReplErrorLevel | null {
  return ERROR_LEVELS.includes(value as ReplErrorLevel) ? (value as ReplErrorLevel) : null;
}

function parseVerbosity(value: string | undefined): ReplVerbosity | null {
  return VERBOSITIES.includes(value as ReplVerbosity) ? (value as ReplVerbosity) : null;
}

function readOnly(): string {
  return `\n${t('settings.readOnlyUi')}\n${t('settings.usage')}\n`;
}

export function settingsCommand(): CommandEntry {
  return {
    name: 'settings',
    description: t('command.settings.description'),
    usage:
      '/settings [language <zh-CN|en>] [errorLevel <user|all>] [verbosity <minimal|normal|debug>]',
    category: 'config',
    keywords: ['settings', 'language', 'locale', 'i18n', 'errorLevel', 'verbosity'],
    run: async (args, ctx, _state) => {
      const key = args[0];
      if (args.length === 0) {
        return { handled: true, output: showCurrent(ctx) };
      }
      if (key !== 'language' && key !== 'errorLevel' && key !== 'verbosity') {
        return { handled: true, output: usage() };
      }
      if (args.length === 1) {
        return { handled: true, output: showCurrent(ctx) };
      }
      if (args.length > 2) {
        return { handled: true, output: usage() };
      }

      const requested = args[1];
      if (key === 'language') {
        const locale = parseLocale(requested);
        if (!locale) {
          return {
            handled: true,
            output: `\n${t('settings.invalid', { value: requested ?? '' })}\n${t('settings.usage')}\n`,
          };
        }

        // 未注入控制面：只读，不改变运行中 locale。
        if (!ctx.settings) return { handled: true, output: readOnly() };

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
      }

      if (key === 'errorLevel') {
        const level = parseErrorLevel(requested);
        if (!level) {
          return {
            handled: true,
            output: `\n${t('settings.invalidErrorLevel', { value: requested ?? '' })}\n${t('settings.usage')}\n`,
          };
        }
        if (typeof ctx.settings?.setErrorLevel !== 'function') {
          return { handled: true, output: readOnly() };
        }
        try {
          await ctx.settings.setErrorLevel(level);
        } catch (error) {
          return {
            handled: true,
            output: `\n${t('error.command.settings')}\n${formatRpcError(error)}\n`,
          };
        }
        return {
          handled: true,
          output: `\n${t('settings.errorLevelSwitched', { value: level })}\n`,
        };
      }

      const verbosity = parseVerbosity(requested);
      if (!verbosity) {
        return {
          handled: true,
          output: `\n${t('settings.invalidVerbosity', { value: requested ?? '' })}\n${t('settings.usage')}\n`,
        };
      }
      if (typeof ctx.settings?.setVerbosity !== 'function') {
        return { handled: true, output: readOnly() };
      }
      try {
        await ctx.settings.setVerbosity(verbosity);
      } catch (error) {
        return {
          handled: true,
          output: `\n${t('error.command.settings')}\n${formatRpcError(error)}\n`,
        };
      }
      return {
        handled: true,
        output: `\n${t('settings.verbositySwitched', { value: verbosity })}\n`,
      };
    },
  };
}
