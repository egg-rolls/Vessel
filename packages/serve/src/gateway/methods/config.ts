/**
 * config.* / health.get / capabilities.list 与工具、插件目录方法。
 *
 * @module @vessel-agent/serve
 */

import { redactConfig, redactSourcePaths, type VesselConfig } from '@vessel-agent/config';
import type { PluginHost } from '@vessel-agent/core';
import type { PluginCatalogItem } from '../../plugin-host/catalog.js';
import type {
  PluginListMetadata,
  PluginReloadResult,
  PluginRenderContributions,
} from '../../plugin-host/types.js';
import type { NodeInfo, ProtocolInfo, ToolInfo } from '../../protocol.js';
import {
  buildCapabilityManifest,
  RpcError,
  type RpcMethodDefinition,
  type RpcMethodTable,
} from '../../rpc.js';
import type { ConfigGatewayOptionsLike } from '../../tenant.js';
import { stringParam } from './common.js';
import { runtimeSnapshotSchema, stringListSchema } from './schemas.js';

/** `config.set` 可写键（与 CLI `vessel config set` 的白名单一致）。 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'ui.showReasoning',
  'ui.showInternalEvents',
  'ui.askUser',
  'ui.expandCards',
  'observability.showProcessErrors',
]);

const ENUM_KEYS: Readonly<Record<string, readonly string[]>> = {
  'ui.language': ['zh-CN', 'en'],
  'ui.statusBars': ['top', 'bottom', 'both', 'none'],
  'ui.verbosity': ['minimal', 'normal', 'debug'],
  'ui.errorLevel': ['user', 'all'],
};

const SETTABLE_KEYS: ReadonlySet<string> = new Set([
  ...BOOLEAN_KEYS,
  ...Object.keys(ENUM_KEYS),
  'agent.cwd',
]);

/** 返回规范化后的值；非法键/值抛 invalid_params。 */
function normalizeConfigValue(key: string, raw: unknown): string | boolean {
  if (!SETTABLE_KEYS.has(key)) {
    throw new RpcError('invalid_params', `Unsupported config key: ${key}`, { key });
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new RpcError('invalid_params', `${key} must be true or false`, { key });
  }
  if (typeof raw !== 'string') {
    throw new RpcError('invalid_params', `${key} must be a string`, { key });
  }
  const allowed = ENUM_KEYS[key];
  if (allowed !== undefined) {
    if (!allowed.includes(raw)) {
      throw new RpcError('invalid_params', `${key} must be one of ${allowed.join(', ')}`, { key });
    }
    return raw;
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new RpcError('invalid_params', `${key} must not be empty`, { key });
  }
  return value;
}

export interface ConfigMethodsDeps {
  defaultTenantId: string;
  version?: string;
  config?: ConfigGatewayOptionsLike;
  /** health.get 的 runtime 快照（0.15 E6；单执行面）。 */
  runtimeSnapshot(): Record<string, unknown>;
  /** 方法表在组装完成后才有值；handler 调用时解析。 */
  methodTable(): RpcMethodTable;
  toolDescriptions(): Array<{ name: string; description?: string }>;
  plugins(): Array<{ name: string; enabled: boolean }>;
  /** 0.47：只读插件 catalog（单视图）；缺省返回空列表。 */
  pluginCatalog?(): PluginCatalogItem[];
  /** 0.43 E1：只给 enabled 的体验型 plugin 附加渲染字段（additive）。 */
  pluginsContributions?(): Record<string, PluginRenderContributions>;
  /** 0.43 E10：version / mode / status 运行时元数据（additive）。 */
  pluginsMetadata?(): Record<string, PluginListMetadata>;
  /** 0.43 E3：rescan / diff / manager.reload 由 assembly 注入；缺省 not_supported。 */
  pluginsReload?: () => Promise<PluginReloadResult>;
  pluginHost(): PluginHost | undefined;
  /** health.get 的实时状态。 */
  clientCount(): number;
  latestSeq(): number;
  protocolInfo: ProtocolInfo;
  nodeInfo(): NodeInfo;
  startedAt: number;
}

