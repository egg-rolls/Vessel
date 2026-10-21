/**
 * 进程内 AgentService 装配（0.17 Phase A）。
 *
 * 入口层只在这里把父 runtime 的 provider / 工具面 / 限额交给成员执行内核；
 * 不做权限 bridge（A3c），成员的 ask 按 deny 收口（见 InProcessMemberRuntime）。
 *
 * @module vessel/agent-service-wiring
 */

import {
  type AgentMessage,
  type AgentService,
  type BatchResult,
  createAgentService,
  createAgentTool,
  createInProcessMemberRuntime,
  DEFAULT_OWNER,
  type MemberRuntimeMember,
  type MemberRuntimePort,
  type MemberStatus,
  type MemberTurnResult,
  type NewBatchInput,
  type NewMemberInput,
} from '@vessel-agent/agent';
import type {
  LLMProvider,
  Logger,
  PluginHost,
  RuntimePermissionConfig,
  TerminationPolicy,
  ToolDefinition,
  UsageLimits,
} from '@vessel-agent/core';

export interface AgentServiceWiringOptions {
  tenantId: string;
  /** 全局 dataDir；snapshot 落 `<dataDir>/agents/<tenant>.json` */
  dataDir: string;
  sessionId: string;
  pluginHost: PluginHost;
  /** 每个成员一个 provider（当前入口共用父实例；provider 无跨请求状态） */
  providerFactory: () => LLMProvider;
  model: string;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  contextMaxTokens?: number;
  permission?: RuntimePermissionConfig;
  logger?: Logger;
  ownerId?: string;
}

export interface AgentServiceWiring {
  service: AgentService;
  tool: ToolDefinition;
  owner: MemberStatus;
  ownerId: string;
}

/**
 * root owner 是 REPL 的主 agent，不在成员执行内核里 spawn。
 * 成员的自动最终文本会投递给父级（owner）；Phase A 没有 owner turn 的消费方，
 * 这里直接收口，避免 owner 被标成 failed 或刷 `member runtime not spawned` 错误。
 */
class OwnerAwareMemberRuntime implements MemberRuntimePort {
  constructor(
    private readonly inner: MemberRuntimePort,
    private readonly ownerId: string,
  ) {}

  spawn(member: MemberRuntimeMember): Promise<void> {
    if (member.id === this.ownerId) return Promise.resolve();
    return this.inner.spawn(member);
  }

  runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult> {
    if (member.id === this.ownerId) return Promise.resolve({ outcome: 'completed' });
    return this.inner.runTurn(member, message);
  }

  cancel(member: MemberRuntimeMember): Promise<void> | void {
    return this.inner.cancel(member);
  }

  dispose(member: MemberRuntimeMember): Promise<void> | void {
    return this.inner.dispose(member);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Phase A 没有 owner turn 的消费方：不把成员挂到 owner 名下（自动回复会无人可跑）。 */
function stripParent(entry: unknown): unknown {
  if (!isRecord(entry) || entry.parentId === undefined) return entry;
  const { parentId: _parentId, ...rest } = entry;
  return rest;
}

function stripParentInput(input: NewMemberInput | NewBatchInput): NewMemberInput | NewBatchInput {
  if ('members' in input && Array.isArray(input.members)) {
    return { members: input.members.map(stripParent) as NewMemberInput[] };
  }
  return stripParent(input) as NewMemberInput;
}

/**
 * Phase A 门面：`agent.new` 去掉 parentId，避免 AgentService 自动把成员最终文本
 * 投递给没有 runtime 的 REPL owner（A3c 再接 owner turn / 事件）。
 */
function withoutParentDelivery(service: AgentService): AgentService {
  const originalNew = service.new.bind(service) as (
    input: NewMemberInput | NewBatchInput,
  ) => Promise<MemberStatus | BatchResult<MemberStatus>>;
  const wrappedNew = (
    input: NewMemberInput | NewBatchInput,
  ): Promise<MemberStatus | BatchResult<MemberStatus>> => originalNew(stripParentInput(input));

  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === 'new') return wrappedNew;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AgentService;
}

/** 构造成员 runtime + AgentService，并注册 root owner（不 spawn） */
export async function createAgentServiceWiring(
  options: AgentServiceWiringOptions,
): Promise<AgentServiceWiring> {
  const ownerId = options.ownerId ?? DEFAULT_OWNER;
  const innerRuntime = createInProcessMemberRuntime({
    providerFactory: options.providerFactory,
    model: options.model,
    pluginHost: options.pluginHost,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.termination !== undefined ? { termination: options.termination } : {}),
    ...(options.contextMaxTokens !== undefined
      ? { contextMaxTokens: options.contextMaxTokens }
      : {}),
    ...(options.permission !== undefined ? { permission: options.permission } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    tenantId: options.tenantId,
  });
  const runtime = new OwnerAwareMemberRuntime(innerRuntime, ownerId);

  const service = createAgentService({
    tenantId: options.tenantId,
    dataDir: options.dataDir,
    runtime,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    snapshot: { enabled: true },
  });
  const owner = await service.attachOwner({ id: ownerId, sessionId: options.sessionId });
  const publicService = withoutParentDelivery(service);

  return {
    service: publicService,
    tool: createAgentTool(publicService, { ownerId }),
    owner,
    ownerId,
  };
}
