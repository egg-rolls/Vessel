/**
 * UI 设置持久化（0.11 DECISION-021 §3.2）。
 *
 * 写用户配置 `~/.vessel/config.yaml` 的 `ui.language`（YAML snake_case）。
 * 复用 `permission-store` 的写入风格：YAML parse/stringify、同目录临时文件 + rename、
 * 临时文件 0600；只改目标键，根对象与 `ui` 块的其它键保留。
 *
 * 本模块属于应用层：core / config 不感知文件写入；TUI 的 `/settings`
 * 经 `ReplContext.settings.setLanguage()` 调用这里，返回后由调用方 `setLocale()`。
 *
 * @module vessel/ui-settings
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getUserConfigPath } from '../packages/config/src/index';
import { type Locale, resolveLocale } from './i18n';

/** 支持的 UI 语言（与 CLI / TUI catalog 一致） */
export type UiLanguage = Locale;

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(['zh-CN', 'en']);

/** 存储选项 */
export interface UiSettingsStoreOptions {
  /** 用户配置文件路径；缺省 `~/.vessel/config.yaml` */
  configPath?: string;
}

/**
 * DECISION-021 §3.2 的 ReplContext.settings 结构。
 * tui 合并后可直接改用其导出的 `ReplSettingsControl`（字段一致）。
 */
export interface ReplSettingsControlLike {
  language: UiLanguage;
  /** 写入用户配置 ui.language；返回后调用方立即 setLocale */
  setLanguage(locale: UiLanguage): Promise<void>;
}

/** `createReplSettings` 选项 */
export interface CreateReplSettingsOptions extends UiSettingsStoreOptions {
  /** locale 解析用环境变量；缺省 process.env（测试注入） */
  env?: Record<string, string | undefined>;
  /** config.ui.language；通常为已加载配置的值 */
  configLanguage?: string;
}

/** 是否为受支持的 UI 语言 */
export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取 YAML 根对象；不存在/空文档返回 {}；根不是对象时抛错 */
async function readRoot(configPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ui_settings_read_failed: ${configPath}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    // 不回显文件内容（可能含密钥）。
    throw new Error(`ui_settings_parse_failed: ${configPath}: ${messageOf(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error(`ui_settings_invalid_config: ${configPath} must contain a YAML object`);
  }
  return parsed;
}

/** 原子写入（同目录临时文件 + rename）；保留文件其它内容 */
async function writeRoot(configPath: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const body = stringifyYaml(root, { lineWidth: 0 });
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tmp, configPath);
  } catch (error) {
    // Windows 上目标被占用时 rename 可能失败：清理临时文件后显式替换。
    try {
      await unlink(tmp);
    } catch {
      // 忽略清理失败
    }
    try {
      await writeFile(configPath, body, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      throw new Error(`ui_settings_write_failed: ${configPath}: ${messageOf(error)}`);
    }
  }
  // POSIX：rename 后保持 0600；Windows 上 best-effort。
  await chmod(configPath, 0o600).catch(() => {
    // 平台不保证 mode：忽略
  });
}

/**
 * 写入用户配置 `ui.language`，返回后调用方立即 setLocale。
 * 只接受 'zh-CN' / 'en'；其它值抛 `invalid_language`。
 */
export async function setUserLanguage(
  locale: UiLanguage,
  options: UiSettingsStoreOptions = {},
): Promise<void> {
  if (!isUiLanguage(locale)) {
    throw new Error(`invalid_language: ${JSON.stringify(locale)}`);
  }

  const configPath = options.configPath ?? getUserConfigPath();
  const root = await readRoot(configPath);
  const existing = root.ui;
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new Error('ui_settings_invalid_config: ui must be a YAML object');
  }
  root.ui = { ...(existing ?? {}), language: locale };
  await writeRoot(configPath, root);
}

/**
 * 构造注入 `ReplContext.settings` 的控制面。
 * `language` 使用与 CLI / TUI 相同的优先级解析结果。
 */
export function createReplSettings(
  options: CreateReplSettingsOptions = {},
): ReplSettingsControlLike {
  const configPath = options.configPath;
  return {
    language: resolveLocale({
      env: options.env ?? process.env,
      ...(options.configLanguage !== undefined ? { configLanguage: options.configLanguage } : {}),
    }),
    setLanguage: (locale: UiLanguage): Promise<void> =>
      setUserLanguage(locale, configPath !== undefined ? { configPath } : {}),
  };
}
