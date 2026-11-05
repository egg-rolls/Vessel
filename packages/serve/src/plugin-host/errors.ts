/**
 * Plugin 宿主错误：`code` 使用 CONTRACT-0.43 §8 的错误码。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import type { PluginErrorCode } from './types.js';

export class PluginHostError extends Error {
  readonly code: PluginErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PluginErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PluginHostError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function pluginError(
  code: PluginErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PluginHostError {
  return new PluginHostError(code, message, details);
}

/** 未知对象上的错误码（跨包边界用，不信任 instanceof）。 */
export function pluginErrorCodeOf(error: unknown): PluginErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'plugin_manifest_invalid':
    case 'plugin_id_conflict':
    case 'plugin_version_incompatible':
    case 'plugin_dependency_missing':
    case 'plugin_cycle':
    case 'plugin_activation_failed':
    case 'plugin_timeout':
    case 'plugin_crashed':
    case 'plugin_payload_too_large':
    case 'plugin_permission_denied':
    case 'plugin_rpc_denied':
    case 'plugin_config_invalid':
    case 'plugin_event_dropped':
      return code;
    default:
      return undefined;
  }
}
