/**
 * Settings → Display 的可写键白名单（与服务端 `config.set` 一致）。
 *
 * 只做纯转换：读取 `config.get` 的嵌套/蛇形值，写入时转成 string|boolean。
 */
export type DisplaySettingType = 'boolean' | 'enum';

export interface DisplaySettingDef {
  key: string;
  type: DisplaySettingType;
  options?: readonly string[];
  /** i18n key 后缀（settings.display.field.<id>）。 */
  id: string;
}

export const DISPLAY_SETTINGS: readonly DisplaySettingDef[] = [
  { id: 'verbosity', key: 'ui.verbosity', type: 'enum', options: ['minimal', 'normal', 'debug'] },
  { id: 'showInternalEvents', key: 'ui.showInternalEvents', type: 'boolean' },
  { id: 'errorLevel', key: 'ui.errorLevel', type: 'enum', options: ['user', 'all'] },
  { id: 'showProcessErrors', key: 'observability.showProcessErrors', type: 'boolean' },
  { id: 'askUser', key: 'ui.askUser', type: 'boolean' },
  { id: 'showReasoning', key: 'ui.showReasoning', type: 'boolean' },
  {
    id: 'statusBars',
    key: 'ui.statusBars',
    type: 'enum',
    options: ['top', 'bottom', 'both', 'none'],
  },
  { id: 'language', key: 'ui.language', type: 'enum', options: ['zh-CN', 'en'] },
];

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

/** 读取当前值；缺失返回空串，布尔转 "true"/"false"。 */
export function readDisplayValue(source: unknown, key: string): string {
  const value = readPath(source, key);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return '';
}

/** 把表单值转成 `config.set` 的 value；非法返回 undefined。 */
export function toConfigValue(
  setting: DisplaySettingDef,
  raw: string,
): string | boolean | undefined {
  if (setting.type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  return setting.options?.includes(raw) === true ? raw : undefined;
}

export function isDisplaySettingKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function displaySettingFor(key: string): DisplaySettingDef | undefined {
  return BY_KEY.get(key);
}
