/**
 * thinking-intensity 设置快照与状态模型（设计 §4.2 / §4.3）。
 *
 * 设置经 contributes.settings 自动发现，写路径 plugins.config.set → config.yaml
 * plugins[].config。热应用：模块级 live holder 每次 install（启动 + tools 热应用旁路
 * re-install）刷新；BeforeLlm hook 每轮读最新快照（见 index.ts）。
 *
 * 状态按 session_id 键控（成员会话互不串）；会话级覆盖是即时意图，进程重启即失，
 * 持久默认走 settings.default_level（设计 R4）。
 *
 * @module @vessel-agent/thinking-intensity/state
 */

import type { Budgets, ConcreteLevel, Level } from './mapping.js';

export const LEVELS: readonly Level[] = ['auto', 'off', 'low', 'medium', 'high'];

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/** 设置快照（§4.2 schema 的运行时形状）。 */
export interface ThinkingSettings {
  /** kill switch：false ⇒ hook 恒不注入，UI 置灰。 */
  enabled: boolean;
  /** 持久化全局默认；auto = 不注入任何参数（零回归基线）。 */
  default_level: Level;
  budget_low: number;
  budget_medium: number;
  budget_high: number;
  /** experimental 映射行总开关（默认 false，fail-safe）。 */
  experimental_providers: boolean;
}

export const DEFAULT_SETTINGS: ThinkingSettings = {
  enabled: true,
  default_level: 'auto',
  budget_low: 2048,
  budget_medium: 8192,
  budget_high: 16384,
  experimental_providers: false,
};

const BUDGET_MIN = 1024;
const BUDGET_MAX = 65536;

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readBudget(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < BUDGET_MIN || value > BUDGET_MAX) return fallback;
  return value;
}

/** 从 install config 解析设置快照（缺省回默认；非法值回默认，不抛错）。 */
export function parseSettings(config: Record<string, unknown> | undefined): ThinkingSettings {
  const raw = config ?? {};
  const defaultLevel = isLevel(raw.default_level)
    ? raw.default_level
    : DEFAULT_SETTINGS.default_level;
  return {
    enabled: readBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
    default_level: defaultLevel,
    budget_low: readBudget(raw.budget_low, DEFAULT_SETTINGS.budget_low),
    budget_medium: readBudget(raw.budget_medium, DEFAULT_SETTINGS.budget_medium),
    budget_high: readBudget(raw.budget_high, DEFAULT_SETTINGS.budget_high),
    experimental_providers: readBoolean(
      raw.experimental_providers,
      DEFAULT_SETTINGS.experimental_providers,
    ),
  };
}

export function budgetsOf(settings: ThinkingSettings): Budgets {
  return {
    low: settings.budget_low,
    medium: settings.budget_medium,
    high: settings.budget_high,
  };
}

/** 请求期观测缓存条目（UI get_state 靠它；首轮请求前缺省）。 */
export interface ObservedEntry {
  providerName?: string;
  model: string;
  supported: boolean;
  availableLevels?: ConcreteLevel[];
  hint?: string;
}

/** 插件后端内存状态（模块级，跨 install 共享；按 session_id 键控）。 */
export interface ThinkingState {
  sessionLevels: Map<string, Level>;
  runtimeDefault: Level | undefined;
  observed: Map<string, ObservedEntry>;
}

export function createState(): ThinkingState {
  return {
    sessionLevels: new Map(),
    runtimeDefault: undefined,
    observed: new Map(),
  };
}

/** 档位解析优先级：session 覆盖 ?? 运行期默认 ?? settings 默认 ?? auto。 */
export function resolveLevel(
  state: ThinkingState,
  settings: ThinkingSettings,
  sessionId: string | undefined,
): Level {
  if (sessionId !== undefined) {
    const session = state.sessionLevels.get(sessionId);
    if (session !== undefined) return session;
  }
  if (state.runtimeDefault !== undefined) return state.runtimeDefault;
  return settings.default_level;
}

/** 档位来源（get_state 展示）。 */
export function levelSource(
  state: ThinkingState,
  sessionId: string | undefined,
): 'session' | 'runtime' | 'settings' {
  if (sessionId !== undefined && state.sessionLevels.has(sessionId)) return 'session';
  if (state.runtimeDefault !== undefined) return 'runtime';
  return 'settings';
}