/** health.get / capabilities.list / config.get / config.sources */
export function createConfigMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const {
    version,
    config,
    methodTable,
    toolDescriptions,
    plugins,
    clientCount,
    latestSeq,
    protocolInfo,
    nodeInfo,
    startedAt,
    runtimeSnapshot,
  } = deps;

  function configControl(): ConfigGatewayOptionsLike {
    if (!config) throw new RpcError('not_found', 'Config view is not available');
    return config;
  }

  return [
    {
      name: 'health.get',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['status', 'clients', 'latest_seq', 'protocol', 'node', 'started_at', 'runtime'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          clients: { type: 'integer' },
          latest_seq: { type: 'integer' },
          protocol: {
            type: 'object',
            required: ['name', 'version', 'min', 'features'],
            properties: {
              name: { type: 'string', enum: ['vessel.gateway'] },
              version: { type: 'integer' },
              min: { type: 'integer' },
              features: stringListSchema,
            },
          },
          node: {
            type: 'object',
            required: [
              'node_id',
              'name',
              'pid',
              'started_at',
              'endpoint',
              'role',
              'status',
              'capabilities',
            ],
            properties: {
              node_id: { type: 'string' },
              name: { type: 'string' },
              pid: { type: 'integer' },
              started_at: { type: 'number' },
              endpoint: { type: 'string' },
              role: { type: 'string', enum: ['standalone', 'team'] },
              status: { type: 'string', enum: ['idle', 'busy', 'draining'] },
              current_run_id: { type: 'string' },
              current_session_id: { type: 'string' },
              capabilities: {
                type: 'object',
                required: ['tools', 'max_concurrency', 'protocol'],
                properties: {
                  tools: stringListSchema,
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  max_concurrency: { type: 'integer' },
                  protocol: { type: 'integer' },
                },
              },
            },
          },
          started_at: { type: 'number' },
          /** 0.15 E6：active run 与 scheduler 快照。 */
          runtime: runtimeSnapshotSchema,
        },
      },
      handler: () => {
        return {
          status: 'ok',
          clients: clientCount(),
          latest_seq: latestSeq(),
          protocol: protocolInfo,
          node: nodeInfo(),
          started_at: startedAt,
          runtime: runtimeSnapshot(),
        };
      },
    },
    {
      name: 'capabilities.list',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['version', 'config_schema_version', 'methods', 'tools', 'plugins'],
        properties: {
          version: { type: 'string' },
          config_schema_version: { type: 'integer' },
          methods: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'permission'],
              properties: {
                name: { type: 'string' },
                params_schema: { type: 'object' },
                result_schema: { type: 'object' },
                permission: { type: 'string', enum: ['read', 'write', 'admin'] },
              },
            },
          },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          plugins: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'enabled'],
              properties: {
                name: { type: 'string' },
                enabled: { type: 'boolean' },
              },
            },
          },
        },
      },
      handler: () =>
        buildCapabilityManifest({
          version: version ?? '0.0.0',
          table: methodTable(),
          tools: toolDescriptions(),
          plugins: plugins(),
        }),
    },
    {
      name: 'config.get',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['schema_version', 'config', 'paths', 'version'],
        properties: {
          schema_version: { type: 'integer' },
          version: { type: 'string' },
          config: { type: 'object' },
          paths: {
            type: 'object',
            required: ['user', 'project'],
            properties: {
              user: { type: 'string' },
              project: { type: 'string' },
            },
          },
        },
      },
      handler: async () => {
        const snapshot = await configControl().snapshot(deps.defaultTenantId);
        return {
          schema_version: snapshot.schema_version,
          // Web 的 Hub / Gateway 状态位需要版本号；与 capabilities.list 同源。
          version: version ?? '0.0.0',
          // DECISION-020 §R1.1：防御性二次脱敏（asm snapshot 已先脱敏）；
          // 复用 @vessel-agent/config#redactConfig，不在 serve 维护副本。
          config: redactConfig(snapshot.config as VesselConfig),
          // A-5 §12.2：TUI 需要展示 user/project 路径
          paths: snapshot.paths ?? { user: '', project: '' },
        };
      },
    },
    {
      name: 'config.set',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: 'string', minLength: 1 },
          // 布尔键接受 boolean，其余键接受 string；具体校验在 handler。
          value: {},
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok', 'key', 'value'],
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          value: {},
        },
      },
      handler: async (params) => {
        const control = configControl();
        if (typeof control.set !== 'function') {
          throw new RpcError('not_found', 'Config write is not available');
        }
        const key = stringParam(params, 'key');
        const value = normalizeConfigValue(key, params.value);
        try {
          await control.set({ tenantId: deps.defaultTenantId, key, value });
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throw new RpcError(
            'internal',
            error instanceof Error ? error.message : 'Config write failed',
          );
        }
        return { ok: true, key, value };
      },
    },
    {
      name: 'config.sources',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['sources'],
        properties: {
          sources: { type: 'object' },
        },
      },
      handler: async () => {
        const snapshot = await configControl().snapshot(deps.defaultTenantId);
        return {
          // DECISION-020 §R1.1：sources 键可能含 serve.tokens.<token>.*。
          sources: redactSourcePaths(snapshot.sources),
        };
      },
    },
  ];
}

