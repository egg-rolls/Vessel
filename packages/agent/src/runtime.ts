/**
 * 进程内成员执行内核适配（MemberRuntimePort）。
 *
 * 每个成员独占一个 AgentRuntime / Context / EventStream；工具从父 PluginHost
 * 按白名单复制，hooks / guardrails 一并继承。权限 bridge 尚未实现：
 * 需要交互的判定（ask）一律按 deny 收口并记日志，避免 run 永久等待应答。
 *
 * @module @vessel-agent/agent
 */

import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
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

/** 成员权限模式；bridge 尚未实现，工具面同 allow、交互按 deny */
export type MemberRuntimePermissionMode = 'allow' | 'deny' | 'bridge';

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
  /** 缺省 allow；deny 只保留只读工具 */
  permissionMode?: MemberRuntimePermissionMode;
  /** allow 模式的权限配置（autoApprove / default / timeoutMs） */
  permission?: RuntimePermissionConfig;
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
    this.limits = options.limits ?? {};
    this.termination = options.termination ?? DEFAULT_TERMINATION;
    this.contextMaxTokens = options.contextMaxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
    this.depth = options.depth ?? 1;
    this.logger = options.logger ?? noopLogger;
    this.tenantId = options.tenantId;
    this.includeReasoning = options.includeReasoning;
    this.runtimeFactory =
      options.runtimeFactory ?? ((runtimeOptions) => AgentRuntime.create(runtimeOptions));
    if (this.permissionMode === 'bridge') {
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
    const runtime = await this.runtimeFactory({
      provider: this.providerFactory(),
      model,
      context: new MemoryContextManager({ maxTokens: this.contextMaxTokens }),
      events: new MemoryEventStream(),
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
    this.entries.set(member.id, { runtime });
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
    await entry.runtime.dispose();
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
   * 无 bridge 时 ask 会永久等待应答；按 deny 收口并记日志。
   * 工具没有 checkPermission 时用权限配置的 default（ask 同样收口为 deny）。
   */
  private restrictPermissions(tool: ToolDefinition, memberId: string): ToolDefinition {
    const check = tool.checkPermission;
    return {
      ...tool,
      checkPermission: async (input, ctx) => {
        const decision = check ? await check(input, ctx) : this.fallbackDecision(tool.name);
        if (decision !== 'ask') return decision;
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
