/**
 * @vessel/team - agent team 原型（0.1.0）
 *
 * 只提供成员语义：spawn / send / inbox / cancel / status。
 * 依赖最小 `RuntimeHost` 形状接口（见 ./host.ts），不依赖 delegate_task 的内部 spawn，
 * 也不新增 core 接口。默认导出是空插件——必须由 asm 用 createTeamPlugin() 显式构造，
 * 不进默认插件集。跨进程 transport 在 0.2 由 web 提供。
 */

import { randomUUID } from 'node:crypto';
import type {
  RuntimeHost as CoreRuntimeHost,
  EventStream,
  LLMProvider,
  Plugin,
  PluginHost,
  TerminationPolicy,
  ToolDefinition,
  Transport,
  UsageLimits,
} from '@vessel/core';
import { MemoryPluginHost } from '@vessel/core';
import { CoreHostAdapter, type TeamHostPort } from './core-adapter.js';
import type { AgentStatus, TeamMessage, TeamMessageKind } from './host.js';
import { RoutingTeamHost } from './routing.js';

export * from './host.js';

/** 团队工具前缀：不给成员复制，防止成员继续 spawn/发消息 */
const TEAM_TOOL_PREFIX = 'team_';

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeTenantId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!TENANT_ID_RE.test(value)) throw new Error(`invalid tenant id "${value}"`);
  return value;
}

/** 插件配置 */
export interface TeamPluginOptions {
  /** 成员 provider 工厂（每次 spawn 调用一次） */
  providerFactory: () => LLMProvider;
  /** 成员默认模型 */
  model: string;
  /** core Host（必需；由 asm 构造并注入） */
  host: CoreRuntimeHost;
  /** 观测事件流（team.* 事件发布到这里） */
  events?: EventStream;
  /** owner（主 agent）成员 ID（默认 'owner'） */
  ownerId?: string;
  /** 跨进程传输（asm A5 注入）；提供时必须同时给 nodeId */
  transport?: Transport;
  /** 本机 nodeId，由 asm 从 host.node_id 解析后注入（不是 team 配置键） */
  nodeId?: string;
  /** owner 的 canonical 地址；缺省 `${nodeId}:${ownerId}` */
  ownerRef?: string;
  /** 成员用量限制 */
  memberLimits?: UsageLimits;
  /** 成员终止策略 */
  memberTermination?: TerminationPolicy;
  /** 0.5：tenant 作用域（可选）；缺失不写 tenant_id。 */
  tenantId?: string;
}

/** 解析后的配置 */
interface ResolvedConfig {
  providerFactory: () => LLMProvider;
  model: string;
  port: TeamHostPort;
  ownerId: string;
  memberLimits?: UsageLimits;
  memberTermination?: TerminationPolicy;
}

/** 类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 读字符串参数 */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * 成员的插件宿主：复制工具（排除 team_*）、guardrail、hook。
 * 成员不能继续 delegate 团队能力，避免无限扩张。
 */
function buildChildHost(host: PluginHost): MemoryPluginHost {
  const childHost = new MemoryPluginHost();
  for (const guardrail of host.getGuardrails()) childHost.registerGuardrail(guardrail);
  for (const hook of host.getHooks()) childHost.registerHook(hook);
  for (const tool of host.listTools()) {
    if (tool.name.startsWith(TEAM_TOOL_PREFIX)) continue;
    childHost.registerTool(tool);
  }
  return childHost;
}

