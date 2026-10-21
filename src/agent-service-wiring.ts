/**
 * 进程内 AgentService 装配（0.17 Phase A）。
 *
 * 入口层在这里把父 runtime 的 provider / 工具面 / 限额 / 事件流交给成员执行内核：
 * - 交互入口传 `permissionMode: 'bridge'` 与父事件流，成员 ask 经父流弹到现有权限卡片；
 * - headless 传 `allow`；
 * - 父 turn 的 BeforeLlm hook 排空 owner 队列（agent 轨 `takeMessages`）。
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
  type InProcessMemberRuntimeOptions,
  type MemberRuntimeMember,
  type MemberRuntimePermissionMode,
  type MemberRuntimePort,
  type MemberStatus,
  type MemberTurnResult,
  type NewBatchInput,
  type NewMemberInput,
} from '@vessel-agent/agent';
import type {
  EventStream,
  LLMProvider,
  Logger,
  PluginHost,
  RuntimePermissionConfig,
  TerminationPolicy,
  ToolDefinition,
  UsageLimits,
} from '@vessel-agent/core';
import {
  AGENT_OWNER_INJECTION_HOOK,
  type AgentOwnerInjector,
  createAgentOwnerInjector,
  createOwnerMessageSource,
  type OwnerMessageSource,
} from './agent-owner-injection';

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
  /**
   * 0.17 A3c：父入口（REPL owner）事件流。成员 bridge 的
   * `tool.permission.request` 与父级共用同一流，TUI / Web 的现有权限控制器
   * 与 `permission.respond` 无需第二套协议。
   */
  parentEvents?: EventStream;
  /** 成员权限模式：交互 bridge、headless allow（缺省沿用 agent 包缺省 allow） */
  permissionMode?: MemberRuntimePermissionMode;
}

export interface AgentServiceWiring {
  service: AgentService;
  tool: ToolDefinition;
  owner: MemberStatus;
  ownerId: string;
  /** 父 turn 的 owner 队列注入；关闭时停止 hook（PluginHost 无反注册） */
  injector: AgentOwnerInjector;
}

/**
 * 成员 runtime 选项 + agent 轨 A3c 新增的 `parentEvents`。
 * agent 包合并前多出的字段在运行时被忽略；合并后无需改这里。
 */
export type MemberRuntimeOptionsWithParentEvents = InProcessMemberRuntimeOptions & {
  parentEvents?: EventStream;
};

/** 构造成员 runtime 选项（导出便于测试选项传递，不直接构造 runtime） */
export function buildMemberRuntimeOptions(
  options: AgentServiceWiringOptions,
): MemberRuntimeOptionsWithParentEvents {
  return {
    providerFactory: options.providerFactory,
    model: options.model,
    pluginHost: options.pluginHost,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.termination !== undefined ? { termination: options.termination } : {}),
    ...(options.contextMaxTokens !== undefined
      ? { contextMaxTokens: options.contextMaxTokens }
      : {}),
    ...(options.permission !== undefined ? { permission: options.permission } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    // A3c：bridge 权限事件与父入口同源；未提供时成员保持无父流。
    ...(options.parentEvents !== undefined ? { parentEvents: options.parentEvents } : {}),
    tenantId: options.tenantId,
  };
}

/**
 * root owner 是 REPL 的主 agent，不在成员执行内核里 spawn。
 * owner 的 turn 由外层 REPL/TUI 驱动；这里显式收口，避免 owner 被标成 failed
 * 或刷 `member runtime not spawned`。owner 队列由 BeforeLlm 的 takeMessages 消费。
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

/** 没有 owner 队列消费方时：不把成员挂到 owner 名下（自动回复会无人可跑）。 */
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
 * A3b 兼容门面：agent 轨尚未提供 `takeMessages` 时，`agent.new` 去掉 parentId，
 * 避免成员最终文本投递给没有消费方的 REPL owner。A3c 合并后不再使用。
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
  const innerRuntime = createInProcessMemberRuntime(buildMemberRuntimeOptions(options));
  const runtime = new OwnerAwareMemberRuntime(innerRuntime, ownerId);

  const service = createAgentService({
    tenantId: options.tenantId,
    dataDir: options.dataDir,
    runtime,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    snapshot: { enabled: true },
  });
  const owner = await service.attachOwner({ id: ownerId, sessionId: options.sessionId });
  // A3c：agent 轨提供 takeMessages 后才保留 parentId，让成员最终文本进 owner 队列
  // 由 BeforeLlm 排空；未合并时沿用 A3b 的“不挂 parent、不自动投递”，避免 owner
  // 被自动回复拉进一个没有消费方的 turn。
  const supportsOwnerInbox =
    typeof (service as Partial<OwnerMessageSource>).takeMessages === 'function';
  const publicService = supportsOwnerInbox ? service : withoutParentDelivery(service);

  // 成员 runtime 复制父 PluginHost 的 hooks；只有父 turn 才能排空 owner 队列。
  const injector = createAgentOwnerInjector({
    source: createOwnerMessageSource(publicService),
    ownerId,
    isMemberSession: async (sessionId) => {
      if (sessionId === undefined) return false;
      const members = await publicService.list();
      return members.some((member) => member.id !== ownerId && member.session_id === sessionId);
    },
    ...(options.parentEvents !== undefined ? { events: options.parentEvents } : {}),
    tenantId: options.tenantId,
  });
  const registered = options.pluginHost
    .getHooks()
    .some((hook) => hook.name === AGENT_OWNER_INJECTION_HOOK);
  if (!registered) options.pluginHost.registerHook(injector.hook);

  return {
    service: publicService,
    tool: createAgentTool(publicService, { ownerId }),
    owner,
    ownerId,
    injector,
  };
}
