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
  type AgentTeamService,
  ConversationBudget,
  ConversationStore,
  createAgentService,
  createAgentTool,
  createInProcessMemberRuntime,
  createTeamService,
  DEFAULT_OWNER,
  type FederationSendPort,
  FileTeamStore,
  type InProcessMemberRuntimeOptions,
  type MemberPermissionState,
  type MemberRunnableAgent,
  type MemberRuntimeMember,
  type MemberRuntimePermissionMode,
  type MemberRuntimePort,
  type MemberStatus,
  type MemberTurnResult,
  type TeamDeclaration,
  type TeamStore,
} from '@vessel-agent/agent';
import type {
  AgentRuntimeOptions,
  EventStream,
  LLMProvider,
  Logger,
  PluginHost,
  RunEvent,
  RuntimePermissionConfig,
  TerminationPolicy,
  ToolDefinition,
  UsageLimits,
} from '@vessel-agent/core';
import {
  AGENT_OWNER_INJECTION_HOOK,
  type AgentOwnerInjector,
  createAgentOwnerInjector,
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
  /** deny 模式保留的只读工具（默认 ['read']） */
  readOnlyTools?: readonly string[];
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
  /** tenant SessionBackend；成员 Body 用同一份存储按 session_id 续接历史 */
  session?: AgentRuntimeOptions['session'];
  /** tenant SessionEventLog；与父入口同源（缺省不落 trace） */
  eventLog?: AgentRuntimeOptions['eventLog'];
  /**
   * 测试接缝：覆盖成员 AgentRuntime 构造。缺省 `AgentRuntime.create`；
   * bridge / owner 队列的端到端测试用 fake runtime，不调真实 provider。
   */
  runtimeFactory?: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
  /** 0.19 S3：全局配置声明的 Team；只补写缺失的 team.json */
  teamDeclarations?: readonly TeamDeclaration[];
  /**
   * 0.19 S3：`new` 未显式传 workspace 时的默认 Team workspace。
   * 仅当声明与 `agent.cwd` 归一化后精确相等时提供。
   */
  defaultWorkspace?: string;
  /** 0.21：跨节点发送端口；只在 federation 启用时由 bootstrap 注入 */
  federation?: FederationSendPort;
}

export interface AgentServiceWiring {
  service: AgentService;
  tool: ToolDefinition;
  owner: MemberStatus;
  ownerId: string;
  /** 0.19 S3：Team 能力层（owner 端点 / gateway 注入 / agent 工具共用） */
  team: AgentTeamService;
  /** Team 文件存储；dispose 时需 flush（内部字段） */
  teamStore: TeamStore;
  /** 0.19 S4：conversation 预算（有 dataDir 时构造） */
  budget?: ConversationBudget;
  /** 0.19 S4：预算状态文件存储；dispose 时需 flush */
  conversationStore?: ConversationStore;
  /** 父 turn 的 owner 队列注入；关闭时停止 hook（PluginHost 无反注册） */
  injector: AgentOwnerInjector;
}

