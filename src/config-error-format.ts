/**
 * 配置校验错误统一格式化（DECISION-020 §R1.7）。
 *
 * bootstrap / eval / resume / workflow / `config show` 共用同一输出：
 * 每条错误 `${path}: ${message}`，附配置文件路径与 `vessel doctor` 下一步。
 *
 * @module vessel/config-error-format
 */

import type { ConfigValidationError } from '../packages/config/src/index';

/** 格式化选项 */
export interface ConfigErrorFormatOptions {
  /** `loadConfig().paths`；提供时追加一行配置路径 */
  paths?: { user: string; project: string };
  /** 覆盖默认下一步提示 */
  hint?: string;
}

/** 默认下一步提示 */
export const CONFIG_ERROR_HINT = 'Run `vessel doctor` to check your configuration.';

/** 单条错误：`${path}: ${message}` */
export function formatConfigError(error: ConfigValidationError): string {
  return `${error.path}: ${error.message}`;
}

/**
 * 多条错误组成一个可读块（调用方直接 `console.error`）。
 * 空数组返回空串。
 */
export function formatConfigErrors(
  errors: ConfigValidationError[],
  options: ConfigErrorFormatOptions = {},
): string {
  if (errors.length === 0) return '';

  const lines = errors.map((error) => `✗ ${formatConfigError(error)}`);
  if (options.paths) {
    lines.push(`Config files: user=${options.paths.user}, project=${options.paths.project}`);
  }
  lines.push(options.hint ?? CONFIG_ERROR_HINT);
  return lines.join('\n');
}
