/**
 * 进程内成员执行内核适配（MemberRuntimePort）。
 *
 * 每个成员独占一个 AgentRuntime / Context / EventStream；工具从父 PluginHost
 * 按白名单复制，hooks / guardrails 一并继承。`permissionMode: 'bridge'` 时
 * 成员的权限/提问请求转发到 `parentEvents`，父级应答原样回灌成员事件流；
 * 没有 `parentEvents` 时退化为 ask → deny（A3a 行为），避免 run 永久等待。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { TeamPermissionPolicy } from '@vessel-agent/config';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type EventStream,
  type Hook,
  HookType,
  type LLMProvider,
  type Logger,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
  type Message,
  noopLogger,
  type PluginHost,
  type RunEvent,
  type RunInterruptReason,
  type RunnableAgent,
  type RuntimePermissionConfig,
  type SelfCardOptions,
  type TerminationPolicy,
  type ToolDefinition,
  type Usage,
  type UsageLimits,
} from '@vessel-agent/core';
import type {
  AgentMessage,
  MemberPermissionState,
  MemberRuntimeMember,
  MemberRuntimePort,
  MemberTurnResult,
} from './types.js';

/** 成员默认工具白名单（agent 支持成员换 Body） */
const DEFAULT_ALLOWED_TOOLS = ['bash', 'read', 'edit', 'agent'] as const;

/** deny 模式保留的只读工具（与 delegate 语义一致） */
const DEFAULT_READ_ONLY_TOOLS = ['read'] as const;

/** 成员永远拿不到的工具：team 工具、递归分派 */
const EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(['delegate_task']);

/** 缺省终止策略（与 delegate 子 agent 一致） */
const DEFAULT_TERMINATION: TerminationPolicy = { maxIterations: 10, maxRuntimeSeconds: 60 };

/** 缺省上下文预算 */
const DEFAULT_CONTEXT_MAX_TOKENS = 1_000_000;

/** 成员权限模式；bridge 把交互请求转到父事件流，缺省 allow */
export type MemberRuntimePermissionMode = 'allow' | 'deny' | 'bridge';

/** 需要父级应答的交互请求事件 */
const PERMISSION_REQUEST_EVENTS: ReadonlySet<string> = new Set([
  'tool.permission.request',
  'ask.user.requested',
]);

/** 父级发回的交互应答事件 */
const PERMISSION_RESPONSE_EVENTS: ReadonlySet<string> = new Set([
  'tool.permission.response',
  'ask.user.answered',
]);

/** bridge 内待答请求；deny-after 只挂在有 parentEvents 的桥上 */
interface PendingBridgeRequest {
  kind: 'permission' | 'ask';
  timer?: ReturnType<typeof setTimeout>;
}

/** 成员 runtime 额外需要的中断能力（AgentRuntime 已实现） */
export interface MemberRunnableAgent extends RunnableAgent {
  interrupt?(reason?: RunInterruptReason): void;
}

