/**
 * gateway.* 管理方法（`gateway.reload`，DECISION-023 §2.3；CONTRACT-hot-apply §1；
 * `gateway.shutdown`，P0-run-stops P1：Windows 强杀前的优雅关闭入口）。
 *
 * serve 只负责协议形状、权限与参数校验（scope 枚举 + 去重）；真实 applier 由 asm
 * 通过 `GatewayOptions.reload` / `GatewayOptions.shutdown` 注入。未注入时明确返回
 * `not_supported`。结果形状保持 `{ reloaded, requires_restart }`，不因 scope 扩展而变。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringListSchema } from './schemas.js';

/**
 * 可热重载的范围（DECISION-023 §2.3；CONTRACT-hot-apply §1）。
 *
 * serve 只做枚举校验，不实现任何 applier：`scope -> applier` 的映射在 asm 侧
 * （`src/gateway-reload-wiring.ts`）。新增 applier 不需要改这里以外的协议形状。
 */
export const RELOAD_SCOPES = ['config', 'plugins', 'permission', 'tools', 'mcp'] as const;

/** 热重载范围。 */
export type ReloadScope = (typeof RELOAD_SCOPES)[number];

/** `gateway.reload` 结果；`requires_restart` 不得伪装成已生效。 */
export interface GatewayReloadResult {
  reloaded: string[];
  requires_restart: string[];
}

/** `gateway.shutdown` 结果：只表示「退出序列已受理」，不表示进程已退出。 */
export interface GatewayShutdownResult {
  stopping: boolean;
}

export interface AdminMethodsDeps {
  /** asm 注入的实际热重载实现；缺省 → `not_supported`。 */
  reload?: (scopes: string[]) => Promise<GatewayReloadResult>;
  /**
   * asm 注入的优雅退出序列（P0-run-stops P1）：跑现成的 shutdownServeStack
   * （beginDrain 写 resume 标记 → gateway.stop → … → exit）。缺省 → `not_supported`。
   * **调用方（停止侧 CLI）在超时后仍会强杀**——这里不保证进程一定退出。
   */
  shutdown?: () => Promise<void>;
}

/**
 * 解析 `scopes`：缺省（undefined）→ 空数组，默认集由装配层决定
 * （`src/gateway-reload-wiring.ts` 的 `DEFAULT_SCOPES`，ADR-075：`config,plugins`）。
 * 显式传入且未注册的 scope 仍由装配层拒绝，不静默忽略。
 * 去重并保持调用方顺序；schema 已先校验类型与 enum，这里兜底非数组输入。
 */
export function parseReloadScopes(value: unknown): ReloadScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RpcError('invalid_params', 'scopes must be an array');
  }
  const scopes: ReloadScope[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(RELOAD_SCOPES as readonly string[]).includes(item)) {
      throw new RpcError('invalid_params', `scopes must only contain: ${RELOAD_SCOPES.join(', ')}`);
    }
    if (!scopes.includes(item as ReloadScope)) scopes.push(item as ReloadScope);
  }
  return scopes;
}

export function createAdminMethods(deps: AdminMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'gateway.reload',
      permission: 'admin',
      params_schema: {
        type: 'object',
        properties: {
          scopes: {
            type: 'array',
            // 枚举是唯一真相源：新增 applier 只改 RELOAD_SCOPES，不改这里。
            items: { type: 'string', enum: [...RELOAD_SCOPES] },
          },
        },
      },
      result_schema: {
        type: 'object',
        required: ['reloaded', 'requires_restart'],
        properties: {
          reloaded: stringListSchema,
          requires_restart: stringListSchema,
        },
      },
      handler: async (params) => {
        const reload = deps.reload;
        if (!reload) {
          throw new RpcError('not_supported', 'gateway.reload is not supported by this gateway');
        }
        return reload(parseReloadScopes(params.scopes));
      },
    },
    {
      // P0-run-stops P1：优雅关闭。Windows 上外部 `process.kill` 是无条件终止，
      // 进程内信号处理器永远跑不到 ⇒ 停止侧先经本方法触发进程内 drain，再等退出；
      // 超时仍回退强杀。响应必须先于退出序列发出：handler 只**受理**（defer 一拍），
      // 真正的 shutdownServeStack + process.exit 由 asm 注入的闭包在下一拍执行。
      name: 'gateway.shutdown',
      permission: 'admin',
      params_schema: { type: 'object', properties: {} },
      result_schema: {
        type: 'object',
        required: ['stopping'],
        properties: { stopping: { type: 'boolean' } },
      },
      handler: async () => {
        const shutdown = deps.shutdown;
        if (!shutdown) {
          throw new RpcError('not_supported', 'gateway.shutdown is not supported by this gateway');
        }
        setTimeout(() => {
          // 退出序列自身的失败由 asm 闭包记录；这里不吞进程退出（停止侧有强杀兜底）。
          void shutdown().catch(() => undefined);
        }, 0);
        return { stopping: true };
      },
    },
  ];
}
