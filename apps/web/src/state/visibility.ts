/**
 * UI 信息层级（0.15 P0，DESIGN-0.14 §1）。
 *
 * Web 从 `config.get` 的 `ui` 读取，缺省/非法值回退 0.13 行为：
 * - `verbosity: normal`（默认）：L1 + 折叠 L2；
 * - `minimal`：只保留正文、失败工具、run 终态，隐藏成功工具卡/思考/时间元数据；
 * - `debug`：等同 `showInternalEvents: true`，再显示 L3 原始事件；
 * - `showInternalEvents` 与 `verbosity: debug` 取“或”。
 */
import type { ErrorVisibility } from './error-visibility';

export type Verbosity = 'minimal' | 'normal' | 'debug';

export interface UiVisibility {
  verbosity: Verbosity;
  /** `showInternalEvents` 显式开关（不含 debug 的隐式开启）。 */
  showInternalEvents: boolean;
  errorLevel: ErrorVisibility;
}

const DEFAULT_VISIBILITY: UiVisibility = {
  verbosity: 'normal',
  showInternalEvents: false,
  errorLevel: 'user',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 兼容 `{config:{ui}}` 与已解包的 config 对象；snake_case 也接受。 */
function uiOf(source: unknown): Record<string, unknown> | undefined {
  if (!isRecord(source)) return undefined;
  const config = isRecord(source.config) ? source.config : source;
  return isRecord(config.ui) ? config.ui : undefined;
}

export function resolveVerbosity(source: unknown): Verbosity {
  const value = uiOf(source)?.verbosity;
  return value === 'minimal' || value === 'debug' ? value : 'normal';
}

export function resolveShowInternalEvents(source: unknown): boolean {
  const ui = uiOf(source);
  const value = ui?.showInternalEvents ?? ui?.show_internal_events;
  return value === true;
}

/** 读取完整可见性配置；缺失字段回退 normal / false / user。 */
export function resolveUiVisibility(source: unknown): UiVisibility {
  const ui = uiOf(source);
  const errorValue = ui?.errorLevel ?? ui?.error_level;
  return {
    verbosity: resolveVerbosity(source),
    showInternalEvents: resolveShowInternalEvents(source),
    errorLevel: errorValue === 'all' ? 'all' : 'user',
  };
}

/** debug 或显式 showInternalEvents 时展示 L3 内部事件。 */
export function showsInternalEvents(visibility: UiVisibility): boolean {
  return visibility.showInternalEvents || visibility.verbosity === 'debug';
}

/** minimal 隐藏成功工具卡与思考，但失败工具永不隐藏。 */
export function showsSuccessfulTools(visibility: UiVisibility): boolean {
  return visibility.verbosity !== 'minimal';
}

/** minimal 隐藏时间 / 耗时等元数据。 */
export function showsTimeMetadata(visibility: UiVisibility): boolean {
  return visibility.verbosity !== 'minimal';
}

export { DEFAULT_VISIBILITY };
