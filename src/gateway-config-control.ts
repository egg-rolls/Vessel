/**
 * gateway `config.set` 的写回实现（0.15）。
 *
 * serve 负责方法与白名单校验；asm 只提供写入面。这里再做一层防御：
 * 非 default tenant → forbidden；未知键 → invalid_params。
 * 值经 `setUserConfigValue` 按已知键校验，原子写 0600 并保留其它键。
 *
 * @module vessel/gateway-config-control
 */

import { getUserConfigPath } from '../packages/config/src/index';
import { isSettableConfigKey, setUserConfigValue } from './ui-settings';

export interface GatewayConfigSetRequest {
  tenantId: string;
  key: string;
  value: string | boolean;
}

export interface GatewayConfigSetOptions {
  defaultTenantId: string;
  /** 用户配置路径；缺省 `~/.vessel/config.yaml` */
  configPath?: string;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** 构造 `ConfigGatewayOptionsLike.set`。 */
export function createGatewayConfigSet(
  options: GatewayConfigSetOptions,
): (request: GatewayConfigSetRequest) => Promise<void> {
  const configPath = options.configPath ?? getUserConfigPath();
  return async (request: GatewayConfigSetRequest): Promise<void> => {
    if (request.tenantId !== options.defaultTenantId) {
      throw codedError('forbidden', 'config.set is only available for the default tenant');
    }
    if (!isSettableConfigKey(request.key)) {
      throw codedError('invalid_params', `Unsupported config key: ${request.key}`);
    }
    await setUserConfigValue(request.key, request.value, { configPath });
  };
}
