/**
 * `gateway.reload` 的 asm 侧实现（0.12 DECISION-023 §2.3；CONTRACT-hot-apply §1/§4）。
 *
 * serve 只暴露 RPC 形状与 scope 枚举；这里维护 `scope -> applier` 映射，决定哪些东西
 * 真的能热应用：
 * - `plugins`：清空插件扫描缓存（下次 `list()` 重新扫描；已安装插件与 active run 不受影响）；
 * - `config`：重新 `loadConfig()`；`serve.allowed_origins` 通过 web 的
 *   `gateway.reconfigure({ allowedOrigins })` 生效；其余字段一律进 `requires_restart`，
 *   不假装已经生效；
 * - `permission` / `tools` / `mcp`：由 `src/cli.ts` 注入 applier（见下）。
 *
 * ## applier 注册面
 *
 * `appliers` 是 `scope -> () => Promise<string[]>` 的注入表：
 * - 每个 applier 返回**要广播的差异摘要行**（如 `permission: bash always ask`）；
 *   返回空数组表示「该 scope 执行了但无差异」；
 * - 只注册真实存在的 applier（例如没有 MCP server 时不注册 `mcp`），
 *   请求未注册的 scope → 抛 `unknown reload scope`（不静默忽略）；
 * - 单个 scope 的 applier 抛错不中断其余 scope：失败写进该 scope 的摘要
 *   （`<scope>: reload failed (...)`），由调用方广播，不新增失败字段。
 *
 * 这样 serve 的协议形状完全不变，新增 applier 只是往注入表里加一个键，且每个 applier
 * 都能脱离 CLI 单独测试。
 *
 * @module vessel/gateway-reload-wiring
 */

import type { VesselConfig } from '../packages/config/src/index';
import type { GatewayReloadResult } from '../packages/serve/src/index';

/** web gateway 的可选热重配置入口（尚未合入时缺省） */
export interface GatewayReconfigureTarget {
  reconfigure?(options: { allowedOrigins?: string[] }): void | Promise<void>;
}

/** 一个 scope 的 applier：返回差异摘要行（用于广播 / 调试）。 */
export type GatewayReloadApplier = () => Promise<string[]> | string[];

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
  /**
   * `scope -> applier`。`config` / `plugins` 由本模块自己实现，不需要出现在这里；
   * 请求一个本表没有、也不是 `config` / `plugins` 的 scope → `unknown reload scope`。
   */
  appliers?: Readonly<Record<string, GatewayReloadApplier>>;
}

/** 需要重启才能生效的配置域（DECISION-023 §2.3；`permission` 已可热应用）。 */
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
  // CONTRACT-hot-apply §1：permission 走 applier，不再进 requires_restart。
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

/** 缺省 scopes（`gateway.reload({})` 时跑）：与 serve 的 `RELOAD_SCOPES` 同序。 */
const DEFAULT_SCOPES = ['config', 'plugins'] as const;

/**
 * 一次 `gateway.reload` 的完整结果：serve 需要的 `{ reloaded, requires_restart }`
 * 加上每个 applier 产出的差异摘要（供 `runtime.notice` 广播）。
 */
export interface GatewayReloadOutcome extends GatewayReloadResult {
  /** scope → 该 scope 的差异摘要行（无差异时是空数组） */
  summaries: Record<string, string[]>;
}

export interface GatewayReloadRunner {
  /** serve `GatewayOptions.reload` 的形状（只返回契约字段） */
  reload(scopes: string[]): Promise<GatewayReloadResult>;
  /** 同上，但额外返回每个 scope 的差异摘要（装配层广播 notice 用） */
  reloadWithSummaries(scopes: string[]): Promise<GatewayReloadOutcome>;
  /** 当前已注册 applier 的 scope 名（配置监听据此过滤，避免请求不可用 scope） */
  registeredScopes(): string[];
}

/**
 * 构造 `GatewayOptions.reload` 及带摘要的变体。
 * @param options 注入面（gateway / 配置读取 / 插件刷新 / appliers）
 */
export function createGatewayReloadRunner(
  options: GatewayReloadWiringOptions,
): GatewayReloadRunner {
  const appliers = options.appliers ?? {};

  const reloadWithSummaries = async (scopes: string[]): Promise<GatewayReloadOutcome> => {
    const requested = scopes.length > 0 ? scopes : [...DEFAULT_SCOPES];
    const reloaded: string[] = [];
    const requiresRestart: string[] = [];
    const summaries: Record<string, string[]> = {};

    for (const scope of requested) {
      // 未知 scope 是请求错误，不是执行失败：在隔离之外显式抛出（契约 §1：不静默忽略）。
      if (scope !== 'plugins' && scope !== 'config' && appliers[scope] === undefined) {
        throw new Error(`unknown reload scope: ${scope}`);
      }
      // 每个 scope 独立收口：单个 applier 失败不阻断后续 scope，失败写进该 scope
      // 的摘要（不新增 `failures` 字段），调用方仍能广播失败原因。
      try {
        if (scope === 'plugins') {
          // 只失效目录缓存；pluginHost / 已安装插件 / active run 不动。
          options.refreshPlugins();
          reloaded.push('plugins');
          summaries.plugins = [];
          continue;
        }

        if (scope === 'config') {
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
          summaries.config = restartFields.map((field) => `config: ${field} requires restart`);
          continue;
        }

        const applier = appliers[scope] as GatewayReloadApplier;
        const lines = await applier();
        reloaded.push(scope);
        summaries[scope] = Array.isArray(lines) ? [...lines] : [];
      } catch (error) {
        summaries[scope] = [
          `${scope}: reload failed (${error instanceof Error ? error.message : String(error)})`,
        ];
      }
    }

    return { reloaded, requires_restart: requiresRestart, summaries };
  };

  return {
    reloadWithSummaries,
    async reload(scopes) {
      const outcome = await reloadWithSummaries(scopes);
      return { reloaded: outcome.reloaded, requires_restart: outcome.requires_restart };
    },
    registeredScopes() {
      return Object.keys(appliers);
    },
  };
}

/**
 * 构造 `GatewayOptions.reload`（只返回契约字段）。
 * @param options 注入面（gateway / 配置读取 / 插件刷新 / appliers）
 */
export function createGatewayReload(
  options: GatewayReloadWiringOptions,
): (scopes: string[]) => Promise<GatewayReloadResult> {
  return createGatewayReloadRunner(options).reload;
}