/** tools.list（与 config 同域；单独工厂以保持方法表原顺序）。 */
export function createToolMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const { pluginHost } = deps;

  function toolsPayload(): { tools: ToolInfo[] } {
    const tools = pluginHost()?.listTools() ?? [];
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        has_permission_check: typeof tool.checkPermission === 'function',
      })),
    };
  }

  return [
    {
      name: 'tools.list',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['tools'],
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'description', 'input_schema', 'has_permission_check'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                input_schema: { type: 'object' },
                has_permission_check: { type: 'boolean' },
              },
            },
          },
        },
      },
      handler: () => toolsPayload(),
    },
  ];
}

/** `plugins.list` 单项（E1 贡献 + E10 元数据；旧客户端可忽略新字段）。 */
export interface PluginListEntry extends PluginListMetadata {
  name: string;
  enabled: boolean;
  contributions?: PluginRenderContributions;
}

/** 合并 plugins.list 条目、E1 贡献与 E10 元数据；`plugin.changed` 也用它。 */
export function mergePluginList(
  plugins: Array<{ name: string; enabled: boolean }>,
  contributions: Record<string, PluginRenderContributions> | undefined,
  metadata: Record<string, PluginListMetadata> | undefined,
): PluginListEntry[] {
  if (contributions === undefined && metadata === undefined) return plugins;
  return plugins.map((plugin) => {
    const extraMeta = metadata?.[plugin.name];
    const base =
      extraMeta !== undefined ? { ...plugin, ...extraMeta } : (plugin as PluginListEntry);
    if (!base.enabled) return base;
    const extra = contributions?.[base.name];
    return extra !== undefined ? { ...base, contributions: extra } : base;
  });
}

/** plugins.list / plugins.reload（与 config 同域；单独工厂以保持方法表原顺序）。 */
export function createPluginsMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'plugins.list',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['plugins'],
        properties: {
          plugins: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'enabled'],
              properties: {
                name: { type: 'string' },
                enabled: { type: 'boolean' },
                // 0.43 E10：additive 运行时元数据。
                version: { type: 'string' },
                mode: { type: 'string', enum: ['in-process', 'child'] },
                status: {
                  type: 'string',
                  enum: ['inactive', 'active', 'unhealthy', 'disabled', 'invalid'],
                },
                // 0.43 E1：additive；能力插件 / 无渲染贡献不返回。
                contributions: {
                  type: 'object',
                  properties: {
                    // E5：自定义分组（v1 最多一个）。
                    navGroups: { type: 'array', items: { type: 'object' } },
                    // E9：插件私有 i18n（原样透传，已校验）。
                    i18n: { type: 'object' },
                    pages: { type: 'array', items: { type: 'object' } },
                    panels: { type: 'array', items: { type: 'object' } },
                    commands: { type: 'array', items: { type: 'object' } },
                    // E1 amendment：bare RPC 方法名。
                    rpc: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      handler: () => ({
        plugins: mergePluginList(
          deps.plugins(),
          deps.pluginsContributions?.(),
          deps.pluginsMetadata?.(),
        ),
      }),
    },
    {
      // 0.47：只读统一插件视图；写路径仍走 config / set-enabled。
      name: 'plugins.catalog',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array' },
        },
      },
      handler: () => ({
        items: deps.pluginCatalog?.() ?? [],
      }),
    },
    {
      // 0.43 E3：plugin 子进程没有调用宿主 RPC 的通道，只有 gateway principal 能触发。
      name: 'plugins.reload',
      permission: 'write',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['added', 'removed', 'changed', 'active', 'errors'],
        properties: {
          added: { type: 'array', items: { type: 'string' } },
          removed: { type: 'array', items: { type: 'string' } },
          changed: { type: 'array', items: { type: 'string' } },
          active: { type: 'array', items: { type: 'string' } },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'code', 'message'],
              properties: {
                id: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          restart_required: { type: 'boolean' },
        },
      },
      handler: async () => {
        if (deps.pluginsReload === undefined) {
          throw new RpcError('not_supported', 'Plugin reload is not available.');
        }
        return deps.pluginsReload();
      },
    },
  ];
}
