/**
 * UI 设置持久化（0.11 DECISION-021 §3.2）。
 *
 * 写用户配置 `~/.vessel/config.yaml` 的已知键（YAML snake_case）：
 * 0.11 只有 `ui.language`；0.11.1 增加 `ui.showReasoning` 与 `agent.cwd`；
 * 0.13 增加 `ui.statusBars`（YAML `ui.status_bars`）；0.14 增加可见性键；
 * 0.15 增加 `ui.askUser`（YAML `ui.ask_user`）。
 * 写入风格：YAML parse/stringify、同目录临时文件 + rename、临时文件 0600；
 * 只改目标键，根对象与目标块的其它键保留。读写原语（readUserConfigRoot /
 * writeUserConfigRoot）与跨进程写锁（withConfigLock）位于 `@vessel-agent/config`
 * （model-registry P1 前置重构移入）；本模块只保留 UI settings 业务函数。
 *
 * 本模块属于应用层；TUI 的 `/settings`
 * 经 `ReplContext.settings.setLanguage()` 调用这里，返回后由调用方 `setLocale()`。
 *
 * @module vessel/ui-settings
 */

import {
  DEFAULT_ENV_CADENCE,
  type EnvScopeWord,
  getUserConfigPath,
  PINNED_REQUEST_SCOPES,
  readUserConfigRoot,
  type UiStatusBars,
  withConfigLock,
  writeUserConfigRoot,
} from '../../packages/config/src/index';
import { ENV_CADENCE_VALUES, ENV_CHANNEL_VALUES } from '../../packages/core/src/index';
import { type Locale, resolveLocale } from '../i18n';

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

/**
 * `observability.log.*` 允许值（日志中枢；与 config validator / serve ENUM_KEYS 一致）。
 * CLI / RPC / Web 共用这一份枚举，避免三处各写一套漂移。
 */
export const LOG_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  'observability.log.level': ['debug', 'info', 'warn', 'error'],
  'observability.log.color': ['auto', 'always', 'never'],
  'observability.log.format': ['pretty', 'json'],
  'observability.log.time': ['auto', 'none', 'clock', 'iso'],
};

/**
 * `ui.depthColor.*` number 键值域（depth-color §6.1；与 config validator /
 * serve config.set NUMBER_KEYS 同界）。L 上/下界 = WCAG 对比度护栏（实证锁定）。
 */
const DEPTH_COLOR_RANGES: Readonly<
  Record<string, { min: number; max: number; maxExclusive?: boolean }>
> = {
  'ui.depthColor.rootHue': { min: 0, max: 360, maxExclusive: true },
  'ui.depthColor.hueStep': { min: 0, max: 360 },
  'ui.depthColor.lightnessLight': { min: 0.3, max: 0.51 },
  'ui.depthColor.chromaLight': { min: 0, max: 0.37 },
  'ui.depthColor.lightnessDark': { min: 0.73, max: 0.95 },
  'ui.depthColor.chromaDark': { min: 0, max: 0.37 },
};

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

/** `vessel config set` 支持的键（0.11.1 扩展；0.13 statusBars；0.14 可见性） */
export type SettableConfigKey =
  | 'ui.language'
  | 'ui.showReasoning'
  | 'ui.statusBars'
  | 'ui.verbosity'
  | 'ui.showInternalEvents'
  | 'ui.messageVisibility.reasoning'
  | 'ui.messageVisibility.tools'
  | 'ui.messageVisibility.environment'
  | 'ui.messageVisibility.source'
  | 'ui.messageVisibility.system'
  | 'ui.showArchived'
  | 'ui.errorLevel'
  | 'ui.askUser'
  | 'ui.expandCards'
  | 'observability.showProcessErrors'
  | 'observability.log.level'
  | 'observability.log.color'
  | 'observability.log.format'
  | 'observability.log.time'
  | 'agent.cwd'
  // q-team-limit-config：Team present 成员上限（YAML agent.team_member_limit）。
  | 'agent.teamMemberLimit'
  // q-vision-image-budget-fix ①B：图片 token 预算比例（YAML vision.image_token_budget_ratio）。
  | 'vision.imageTokenBudgetRatio'
  // q-empty-response：空响应兜底（core 设置面；YAML `empty_response`）。
  | 'emptyResponse.enabled'
  | 'emptyResponse.seamless'
  | 'emptyResponse.maxRetries'
  | 'emptyResponse.nudge'
  // q-kanban-proxy：看板 board.json 路径（YAML kanban.board_path）。
  | 'kanban.boardPath'
  // auto-gc P1：自动回收四键（YAML `auto_prune`；WebUI 设置面 P3 消费同一白名单）。
  | 'autoPrune.enabled'
  | 'autoPrune.intervalHours'
  | 'autoPrune.olderThanHours'
  | 'autoPrune.dryRun'
  // depth-color：会话卡树深度配色七键（YAML `ui.depth_color`；D7 浮点键）。
  | 'ui.depthColor.enabled'
  | 'ui.depthColor.rootHue'
  | 'ui.depthColor.hueStep'
  | 'ui.depthColor.lightnessLight'
  | 'ui.depthColor.chromaLight'
  | 'ui.depthColor.lightnessDark'
  | 'ui.depthColor.chromaDark'
  // q-env-granularity（P2 §4.3）：环境信息粒度两轴（YAML `env_injection`）。
  // default + scopes/channels 全词表（R-10 单源：词联合派生自 config `EnvScopeWord`
  // = DEFAULT_ENV_CADENCE 同一张表，含 health）；三层键先例 observability.log.*。
  | 'envInjection.default'
  | `envInjection.scopes.${EnvScopeWord}`
  | `envInjection.channels.${EnvScopeWord}`;

