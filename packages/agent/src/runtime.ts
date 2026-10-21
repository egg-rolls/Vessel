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
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type EventStream,
  type LLMProvider,
  type Logger,
  MemoryContextManager,
  MemoryEventStream,
  MemoryPluginHost,
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

/** 成员默认工具白名单 */
const DEFAULT_ALLOWED_TOOLS = ['bash', 'read', 'edit'] as const;

/** deny 模式保留的只读工具（与 delegate 语义一致） */
const DEFAULT_READ_ONLY_TOOLS = ['read'] as const;

/** 成员永远拿不到的工具：生命周期工具、team 工具、递归分派 */
const EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(['agent', 'delegate_task']);

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
  /** allow / bridge 模式的权限配置（autoApprove / default / timeoutMs） */
  permission?: RuntimePermissionConfig;
  /**
   * 父级事件流（owner）。bridge 模式下把成员的
   * `tool.permission.request` / `ask.user.requested` 转发到这里，并订阅
   * `tool.permission.response` / `ask.user.answered` 回灌成员事件流。
   */
  parentEvents?: EventStream;
  /** bridge 模式下成员进入/离开权限等待时回调（入口层接 AgentService 状态） */
  onPermissionState?: (memberId: string, state: MemberPermissionState) => void;
  limits?: UsageLimits;
  termination?: TerminationPolicy;
  /** 上下文预算；同时写入 Self Card 的 context.max */
  contextMaxTokens?: number;
  /** 成员深度（Self Card） */
  depth?: number;
  logger?: Logger;
  tenantId?: string;
  includeReasoning?: boolean;
  /** 覆盖 runtime 构造（测试捕获 options） */
  runtimeFactory?: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
}

interface MemberRuntimeEntry {
  runtime: MemberRunnableAgent;
  /** 成员独占事件流；bridge 请求/应答都经过它 */
  events: MemoryEventStream;
  /** bridge 订阅取消函数（dispose 时回收） */
  unsubscribers: Array<() => void>;
  /** 已转发给父级、尚未应答的 requestId */
  pendingPermissions: Set<string>;
  /** 是否已通过 onPermissionState 报过 waiting（避免重复回调） */
  waiting: boolean;
}

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
  data.agent_id = member.id;
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

/** 成员不可见的工具 */
function isExcludedTool(name: string): boolean {
  return EXCLUDED_TOOL_NAMES.has(name) || name.startsWith('team_');
}

/** 进程内成员执行内核 */
export class InProcessMemberRuntime implements MemberRuntimePort {
  private readonly providerFactory: () => LLMProvider;
  private readonly model?: string;
  private readonly pluginHost?: PluginHost;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly readOnlyTools: ReadonlySet<string>;
  private readonly permissionMode: MemberRuntimePermissionMode;
  private readonly permission?: RuntimePermissionConfig;
  private readonly parentEvents?: EventStream;
  private readonly onPermissionState?: (memberId: string, state: MemberPermissionState) => void;
  private readonly limits: UsageLimits;
  private readonly termination: TerminationPolicy;
  private readonly contextMaxTokens: number;
  private readonly depth: number;
  private readonly logger: Logger;
  private readonly tenantId?: string;
  private readonly includeReasoning?: boolean;
  private readonly runtimeFactory: (options: AgentRuntimeOptions) => Promise<MemberRunnableAgent>;
  private readonly entries = new Map<string, MemberRuntimeEntry>();

  constructor(options: InProcessMemberRuntimeOptions) {
    this.providerFactory = options.providerFactory;
    this.model = options.model;
    this.pluginHost = options.pluginHost;
    this.allowedTools = new Set([...DEFAULT_ALLOWED_TOOLS, ...(options.extraTools ?? [])]);
    this.readOnlyTools = new Set(options.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
    this.permissionMode = options.permissionMode ?? 'allow';
    this.permission = options.permission;
    this.parentEvents = options.parentEvents;
    this.onPermissionState = options.onPermissionState;
    this.limits = options.limits ?? {};
    this.termination = options.termination ?? DEFAULT_TERMINATION;
    this.contextMaxTokens = options.contextMaxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
    this.depth = options.depth ?? 1;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.includeReasoning = options.includeReasoning;
    this.runtimeFactory =
      options.runtimeFactory ?? ((runtimeOptions) => AgentRuntime.create(runtimeOptions));
    if (this.permissionMode === 'bridge' && this.parentEvents === undefined) {
      this.logger.warn('agent.member.permission_bridge_unavailable', {
        fallback: 'ask_denied',
      });
    }
  }

  async spawn(member: MemberRuntimeMember): Promise<void> {
    if (this.entries.has(member.id)) {
      throw new Error(`member runtime already spawned: ${member.id}`);
    }
    const model = member.model ?? this.model;
    if (!model) {
      throw new Error(`member runtime model is required: ${member.id}`);
    }

    const tools = this.selectTools().map((tool) => this.restrictPermissions(tool, member.id));
    const pluginHost = new MemoryPluginHost();
    for (const hook of this.pluginHost?.getHooks() ?? []) pluginHost.registerHook(hook);
    for (const guardrail of this.pluginHost?.getGuardrails() ?? []) {
      pluginHost.registerGuardrail(guardrail);
    }
    for (const tool of tools) pluginHost.registerTool(tool);

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
    });
    const entry: MemberRuntimeEntry = {
      runtime,
      events,
      unsubscribers: [],
      pendingPermissions: new Set(),
      waiting: false,
    };
    this.entries.set(member.id, entry);
    if (this.permissionMode === 'bridge' && this.parentEvents !== undefined) {
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

    try {
      const content = await entry.runtime.run(message.content, member.session_id, { runId });
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
      // 取消 / 失败时可能仍停在等待：清掉挂起请求并把状态还回 running，
      // 让 AgentService 能正常进入终态（应答随后到达时已无人等待）。
      if (entry.waiting) {
        entry.waiting = false;
        entry.pendingPermissions.clear();
        this.notifyPermissionState(member.id, 'running');
      }
    }
  }

