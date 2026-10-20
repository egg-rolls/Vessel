/**
 * `gateway.reload` 的 asm 侧实现（0.12 DECISION-023 §2.3）。
 *
 * serve 只暴露 RPC 形状；这里决定哪些东西真的能热重载：
 * - `plugins`：清空插件扫描缓存（下次 `list()` 重新扫描；已安装插件与 active run 不受影响）；
 * - `config`：重新 `loadConfig()`；`serve.allowed_origins` 通过 web 的
 *   `gateway.reconfigure({ allowedOrigins })` 生效；其余字段一律进 `requires_restart`，
 *   不假装已经生效。
 *
 * 配置读取失败、reconfigure 抛错都向上抛（RPC 返回错误），不会返回成功。
 *
 * @module vessel/gateway-reload-wiring
 */

import type { VesselConfig } from '../packages/config/src/index';
import type { GatewayReloadResult } from '../packages/serve/src/index';

/** web gateway 的可选热重配置入口（尚未合入时缺省） */
export interface GatewayReconfigureTarget {
  reconfigure?(options: { allowedOrigins?: string[] }): void | Promise<void>;
}

/** 注入面 */
export interface GatewayReloadWiringOptions {
  /** 当前 gateway（RPC 到达时已启动）；返回 null 表示无法热重配 */
  gateway: () => GatewayReconfigureTarget | null;
  /** 启动时的配置（内存值；含首启向导写入） */
  currentConfig: () => VesselConfig;
  /** 重新读取配置；失败必须抛错 */
  reloadConfig: () => Promise<VesselConfig>;
  /** 清空所有 tenant 的插件扫描缓存 */
  refreshPlugins: () => void;
}

/** 需要重启才能生效的配置域（DECISION-023 §2.3） */
interface RestartField {
  name: string;
  read: (config: VesselConfig) => unknown;
}

function withoutModel(provider: VesselConfig['provider']): unknown {
  if (!provider) return undefined;
  const { model: _model, ...rest } = provider;
  return rest;
}

const RESTART_FIELDS: readonly RestartField[] = [
  { name: 'provider', read: (config) => withoutModel(config.provider) },
  { name: 'model', read: (config) => config.provider?.model },
  { name: 'agent', read: (config) => config.agent },
  { name: 'permission', read: (config) => config.permission },
  { name: 'tls', read: (config) => config.serve?.tls },
  {
    name: 'token',
    read: (config) => ({
      token: config.serve?.token,
      tokenEnv: config.serve?.tokenEnv,
      adminToken: config.serve?.adminToken,
      adminTokenEnv: config.serve?.adminTokenEnv,
      tokens: config.serve?.tokens,
    }),
  },
  { name: 'port', read: (config) => config.serve?.port },
];

/** 稳定序列化（对象键排序；undefined 也参与比较） */
function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 比较两份配置，返回需要重启的字段名（顺序固定） */
export function diffRestartFields(current: VesselConfig, next: VesselConfig): string[] {
  return RESTART_FIELDS.filter(
    (field) => stableValue(field.read(current)) !== stableValue(field.read(next)),
  ).map((field) => field.name);
}

/**
 * 判断 allowed_origins 是否变化。CORS 列表与顺序无关；缺省与空数组等价。
 */
export function allowedOriginsChanged(current: VesselConfig, next: VesselConfig): boolean {
  const normalize = (value: string[] | undefined): string[] => [...(value ?? [])].sort();
  const left = normalize(current.serve?.allowedOrigins);
  const right = normalize(next.serve?.allowedOrigins);
  return left.length !== right.length || left.some((origin, index) => origin !== right[index]);
}

/**
 * 构造 `GatewayOptions.reload`。
 * @param options 注入面（gateway / 配置读取 / 插件刷新）
 */
export function createGatewayReload(
  options: GatewayReloadWiringOptions,
): (scopes: string[]) => Promise<GatewayReloadResult> {
  return async (scopes) => {
    const requested = scopes.length > 0 ? scopes : ['config', 'plugins'];
    const reloaded: string[] = [];
    const requiresRestart: string[] = [];

    for (const scope of requested) {
      if (scope === 'plugins') {
        // 只失效目录缓存；pluginHost / 已安装插件 / active run 不动。
        options.refreshPlugins();
        reloaded.push('plugins');
        continue;
      }
      if (scope !== 'config') {
        throw new Error(`unknown reload scope: ${scope}`);
      }

      const current = options.currentConfig();
      let next: VesselConfig;
      try {
        next = await options.reloadConfig();
      } catch (error) {
        throw new Error(
          `config_reload_failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const restartFields = diffRestartFields(current, next);
      if (allowedOriginsChanged(current, next)) {
        const target = options.gateway();
        const reconfigure = target?.reconfigure;
        if (!target || typeof reconfigure !== 'function') {
          // web 尚未提供 reconfigure：不声称 config 已生效。
          requiresRestart.push('serve.allowedOrigins');
        } else {
          await reconfigure.call(target, {
            allowedOrigins: next.serve?.allowedOrigins ?? [],
          });
          reloaded.push('config');
        }
      } else {
        reloaded.push('config');
      }
      requiresRestart.push(...restartFields);
    }

    return { reloaded, requires_restart: requiresRestart };
  };
}