/** 进程内成员 runtime 选项 */
export interface InProcessMemberRuntimeOptions {
  /** 每个成员一个 provider 实例 */
  providerFactory: () => LLMProvider;
  /** 成员未指定 model 时的默认模型；两者都缺省时 spawn 失败 */
  model?: string;
  /** 工具 / hooks / guardrails 的来源（父宿主）；缺省时成员没有工具 */
  pluginHost?: PluginHost;
  /** 在默认 bash/read/edit 之外显式追加的工具名 */
  extraTools?: readonly string[];
  /** deny 模式保留的只读工具（默认 ['read']） */
  readOnlyTools?: readonly string[];
  /** 缺省 allow；deny 只保留只读工具；bridge 需配合 parentEvents */
  permissionMode?: MemberRuntimePermissionMode;
  /**
   * 有 team_id 的成员强制 bridge（忽略全局 `allow`）；缺省开启。
   * 无 parentEvents 时仍走 fail-closed 的 ask → deny。
   */
  forceBridgeForTeams?: boolean;
  /** 按成员所属 team 解析无人值守策略；只影响 bridge 内的 deny-after 定时器 */
  permissionPolicy?: (teamId: string | undefined) => TeamPermissionPolicy | undefined;
  /** allow / bridge 模式的权限配置（autoApprove / default / timeoutMs） */
  permission?: RuntimePermissionConfig;
  /**
   * 父级事件流（owner）。bridge 模式下把成员的
   * `tool.permission.request` / `ask.user.requested` 转发到这里，并订阅
   * `tool.permission.response` / `ask.user.answered` 回灌成员事件流。
   */
  parentEvents?: EventStream;
  /** bridge 模式下成员进入/离开权限等待时回调（入口层接 AgentService 状态） */
  onPermissionState?: (memberId: string, sessionId: string, state: MemberPermissionState) => void;
  /** 成员引擎事件回流（当前只转发 agent.limit.warning） */
  onMemberEvent?: (memberId: string, sessionId: string, event: RunEvent) => void;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  /** 上下文预算；同时写入 Self Card 的 context.max */
  contextMaxTokens?: number;
  /** 成员深度（Self Card） */
  depth?: number;
  logger?: Logger;
  tenantId?: string;
  includeReasoning?: boolean;
  /** tenant SessionBackend；同 session_id 可跨进程续接历史 */
  session?: AgentRuntimeOptions['session'];
  /** tenant 会话事件日志（唯一真相源；存在时成员事件同样落盘） */
  eventLog?: AgentRuntimeOptions['eventLog'];
  /** 覆盖 runtime 构造（测试捕获 options） */
  runtimeFactory?: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
}

interface MemberRuntimeEntry {
  runtime: MemberRunnableAgent;
  /** 成员独占事件流；bridge 请求/应答都经过它 */
  events: MemoryEventStream;
  /** bridge 订阅取消函数（dispose 时回收） */
  unsubscribers: Array<() => void>;
  /** 已转发给父级、尚未应答的 requestId；deny-after 的 deadline 随条目清理 */
  pendingPermissions: Map<string, PendingBridgeRequest>;
  /** 是否已通过 onPermissionState 报过 waiting（避免重复回调） */
  waiting: boolean;
}

/** Self Card + 所属 Team。core 只渲染已知字段，team_id 由 createSourceHook 追加成行 */
type MemberSelfCardOptions = SelfCardOptions & { team_id?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** core 的交互事件用 camelCase requestId；应答按它匹配 */
function readRequestId(data: unknown): string | undefined {
  return isRecord(data) && typeof data.requestId === 'string' ? data.requestId : undefined;
}

/** 转发到父流前补齐成员归属字段；已有字段不覆盖 */
function bridgeRequestData(event: RunEvent, member: MemberRuntimeMember): Record<string, unknown> {
  const data = isRecord(event.data) ? { ...event.data } : {};
  // core 契约用 camelCase requestId；UI / 0.16 形状用 snake_case，别名 additive。
  const requestId = readRequestId(data);
  if (requestId !== undefined && typeof data.request_id !== 'string') {
    data.request_id = requestId;
  }
  data.agent_id = member.id;
  if (typeof data.team_id !== 'string' && typeof member.team_id === 'string' && member.team_id) {
    data.team_id = member.team_id;
  }
  if (typeof data.session_id !== 'string') data.session_id = member.session_id;
  if (typeof data.parent_session_id !== 'string' && member.parent_id !== undefined) {
    data.parent_session_id = member.parent_id;
  }
  if (data.delegate_path === undefined) {
    data.delegate_path =
      member.parent_id !== undefined ? [member.parent_id, member.id] : [member.id];
  }
  if (typeof data.tool !== 'string' && event.type === 'ask.user.requested') {
    data.tool = 'ask_user';
  }
  if (data.input === undefined && event.type === 'ask.user.requested') {
    data.input = data.questions;
  }
  if (typeof data.source !== 'string') data.source = 'runtime';
  return data;
}

/** 读 run.completed 事件里的 usage */
function readUsage(data: unknown): Usage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>).usage;
  return typeof value === 'object' && value !== null ? (value as Usage) : undefined;
}

