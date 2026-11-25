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
import {
  DEFAULT_MESSAGE_VISIBILITY,
  type MessageVisibility,
  resolveMessageVisibility,
} from './message-visibility';

export type Verbosity = 'minimal' | 'normal' | 'debug';

export interface UiVisibility {
  verbosity: Verbosity;
  /** `showInternalEvents` 显式开关（不含 debug 的隐式开启）。q-msg-visibility 起系统信息以 messageVisibility.system 为准（含旧键兼容映射）；本字段保留旧键原值。 */
  showInternalEvents: boolean;
  errorLevel: ErrorVisibility;
  /** 消息显示五 toggle（q-msg-visibility；已含旧键兼容映射，未含 debug 叠加）。 */
  messageVisibility: MessageVisibility;
}

const DEFAULT_VISIBILITY: UiVisibility = {
  verbosity: 'normal',
  showInternalEvents: false,
  errorLevel: 'user',
  messageVisibility: DEFAULT_MESSAGE_VISIBILITY,
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

/** 读取完整可见性配置；缺失字段回退 normal / false / user / 消息显示缺省。 */
export function resolveUiVisibility(source: unknown): UiVisibility {
  const ui = uiOf(source);
  const errorValue = ui?.errorLevel ?? ui?.error_level;
  return {
    verbosity: resolveVerbosity(source),
    showInternalEvents: resolveShowInternalEvents(source),
    errorLevel: errorValue === 'all' ? 'all' : 'user',
    messageVisibility: resolveMessageVisibility(source),
  };
}

/** `observability.showProcessErrors`；缺失/非法 → false（0.14 行为）。 */
export function resolveShowProcessErrors(source: unknown): boolean {
  if (!isRecord(source)) return false;
  const config = isRecord(source.config) ? source.config : source;
  const observability = isRecord(config.observability) ? config.observability : undefined;
  const value = observability?.showProcessErrors ?? observability?.show_process_errors;
  return value === true;
}

/**
 * debug 或系统信息 toggle 打开时展示 L3 内部事件。
 * q-msg-visibility：系统信息读 messageVisibility.system（未配置新键时已回退旧
 * showInternalEvents）；debug 的「或」语义不变。
 */
export function showsInternalEvents(visibility: UiVisibility): boolean {
  return visibility.messageVisibility.system || visibility.verbosity === 'debug';
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
