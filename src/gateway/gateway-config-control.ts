/**
 * gateway `config.set` 的写回实现（0.15）。
 *
 * serve 负责方法与白名单校验；asm 只提供写入面。这里再做一层防御：
 * 非 default tenant → forbidden；未知键 → invalid_params。
 * 值经 `setUserConfigValue` 按已知键校验，原子写 0600 并保留其它键。
 *
 * @module vessel/gateway-config-control
 */

import { getUserConfigPath } from '../../packages/config/src/index';
import { isSettableConfigKey, setUserConfigValue } from '../config/ui-settings';

export interface GatewayConfigSetRequest {
  tenantId: string;
  key: string;
  value: string | boolean | number;
  /** S5 additive：写入层级；缺省 user。project 未注入路径 → not_found。 */
  scope?: 'user' | 'project';
}

export interface GatewayConfigSetOptions {
  defaultTenantId: string;
  /** 用户配置路径；缺省 `~/.vessel/config.yaml` */
  configPath?: string;
  /** S5：项目配置路径（工作区覆盖层）；缺省 → project 写入 not_found。 */
  projectConfigPath?: string;
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
    // S5：project 层写 <project>/vessel.yaml（setUserConfigValue 的 configPath 选项已支持）。
    const targetPath = request.scope === 'project' ? options.projectConfigPath : configPath;
    if (targetPath === undefined) {
      throw codedError('not_supported', 'Project config write is not available');
    }
    await setUserConfigValue(request.key, request.value, { configPath: targetPath });
  };
}