interface ConfigSetTarget {
  /** YAML 根下的块名 */
  block: string;
  /** 块内的 YAML 键（snake_case） */
  yamlKey: string;
  /** 中间子块（三层键，如 observability.log.level 的 `log`）；缺省 = 两层 */
  subBlock?: string;
}

/**
 * q-env-granularity（P2 §4.3）：env_injection 的 scope 词表。
 * R-10 单源：派生自 config `DEFAULT_ENV_CADENCE`（17 词含 health），与 serve
 * SETTABLE_KEYS / Web settings-registry 同一张表，漂移结构上不可能。
 * scopes / channels 两子块各全词表键，三层键（block=env_injection, subBlock=scopes|channels）。
 */
const ENV_GRANULARITY_SCOPES: readonly string[] = Object.keys(DEFAULT_ENV_CADENCE);

const ENV_INJECTION_SET_TARGETS: Readonly<Record<string, ConfigSetTarget>> = Object.fromEntries([
  ['envInjection.default', { block: 'env_injection', yamlKey: 'default' }],
  ...ENV_GRANULARITY_SCOPES.map((scope) => [
    `envInjection.scopes.${scope}`,
    { block: 'env_injection', subBlock: 'scopes', yamlKey: scope },
  ]),
  ...ENV_GRANULARITY_SCOPES.map((scope) => [
    `envInjection.channels.${scope}`,
    { block: 'env_injection', subBlock: 'channels', yamlKey: scope },
  ]),
]);

