/**
 * 错误可见性与错误元数据（0.14 P0，DECISION-025 §1.2 / §1.3）。
 *
 * - 默认 `user`：只展示 run / tool / permission 级错误；internal 需要
 *   `ui.errorLevel: all` 或用户展开内部事件。
 * - 结构化 envelope 是 additive：`error_code` / `category` / `phase` /
 *   `retryable` / `http_status` 缺失时保持 0.13 展示行为。
 */
import type { RunEvent } from '../gateway/types';

export type ErrorVisibility = 'user' | 'all';
export type ErrorLevel = 'run' | 'tool' | 'permission' | 'internal';

export interface ErrorMeta {
  code?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  httpStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 `config.get` 响应（`{config:{ui}}`）或已解包的 config 对象读取
 * `ui.errorLevel`；兼容 snake_case。非法/缺失 → `user`。
 */
export function resolveErrorLevel(source: unknown): ErrorVisibility {
  if (!isRecord(source)) return 'user';
  const config = isRecord(source.config) ? source.config : source;
  const ui = isRecord(config.ui) ? config.ui : undefined;
  if (!ui) return 'user';
  const value = ui.errorLevel ?? ui.error_level;
  return value === 'all' ? 'all' : 'user';
}

/**
 * 失败/错误事件。在 0.13 `isErrorEvent` 口径（`.failed`）之外补 `.error`
 * （`hook.error` / `process.error` / `guardrail.error`），供可见性过滤使用。
 */
export function isErrorEventType(type: string): boolean {
  return (
    type === 'error' ||
    type === 'guardrail.blocked' ||
    type.endsWith('.failed') ||
    type.endsWith('.error')
  );
}

/**
 * 事件所属错误层级。run/tool/permission 是默认可见级；
 * guardrail.blocked 归 tool（用户可理解、0.13 可见）；其余为 internal。
 */
export function errorLevelOf(type: string): ErrorLevel {
  if (type.startsWith('run.')) return 'run';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('permission.') || type.startsWith('ask.')) return 'permission';
  if (type.startsWith('guardrail.')) return 'tool';
  return 'internal';
}

/** internal 级错误默认隐藏；`all` 或展开内部事件时显示。 */
export function isHiddenInternalError(
  type: string,
  level: ErrorVisibility,
  showInternal: boolean,
): boolean {
  if (showInternal || level === 'all') return false;
  return isErrorEventType(type) && errorLevelOf(type) === 'internal';
}

/** 事件是否应当在当前可见性设置下渲染（非错误事件始终通过）。 */
export function isEventVisible(
  event: Pick<RunEvent, 'type'>,
  level: ErrorVisibility,
  showInternal = false,
): boolean {
  return !isHiddenInternalError(event.type, level, showInternal);
}

/** 读取 additive 错误字段；不存在时返回 undefined，不推断。 */
export function errorMetaOf(data: unknown): ErrorMeta | undefined {
  if (!isRecord(data)) return undefined;
  const meta: ErrorMeta = {};
  const code = data.error_code ?? data.errorCode;
  const category = data.category;
  const phase = data.phase;
  const retryable = data.retryable;
  const httpStatus = data.http_status ?? data.httpStatus;
  if (typeof code === 'string' && code.length > 0) meta.code = code;
  if (typeof category === 'string' && category.length > 0) meta.category = category;
  if (typeof phase === 'string' && phase.length > 0) meta.phase = phase;
  if (typeof retryable === 'boolean') meta.retryable = retryable;
  if (typeof httpStatus === 'number' && Number.isFinite(httpStatus)) {
    meta.httpStatus = httpStatus;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** 紧凑 chip 文本：`code · category · phase`。 */
export function formatErrorMeta(meta: ErrorMeta | undefined): string {
  if (!meta) return '';
  const parts = [meta.code, meta.category, meta.phase].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.join(' · ');
}
