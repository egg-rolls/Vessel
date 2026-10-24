/**
 * config.* / health.get / capabilities.list 与工具、插件目录方法。
 *
 * @module @vessel-agent/serve
 */

import { redactConfig, redactSourcePaths, type VesselConfig } from '@vessel-agent/config';
import type { PluginHost } from '@vessel-agent/core';
import type { NodeInfo, ProtocolInfo, ToolInfo } from '../../protocol.js';
import {
  buildCapabilityManifest,
  RpcError,
  type RpcMethodDefinition,
  type RpcMethodTable,
} from '../../rpc.js';
import type { ConfigGatewayOptionsLike } from '../../tenant.js';
import { stringParam, tenantParamSchema } from './common.js';
import { runtimeSnapshotSchema, stringListSchema } from './schemas.js';

/** `config.set` 可写键（与 CLI `vessel config set` 的白名单一致）。 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'ui.showReasoning',
  'ui.showInternalEvents',
  'ui.askUser',
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
  /** health.get 的 runtime 快照（0.15 E6）。 */
  runtimeSnapshot(tenantId: string): Record<string, unknown>;
  /** 方法表在组装完成后才有值；handler 调用时解析。 */
  methodTable(): RpcMethodTable;
  toolDescriptionsForTenant(tenantId: string): Array<{ name: string; description?: string }>;
  pluginsForTenant(tenantId: string): Array<{ name: string; enabled: boolean }>;
  pluginHostFor(tenantId: string): PluginHost | undefined;
  /** health.get 的实时状态。 */
  clientCount(): number;
  latestSeq(): number;
  protocolInfo: ProtocolInfo;
  nodeInfo(tenantId?: string): NodeInfo;
  startedAt: number;
}

/** health.get / capabilities.list / config.get / config.sources */
export function createConfigMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const {
    version,
    config,
    methodTable,
    toolDescriptionsForTenant,
    pluginsForTenant,
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
        required: [
          'status',
          'clients',
          'latest_seq',
          'protocol',
          'node',
          'started_at',
          'tenant_id',
          'runtime',
        ],
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
          tenant_id: { type: 'string' },
          /** 0.15 E6：active run 与 scheduler 快照。 */
          runtime: runtimeSnapshotSchema,
        },
      },
      handler: (_params, ctx) => {
        return {
          status: 'ok',
          clients: clientCount(),
          latest_seq: latestSeq(),
          protocol: protocolInfo,
          node: nodeInfo(ctx.tenantId),
          started_at: startedAt,
          tenant_id: ctx.tenantId,
          runtime: runtimeSnapshot(ctx.tenantId),
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
      handler: (_params, ctx) =>
        buildCapabilityManifest({
          version: version ?? '0.0.0',
          table: methodTable(),
          tools: toolDescriptionsForTenant(ctx.tenantId),
          plugins: pluginsForTenant(ctx.tenantId),
        }),
    },
    {
      name: 'config.get',
      permission: 'read',
      params_schema: tenantParamSchema,
      result_schema: {
        type: 'object',
        required: ['schema_version', 'config', 'paths', 'tenant_id'],
        properties: {
          schema_version: { type: 'integer' },
          config: { type: 'object' },
          paths: {
            type: 'object',
            required: ['user', 'project'],
            properties: {
              user: { type: 'string' },
              project: { type: 'string' },
            },
          },
          tenant_id: { type: 'string' },
          tenant_overlay_keys: stringListSchema,
        },
      },
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          schema_version: snapshot.schema_version,
          // DECISION-020 §R1.1：防御性二次脱敏（asm snapshot 已先脱敏）；
          // 复用 @vessel-agent/config#redactConfig，不在 serve 维护副本。
          config: redactConfig(snapshot.config as VesselConfig),
          // A-5 §12.2：TUI 需要展示 user/project 路径
          paths: snapshot.paths ?? { user: '', project: '' },
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
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
      handler: async (params, ctx) => {
        // 用户配置是进程级的；非 default tenant 不得跨租户改写。
        if (ctx.tenantId !== deps.defaultTenantId) {
          throw new RpcError('forbidden', 'config.set is only available for the default tenant');
        }
        const control = configControl();
        if (typeof control.set !== 'function') {
          throw new RpcError('not_found', 'Config write is not available');
        }
        const key = stringParam(params, 'key');
        const value = normalizeConfigValue(key, params.value);
        try {
          await control.set({ tenantId: ctx.tenantId, key, value });
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
      params_schema: tenantParamSchema,
      result_schema: {
        type: 'object',
        required: ['sources', 'tenant_id'],
        properties: {
          sources: { type: 'object' },
          tenant_id: { type: 'string' },
          tenant_overlay_keys: stringListSchema,
        },
      },
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          // DECISION-020 §R1.1：sources 键可能含 serve.tokens.<token>.*。
          sources: redactSourcePaths(snapshot.sources),
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
        };
      },
    },
  ];
}

/** tools.list（与 config 同域；单独工厂以保持方法表原顺序）。 */
export function createToolMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, pluginHostFor } = deps;

  function toolsPayload(tenantId: string = defaultTenantId): { tools: ToolInfo[] } {
    const host = pluginHostFor(tenantId);
    if (tenantId !== defaultTenantId && !host) {
      throw new RpcError('forbidden', `Tenant plugin host is not configured: ${tenantId}`);
    }
    const tools = host?.listTools() ?? [];
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
      params_schema: tenantParamSchema,
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
      handler: (_params, ctx) => toolsPayload(ctx.tenantId),
    },
  ];
}

/** plugins.list（与 config 同域；单独工厂以保持方法表原顺序）。 */
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
              },
            },
          },
        },
      },
      handler: (_params, ctx) => ({ plugins: deps.pluginsForTenant(ctx.tenantId) }),
    },
  ];
}
