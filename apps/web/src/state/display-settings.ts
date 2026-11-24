/**
 * Settings → Display 的可写键白名单（与服务端 `config.set` 一致）。
 *
 * 只做纯转换：读取 `config.get` 的嵌套/蛇形值，写入时转成 string|boolean|number。
 *
 * S6 反转（vscode-settings-design §2.2）：单一事实源 = settings-registry 核心键表；
 * 本文件是**派生兼容层**——DISPLAY_SETTINGS 从 CORE_SETTINGS 反向派生（保留导出），
 * 值读取/overlay 工具函数继续服务弹窗与 transcript 消费方。
 */
import {
  CORE_SETTINGS,
  coreShortId,
  EMPTY_RESPONSE_SETTING_PREFIX,
  LOG_SETTING_PREFIX,
  type SettingDef,
} from './settings-registry';

export { EMPTY_RESPONSE_SETTING_PREFIX, LOG_SETTING_PREFIX };

export type DisplaySettingType = 'boolean' | 'enum' | 'number' | 'string';

export interface DisplaySettingDef {
  key: string;
  type: DisplaySettingType;
  options?: readonly string[];
  /** i18n key 后缀（settings.item.<id>.title）。 */
  id: string;
  /** number 键的取值范围（含端点；与 config validator 同界）。 */
  min?: number;
  max?: number;
  /** 配置缺省时的展示值（缺省行为 ≠ 空：如 emptyResponse.enabled 缺省 true）。 */
  fallback?: string;
}

/** 核心键 type 收窄（核心键表只含 boolean/enum/number/string 四种可写型）。 */
function displayType(def: SettingDef): DisplaySettingType {
  return def.type as DisplaySettingType;
}

/** 从注册表核心定义派生（顺序 = 键表登记顺序；不另立第二份清单）。 */
export const DISPLAY_SETTINGS: readonly DisplaySettingDef[] = CORE_SETTINGS.map((def) => ({
  key: def.key,
  type: displayType(def),
  id: coreShortId(def.key),
  options: def.options,
  min: def.min,
  max: def.max,
  fallback: def.fallback,
}));

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
