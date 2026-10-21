/**
 * UI 设置持久化（0.11 DECISION-021 §3.2）。
 *
 * 写用户配置 `~/.vessel/config.yaml` 的已知键（YAML snake_case）：
 * 0.11 只有 `ui.language`；0.11.1 增加 `ui.showReasoning` 与 `agent.cwd`；
 * 0.13 增加 `ui.statusBars`（YAML `ui.status_bars`）；0.14 增加可见性键；
 * 0.15 增加 `ui.askUser`（YAML `ui.ask_user`）。
 * 复用 `permission-store` 的写入风格：YAML parse/stringify、同目录临时文件 + rename、
 * 临时文件 0600；只改目标键，根对象与目标块的其它键保留。
 *
 * 本模块属于应用层：core / config 不感知文件写入；TUI 的 `/settings`
 * 经 `ReplContext.settings.setLanguage()` 调用这里，返回后由调用方 `setLocale()`。
 *
 * @module vessel/ui-settings
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getUserConfigPath, type UiStatusBars } from '../packages/config/src/index';
import { type Locale, resolveLocale } from './i18n';

/** 支持的 UI 语言（与 CLI / TUI catalog 一致） */
export type UiLanguage = Locale;

/** `ui.errorLevel`（0.15 TUI `/settings errorLevel`） */
export type UiErrorLevel = 'user' | 'all';

/** `ui.verbosity`（0.15 TUI `/settings verbosity`） */
export type UiVerbosity = 'minimal' | 'normal' | 'debug';

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(['zh-CN', 'en']);

/** `ui.statusBars` 允许值（0.13） */
const SUPPORTED_STATUS_BARS: ReadonlySet<string> = new Set(['top', 'bottom', 'both', 'none']);

/** `ui.verbosity` 允许值（0.14） */
const SUPPORTED_VERBOSITY: ReadonlySet<string> = new Set(['minimal', 'normal', 'debug']);

/** `ui.errorLevel` 允许值（0.14） */
const SUPPORTED_ERROR_LEVELS: ReadonlySet<string> = new Set(['user', 'all']);

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
  /** 当前状态栏位置；未配置时为 undefined（0.13） */
  statusBars: UiStatusBars | undefined;
  /** 写入用户配置 ui.status_bars；成功后就地更新 statusBars（0.13） */
  setStatusBars(value: UiStatusBars): Promise<void>;
  /** 当前 ui.errorLevel；未配置时 undefined（0.15） */
  errorLevel?: UiErrorLevel;
  /** 写入用户配置 ui.error_level（0.15） */
  setErrorLevel?(value: UiErrorLevel): Promise<void>;
  /** 当前 ui.verbosity；未配置时 undefined（0.15） */
  verbosity?: UiVerbosity;
  /** 写入用户配置 ui.verbosity（0.15） */
  setVerbosity?(value: UiVerbosity): Promise<void>;
}

/** `createReplSettings` 选项 */
export interface CreateReplSettingsOptions extends UiSettingsStoreOptions {
  /** locale 解析用环境变量；缺省 process.env（测试注入） */
  env?: Record<string, string | undefined>;
  /** config.ui.language；通常为已加载配置的值 */
  configLanguage?: string;
  /** config.ui.statusBars；通常为已加载配置的值（0.13） */
  configStatusBars?: string;
  /** config.ui.errorLevel（0.15） */
  configErrorLevel?: string;
  /** config.ui.verbosity（0.15） */
  configVerbosity?: string;
}

/** 是否为受支持的 UI 语言 */
export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.has(value);
}

/** 是否为受支持的状态栏位置（0.13） */
export function isUiStatusBars(value: unknown): value is UiStatusBars {
  return typeof value === 'string' && SUPPORTED_STATUS_BARS.has(value);
}

/** 是否为受支持的输出详略（0.14） */
export function isUiVerbosity(value: unknown): boolean {
  return typeof value === 'string' && SUPPORTED_VERBOSITY.has(value);
}