/** 构造成员 runtime 选项（导出便于测试选项传递，不直接构造 runtime） */
export function buildMemberRuntimeOptions(
  options: AgentServiceWiringOptions,
  onPermissionState?: (memberId: string, sessionId: string, state: MemberPermissionState) => void,
  onMemberEvent?: (memberId: string, sessionId: string, event: RunEvent) => void,
  teamPolicy?: InProcessMemberRuntimeOptions['permissionPolicy'],
): InProcessMemberRuntimeOptions {
  // 成员 Body 只能通过 `agent` 工具 rotate 自己（tool handler 收紧），
  // 因此 member runtime 免确认该工具；owner 侧权限不变。
  const permission =
    options.permission !== undefined
      ? {
          ...options.permission,
          autoApprove: [...new Set([...(options.permission.autoApprove ?? []), 'agent'])],
        }
      : undefined;
  return {
    providerFactory: options.providerFactory,
    model: options.model,
    pluginHost: options.pluginHost,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.termination !== undefined ? { termination: options.termination } : {}),
    ...(options.contextMaxTokens !== undefined
      ? { contextMaxTokens: options.contextMaxTokens }
      : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    // 0.19 S4：Team 成员强制 bridge；无人值守策略按成员所属 Team 解析。
    forceBridgeForTeams: true,
    ...(teamPolicy !== undefined ? { permissionPolicy: teamPolicy } : {}),
    ...(options.readOnlyTools !== undefined ? { readOnlyTools: options.readOnlyTools } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    // A3c：bridge 权限事件与父入口同源；未提供时成员保持无父流。
    ...(options.parentEvents !== undefined ? { parentEvents: options.parentEvents } : {}),
    ...(onPermissionState !== undefined ? { onPermissionState } : {}),
    ...(onMemberEvent !== undefined ? { onMemberEvent } : {}),
    ...(options.runtimeFactory !== undefined ? { runtimeFactory: options.runtimeFactory } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.eventLog !== undefined ? { eventLog: options.eventLog } : {}),
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

/** 构造成员 runtime + AgentService，并注册 root owner（不 spawn） */
export async function createAgentServiceWiring(
  options: AgentServiceWiringOptions,
): Promise<AgentServiceWiring> {
  const ownerId = options.ownerId ?? DEFAULT_OWNER;

  // Team 元数据必须先于成员 runtime 与 AgentService 就绪：`new` 的 ensure / seed
  // 都经 TeamBinder，成员的 unmanned 权限策略也从同一 store 解析。
  const teamStore = new FileTeamStore({
    dataDir: options.dataDir,
    tenantId: options.tenantId,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  await teamStore.ready();
  await teamStore.seed(options.teamDeclarations ?? []);

  // 成员 bridge 进入/离开权限等待时回调 AgentService；service 在 runtime 之后构造，
  // 用晚绑定避免循环依赖。
  let serviceRef: AgentService | undefined;
  const innerRuntime = createInProcessMemberRuntime(
    buildMemberRuntimeOptions(
      options,
      (memberId, sessionId, state) => serviceRef?.notePermissionState(memberId, sessionId, state),
      (memberId, sessionId, event) => serviceRef?.noteMemberEvent(memberId, sessionId, event),
      (teamId) => (teamId === undefined ? undefined : teamStore.policy(teamId)?.permission),
    ),
  );
  const runtime = new OwnerAwareMemberRuntime(innerRuntime, ownerId);

  // 0.19 S4：有 dataDir 才落 conversation 预算；否则保持纯内存。
  const conversationStore =
    options.dataDir !== undefined
      ? new ConversationStore({
          dataDir: options.dataDir,
          tenantId: options.tenantId,
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        })
      : undefined;
  const budget =
    conversationStore !== undefined
      ? new ConversationBudget({
          store: conversationStore,
          policyFor: (teamId) => (teamId === undefined ? undefined : teamStore.policy(teamId)),
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        })
      : undefined;

  const service = createAgentService({
    tenantId: options.tenantId,
    dataDir: options.dataDir,
    runtime,
    defaultModel: options.model,
    // 成员生命周期事件与父入口同源；缺省时只有 subscribe，不进入父流。
    ...(options.parentEvents !== undefined ? { events: options.parentEvents } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.defaultWorkspace !== undefined
      ? { defaultWorkspace: options.defaultWorkspace }
      : {}),
    teamBinder: teamStore,
    teamPolicy: (teamId) => teamStore.policy(teamId),
    ...(budget !== undefined ? { budget } : {}),
    snapshot: { enabled: true },
  });
  serviceRef = service;
  const owner = await service.attachOwner({ id: ownerId, sessionId: options.sessionId });
  const team = createTeamService({
    tenantId: options.tenantId,
    agent: service,
    store: teamStore,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.federation !== undefined ? { federation: options.federation } : {}),
  });

  // 成员 runtime 复制父 PluginHost 的 hooks；只有父 turn 才能排空 owner 队列。
  const injector = createAgentOwnerInjector({
    // owner 是 external owner：pump 不消费，只能由父 turn 排空。
    source: service,
    ownerId,
    // 当前 Body、正在跑的旧 Body、已退役 Body 与 rotate 目标都算成员 Body；
    // 由 service 统一判定，owner 的 Body 不算。
    isMemberSession: (sessionId) => sessionId !== undefined && service.isMemberBody(sessionId),
    ...(options.parentEvents !== undefined ? { events: options.parentEvents } : {}),
    tenantId: options.tenantId,
  });
  const registered = options.pluginHost
    .getHooks()
    .some((hook) => hook.name === AGENT_OWNER_INJECTION_HOOK);
  if (!registered) options.pluginHost.registerHook(injector.hook);

  return {
    service,
    tool: createAgentTool(service, {
      ownerId,
      ownerSessionId: options.sessionId,
      team,
    }),
    owner,
    ownerId,
    team,
    teamStore,
    ...(budget !== undefined ? { budget } : {}),
    ...(conversationStore !== undefined ? { conversationStore } : {}),
    injector,
  };
}
