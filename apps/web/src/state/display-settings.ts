/**
 * Settings → Display 的可写键白名单（与服务端 `config.set` 一致）。
 *
 * 只做纯转换：读取 `config.get` 的嵌套/蛇形值，写入时转成 string|boolean|number。
 *
 * q-empty-response 起本表也是**核心运行期设置**的登记处（emptyResponse.*）：
 * 对齐 docs/dev/plans/vscode-settings-design.md 的注册表机制 —— 注册表（S1）落地后
 * 核心 SettingDef 从本表派生（id/key/type/范围即注册表字段），不再另立第二份清单。
 */
export type DisplaySettingType = 'boolean' | 'enum' | 'number' | 'string';

export interface DisplaySettingDef {
  key: string;
  type: DisplaySettingType;
  options?: readonly string[];
  /** i18n key 后缀（settings.display.field.<id>）。 */
  id: string;
  /** number 键的取值范围（含端点；与 config validator 同界）。 */
  min?: number;
  max?: number;
  /** 配置缺省时的展示值（缺省行为 ≠ 空：如 emptyResponse.enabled 缺省 true）。 */
  fallback?: string;
}

export const DISPLAY_SETTINGS: readonly DisplaySettingDef[] = [
  { id: 'verbosity', key: 'ui.verbosity', type: 'enum', options: ['minimal', 'normal', 'debug'] },
  { id: 'showInternalEvents', key: 'ui.showInternalEvents', type: 'boolean' },
  // 0.51：已归档 Team / 已停用 agent 的默认隐藏开关。与 showInternalEvents 同一层
  // （同一个 ui 块、同一条 config.set 写路径），入口也在同一个「显示与可见性」分组。
  { id: 'showArchived', key: 'ui.showArchived', type: 'boolean' },
  { id: 'errorLevel', key: 'ui.errorLevel', type: 'enum', options: ['user', 'all'] },
  { id: 'showProcessErrors', key: 'observability.showProcessErrors', type: 'boolean' },
  { id: 'askUser', key: 'ui.askUser', type: 'boolean' },
  { id: 'showReasoning', key: 'ui.showReasoning', type: 'boolean' },
  { id: 'expandCards', key: 'ui.expandCards', type: 'boolean' },
  {
    id: 'statusBars',
    key: 'ui.statusBars',
    type: 'enum',
    options: ['top', 'bottom', 'both', 'none'],
  },
  { id: 'language', key: 'ui.language', type: 'enum', options: ['zh-CN', 'en'] },
  // 日志中枢（gateway）：与 observability.showProcessErrors 同属 observability，
  // 但单独一个分组。modules 是 map，一期只读（不走 config.set）。
  {
    id: 'logLevel',
    key: 'observability.log.level',
    type: 'enum',
    options: ['debug', 'info', 'warn', 'error'],
  },
  {
    id: 'logColor',
    key: 'observability.log.color',
    type: 'enum',
    options: ['auto', 'always', 'never'],
  },
  { id: 'logFormat', key: 'observability.log.format', type: 'enum', options: ['pretty', 'json'] },
  {
    id: 'logTime',
    key: 'observability.log.time',
    type: 'enum',
    options: ['auto', 'none', 'clock', 'iso'],
  },
  // q-empty-response：空响应兜底（core 运行期设置，非插件域）。缺省 = 启用、重试 2 次、
  // 内置 nudge 文案；fallback 让「未配置」显示真实缺省行为而不是空。
  {
    id: 'emptyResponseEnabled',
    key: 'emptyResponse.enabled',
    type: 'boolean',
    fallback: 'true',
  },
  {
    id: 'emptyResponseSeamless',
    key: 'emptyResponse.seamless',
    type: 'boolean',
    fallback: 'true',
  },
  {
    id: 'emptyResponseMaxRetries',
    key: 'emptyResponse.maxRetries',
    type: 'number',
    min: 0,
    max: 10,
    fallback: '2',
  },
  { id: 'emptyResponseNudge', key: 'emptyResponse.nudge', type: 'string' },
];