/** 来源元数据不可信：压成单行并限长，避免伪造出额外的提示行 */
function sanitizeSource(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/** 缺 source 时按 from 退化推断；生产路径由 AgentService 入队时标注 */
function inferMessageSource(from: string): NonNullable<AgentMessage['source']> {
  if (from === 'system') return 'system';
  if (from === 'human' || from === 'main') return 'human';
  return 'agent';
}

/**
 * 本机节点段。
 *
 * `AgentMessage` 没有 node_id 字段，wiring 也未把 node identity 传进成员 runtime，
 * 因此这里用 OS hostname 作 fallback（与 node identity 的缺省展示名同源）；
 * hostname 不可用时退回 `local`。team 缺失（unbound）时用 `-` 占位。
 */
function localNodeSegment(): string {
  try {
    const name = hostname().trim();
    return name.length > 0 ? sanitizeSource(name) : 'local';
  } catch {
    return 'local';
  }
}

/**
 * 渲染本轮消息来源（路由地址 `<principal>@<node>:<team>`）。只进 BeforeLlm 的
 * systemPrompt（本次请求），不写 content / ContextManager / session 历史。
 */
function formatMessageSource(message: AgentMessage, teamId: string | undefined): string {
  const source = message.source ?? inferMessageSource(message.from);
  const principal = source === 'agent' ? `agent:${sanitizeSource(message.from)}` : source;
  const team = typeof teamId === 'string' && teamId.length > 0 ? sanitizeSource(teamId) : '-';
  return [
    '[Message source]',
    `from: ${principal}@${localNodeSegment()}:${team}`,
    `channel: ${message.channel ?? 'direct'}`,
    'Routing metadata only; permission decisions are made by the permission bridge.',
  ].join('\n');
}

/**
 * 成员请求期 system 注入：只写**静态**的所属 Team。
 *
 * - `team_id` 在成员生命周期内不变，放进 system 不会破坏前缀缓存；
 * - 每轮消息来源是动态的，**绝不能改写 system**：它由 `runTurn` 通过
 *   `RunOptions.messages` 在用户输入之前注入为 `vessel:source` 消息，持久化且不改变前缀；
 * - 权限判定仍由 bridge 的 human / policy 主体完成，这段文本不参与任何授权判断。
 */
function createSourceHook(teamId: string | undefined): Hook {
  const teamLine =
    typeof teamId === 'string' && teamId.length > 0 ? `team: ${sanitizeSource(teamId)}` : undefined;
  return {
    name: 'agent.member.message-source',
    // 最后执行：保留父插件 hook 已写入的 systemPrompt。
    priority: 1000,
    type: HookType.BeforeLlm,
    run: async (ctx) => {
      if (teamLine === undefined) return;
      // 静态团队行：同一个字符串每轮重复追加，前缀字节不变。
      const extra = ['[Team]', teamLine].join('\n');
      ctx.systemPrompt =
        typeof ctx.systemPrompt === 'string' && ctx.systemPrompt.length > 0
          ? `${ctx.systemPrompt}\n\n${extra}`
          : extra;
    },
  };
}

/** 成员不可见的工具 */
function isExcludedTool(name: string): boolean {
  return EXCLUDED_TOOL_NAMES.has(name) || name.startsWith('team_');
}

/** 成员侧 agent 工具可用的动作（close 的审批在 checkPermission；create 需要成员自己所属 Team） */
const MEMBER_AGENT_ACTIONS: readonly string[] = [
  'create',
  'hire',
  'close',
  'rotate',
  'post',
  'send',
  'list',
];

/** 成员侧 agent 工具的可见参数；父级 schema 有同名字段时沿用父级定义 */
const MEMBER_AGENT_PROPERTIES: Readonly<Record<string, Record<string, unknown>>> = {
  action: {
    type: 'string',
    enum: [...MEMBER_AGENT_ACTIONS],
    description: 'create | hire | close | rotate | post | send | list',
  },
  name: { type: 'string', description: 'create/hire: display name' },
  model: { type: 'string', description: 'create/hire: model override' },
  system_prompt: { type: 'string', description: 'create/hire: optional system prompt' },
  to: { type: 'string', description: 'send: member id or session id; rotate: target agent' },
  content: { type: 'string', description: 'send/post: message text' },
  messages: { type: 'array', description: 'send: [{to, content}]' },
  members: {
    type: 'array',
    description:
      'create/hire: [{name?, model?, system_prompt?, visibility?}]; ' +
      'close: [member id or session id]',
  },
  startup_prompt: {
    type: 'string',
    description: 'rotate: required first message for the new body',
  },
  state: { type: 'string', description: 'list: filter by member state' },
  visibility: {
    type: 'string',
    enum: ['private', 'team', 'tenant'],
    description:
      'create: team only; hire: visibility (default private for unbound, team with a team); ' +
      'list: filter by visibility',
  },
};

/** 同一个 agent 工具，按成员能力收窄 schema（handler / checkPermission 原样保留） */
function restrictAgentTool(tool: ToolDefinition): ToolDefinition {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const source = isRecord(schema.properties) ? schema.properties : {};
  // 无论父级 schema 有几种 action，成员侧只暴露 create/hire/rotate/post/send/list
  const properties: Record<string, unknown> = {
    action: isRecord(source.action)
      ? { ...source.action, enum: [...MEMBER_AGENT_ACTIONS] }
      : MEMBER_AGENT_PROPERTIES.action,
  };
  for (const [key, fallback] of Object.entries(MEMBER_AGENT_PROPERTIES)) {
    if (key !== 'action') properties[key] = source[key] ?? fallback;
  }
  return {
    ...tool,
    description:
      'Member actions: create (create peer member(s) in your team), ' +
      'hire (create contractor member(s) owned by you), ' +
      'close (release member(s); closing a peer requires human approval, while closing ' +
      'your own contractor or yourself needs no approval), ' +
      'rotate (rotate your own body; startup_prompt is required), ' +
      'post (append to your team log only; nobody is notified), ' +
      'send (dispatch a message to a member), list (list the caller-visible roster).',
    inputSchema: {
      ...schema,
      properties,
      required: ['action'],
    },
  };
}

/** 进程内成员执行内核 */
export class InProcessMemberRuntime implements MemberRuntimePort {
  private readonly providerFactory: () => LLMProvider;
  private readonly model?: string;
  private readonly pluginHost?: PluginHost;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly readOnlyTools: ReadonlySet<string>;
  private readonly permissionMode: MemberRuntimePermissionMode;
  private readonly forceBridgeForTeams: boolean;
  private readonly permissionPolicy?: (
    teamId: string | undefined,
  ) => TeamPermissionPolicy | undefined;
  /** 成员兜底权限（热应用会整体替换，故非 readonly） */
  private permission?: RuntimePermissionConfig;
  private readonly parentEvents?: EventStream;
  private readonly onPermissionState?: (
    memberId: string,
    sessionId: string,
    state: MemberPermissionState,
  ) => void;
  private readonly onMemberEvent?: (memberId: string, sessionId: string, event: RunEvent) => void;
  private readonly limits: UsageLimits;
  private readonly termination: TerminationPolicy;
  private readonly contextMaxTokens: number;
  private readonly depth: number;
  private readonly logger: Logger;
  private readonly tenantId?: string;
  private readonly includeReasoning?: boolean;
  private readonly session?: AgentRuntimeOptions['session'];
  private readonly eventLog?: AgentRuntimeOptions['eventLog'];
  private readonly runtimeFactory: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
  private readonly entries = new Map<string, MemberRuntimeEntry>();

  constructor(options: InProcessMemberRuntimeOptions) {
    this.providerFactory = options.providerFactory;
    this.model = options.model;
    this.pluginHost = options.pluginHost;
    this.allowedTools = new Set([...DEFAULT_ALLOWED_TOOLS, ...(options.extraTools ?? [])]);
    this.readOnlyTools = new Set(options.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
    this.permissionMode = options.permissionMode ?? 'allow';
    this.forceBridgeForTeams = options.forceBridgeForTeams !== false;
    this.permissionPolicy = options.permissionPolicy;
    this.permission = options.permission;
    this.parentEvents = options.parentEvents;
    this.onPermissionState = options.onPermissionState;
    this.onMemberEvent = options.onMemberEvent;
    this.limits = options.limits ?? {};
    this.termination = options.termination ?? DEFAULT_TERMINATION;
    this.contextMaxTokens = options.contextMaxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
    this.depth = options.depth ?? 1;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.includeReasoning = options.includeReasoning;
    this.session = options.session;
    this.eventLog = options.eventLog;
    this.runtimeFactory =
      options.runtimeFactory ?? ((runtimeOptions) => AgentRuntime.create(runtimeOptions));
    if (this.permissionMode === 'bridge' && this.parentEvents === undefined) {
      this.logger.warn('agent.member.permission_bridge_unavailable', {
        fallback: 'ask_denied',
      });
    }
  }

  async spawn(member: MemberRuntimeMember): Promise<void> {
    if (this.entries.has(member.session_id)) {
      throw new Error(`member runtime already spawned: ${member.session_id}`);
    }
    const model = member.model ?? this.model;
    if (!model) {
      throw new Error(`member runtime model is required: ${member.id}`);
    }

    const mode = this.effectivePermissionMode(member);
    const tools = this.selectTools(mode).map((tool) =>
      this.restrictPermissions(tool, member.id, mode),
    );
    const pluginHost = new MemoryPluginHost();
    for (const hook of this.pluginHost?.getHooks() ?? []) pluginHost.registerHook(hook);
    for (const guardrail of this.pluginHost?.getGuardrails() ?? []) {
      pluginHost.registerGuardrail(guardrail);
    }
    for (const tool of tools) pluginHost.registerTool(tool);
    // 只写静态 team 行；每轮来源由 runTurn 作为 RunOptions.messages 注入。
    pluginHost.registerHook(createSourceHook(member.team_id));

    const selfCard = this.buildSelfCard(member, model, tools);
    const events = new MemoryEventStream();
    const runtime = await this.runtimeFactory({
      provider: this.providerFactory(),
      model,
      context: new MemoryContextManager({ maxTokens: this.contextMaxTokens }),
      events,
      pluginHost,
      limits: this.limits,
      termination: this.termination,
      // 所有工具都包了 checkPermission；这里只是兜底，不让未包装的工具走交互等待。
      permission: { default: 'allow' },
      selfCard,
      agentId: member.id,
      logger: this.logger,
      ...(member.system_prompt !== undefined ? { systemPrompt: member.system_prompt } : {}),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      ...(this.includeReasoning !== undefined ? { includeReasoning: this.includeReasoning } : {}),
      ...(this.session !== undefined ? { session: this.session } : {}),
      ...(this.eventLog !== undefined ? { eventLog: this.eventLog } : {}),
    });
    const entry: MemberRuntimeEntry = {
      runtime,
      events,
      unsubscribers: [],
      pendingPermissions: new Map(),
      waiting: false,
    };
    this.entries.set(member.session_id, entry);
    if (this.onMemberEvent !== undefined) {
      const onMemberEvent = this.onMemberEvent;
      entry.unsubscribers.push(
        entry.events.subscribe((event: RunEvent) => {
          if (event.type !== 'agent.limit.warning') return;
          try {
            onMemberEvent(member.id, member.session_id, event);
          } catch (error) {
            this.logger.warn('agent.member.event_callback_failed', {
              member_id: member.id,
              session_id: member.session_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
    if (mode === 'bridge' && this.parentEvents !== undefined) {
      this.attachBridge(member, entry);
    }
  }

  async runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult> {
    const entry = this.requireEntry(member);
    const runId = randomUUID();
    let terminal: 'completed' | 'failed' | 'cancelled' | undefined;
    let usage: Usage | undefined;
    const unsubscribe = entry.runtime.events.subscribe((event: RunEvent) => {
      if (event.run_id !== runId) return;
      if (event.type === 'run.completed') {
        terminal = 'completed';
        usage = readUsage(event.data);
      } else if (event.type === 'run.cancelled') {
        terminal = 'cancelled';
      } else if (event.type === 'run.failed') {
        terminal = 'failed';
      }
    });

    // 来源标注作为用户输入之前的持久化消息注入；不改 system，也不改写用户文本。
    const sourceMessage: Message = {
      role: 'user',
      name: 'vessel:source',
      content: formatMessageSource(message, member.team_id),
      timestamp: Date.now(),
    };
    try {
      const content = await entry.runtime.run(message.content, member.session_id, {
        runId,
        messages: [sourceMessage],
      });
      return {
        content,
        outcome: 'completed',
        ...(usage !== undefined ? { usage } : {}),
      };
    } catch (error) {
      // 取消不是失败：interrupt('user') 让 core 发 run.cancelled 并 reject。
      if (terminal === 'cancelled') return { outcome: 'cancelled' };
      throw error;
    } finally {
      unsubscribe();
      // 取消 / 失败时可能仍停在等待：清掉挂起请求与 deadline，把状态还回 running，
      // 让 AgentService 能正常进入终态（应答随后到达时已无人等待）。
      this.clearPending(entry);
      if (entry.waiting) {
        entry.waiting = false;
        this.notifyPermissionState(member.id, member.session_id, 'running');
      }
    }
  }

  cancel(member: MemberRuntimeMember): void {
    this.entries.get(member.session_id)?.runtime.interrupt?.('user');
  }

  async dispose(member: MemberRuntimeMember): Promise<void> {
    const entry = this.entries.get(member.session_id);
    if (!entry) return;
    // 先移除，避免 dispose 期间 / 之后又有 runTurn 走进已释放的 runtime
    this.entries.delete(member.session_id);
    for (const unsubscribe of entry.unsubscribers) unsubscribe();
    entry.unsubscribers.length = 0;
    this.clearPending(entry);
    await entry.runtime.dispose();
  }

  /**
   * CONTRACT-hot-apply §4：把权限规则热应用到所有存活成员 Body。
   *
   * 规则整体替换（与 owner 侧同一语义）。这里只覆盖 core `PermissionPolicy` 的
   * 判定面；成员工具的 checkPermission 包装（`restrictPermissions`）把 ask 折回
   * bridge / deny，属于装配期决定，热应用不改它。
   * `members` 有记录但尚未 spawn 出 Body 时没有可应用的 runtime，跳过并计入未应用。
   */
  applyPermissionRules(rules: RuntimePermissionConfig): number {
    this.permission = rules;
    let applied = 0;
    for (const [sessionId, entry] of this.entries) {
      const runtime = entry.runtime as MemberRunnableAgent & {
        applyPermissionRules?: (next: RuntimePermissionConfig) => void;
      };
      if (typeof runtime.applyPermissionRules !== 'function') continue;
      try {
        runtime.applyPermissionRules(rules);
        applied += 1;
      } catch (error) {
        // 单个 Body 失败不影响其它 Body；装配层按数量判定是否全部生效。
        this.logger.warn('agent.member.permission_apply_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return applied;
  }

  /**
   * 权限 bridge：成员请求 → 父流（补成员归属字段）；父级应答 → 成员流。
   * 只回灌本成员挂起过的 requestId，父流上的其它应答不会串台。
   */
  private attachBridge(member: MemberRuntimeMember, entry: MemberRuntimeEntry): void {
    const parentEvents = this.parentEvents;
    if (!parentEvents) return;

    entry.unsubscribers.push(
      entry.events.subscribe((event: RunEvent) => {
        if (!PERMISSION_REQUEST_EVENTS.has(event.type)) return;
        if (this.entries.get(member.session_id) !== entry) return;

        const kind = event.type === 'ask.user.requested' ? 'ask' : 'permission';
        const requestId = readRequestId(event.data);
        if (requestId !== undefined) entry.pendingPermissions.set(requestId, { kind });
        if (!entry.waiting) {
          entry.waiting = true;
          this.notifyPermissionState(member.id, member.session_id, 'waiting');
        }
        const data = bridgeRequestData(event, member);
        const forwarded: RunEvent = {
          ...event,
          data,
          ...(this.tenantId !== undefined && event.tenant_id === undefined
            ? { tenant_id: this.tenantId }
            : {}),
        };
        parentEvents.publish(forwarded);
        if (requestId !== undefined) {
          this.scheduleDenyAfter(member, entry, requestId, kind, forwarded);
        }
      }),
    );

    entry.unsubscribers.push(
      parentEvents.subscribe((event: RunEvent) => {
        if (!PERMISSION_RESPONSE_EVENTS.has(event.type)) return;
        if (this.entries.get(member.session_id) !== entry) return;

        const requestId = readRequestId(event.data);
        if (requestId === undefined) return;
        const pending = entry.pendingPermissions.get(requestId);
        if (pending === undefined) return;

        // only-human：缺 answered_by 视为 legacy human；policy 只接受 deny_after。
        const data = isRecord(event.data) ? event.data : {};
        const answeredBy = data.answered_by;
        if (
          answeredBy !== undefined &&
          answeredBy !== 'human' &&
          !(answeredBy === 'policy' && data.policy === 'deny_after')
        ) {
          this.logger.warn('agent.member.permission_response_dropped', {
            member_id: member.id,
            session_id: member.session_id,
            request_id: requestId,
            answered_by: answeredBy,
            policy: data.policy,
          });
          return;
        }

        entry.pendingPermissions.delete(requestId);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        // 原样交给成员事件流，由 core 按 requestId 路由回发起请求的 waitFor。
        entry.events.publish(event);
        this.noteBridgeSettled(member, entry);
      }),
    );
  }

  /**
   * 非空 team_id 的成员把全局 allow 提升为 bridge；显式 deny 保持只读工具，
   * 不因 Team 绑定放宽。缺 parentEvents 时仍由 ask → deny 收口。
   */
  private effectivePermissionMode(member: MemberRuntimeMember): MemberRuntimePermissionMode {
    if (
      this.forceBridgeForTeams &&
      this.permissionMode === 'allow' &&
      typeof member.team_id === 'string' &&
      member.team_id.length > 0
    ) {
      return 'bridge';
    }
    return this.permissionMode;
  }

  private clearPending(entry: MemberRuntimeEntry): void {
    for (const pending of entry.pendingPermissions.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    entry.pendingPermissions.clear();
  }

  private noteBridgeSettled(member: MemberRuntimeMember, entry: MemberRuntimeEntry): void {
    if (entry.pendingPermissions.size === 0 && entry.waiting) {
      entry.waiting = false;
      this.notifyPermissionState(member.id, member.session_id, 'running');
    }
  }

  /**
   * team 显式 deny-after 的单次 deadline；hold / 缺失 / 非法秒数都不建定时器。
   * 到期后把 normal response 同时交给成员流（解除等待）与父流（RunEngine 审计）。
   */
  private scheduleDenyAfter(
    member: MemberRuntimeMember,
    entry: MemberRuntimeEntry,
    requestId: string,
    kind: 'permission' | 'ask',
    forwarded: RunEvent,
  ): void {
    // 定时器只能由 bridge 创建；没有父流就没有人端，走既有的 ask → deny。
    if (this.parentEvents === undefined) return;
    const policy = this.permissionPolicy?.(member.team_id);
    if (policy?.unattended !== 'deny-after') return;
    const seconds = policy.denyAfterSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;

    const timer = setTimeout(
      () => {
        if (this.entries.get(member.session_id) !== entry) return;
        const pending = entry.pendingPermissions.get(requestId);
        if (pending === undefined || pending.kind !== kind) return;
        entry.pendingPermissions.delete(requestId);
        const data = isRecord(forwarded.data) ? forwarded.data : {};
        const sessionId =
          typeof data.session_id === 'string' && data.session_id.length > 0
            ? data.session_id
            : undefined;
        const responseData =
          kind === 'ask'
            ? {
                requestId,
                answers: [],
                ...(sessionId !== undefined ? { session_id: sessionId } : {}),
                answered_by: 'policy',
                answered_via: 'policy',
                policy: 'deny_after',
              }
            : {
                requestId,
                decision: 'deny',
                scope: 'once',
                ...(sessionId !== undefined ? { session_id: sessionId } : {}),
                answered_by: 'policy',
                answered_via: 'policy',
                policy: 'deny_after',
                reason: 'deny_after',
              };
        const tenantId = forwarded.tenant_id ?? this.tenantId;
        const response: RunEvent = {
          type: kind === 'ask' ? 'ask.user.answered' : 'tool.permission.response',
          run_id: forwarded.run_id,
          data: responseData,
          ts: Date.now(),
          ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
        };
        entry.events.publish(response);
        this.parentEvents?.publish(response);
        this.noteBridgeSettled(member, entry);
      },
      Math.round(seconds * 1000),
    );
    // 不能 unref：Bun 在只剩 unref 定时器的 await 上会直接退出/不触发 deadline。
    entry.pendingPermissions.set(requestId, { kind, timer });
  }

  private notifyPermissionState(
    memberId: string,
    sessionId: string,
    state: MemberPermissionState,
  ): void {
    try {
      this.onPermissionState?.(memberId, sessionId, state);
    } catch (error) {
      this.logger.warn('agent.member.permission_state_callback_failed', {
        member_id: memberId,
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 按模式与白名单从父宿主挑工具 */
  private selectTools(mode: MemberRuntimePermissionMode): ToolDefinition[] {
    const parent = this.pluginHost;
    if (!parent) return [];
    const denyFilter = mode === 'deny';
    const selected: ToolDefinition[] = [];
    for (const tool of parent.listTools()) {
      if (isExcludedTool(tool.name)) continue;
      if (denyFilter) {
        if (!this.readOnlyTools.has(tool.name)) continue;
      } else if (!this.allowedTools.has(tool.name)) {
        continue;
      }
      selected.push(tool.name === 'agent' ? restrictAgentTool(tool) : tool);
    }
    return selected;
  }

  /**
   * ask 在 bridge 可用时放行给 core（发请求事件 → 父级应答）；
   * bridge 关闭 / 缺失时按 deny 收口并记日志，避免 run 永久等待应答。
   * 工具没有 checkPermission 时用权限配置的 default（ask 同样按上述规则处理）。
   */
  private restrictPermissions(
    tool: ToolDefinition,
    memberId: string,
    mode: MemberRuntimePermissionMode,
  ): ToolDefinition {
    const check = tool.checkPermission;
    return {
      ...tool,
      checkPermission: async (input, ctx) => {
        const decision = check ? await check(input, ctx) : this.fallbackDecision(tool.name);
        if (decision !== 'ask') return decision;
        if (mode === 'bridge' && this.parentEvents !== undefined) return 'ask';
        this.logger.warn('agent.member.permission_ask_denied', {
          member_id: memberId,
          tool: tool.name,
        });
        return 'deny';
      },
    };
  }

  /** 无 checkPermission 的工具：autoApprove 放行，default=ask 因无 bridge 转为 deny */
  private fallbackDecision(toolName: string): 'allow' | 'deny' {
    if (this.permission?.autoApprove?.includes(toolName)) return 'allow';
    return this.permission?.default === 'ask' ? 'deny' : 'allow';
  }

  private buildSelfCard(
    member: MemberRuntimeMember,
    model: string,
    tools: readonly ToolDefinition[],
  ): MemberSelfCardOptions {
    const toolNames = tools.map((tool) => tool.name);
    return {
      role: member.name ?? 'member',
      ...(member.parent_id !== undefined ? { parent_id: member.parent_id } : {}),
      // 只有绑定 Team 的成员才带该字段；unbound 不伪造。
      ...(typeof member.team_id === 'string' && member.team_id.length > 0
        ? { team_id: member.team_id }
        : {}),
      depth: this.depth,
      model,
      tools: toolNames,
      limits: {
        ...this.limits,
        ...(this.termination.maxIterations !== undefined
          ? { maxIterations: this.termination.maxIterations }
          : {}),
        ...(this.termination.maxRuntimeSeconds !== undefined
          ? { maxRuntimeSeconds: this.termination.maxRuntimeSeconds }
          : {}),
      },
      context: { max: this.contextMaxTokens },
      how_to_ask: toolNames.includes('ask_user')
        ? 'Use the ask_user tool to request human input.'
        : 'This is a non-interactive run; state blockers in your final text.',
    };
  }

  private requireEntry(member: MemberRuntimeMember): MemberRuntimeEntry {
    const entry = this.entries.get(member.session_id);
    if (!entry) throw new Error(`member runtime not spawned: ${member.session_id}`);
    return entry;
  }
}

/** 工厂：入口层只依赖 MemberRuntimePort */
export function createInProcessMemberRuntime(
  options: InProcessMemberRuntimeOptions,
): MemberRuntimePort {
  return new InProcessMemberRuntime(options);
}