  cancel(member: MemberRuntimeMember): void {
    this.entries.get(member.id)?.runtime.interrupt?.('user');
  }

  async dispose(member: MemberRuntimeMember): Promise<void> {
    const entry = this.entries.get(member.id);
    if (!entry) return;
    // 先移除，避免 dispose 期间 / 之后又有 runTurn 走进已释放的 runtime
    this.entries.delete(member.id);
    for (const unsubscribe of entry.unsubscribers) unsubscribe();
    entry.unsubscribers.length = 0;
    entry.pendingPermissions.clear();
    await entry.runtime.dispose();
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
        if (this.entries.get(member.id) !== entry) return;

        const requestId = readRequestId(event.data);
        if (requestId !== undefined) entry.pendingPermissions.add(requestId);
        if (!entry.waiting) {
          entry.waiting = true;
          this.notifyPermissionState(member.id, 'waiting');
        }
        const forwarded: RunEvent = {
          ...event,
          data: bridgeRequestData(event, member),
          ...(this.tenantId !== undefined && event.tenant_id === undefined
            ? { tenant_id: this.tenantId }
            : {}),
        };
        parentEvents.publish(forwarded);
      }),
    );

    entry.unsubscribers.push(
      parentEvents.subscribe((event: RunEvent) => {
        if (!PERMISSION_RESPONSE_EVENTS.has(event.type)) return;
        if (this.entries.get(member.id) !== entry) return;

        const requestId = readRequestId(event.data);
        if (requestId === undefined || !entry.pendingPermissions.delete(requestId)) return;
        // 原样交给成员事件流，由 core 按 requestId 路由回发起请求的 waitFor。
        entry.events.publish(event);
        if (entry.pendingPermissions.size === 0 && entry.waiting) {
          entry.waiting = false;
          this.notifyPermissionState(member.id, 'running');
        }
      }),
    );
  }

  private notifyPermissionState(memberId: string, state: MemberPermissionState): void {
    try {
      this.onPermissionState?.(memberId, state);
    } catch (error) {
      this.logger.warn('agent.member.permission_state_callback_failed', {
        member_id: memberId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 按模式与白名单从父宿主挑工具 */
  private selectTools(): ToolDefinition[] {
    const parent = this.pluginHost;
    if (!parent) return [];
    const denyFilter = this.permissionMode === 'deny';
    const selected: ToolDefinition[] = [];
    for (const tool of parent.listTools()) {
      if (isExcludedTool(tool.name)) continue;
      if (denyFilter) {
        if (!this.readOnlyTools.has(tool.name)) continue;
      } else if (!this.allowedTools.has(tool.name)) {
        continue;
      }
      selected.push(tool);
    }
    return selected;
  }

  /**
   * ask 在 bridge 可用时放行给 core（发请求事件 → 父级应答）；
   * bridge 关闭 / 缺失时按 deny 收口并记日志，避免 run 永久等待应答。
   * 工具没有 checkPermission 时用权限配置的 default（ask 同样按上述规则处理）。
   */
  private restrictPermissions(tool: ToolDefinition, memberId: string): ToolDefinition {
    const check = tool.checkPermission;
    return {
      ...tool,
      checkPermission: async (input, ctx) => {
        const decision = check ? await check(input, ctx) : this.fallbackDecision(tool.name);
        if (decision !== 'ask') return decision;
        if (this.permissionMode === 'bridge' && this.parentEvents !== undefined) return 'ask';
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
  ): SelfCardOptions {
    const toolNames = tools.map((tool) => tool.name);
    return {
      role: member.name ?? 'member',
      ...(member.parent_id !== undefined ? { parent_id: member.parent_id } : {}),
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
    const entry = this.entries.get(member.id);
    if (!entry) throw new Error(`member runtime not spawned: ${member.id}`);
    return entry;
  }
}

/** 工厂：入口层只依赖 MemberRuntimePort */
export function createInProcessMemberRuntime(
  options: InProcessMemberRuntimeOptions,
): MemberRuntimePort {
  return new InProcessMemberRuntime(options);
}