/** 日志分组键前缀（Display 页据此拆出「日志（gateway）」分组）。 */
export const LOG_SETTING_PREFIX = 'observability.log.';

/** 空响应兜底键前缀（Display 页据此拆出「运行期（core）」分组）。 */
export const EMPTY_RESPONSE_SETTING_PREFIX = 'emptyResponse.';

/** config.get 回报的一条日志环境变量覆盖（与 core LogEnvOverride 同形）。 */
export interface LogEnvOverrideInfo {
  env: string;
  key: string;
  value: string;
}

/** 读 config.get 的 logEnvOverrides（可选字段；缺失 / 形状不对返回空）。 */
export function readLogEnvOverrides(source: unknown): LogEnvOverrideInfo[] {
  if (!isRecord(source) || !Array.isArray(source.logEnvOverrides)) return [];
  const overrides: LogEnvOverrideInfo[] = [];
  for (const entry of source.logEnvOverrides) {
    if (
      isRecord(entry) &&
      typeof entry.env === 'string' &&
      typeof entry.key === 'string' &&
      typeof entry.value === 'string'
    ) {
      overrides.push({ env: entry.env, key: entry.key, value: entry.value });
    }
  }
  return overrides;
}

/** 读 observability.log.modules（只读展示；键是事件名前缀，值是级别）。 */
export function readLogModules(source: unknown): [string, string][] {
  const value = readPath(source, 'observability.log.modules');
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
}

const BY_KEY = new Map(DISPLAY_SETTINGS.map((setting) => [setting.key, setting]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(source: unknown, key: string): unknown {
  if (!isRecord(source)) return undefined;
  const config = isRecord(source.config) ? source.config : source;
  let current: unknown = config;
  for (const part of key.split('.')) {
    if (!isRecord(current)) return undefined;
    // snake_case 回退：showInternalEvents → show_internal_events
    const snake = part.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    current = current[part] !== undefined ? current[part] : current[snake];
  }
  return current;
}

/** 读取当前值；缺失回落到登记的缺省展示值（无则空串），布尔转 "true"/"false"。 */
export function readDisplayValue(source: unknown, key: string): string {
  const value = readPath(source, key);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === undefined) return BY_KEY.get(key)?.fallback ?? '';
  return '';
}

/**
 * 服务端快照 + 本地乐观 overlay：pending 优先。
 * 保存中到达的旧快照不会覆盖用户刚选的值。
 */
export function resolveDisplayValues(
  source: unknown,
  pending: Readonly<Record<string, string>>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const setting of DISPLAY_SETTINGS) {
    next[setting.key] = readDisplayValue(source, setting.key);
  }
  return { ...next, ...pending };
}

/** 一条待确认的乐观写入；清 overlay 时必须按键+值匹配，避免清掉更新的选择。 */
export interface DisplayPendingEntry {
  key: string;
  value: string;
}

/** pending 中已被服务端快照确认的条目（key+value）；用于按值清除 overlay。 */
export function confirmedDisplayKeys(
  source: unknown,
  pending: Readonly<Record<string, string>>,
): DisplayPendingEntry[] {
  const confirmed: DisplayPendingEntry[] = [];
  for (const [key, value] of Object.entries(pending)) {
    if (readDisplayValue(source, key) === value) confirmed.push({ key, value });
  }
  return confirmed;
}

/** 把表单值转成 `config.set` 的 value；非法返回 undefined。 */
export function toConfigValue(
  setting: DisplaySettingDef,
  raw: string,
): string | boolean | number | undefined {
  if (setting.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (setting.type === 'number') {
    const value = Number(raw);
    const min = setting.min ?? Number.NEGATIVE_INFINITY;
    const max = setting.max ?? Number.POSITIVE_INFINITY;
    if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      return undefined;
    }
    return value;
  }
  if (setting.type === 'string') {
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
  }
  return setting.options?.includes(raw) === true ? raw : undefined;
}

export function isDisplaySettingKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function displaySettingFor(key: string): DisplaySettingDef | undefined {
  return BY_KEY.get(key);
}