/** 是否为受支持的错误展示层级（0.14） */
export function isUiErrorLevel(value: unknown): boolean {
  return typeof value === 'string' && SUPPORTED_ERROR_LEVELS.has(value);
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

/** `vessel config set` 支持的键（0.11.1 扩展；0.13 statusBars；0.14 可见性） */
export type SettableConfigKey =
  | 'ui.language'
  | 'ui.showReasoning'
  | 'ui.statusBars'
  | 'ui.verbosity'
  | 'ui.showInternalEvents'
  | 'ui.errorLevel'
  | 'ui.askUser'
  | 'observability.showProcessErrors'
  | 'agent.cwd';

interface ConfigSetTarget {
  /** YAML 根下的块名 */
  block: string;
  /** 块内的 YAML 键（snake_case） */
  yamlKey: string;
}

const CONFIG_SET_TARGETS: Readonly<Record<SettableConfigKey, ConfigSetTarget>> = {
  'ui.language': { block: 'ui', yamlKey: 'language' },
  'ui.showReasoning': { block: 'ui', yamlKey: 'show_reasoning' },
  'ui.statusBars': { block: 'ui', yamlKey: 'status_bars' },
  'ui.verbosity': { block: 'ui', yamlKey: 'verbosity' },
  'ui.showInternalEvents': { block: 'ui', yamlKey: 'show_internal_events' },
  'ui.errorLevel': { block: 'ui', yamlKey: 'error_level' },
  'ui.askUser': { block: 'ui', yamlKey: 'ask_user' },
  'observability.showProcessErrors': {
    block: 'observability',
    yamlKey: 'show_process_errors',
  },
  'agent.cwd': { block: 'agent', yamlKey: 'cwd' },
};

/** 是否为支持的 `config set` 键 */
export function isSettableConfigKey(value: string): value is SettableConfigKey {
  return Object.hasOwn(CONFIG_SET_TARGETS, value);
}

/**
 * 写入用户配置的单个已知键（保留其它键与块内其它键）。
 * 值先按键校验：语言枚举 / 布尔 / 非空路径；写入失败抛 `ui_settings_*`。
 */
export async function setUserConfigValue(
  key: SettableConfigKey,
  value: string | boolean,
  options: UiSettingsStoreOptions = {},
): Promise<void> {
  const target = CONFIG_SET_TARGETS[key];
  if (key === 'ui.language' && !isUiLanguage(value)) {
    throw new Error(`invalid_language: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.showReasoning' && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.statusBars' && !isUiStatusBars(value)) {
    throw new Error(`invalid_status_bars: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.verbosity' && !isUiVerbosity(value)) {
    throw new Error(`invalid_verbosity: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.showInternalEvents' && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.errorLevel' && !isUiErrorLevel(value)) {
    throw new Error(`invalid_error_level: ${JSON.stringify(value)}`);
  }
  if (key === 'ui.askUser' && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (key === 'observability.showProcessErrors' && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (key === 'agent.cwd' && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`invalid_path: ${JSON.stringify(value)}`);
  }

  const configPath = options.configPath ?? getUserConfigPath();
  const root = await readRoot(configPath);
  const existing = root[target.block];
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new Error(`ui_settings_invalid_config: ${target.block} must be a YAML object`);
  }
  root[target.block] = { ...(existing ?? {}), [target.yamlKey]: value };
  await writeRoot(configPath, root);
}

/**
 * 写入用户配置 `ui.language`，返回后调用方立即 setLocale。
 * 只接受 'zh-CN' / 'en'；其它值抛 `invalid_language`。
 */
export async function setUserLanguage(
  locale: UiLanguage,
  options: UiSettingsStoreOptions = {},
): Promise<void> {
  await setUserConfigValue('ui.language', locale, options);
}

/**
 * 构造注入 `ReplContext.settings` 的控制面。
 * `language` 使用与 CLI / TUI 相同的优先级解析结果。
 */
export function createReplSettings(
  options: CreateReplSettingsOptions = {},
): ReplSettingsControlLike {
  const configPath = options.configPath;
  let statusBars: UiStatusBars | undefined = isUiStatusBars(options.configStatusBars)
    ? options.configStatusBars
    : undefined;
  let errorLevel: UiErrorLevel | undefined = isUiErrorLevel(options.configErrorLevel)
    ? (options.configErrorLevel as UiErrorLevel)
    : undefined;
  let verbosity: UiVerbosity | undefined = isUiVerbosity(options.configVerbosity)
    ? (options.configVerbosity as UiVerbosity)
    : undefined;
  return {
    language: resolveLocale({
      env: options.env ?? process.env,
      ...(options.configLanguage !== undefined ? { configLanguage: options.configLanguage } : {}),
    }),
    setLanguage: (locale: UiLanguage): Promise<void> =>
      setUserLanguage(locale, configPath !== undefined ? { configPath } : {}),
    get statusBars(): UiStatusBars | undefined {
      return statusBars;
    },
    setStatusBars: async (value: UiStatusBars): Promise<void> => {
      await setUserConfigValue(
        'ui.statusBars',
        value,
        configPath !== undefined ? { configPath } : {},
      );
      statusBars = value;
    },
    get errorLevel(): UiErrorLevel | undefined {
      return errorLevel;
    },
    setErrorLevel: async (value: UiErrorLevel): Promise<void> => {
      await setUserConfigValue(
        'ui.errorLevel',
        value,
        configPath !== undefined ? { configPath } : {},
      );
      errorLevel = value;
    },
    get verbosity(): UiVerbosity | undefined {
      return verbosity;
    },
    setVerbosity: async (value: UiVerbosity): Promise<void> => {
      await setUserConfigValue(
        'ui.verbosity',
        value,
        configPath !== undefined ? { configPath } : {},
      );
      verbosity = value;
    },
  };
}
