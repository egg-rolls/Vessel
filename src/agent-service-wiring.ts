/**
 * 进程内 AgentService 装配（0.17 Phase A / 0.27 统一 agent-body）。
 *
 * 入口层在这里把 provider / 工具面 / 限额 / 事件流 / scheduler 交给成员执行内核：
 * - 交互入口传 `permissionMode: 'bridge'` 与父事件流，成员 ask 经父流弹到现有权限卡片；
 * - headless 传 `allow`；
 * - `main` 走普通 create（role `single`），由 `admit` 正常执行；不再有 owner 特例。
 *
 * @module vessel/agent-service-wiring
 */

import {
  AgentError,
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
  type MemberRuntimePermissionMode,
  type MemberStatus,
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
  Scheduler,
  TerminationPolicy,
  ToolDefinition,
  UsageLimits,
} from '@vessel-agent/core';

export interface AgentServiceWiringOptions {
  /**
   * 本机 node id：唯一的 nodeId 来源是 bootstrap 的 `resolveNodeIdentity()`，
   * 装配层只做分发，不自己解析。
   *
   * 两个消费者共用这一个值：成员来源行（`<principal>@<node>:<team>`）与
   * federation 发送端口。必填 —— federation 关闭时来源行仍要 node 段。
   */
  nodeId: string;
  tenantId: string;
  /** 全局 dataDir；snapshot 落 `<dataDir>/agents/<tenant>.json` */
  dataDir: string;
  sessionId: string;
  pluginHost: PluginHost;
  /**
   * 0.27（spec §5.1）：每 tenant 唯一 scheduler，由装配层（tenant bundle）构造并注入。
   * `AgentService` 的所有执行都经它的 executor。
   */
  scheduler: Scheduler;
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
  /**
   * 在成员默认白名单（bash / read / edit / agent）之外额外放行的工具名，原样透传给
   * `InProcessMemberRuntimeOptions.extraTools`。
   *
   * 唯一用途是让「父宿主真的注册了某工具」这件事传到成员 Body（当前只有
   * `ask_user`：serve / 交互 REPL 有应答者，headless 没有）。可选 = 不传则维持旧工具面。
   */
  extraTools?: readonly string[];
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
  /**
   * 派生 `main`（role `single`）成员，返回建好或复用的状态。
   *
   * 排序契约：**必须在父宿主 `registerTool(tool)` 之后调用**。成员 Body 在 spawn
   * 时快照父宿主的工具列表（`packages/agent/src/runtime.ts` 的 `selectTools`），
   * 装配期就 spawn 会让 `main` 永久缺 `agent` 工具。幂等：并发/重复调用只 create 一次。
   */
  startOwner: () => Promise<MemberStatus>;
  ownerId: string;
  /** 0.19 S3：Team 能力层（owner 端点 / gateway 注入 / agent 工具共用） */
  team: AgentTeamService;
  /** Team 文件存储；dispose 时需 flush（内部字段） */
  teamStore: TeamStore;
  /** 0.19 S4：conversation 预算（有 dataDir 时构造） */
  budget?: ConversationBudget;
  /** 0.19 S4：预算状态文件存储；dispose 时需 flush */
  conversationStore?: ConversationStore;
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
    // 父宿主已注册的工具（当前只有 ask_user）白名单放行；不传时成员工具面不变。
    ...(options.extraTools !== undefined ? { extraTools: options.extraTools } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    // A3c：bridge 权限事件与父入口同源；未提供时成员保持无父流。
    ...(options.parentEvents !== undefined ? { parentEvents: options.parentEvents } : {}),
    ...(onPermissionState !== undefined ? { onPermissionState } : {}),
    ...(onMemberEvent !== undefined ? { onMemberEvent } : {}),
    ...(options.runtimeFactory !== undefined ? { runtimeFactory: options.runtimeFactory } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.eventLog !== undefined ? { eventLog: options.eventLog } : {}),
    tenantId: options.tenantId,
    // 来源行的 node 段：与 federation 端口同源（bootstrap 的 nodeIdentity），
    // 只在装配期传一次，执行内核不自己解析。
    nodeId: options.nodeId,
  };
}

/**
 * 创建 `main`（普通 single agent）或复用已存在的记录。
 *
 * 同一 dataDir 可能被装配多次（REPL 重启 / snapshot 重载），此时 `main` 已在
 * snapshot 里，`create` 会以 `duplicate member id` 拒绝。只吞这一种错误，
 * 其它（invalid_input 的其它原因、spawn_failed…）原样抛出。`main` 是 private，
 * 因此回读必须带 `viewer` 身份，否则列表看不到它。
 */
async function createOrRestoreOwner(service: AgentService, ownerId: string): Promise<MemberStatus> {
  try {
    // `name` 与 id 同值：来源行有名字就渲染名字、没名字才退回 id。不给 name 时
    // main 靠「id 恰好叫 main」碰巧渲染正确；一旦 `agent.ownerId` 配成别的值，
    // 渲染出的 principal 就是那个配置值（一个 id），与「有名字用名字」不一致。
    // 注意：已存在的 main 回读时不补 name（见下方 catch），旧快照靠 id 兜底，结果相同。
    return await service.create({ id: ownerId, name: ownerId, role: 'single' });
  } catch (error) {
    const duplicate =
      error instanceof AgentError &&
      error.code === 'invalid_input' &&
      error.message === `duplicate member id: ${ownerId}`;
    if (!duplicate) throw error;
    const existing = (await service.list({ viewer: ownerId })).find(
      (status) => status.id === ownerId,
    );
    // 回读不到说明不是“已存在”的重复，而是别的问题：保留原始错误。
    if (existing === undefined) throw error;
    return existing;
  }
}

/** 构造成员 runtime + AgentService；`main` 由返回的 `startOwner()` 在工具注册后再派生 */
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
  // 0.27：body lease 取代 per-run session 写锁；`main` 也不再走特殊执行路径。

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
    runtime: innerRuntime,
    // 0.27（spec §5.1）：执行只经 tenant scheduler 的 executor，不再有第二套队列。
    scheduler: options.scheduler,
    defaultModel: options.model,
    ownerId,
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
  // 装配只组装，不 spawn：`main` 的 Body 会快照父宿主工具列表，调用方必须先
  // `registerTool(tool)` 再调 `startOwner()`。并发/重复调用共享同一个 promise；
  // 失败时清掉 memo，避免用缓存住的 rejection 毒化重试。
  let ownerPromise: Promise<MemberStatus> | undefined;
  const startOwner = (): Promise<MemberStatus> => {
    if (ownerPromise === undefined) {
      ownerPromise = createOrRestoreOwner(service, ownerId).catch((error: unknown) => {
        ownerPromise = undefined;
        throw error;
      });
    }
    return ownerPromise;
  };
  const team = createTeamService({
    tenantId: options.tenantId,
    agent: service,
    store: teamStore,
    // 0.27：Team 日志的 reply / 失败条目改从 run.* 终态读，与 agent.* 同一条父流。
    ...(options.parentEvents !== undefined ? { events: options.parentEvents } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.federation !== undefined ? { federation: options.federation } : {}),
  });

  return {
    service,
    tool: createAgentTool(service, {
      ownerId,
      ownerSessionId: options.sessionId,
      team,
    }),
    startOwner,
    ownerId,
    team,
    teamStore,
    ...(budget !== undefined ? { budget } : {}),
    ...(conversationStore !== undefined ? { conversationStore } : {}),
  };
}