const CONFIG_SET_TARGETS: Readonly<Record<string, ConfigSetTarget>> = {
  'ui.language': { block: 'ui', yamlKey: 'language' },
  'ui.showReasoning': { block: 'ui', yamlKey: 'show_reasoning' },
  'ui.statusBars': { block: 'ui', yamlKey: 'status_bars' },
  'ui.verbosity': { block: 'ui', yamlKey: 'verbosity' },
  'ui.showInternalEvents': { block: 'ui', yamlKey: 'show_internal_events' },
  // q-msg-visibility：消息显示五 toggle（YAML 子块 message_visibility）。
  'ui.messageVisibility.reasoning': {
    block: 'ui',
    subBlock: 'message_visibility',
    yamlKey: 'reasoning',
  },
  'ui.messageVisibility.tools': { block: 'ui', subBlock: 'message_visibility', yamlKey: 'tools' },
  'ui.messageVisibility.environment': {
    block: 'ui',
    subBlock: 'message_visibility',
    yamlKey: 'environment',
  },
  'ui.messageVisibility.source': { block: 'ui', subBlock: 'message_visibility', yamlKey: 'source' },
  'ui.messageVisibility.system': { block: 'ui', subBlock: 'message_visibility', yamlKey: 'system' },
  'ui.showArchived': { block: 'ui', yamlKey: 'show_archived' },
  'ui.errorLevel': { block: 'ui', yamlKey: 'error_level' },
  'ui.askUser': { block: 'ui', yamlKey: 'ask_user' },
  'ui.expandCards': { block: 'ui', yamlKey: 'expand_cards' },
  'observability.showProcessErrors': {
    block: 'observability',
    yamlKey: 'show_process_errors',
  },
  'observability.log.level': { block: 'observability', subBlock: 'log', yamlKey: 'level' },
  'observability.log.color': { block: 'observability', subBlock: 'log', yamlKey: 'color' },
  'observability.log.format': { block: 'observability', subBlock: 'log', yamlKey: 'format' },
  'observability.log.time': { block: 'observability', subBlock: 'log', yamlKey: 'time' },
  'agent.cwd': { block: 'agent', yamlKey: 'cwd' },
  'agent.teamMemberLimit': { block: 'agent', yamlKey: 'team_member_limit' },
  'vision.imageTokenBudgetRatio': { block: 'vision', yamlKey: 'image_token_budget_ratio' },
  'emptyResponse.enabled': { block: 'empty_response', yamlKey: 'enabled' },
  'emptyResponse.seamless': { block: 'empty_response', yamlKey: 'seamless' },
  'emptyResponse.maxRetries': { block: 'empty_response', yamlKey: 'max_retries' },
  'emptyResponse.nudge': { block: 'empty_response', yamlKey: 'nudge' },
  'kanban.boardPath': { block: 'kanban', yamlKey: 'board_path' },
  'autoPrune.enabled': { block: 'auto_prune', yamlKey: 'enabled' },
  'autoPrune.intervalHours': { block: 'auto_prune', yamlKey: 'interval_hours' },
  'autoPrune.olderThanHours': { block: 'auto_prune', yamlKey: 'older_than_hours' },
  'autoPrune.dryRun': { block: 'auto_prune', yamlKey: 'dry_run' },
  // depth-color：ui.depth_color 子块（与 message_visibility 同款三层键）。
  'ui.depthColor.enabled': { block: 'ui', subBlock: 'depth_color', yamlKey: 'enabled' },
  'ui.depthColor.rootHue': { block: 'ui', subBlock: 'depth_color', yamlKey: 'root_hue' },
  'ui.depthColor.hueStep': { block: 'ui', subBlock: 'depth_color', yamlKey: 'hue_step' },
  'ui.depthColor.lightnessLight': {
    block: 'ui',
    subBlock: 'depth_color',
    yamlKey: 'lightness_light',
  },
  'ui.depthColor.chromaLight': { block: 'ui', subBlock: 'depth_color', yamlKey: 'chroma_light' },
  'ui.depthColor.lightnessDark': {
    block: 'ui',
    subBlock: 'depth_color',
    yamlKey: 'lightness_dark',
  },
  'ui.depthColor.chromaDark': { block: 'ui', subBlock: 'depth_color', yamlKey: 'chroma_dark' },
  // q-env-granularity：env_injection default + scopes/channels 全词表（单源派生展开）。
  ...ENV_INJECTION_SET_TARGETS,
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
  value: string | boolean | number,
  options: UiSettingsStoreOptions = {},
): Promise<void> {
  const target = CONFIG_SET_TARGETS[key];
  if (target === undefined) {
    throw new Error(`invalid_key: ${key}`);
  }
  if (key === 'ui.language' && !isUiLanguage(value)) {
    throw new Error(`invalid_language: ${JSON.stringify(value)}`);
  }
  if (
    (key === 'ui.showReasoning' ||
      key === 'ui.askUser' ||
      key === 'ui.expandCards' ||
      key === 'ui.showArchived') &&
    typeof value !== 'boolean'
  ) {
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
  // q-msg-visibility：五 toggle 均为布尔。
  if (key.startsWith('ui.messageVisibility.') && typeof value !== 'boolean') {
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
  const logEnum = LOG_ENUM_VALUES[key];
  if (logEnum !== undefined && (typeof value !== 'string' || !logEnum.includes(value))) {
    throw new Error(`invalid_enum: ${key}=${JSON.stringify(value)}`);
  }
  if (key === 'agent.cwd' && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`invalid_path: ${JSON.stringify(value)}`);
  }
  // q-team-limit-config：与 config validator / serve config.set 同形状同界
  // （正整数 ≥1，无人为上限）。构造期注入，写后需重启生效。
  if (
    key === 'agent.teamMemberLimit' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error(`invalid_number: ${key}=${JSON.stringify(value)} (integer >= 1)`);
  }
  // q-vision-image-budget-fix ①B：与 config validator / serve config.set 同界（[0,1] 浮点）。
  if (
    key === 'vision.imageTokenBudgetRatio' &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error(`invalid_number: ${key}=${JSON.stringify(value)} (finite number in [0, 1])`);
  }
  // q-kanban-proxy：与 config validator 同界（非空字符串）；~ 展开 / 相对 cwd
  // 解析在装配层（与启动装配同一表达式），这里不做路径存在性校验。
  if (key === 'kanban.boardPath' && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`invalid_path: ${JSON.stringify(value)}`);
  }
  // q-empty-response：与 config validator / serve config.set 同形状同界。
  if (
    (key === 'emptyResponse.enabled' || key === 'emptyResponse.seamless') &&
    typeof value !== 'boolean'
  ) {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (
    key === 'emptyResponse.maxRetries' &&
    (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10)
  ) {
    throw new Error(`invalid_number: ${key}=${JSON.stringify(value)} (integer in [0, 10])`);
  }
  if (key === 'emptyResponse.nudge' && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`invalid_nudge: ${JSON.stringify(value)}`);
  }
  // auto-gc P1：与 config validator / 未来设置面（§6.1）同形状同界。
  if ((key === 'autoPrune.enabled' || key === 'autoPrune.dryRun') && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  if (
    key === 'autoPrune.intervalHours' &&
    (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 168)
  ) {
    throw new Error(`invalid_number: ${key}=${JSON.stringify(value)} (integer in [1, 168])`);
  }
  if (
    key === 'autoPrune.olderThanHours' &&
    (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8760)
  ) {
    throw new Error(`invalid_number: ${key}=${JSON.stringify(value)} (integer in [0, 8760])`);
  }
  // depth-color：与 config validator / serve config.set 同形状同界（D7 浮点键）。
  if (key === 'ui.depthColor.enabled' && typeof value !== 'boolean') {
    throw new Error(`invalid_boolean: ${JSON.stringify(value)}`);
  }
  const depthColorRange = DEPTH_COLOR_RANGES[key];
  if (depthColorRange !== undefined) {
    const upperOk =
      typeof value === 'number' &&
      (depthColorRange.maxExclusive === true
        ? value < depthColorRange.max
        : value <= depthColorRange.max);
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < depthColorRange.min ||
      !upperOk
    ) {
      const upper = depthColorRange.maxExclusive === true ? ')' : ']';
      throw new Error(
        `invalid_number: ${key}=${JSON.stringify(value)} (number in [${depthColorRange.min}, ${depthColorRange.max}${upper})`,
      );
    }
  }

  // q-env-granularity（P2 §4.3）：env_injection 两轴枚举校验（与 config validator 同口径）。
  // scopes/default ∈ request|run|off；pinned（trim/model）拒 request（前缀不变量），off 允许（D6）。
  // channels ∈ model+ui|ui-only。
  if (key === 'envInjection.default' || key.startsWith('envInjection.scopes.')) {
    if (typeof value !== 'string' || !(ENV_CADENCE_VALUES as readonly string[]).includes(value)) {
      throw new Error(`invalid_enum: ${key}=${JSON.stringify(value)} (request|run|off)`);
    }
    const scope = key.startsWith('envInjection.scopes.')
      ? key.slice('envInjection.scopes.'.length)
      : undefined;
    if (
      value === 'request' &&
      scope !== undefined &&
      (PINNED_REQUEST_SCOPES as readonly string[]).includes(scope)
    ) {
      throw new Error(`invalid_pinned: ${key}=request (pinned to run; off is allowed)`);
    }
  }
  if (key.startsWith('envInjection.channels.')) {
    if (typeof value !== 'string' || !(ENV_CHANNEL_VALUES as readonly string[]).includes(value)) {
      throw new Error(`invalid_enum: ${key}=${JSON.stringify(value)} (model+ui|ui-only)`);
    }
  }

  const configPath = options.configPath ?? getUserConfigPath();
  await withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const existing = root[target.block];
    if (existing !== undefined && existing !== null && !isRecord(existing)) {
      throw new Error(`ui_settings_invalid_config: ${target.block} must be a YAML object`);
    }
    const blockMap: Record<string, unknown> = { ...(existing ?? {}) };
    if (target.subBlock !== undefined) {
      // 三层键（observability.log.*）：子块不存在就建，存在但非对象则报错（不吞用户数据）。
      const sub = blockMap[target.subBlock];
      if (sub !== undefined && sub !== null && !isRecord(sub)) {
        throw new Error(
          `ui_settings_invalid_config: ${target.block}.${target.subBlock} must be a YAML object`,
        );
      }
      blockMap[target.subBlock] = { ...(sub ?? {}), [target.yamlKey]: value };
    } else {
      blockMap[target.yamlKey] = value;
    }
    root[target.block] = blockMap;
    await writeUserConfigRoot(configPath, root);
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