/** 构造 team_spawn */
function makeSpawnTool(host: PluginHost, config: ResolvedConfig): ToolDefinition {
  return {
    name: 'team_spawn',
    description:
      'Spawn a long-lived in-process team member with its own context. Returns the member id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        model: { type: 'string', description: 'Model override for this member' },
        systemPrompt: { type: 'string', description: 'Optional system prompt' },
      },
      required: [],
    },
    handler: async (args: unknown) => {
      const record = isRecord(args) ? args : {};
      try {
        const status = await config.port.spawn({
          name: readString(record, 'name') || undefined,
          provider: config.providerFactory(),
          model: readString(record, 'model') || config.model,
          pluginHost: buildChildHost(host),
          systemPrompt: readString(record, 'systemPrompt') || undefined,
          limits: config.memberLimits,
          termination: config.memberTermination,
        });
        return JSON.stringify(status);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** 构造 team_send */
function makeSendTool(config: ResolvedConfig): ToolDefinition {
  return {
    name: 'team_send',
    description:
      'Send a message or task to a team member (kind: message | task). ' +
      'task runs the member and delivers a result back to the owner inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target member id' },
        content: { type: 'string', description: 'Message/task text' },
        kind: {
          type: 'string',
          enum: ['message', 'task'],
          description: 'message (default) or task',
        },
      },
      required: ['to', 'content'],
    },
    handler: async (args: unknown) => {
      if (!isRecord(args)) return 'Error: team_send requires { to, content }';
      const to = readString(args, 'to');
      const content = readString(args, 'content');
      const rawKind = readString(args, 'kind');
      const kind: TeamMessageKind = rawKind === 'task' ? 'task' : 'message';
      if (!to) return 'Error: team_send requires a non-empty to';
      if (!content) return 'Error: team_send requires a non-empty content';

      try {
        await config.port.send({
          id: randomUUID(),
          from: config.ownerId,
          to,
          kind,
          content,
          ts: Date.now(),
        });
        return JSON.stringify({ ok: true, to, kind });
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** 构造 team_inbox */
function makeInboxTool(config: ResolvedConfig): ToolDefinition {
  return {
    name: 'team_inbox',
    description:
      'Read messages sent to a member (default: the owner). Pass the returned cursor ' +
      'back to read only new messages.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member id (default: owner)' },
        cursor: { type: 'string', description: 'Cursor from the previous call' },
      },
      required: [],
    },
    handler: async (args: unknown) => {
      const record = isRecord(args) ? args : {};
      const member = readString(record, 'member') || config.ownerId;
      try {
        const page = await config.port.inbox(member, readString(record, 'cursor'));
        return JSON.stringify(page);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** 构造 team_status */
function makeStatusTool(config: ResolvedConfig): ToolDefinition {
  return {
    name: 'team_status',
    description: 'List team members, or show one member when `member` is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Optional member id' },
      },
      required: [],
    },
    handler: async (args: unknown) => {
      const record = isRecord(args) ? args : {};
      const member = readString(record, 'member');
      try {
        const status: AgentStatus | AgentStatus[] = await config.port.status(member || undefined);
        return JSON.stringify(status);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** 构造 team_cancel */
function makeCancelTool(config: ResolvedConfig): ToolDefinition {
  return {
    name: 'team_cancel',
    description: 'Cancel the running task of a team member.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member id' },
      },
      required: ['member'],
    },
    handler: async (args: unknown) => {
      if (!isRecord(args)) return 'Error: team_cancel requires { member }';
      const member = readString(args, 'member');
      if (!member) return 'Error: team_cancel requires a non-empty member';
      try {
        await config.port.cancel(member);
        return JSON.stringify({ ok: true, member, state: 'cancelled' });
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/** 创建 team 插件（必须显式构造；不随默认插件集启用） */
export function createTeamPlugin(options: TeamPluginOptions): Plugin {
  if (!options.host) {
    throw new Error('team plugin requires a core RuntimeHost (host)');
  }
  if (options.transport && !options.nodeId) {
    throw new Error('nodeId is required when transport is enabled');
  }

  const ownerId = options.ownerId ?? 'owner';
  const tenantId = normalizeTenantId(options.tenantId);
  // 跨进程时本地成员的结果需要经 routing 投递（远端用 transport，本机用 local）
  const holder: { routing?: RoutingTeamHost } = {};
  const deliverResult = options.transport
    ? (message: TeamMessage) => holder.routing?.deliverResult(message) ?? Promise.resolve()
    : undefined;

  const localPort: TeamHostPort = new CoreHostAdapter(options.host, {
    events: options.events,
    ownsHost: false,
    ...(deliverResult ? { deliverResult } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  });

  let port: TeamHostPort = localPort;
  if (options.transport) {
    const routing = new RoutingTeamHost({
      local: localPort,
      transport: options.transport,
      nodeId: options.nodeId ?? '',
      ownerId,
      ...(options.ownerRef !== undefined ? { ownerRef: options.ownerRef } : {}),
    });
    holder.routing = routing;
    port = routing;
  }

  const config: ResolvedConfig = {
    providerFactory: options.providerFactory,
    model: options.model,
    port,
    ownerId,
    memberLimits: options.memberLimits,
    memberTermination: options.memberTermination,
  };

  return {
    name: 'team',
    version: '0.1.0',
    description: 'agent team prototype: spawn / send / inbox / cancel / status (opt-in)',
    install(host: PluginHost) {
      const tools: ToolDefinition[] = [
        makeSpawnTool(host, config),
        makeSendTool(config),
        makeInboxTool(config),
        makeStatusTool(config),
        makeCancelTool(config),
      ];
      for (const tool of tools) host.registerTool(tool);
    },
  };
}

/**
 * 默认导出是空插件：PluginLoader 自动扫到也不会注册任何工具。
 * 真正启用需要 asm 用 createTeamPlugin() 显式构造（0.2 前保持 opt-in）。
 */
export const disabledTeamPlugin: Plugin = {
  name: 'team',
  version: '0.1.0',
  description: 'agent team prototype (disabled by default; construct via createTeamPlugin)',
  install() {
    // no-op：显式 opt-in
  },
};

export default disabledTeamPlugin;
