/**
 * AgentRuntime 实现
 * @module @vessel-agent/core/runtime
 */

import { randomUUID } from 'node:crypto';
import { estimateMessagesTokens, estimateTokens } from '../context/index.js';
import {
  evaluateLimitWarnings,
  evaluateTermination,
  evaluateUsageLimits,
  LIMIT_WARNING_THRESHOLD,
  LimitExceededError,
  MemoryLimitChecker,
} from '../limits/index.js';
import { createStderrLogger, noopLogger } from '../logging.js';
// D2：跨模块只允许从 barrel 导入（不得直接引用 session 的内部文件）。
import { deriveSessionMeta, mergeHistoryProjection, projectMessages } from '../session/index.js';
import type { ContextCompactedReason, ContextManager } from '../types/context.js';
import type { ErrorEnvelope } from '../types/error.js';
import type { EventStream, RunEvent, SessionEventLogPort, Unsubscribe } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type { LimitChecker, TerminationPolicy, UsageLimits, UsageStats } from '../types/limits.js';
import type { Logger } from '../types/logging.js';
import type {
  AgentRuntimeOptions,
  Plugin,
  PluginHost,
  RuntimePermissionConfig,
  SelfCardOptions,
} from '../types/plugin.js';
import type { ChatRequest, LLMProvider, LLMResponse, Message } from '../types/provider.js';
import type { RunExecution, RunInterruptReason, RunOptions } from '../types/run.js';
import type { RunCheckpoint, RunStore } from '../types/run-store.js';
import {
  RUN_INTERRUPT_REASONS,
  RunAlreadyRunningError,
  RunResumeError,
} from '../types/run-store.js';
import type { RunState, SessionBackend } from '../types/session.js';

export type { RunOptions } from '../types/run.js';

import type { ToolCall } from '../types/tool.js';
import { toErrorEnvelope } from './error-envelope.js';
import { GuardrailRunner } from './guardrail-runner.js';
import { HookRunner } from './hook-runner.js';
import {
  PermissionAbortedError,
  PermissionPolicy,
  PermissionTimeoutError,
} from './permission-policy.js';
import { MemoryPluginHost } from './plugin-host.js';
import { createToolPipeline, isToolCall, type ToolPipeline } from './tool-pipeline.js';

/** finalizeRun 的终态输入（C1） */
type RunTerminalOutcome =
  | { status: 'completed'; output: string }
  | { status: 'failed'; error: unknown; signal?: AbortSignal };

/** 新建一次 run 的 usage 统计 */
function createUsageStats(startTime: number): UsageStats {
  return {
    requestCount: 0,
    toolCallsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    startTime,
  };
}

/** 错误文本（事件/持久化统一口径） */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 0.18：不写会话事件日志的派生/观测事件。
 *
 * 唯一真相源只保留事实（用户输入、LLM 响应、工具调用、权限、终态）；
 * 流式增量、请求快照、消息镜像、checkpoint 进度与插件生命周期都可重建，
 * 落盘只会放大体积并制造第二份事实。
 */
const NON_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'llm.stream.chunk',
  'llm.request',
  'context.changed',
  'session.saved',
  'run.checkpoint',
  'session.deleted',
  'session.log.failed',
  'plugin.loaded',
  'plugin.failed',
  'plugin.init.failed',
  'plugin.dispose.failed',
]);

/**
 * 由 harness / 插件直接发布到事件流、但必须落盘的交互事件。
 * runtime 在事件流上观察它们（本身不再二次发布，避免回环）。
 */
const OBSERVED_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool.permission.response',
  'ask.user.requested',
  'ask.user.answered',
]);

/**
 * context-overflow 的通用文案 / 错误码（0.10 R2-17）。
 * 不绑定厂商名：只认状态码 400 + 可识别的描述。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context window/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /token limit/i,
  /request too large/i,
];

/** 从错误对象读取 HTTP 状态码（status / statusCode / httpStatus / response.status） */
function readHttpStatus(error: Record<string, unknown>): number | undefined {
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const response = error.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return undefined;
}

/**
 * provider 报 context-overflow 时返回 true（0.10 R2-17）。
 * 判定条件：400（结构化状态或 message 中的状态）且 message / code 命中通用模式。
 */
function isContextOverflowError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const message = error instanceof Error ? error.message : String(record.message ?? '');
  const code = typeof record.code === 'string' ? record.code : '';
  const has400 = readHttpStatus(record) === 400 || /(^|\D)400(\D|$)/.test(message);
  if (!has400) return false;
  const haystack = `${message}\n${code}`;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Self Card token 上限（0.15 E9） */
const SELF_CARD_TOKEN_LIMIT = 400;

/**
 * BeforeLlm 注入消息的稳定键（0.16 E5）。
 * 有 `name` / `timestamp` 时按键去重；都缺失时返回 undefined，退回对象引用去重。
 */
function injectedMessageKey(message: Message): string | undefined {
  if (message.name === undefined && message.timestamp === undefined) return undefined;
  return [
    message.name ?? '',
    message.timestamp ?? '',
    message.role,
    message.tool_call_id ?? '',
    message.tool_calls?.map((call) => call.id).join(',') ?? '',
    message.content,
  ].join('\u0000');
}

/** 按估算 token 截断（Self Card 上限） */
function truncateToTokens(text: string, limit: number): string {
  if (estimateTokens(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

/** 有效限额渲染（run 开始时计数均为 0） */
function formatSelfCardLimits(limits: SelfCardOptions['limits']): string {
  const parts: string[] = [];
  if (limits.requestLimit !== undefined) parts.push(`requests 0/${limits.requestLimit}`);
  if (limits.toolCallsLimit !== undefined) parts.push(`tool calls 0/${limits.toolCallsLimit}`);
  if (limits.inputTokensLimit !== undefined) {
    parts.push(`input tokens 0/${limits.inputTokensLimit}`);
  }
  if (limits.outputTokensLimit !== undefined) {
    parts.push(`output tokens 0/${limits.outputTokensLimit}`);
  }
  if (limits.totalCostLimit !== undefined) parts.push(`cost 0/${limits.totalCostLimit}`);
  if (limits.maxIterations !== undefined) parts.push(`iterations 0/${limits.maxIterations}`);
  if (limits.maxRuntimeSeconds !== undefined) {
    parts.push(`runtime 0s/${limits.maxRuntimeSeconds}s`);
  }
  return parts.join(', ');
}

/** 生成 Self Card 文本（≤400 tokens） */
function formatSelfCard(card: SelfCardOptions): string {
  const lines = ['[Self Card]', `role: ${card.role}`];
  if (card.parent_id !== undefined) lines.push(`parent: ${card.parent_id}`);
  lines.push(`depth: ${card.depth}`, `model: ${card.model}`);
  if (card.tools.length > 0) lines.push(`tools: ${card.tools.join(', ')}`);
  const limits = formatSelfCardLimits(card.limits);
  if (limits) lines.push(`limits: ${limits}`);
  // 只写预算、不写实时用量：Self Card 是 system 前缀的一部分，必须跨 run 稳定，
  // 否则每轮都会让整段提示词缓存失效（价格远大于几行上下文）。
  lines.push(`context: ${card.context.max} tokens (budget)`);
  if (card.how_to_ask !== undefined) lines.push(`how to ask for help: ${card.how_to_ask}`);
  return truncateToTokens(lines.join('\n'), SELF_CARD_TOKEN_LIMIT);
}

/** 预处理后的工具调用（0.6.1 P1：安全批次并发） */
interface PreparedToolCall {
  toolCall: ToolCall;
  toolName: string;
  args: unknown;
  startedAt: number;
  /** 已定性的失败（guardrail 阻断 / 非法 JSON）；不执行工具，直接折回 */
  failureMessage?: string;
}

/** 单个工具调用的执行结果（上下文按原顺序写回） */
interface ToolExecutionOutcome {
  toolCall: ToolCall;
  /** 实际使用的输入（BeforeTool hook 改写后）；供 AfterTool 读取 */
  input: unknown;
  ok: boolean;
  content: string;
}

/**
 * Agent Runtime
 * 核心运行时，实现 tool-calling loop。
 * 协调 provider/context/events/limits/termination/session + 三个编排器（权限/guardrail/hook），
 * 自身不再内联编排逻辑（ADR-033）。
 */
export class AgentRuntime {
  private provider: LLMProvider;
  private model: string;
  private context: ContextManager;
  /** 事件流（公开只读——headless/外部可订阅事件，实现应答策略，ADR-029） */
  readonly events: EventStream;
  /** 插件宿主（公开只读——app/TUI 从这里读工具与插件，工具的唯一来源） */
  readonly pluginHost: PluginHost;
  private limits: UsageLimits;
  private termination: TerminationPolicy;
  private session?: SessionBackend;
  private limitChecker: LimitChecker;
  private systemPrompt?: string;
  /** 0.15 E9：Self Card 选项；缺省不注入 */
  private readonly selfCard?: SelfCardOptions;
  /** 0.15 E9：本次 run 的 systemPrompt（含 Self Card）；run 结束后清空 */
  private runSystemPrompt?: string;
  /** 0.15 E2：本 run 已预警的 limit key（每个 key 只发一次） */
  private readonly warnedLimitKeys = new Set<string>();
  /** 0.16 E5：本 run 已注入的消息稳定键 / 对象引用（BeforeLlm 去重） */
  private readonly injectedMessageKeys = new Set<string>();
  private injectedMessageRefs = new WeakSet<Message>();
  private permissionPolicy: PermissionPolicy;
  private guardrails: GuardrailRunner;
  private hooks: HookRunner;
  /** 统一工具执行管道（0.8.2 Wave 2B1）：permission + handler + ToolResult guardrail */
  private readonly toolPipeline: ToolPipeline;
  /** durable run 检查点（0.3）；缺省不写、零开销 */
  private readonly runStore?: RunStore;
  /** E1：按插件名提供的安装配置 */
  private readonly pluginConfigs?: Record<string, Record<string, unknown>>;
  private readonly agentId?: string;
  /** 0.5：tenant；事件 / RunState / RunCheckpoint 在缺失时补齐 */
  private readonly tenantId?: string;
  /** 0.11.1：是否发布 reasoning 流式增量（默认 false） */
  private readonly includeReasoning: boolean;
  /** 成功安装的插件（按安装顺序；dispose 逆序，0.9） */
  private readonly installedPlugins: Plugin[] = [];
  /** dispose 幂等：第二次调用复用同一个 Promise，不再调用插件（0.9） */
  private disposePromise?: Promise<void>;
  /** 同一 run 的并发 resume 锁（进程内；DECISION-008 Addendum A-2） */
  private readonly resuming = new Set<string>();
  /**
   * 当前 active run（0.8 C1）：run 级状态隔离 + 单 run 守卫。
   * 同步占位、`finally` 清空；已有值时新的 run()/resume() 立即 `run_already_running`。
   */
  private activeRun?: RunExecution;
  /**
   * 当前 run 的中断控制（0.10 R2-18）：`interrupt()` 与调用方 `opts.signal`
   * 汇合到同一个内部 AbortController；随 active run 创建 / 释放。
   */
  private activeRunControl?: {
    execution: RunExecution;
    controller: AbortController;
    cleanups: Array<() => void>;
  };
  /** 0.10 R2-14：诊断日志；缺省 noop（`VESSEL_DEBUG` 时兜底 stderr） */
  private readonly logger: Logger;
  /** 0.18：会话事件日志（唯一写者；append → publish） */
  private readonly eventLog?: SessionEventLogPort;
  /** 0.18：观察 harness 直接发布的交互事件（permission/ask response） */
  private readonly eventLogUnsubscribe?: Unsubscribe;
  /** 在途的事件日志写入（含 publish 回调），run 终态前等待 */
  private readonly pendingEventLogWrites = new Set<Promise<void>>();
  /** 每个 run 只报告一次落盘失败，避免刷屏 */
  private eventLogFailureReported = false;

  private constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.context = opts.context;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.systemPrompt = opts.systemPrompt;
    this.selfCard = opts.selfCard;
    this.runStore = opts.runStore;
    this.pluginConfigs = opts.pluginConfigs;
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId;
    this.includeReasoning = opts.includeReasoning === true;
    this.eventLog = opts.eventLog;
    this.logger =
      opts.logger ??
      (process.env.VESSEL_DEBUG ? createStderrLogger({ level: 'debug' }) : noopLogger);
    if (this.eventLog) {
      // 交互应答由 harness / 插件直接发布；runtime 只补落盘，不二次发布。
      this.eventLogUnsubscribe = this.events.subscribe((event) => this.persistObservedEvent(event));
    }
    // 依赖倒置（ADR-033）：LimitChecker / PluginHost 可注入，默认 Memory 实现
    this.limitChecker = opts.limitChecker ?? new MemoryLimitChecker();

    // 初始化 PluginHost（唯一工具来源与注册表）——插件在 install() 里 registerTool
    this.pluginHost = opts.pluginHost ?? new MemoryPluginHost();

    // 编排器（ADR-033）：权限策略 / guardrail / hook 各自独立，AgentRuntime 只协调。
    // 0.18：权限请求经 runtime 的 publishEvent，才能保证先落盘再发布。
    this.permissionPolicy = new PermissionPolicy(
      this.events,
      opts.permission,
      opts.tenantId,
      (event) => this.publishEvent(event),
    );
    this.guardrails = new GuardrailRunner(this.pluginHost, this.events, opts.tenantId);
    this.hooks = new HookRunner(this.pluginHost, this.events, opts.tenantId);
    this.toolPipeline = createToolPipeline({
      pluginHost: this.pluginHost,
      events: this.events,
      permission: this.permissionPolicy,
      guardrails: this.guardrails,
      hooks: this.hooks,
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    });
  }

  /** 创建并异步初始化 AgentRuntime。用此替代 new AgentRuntime()。 */
  static async create(opts: AgentRuntimeOptions): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(opts);
    await runtime.installPlugins(opts.plugins ?? []);
    await runtime.initPlugins();
    return runtime;
  }

  private async installPlugins(plugins: Plugin[]): Promise<void> {
    for (const plugin of plugins) {
      await this.installPlugin(plugin);
    }
  }

  /** 所有 install 成功后按安装顺序 init；单个插件异常被隔离（0.9） */
  private async initPlugins(): Promise<void> {
    for (const plugin of this.installedPlugins) {
      if (plugin.init === undefined) continue;
      try {
        await plugin.init({ host: this.pluginHost });
      } catch (error) {
        this.publishEvent({
          type: 'plugin.init.failed',
          run_id: 'plugin',
          data: { name: plugin.name, error: errorText(error) },
          ts: Date.now(),
        });
      }
    }
  }

  /**
   * 安装插件（fail-fast：安装失败则构造函数失败）。
   * 失败时先回滚该插件本次注册的条目，再发 `plugin.failed` 并重新抛出（0.9）。
   * @param plugin 插件
   */
  private async installPlugin(plugin: Plugin): Promise<void> {
    const scope = this.pluginHost.beginPluginInstall?.(plugin.name);
    try {
      const config = this.pluginConfigs?.[plugin.name];
      const result =
        config === undefined
          ? plugin.install(this.pluginHost)
          : plugin.install(this.pluginHost, { config });
      if (result instanceof Promise) {
        await result; // 如果失败，让 async 构造函数抛出
      }
      scope?.commit();
      this.installedPlugins.push(plugin);
      this.publishEvent({
        type: 'plugin.loaded',
        run_id: 'plugin',
        data: {
          name: plugin.name,
          ...(plugin.version !== undefined ? { version: plugin.version } : {}),
        },
        ts: Date.now(),
      });
    } catch (error) {
      scope?.rollback();
      this.publishEvent({
        type: 'plugin.failed',
        run_id: 'plugin',
        data: {
          name: plugin.name,
          error: errorText(error),
        },
        ts: Date.now(),
      });
      throw error;
    }
  }

  /**
   * 执行一次 run
   * @param input 用户输入
   * @param sessionId 会话 ID（默认 'default'）
   * @param opts 可选的 Run 选项（signal 等）
   * @returns 最终响应文本
   */
  async run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string> {
    // F6：Host 可指定 runId，使 RunHandle.id 与事件流 run_id 一致；普通调用方缺省生成
    const runId = opts?.runId ?? randomUUID();
    const currentSessionId = sessionId || 'default';
    // 单 run 守卫必须在任何 await 之前同步占位，第二个并发调用立即失败。
    const execution = this.beginExecution(runId, currentSessionId, opts?.branch);

    try {
      return await this.executeRun(execution, input, opts);
    } finally {
      this.endExecution(execution);
    }
  }

  /** 同步预留 active run 槽位；已有 active run 时抛稳定错误 `run_already_running`。 */
  private beginExecution(runId: string, sessionId: string, branch?: string): RunExecution {
    if (this.activeRun) {
      throw new RunAlreadyRunningError(runId);
    }
    const now = Date.now();
    const execution: RunExecution = {
      runId,
      sessionId,
      ...(branch !== undefined ? { branch } : {}),
      createdAt: now,
      startedAt: now,
      stats: createUsageStats(now),
      context: this.context,
      // 0.14 P0：错误 envelope 的阶段来源；输入 guardrail / 进入 loop 后会被更新。
      phase: 'input',
    };
    // 新 run 不复用上一次的权限等待统计（PermissionPolicy 跨 run 存活）。
    this.permissionPolicy.resetPausedMs();
    this.activeRun = execution;
    this.activeRunControl = {
      execution,
      controller: new AbortController(),
      cleanups: [],
    };
    this.warnedLimitKeys.clear();
    this.eventLogFailureReported = false;
    // 0.16 E5：BeforeLlm 注入去重按 run 重置
    this.injectedMessageKeys.clear();
    this.injectedMessageRefs = new WeakSet();
    return execution;
  }

  private endExecution(execution: RunExecution): void {
    if (this.activeRun === execution) this.activeRun = undefined;
    if (this.activeRunControl?.execution === execution) {
      for (const cleanup of this.activeRunControl.cleanups) cleanup();
      this.activeRunControl = undefined;
    }
    this.runSystemPrompt = undefined;
  }

  /**
   * 中止当前 active run（0.10 R2-18）。
   *
   * - `shutdown` / `timeout`：checkpoint 落 `interrupted`（可 `--resume-run`）；
   * - `user`：按用户取消处理，checkpoint 落 `cancelled`；
   * - 无 active run 或已中止：no-op（幂等）。
   *
   * 只负责发中断；调用方应 await 自己的 run()/resume() promise 确认终态。
   */
  interrupt(reason: RunInterruptReason = 'user'): void {
    const control = this.activeRunControl;
    if (!control || control.controller.signal.aborted) return;
    this.logger.info('run interrupt requested', {
      run_id: control.execution.runId,
      reason,
    });
    control.controller.abort(reason);
  }

  /**
   * 把调用方 signal 桥接到当前 run 的内部 controller（0.10 R2-18）。
   * 外部 reason 原样透传，保持既有 cancelled / interrupted 语义。
   */
  private executionSignal(
    execution: RunExecution,
    external?: AbortSignal,
  ): AbortSignal | undefined {
    const control =
      this.activeRunControl?.execution === execution ? this.activeRunControl : undefined;
    if (!control) return external;

    const signal = control.controller.signal;
    if (!external) return signal;
    if (external.aborted) {
      if (!signal.aborted) control.controller.abort(external.reason);
      return signal;
    }

    const onAbort = (): void => control.controller.abort(external.reason);
    external.addEventListener('abort', onAbort, { once: true });
    control.cleanups.push(() => external.removeEventListener('abort', onAbort));
    return signal;
  }

  /** run() 的主体：调用方已持有 execution 槽位。 */
  private async executeRun(
    execution: RunExecution,
    input: string | Message,
    opts?: RunOptions,
  ): Promise<string> {
    const { runId, sessionId, createdAt } = execution;
    // 外部 signal 与 interrupt() 的内部 controller 统一成一个 signal（0.10 R2-18）
    const signal = this.executionSignal(execution, opts?.signal);

    // 切换到当前会话的 Context
    this.context.setSessionId(sessionId);

    // 仅当 context 为空时初始化：
    //   - in-process 同会话续聊：context 已有历史，不重置（多轮记忆）
    //   - cross-process resume / 新进程：context 空，从 SessionBackend 恢复该 session 历史
    //   - 无 backend 或无历史：加 system prompt 起新对话
    // 不再无条件 clear() -- 那会丢多轮历史（debug-notes 当年为修累积 bug 的过度修复）。
    // 只在 context 为空时加载一次，不会累积。
    if (this.context.messages.length === 0) {
      // 0.15 E9：Self Card 在 run 开始时生成一次；无 selfCard 时等于原 systemPrompt
      this.runSystemPrompt = this.composeRunSystemPrompt();
      // 0.18：新 run 也要重放 session 缓存之后的日志增量；否则 saveSession 会把
      // 未进入上下文的事件标记成“已覆盖”（derived_upto_seq 超前）。
      const history = await this.loadStoredHistory(sessionId);
      if (!history.some((message) => message.role === 'system') && this.runSystemPrompt) {
        this.addContext({ role: 'system', content: this.runSystemPrompt }, runId);
      }
      for (const message of history) {
        this.addContext(message, runId);
      }
    } else {
      this.runSystemPrompt = this.composeRunSystemPrompt();
    }

    // 准备用户消息
    const userMessage: Message =
      typeof input === 'string' ? { role: 'user', content: input } : input;

    // 创建 Run 状态
    const runState: RunState = {
      run_id: runId,
      session_id: sessionId,
      messages: [userMessage],
      started_at: createdAt,
      status: 'running',
      branch: execution.branch,
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };

    // 发布 Run 开始事件
    this.publishEvent({
      type: 'run.started',
      run_id: runId,
      data: { run_id: runId, session_id: sessionId, input: userMessage.content },
      ts: Date.now(),
    });

    try {
      // 注入消息（C5）：core 不解释其语义（skill / 附件 / 引用文件……），先于用户输入写入并持久化
      for (const injected of opts?.messages ?? []) {
        this.publishEvent({
          type: 'message.injected',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId, message: injected },
          ts: Date.now(),
        });
        this.addContext(injected, runId);
      }

      // 应用输入 Guardrail（先于写上下文：replacement 要成为持久化的用户消息，C-05）
      const inputResult = await this.guardrails.apply(
        userMessage.content,
        GuardrailStage.Input,
        runId,
        sessionId,
      );
      if (!inputResult.allowed) {
        throw new Error(`Input blocked by guardrail: ${inputResult.reason}`);
      }
      const effectiveUser =
        typeof inputResult.replacement === 'string' &&
        inputResult.replacement !== userMessage.content
          ? { ...userMessage, content: inputResult.replacement }
          : userMessage;

      // 添加（可能被 guardrail 改写后的）用户消息到上下文
      this.addContext(effectiveUser, runId);

      // 0.18：用户输入是唯一真相源的一部分（run.started.input 是改写前文本，
      // 不能单独用于恢复）。记录实际写入上下文的消息原文。
      this.publishEvent({
        type: 'user.message',
        run_id: runId,
        data: { run_id: runId, session_id: sessionId, message: effectiveUser },
        ts: Date.now(),
      });

      // 初始状态保存真实上下文（恢复历史 + 注入 + 用户输入），运行中崩溃不再丢历史（C-02）
      runState.messages = this.context.messages;
      await this.saveSession(runState);
      await this.updateSessionIndexBestEffort(runState);

      // durable checkpoint：run 开始（用户消息已写入上下文）
      await this.writeCheckpoint(execution, 'running');

      // 执行 tool-calling loop
      const response = await this.toolCallingLoop(execution, signal);

      // 统一终态：status / OnError / session / checkpoint / 事件
      await this.finalizeRun(execution, runState, { status: 'completed', output: response });

      return response;
    } catch (error) {
      await this.finalizeFailure(execution, runState, error, signal);
      throw error;
    }
  }

  /**
   * 统一终态（C1）：run()/resume() 共用。
   *
   * 顺序：status 映射 → OnError hook（best-effort）→ saveSession →
   * writeCheckpoint → 发布 run.completed / run.cancelled / run.failed。
   */
  private async finalizeRun(
    execution: RunExecution,
    runState: RunState,
    outcome: RunTerminalOutcome,
  ): Promise<void> {
    const { runId, sessionId, startedAt, stats } = execution;

    if (outcome.status === 'completed') {
      runState.status = 'completed';
      runState.completed_at = Date.now();
      runState.usage = this.usageFromStats(stats);
      runState.messages = this.context.messages;

      await this.saveSession(runState);
      await this.writeCheckpoint(execution, 'completed');

      this.publishEvent({
        type: 'run.completed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          output: outcome.output,
          usage: runState.usage,
          duration_ms: Date.now() - startedAt,
          iterations: stats.requestCount,
        },
        ts: Date.now(),
      });
      await this.finishEventLog(runState);
      return;
    }

    const signal = outcome.signal;
    // 用户显式取消 → cancelled；Host 中断/普通错误 → failed（与事件口径一致）
    const cancelled = this.isUserCancelled(signal);
    const errorMessage = errorText(outcome.error);
    runState.status = cancelled ? 'cancelled' : 'failed';
    runState.completed_at = Date.now();
    runState.error = errorMessage;
    // 失败也保存真实上下文，避免用单条 user 消息覆盖既有历史（C-02）
    runState.messages = this.context.messages;

    // OnError Hook best-effort（C2）：hook 故障不得替换原始错误，也不得跳过终态写入。
    try {
      await this.hooks.run(HookType.OnError, {
        run_id: runId,
        session_id: sessionId,
        error: errorMessage,
        phase: 'run',
      });
    } catch (hookError) {
      this.publishEvent({
        type: 'hook.error',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          hook_type: HookType.OnError,
          error: errorText(hookError),
        },
        ts: Date.now(),
      });
    }

    await this.saveSession(runState);

    // 用户显式取消发 run.cancelled；Host 关闭/中断与普通失败保持 run.failed
    const permissionTimeout = outcome.error instanceof PermissionTimeoutError;
    // 0.14 P0：结构化错误 envelope 只附加到 run.failed；run.cancelled 保持原形状。
    const envelope: ErrorEnvelope | undefined = cancelled
      ? undefined
      : toErrorEnvelope(outcome.error, {
          ...(execution.phase !== undefined ? { phase: execution.phase } : {}),
        });

    // durable checkpoint：失败 / 取消 / 中断（best-effort，不覆盖原始错误）
    await this.writeCheckpoint(
      execution,
      this.failureCheckpointStatus(signal),
      errorMessage,
      true,
      envelope,
    );

    const partial = execution.partialContent;
    this.publishEvent({
      type: cancelled ? 'run.cancelled' : 'run.failed',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        error: errorMessage,
        duration_ms: Date.now() - startedAt,
        ...(cancelled && typeof signal?.reason === 'string' ? { reason: signal.reason } : {}),
        ...(envelope ?? {}),
        ...(envelope !== undefined ? { error_envelope: envelope } : {}),
        // 0.18：中断时已流出的文本（可还原用户看到的半截回答）
        ...(typeof partial === 'string' && partial.length > 0 ? { partial_content: partial } : {}),
        // 权限超时（DECISION-022 §2.2）：失败原因显式标注，供 UI / 观测区分
        ...(!cancelled && permissionTimeout ? { reason: 'permission_timeout' } : {}),
      },
      ts: Date.now(),
    });
    await this.finishEventLog(runState);
  }

  /**
   * 0.18：终态收尾——等待事件日志落盘，然后 best-effort 更新会话索引。
   * 成功/失败路径共用；日志失败不覆盖 run 终态。
   */
  private async finishEventLog(runState: RunState): Promise<void> {
    if (!this.eventLog) return;
    await this.flushEventLogWrites();
    try {
      await this.updateSessionIndex(runState);
    } catch (error) {
      this.logger.warn('session index update failed', {
        session_id: runState.session_id,
        error: errorText(error),
      });
    }
    // P2：run 结束关闭该 session 的写句柄，避免长进程每会话永久占用一个 FD。
    // 下次 run/append 会重新打开并从文件尾恢复 seq。
    try {
      await this.eventLog.release?.(runState.session_id);
    } catch (error) {
      this.logger.warn('session event log release failed', {
        session_id: runState.session_id,
        error: errorText(error),
      });
    }
  }

  /**
   * 失败终态包装：终态持久化本身失败（如 session 盘满）也不得覆盖原始错误。
   * OnError hook 已在 finalizeRun 内部 best-effort。
   */
  private async finalizeFailure(
    execution: RunExecution,
    runState: RunState,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.finalizeRun(execution, runState, { status: 'failed', error, signal });
    } catch (finalizeError) {
      this.publishEvent({
        type: 'run.finalize.failed',
        run_id: execution.runId,
        data: {
          run_id: execution.runId,
          session_id: execution.sessionId,
          error: errorText(finalizeError),
        },
        ts: Date.now(),
      });
      // 终态写入失败时仍等待已入队的事件落盘，避免调用方看到 run 结束后日志缺尾。
      await this.flushEventLogWrites();
    }
  }

  /** RunState/checkpoint 共用的 usage 快照 */
  private usageFromStats(stats: UsageStats): NonNullable<RunState['usage']> {
    return {
      prompt_tokens: stats.inputTokens,
      completion_tokens: stats.outputTokens,
      total_tokens: stats.totalTokens,
      total_cost: stats.totalCost,
    };
  }

  /**
   * 从 RunStore 恢复并继续一次 run（0.3 durable）。
   *
   * - 会话历史 / usage / iteration 来自 checkpoint；
   * - 不注入新的用户消息；
   * - run id 保持不变，返回值语义与 run() 一致。
   */
  async resume(runId: string, opts?: RunOptions): Promise<string> {
    if (!this.runStore) throw new RunResumeError('run_store_required', runId);
    if (this.resuming.has(runId)) throw new RunAlreadyRunningError(runId);

    // 与 run() 共用单 run 守卫；同步占位，避免两次不同 run 的并发 resume。
    const execution = this.beginExecution(runId, '');
    const signal = this.executionSignal(execution, opts?.signal);
    this.resuming.add(runId);
    try {
      const checkpoint = await this.runStore.load(runId);
      if (!checkpoint) throw new RunResumeError('run_not_found', runId);
      if (checkpoint.status !== 'running' && checkpoint.status !== 'interrupted') {
        throw new RunResumeError('run_not_resumable', runId, checkpoint.status);
      }
      const sessionId = checkpoint.session_id;
      execution.sessionId = sessionId;
      execution.createdAt = checkpoint.created_at;
      execution.branch =
        typeof checkpoint.metadata?.branch === 'string' ? checkpoint.metadata.branch : undefined;

      // 恢复统计，保持 limits / termination 连续
      execution.stats = {
        requestCount: checkpoint.iteration ?? 0,
        toolCallsCount:
          typeof checkpoint.metadata?.tool_calls_count === 'number'
            ? checkpoint.metadata.tool_calls_count
            : 0,
        inputTokens: checkpoint.usage?.prompt_tokens ?? 0,
        outputTokens: checkpoint.usage?.completion_tokens ?? 0,
        totalTokens: checkpoint.usage?.total_tokens ?? 0,
        totalCost: checkpoint.usage?.total_cost ?? 0,
        startTime: execution.startedAt,
      };

      // 0.18：session 缓存 + 事件日志是恢复来源；checkpoint.messages 只作
      // legacy 回退（旧文件）。禁止用较旧的 checkpoint 覆盖较新的 session。
      // 0.15 E9：resume 同样在 run 开始时生成一次 Self Card
      this.runSystemPrompt = this.composeRunSystemPrompt();
      const history = await this.loadStoredHistory(sessionId, checkpoint);
      if (history.length === 0) {
        throw new RunResumeError('run_not_resumable', runId, 'empty checkpoint');
      }
      this.context.clear();
      this.context.setSessionId(sessionId);
      if (!history.some((message) => message.role === 'system') && this.runSystemPrompt) {
        this.addContext({ role: 'system', content: this.runSystemPrompt }, runId);
      }
      for (const message of history) {
        this.addContext(message, runId);
      }

      const runState: RunState = {
        run_id: runId,
        session_id: sessionId,
        messages: this.context.messages,
        started_at: execution.createdAt,
        status: 'running',
        ...(execution.branch !== undefined ? { branch: execution.branch } : {}),
        ...((this.tenantId ?? checkpoint.tenant_id) !== undefined
          ? { tenant_id: this.tenantId ?? checkpoint.tenant_id }
          : {}),
      };
      // 0.18：先发布 run.resumed，再 saveSession；否则 derived_upto_seq 会漏掉
      // 这条事件（legacy checkpoint 复用 session 时尤其明显）。
      this.publishEvent({
        type: 'run.resumed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          from_status: checkpoint.status,
          iteration: execution.stats.requestCount,
        },
        ts: Date.now(),
      });

      await this.saveSession(runState);
      await this.updateSessionIndexBestEffort(runState);

      // 标记已被接管（唯一写者：AgentRuntime）
      await this.writeCheckpoint(execution, 'running');

      try {
        const response = await this.toolCallingLoop(execution, signal);

        // 与 run() 共用终态路径：用户取消同样发 run.cancelled（C1）
        await this.finalizeRun(execution, runState, { status: 'completed', output: response });

        return response;
      } catch (error) {
        await this.finalizeFailure(execution, runState, error, signal);
        throw error;
      }
    } finally {
      this.resuming.delete(runId);
      this.endExecution(execution);
    }
  }

  /**
   * Tool-calling loop
   * 核心循环：调用 LLM -> 解析 tool_calls -> 执行工具 -> 注入结果 -> 循环
   * @param execution 本次 run 的执行态（run/session/usage 的唯一来源）
   * @param signal 可选的 AbortSignal（Hermes/Claude Code 模式——Esc 中断）
   */
  protected async toolCallingLoop(execution: RunExecution, signal?: AbortSignal): Promise<string> {
    const { runId, sessionId, stats } = execution;
    while (true) {
      // AbortSignal 中断（Hermes/Claude Code 模式——外部 Esc）
      if (signal?.aborted) {
        throw new Error(signal.reason ?? 'Run cancelled');
      }

      // 权限等待不计入 max_runtime（ADR-084 Errata）：每轮同步累计暂停时长。
      stats.pausedMs = this.permissionPolicy.pausedMs;

      // 0.15 E2：80% 预警（每 run 每 key 一次，不改变执行）
      this.publishLimitWarnings(execution);

      // 检查终止条件
      const terminationBlock = evaluateTermination(stats, this.termination);
      if (terminationBlock) {
        this.publishEvent({
          type: 'limit.blocked',
          run_id: runId,
          data: {
            error_code: 'limit_blocked',
            ...terminationBlock,
            run_id: runId,
            session_id: sessionId,
          },
          ts: Date.now(),
        });
        throw new LimitExceededError(terminationBlock);
      }

      // 检查使用量限制（含 request_limit、tool_calls_limit、token/cost 预算）——硬上限
      const limitBlock = evaluateUsageLimits(stats, this.limits);
      if (limitBlock) {
        this.publishEvent({
          type: 'limit.blocked',
          run_id: runId,
          data: {
            error_code: 'limit_blocked',
            ...limitBlock,
            run_id: runId,
            session_id: sessionId,
          },
          ts: Date.now(),
        });
        throw new LimitExceededError(limitBlock);
      }

      // 0.6.1 E3：按阈值触发真实摘要压缩（旧 ContextManager 无此方法则跳过）。
      // 必须在组装请求前完成，保证本轮请求看到压缩后的历史。
      const compacted = await this.context.autoCompactAsync?.();
      if (typeof compacted === 'number') this.publishCompacted(execution, compacted, 'auto');

      // 执行 BeforeLlm 钩子（hook 可往 ctx.systemPrompt 注入内容：skills / memory）
      // 用本次 run 的 systemPrompt（含 Self Card）作基底，hook 链 prepend 注入
      const hookCtx: HookContext = { run_id: runId, session_id: sessionId };
      const baseSystemPrompt = this.runSystemPrompt ?? this.systemPrompt;
      if (baseSystemPrompt) {
        hookCtx.systemPrompt = baseSystemPrompt;
      }
      const beforeLlm = await this.hooks.run(HookType.BeforeLlm, hookCtx);

      // 0.16 E5：BeforeLlm 注入的消息按返回顺序写入上下文一次（进入本次请求，
      // 后续轮次直接从上下文可见；重复返回同一批消息不重复写入）。
      this.appendInjectedMessages(runId, hookCtx.messages);

      // 组装本次请求的消息（持久化上下文 + BeforeLlm 注入的 system prompt）。
      // 0.6.1 P2：HookResult.additionalContext 追加在 systemPrompt 之后。
      const injectedSystem = [hookCtx.systemPrompt, beforeLlm.additionalContext]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('\n\n');
      const messages = this.buildRequestMessages(injectedSystem || undefined);

      // 统一工具来源：PluginHost（插件在 install() 里 registerTool）
      const allTools = this.pluginHost.listTools();
      const toolSchemas = allTools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));

      // 调用 LLM（context-overflow 时强制压缩一次并重试一次，0.10 R2-17）
      const response = await this.chatWithOverflowRetry(execution, {
        messages,
        tools: toolSchemas,
        sessionId,
        ...(signal !== undefined ? { signal } : {}),
        rebuildMessages: () => this.buildRequestMessages(injectedSystem || undefined),
      });

      // 更新 token 使用量
      if (response.usage) {
        this.limitChecker.addTokens(
          stats,
          response.usage.prompt_tokens ?? 0,
          response.usage.completion_tokens ?? 0,
        );
        // Auto Compact：用**本次请求**的真实 token 数替代字符估算。
        // 不能用累计 stats.totalTokens——多轮会线性放大，第二轮就误触发 compact（C-04）。
        this.context.updateRealTokens(
          (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
        );
      }

      // 0.18：reasoning 只写入会话事件日志（resume 需要），**不进入对外发布的事件**。
      // ADR-077：默认不把思维链发给 UI / trace；TUI 仅在 includeReasoning=true 时
      // 通过 `llm.stream.chunk` 的 reasoning_delta 展示。
      const publishedLlmData = {
        run_id: runId,
        session_id: sessionId,
        content: response.content,
        tool_calls: response.tool_calls,
        finish_reason: response.finish_reason,
        usage: response.usage,
      };
      this.publishEvent(
        {
          type: 'llm.response',
          run_id: runId,
          data: publishedLlmData,
          ts: Date.now(),
        },
        {
          persistData:
            response.reasoning_content !== undefined
              ? { ...publishedLlmData, reasoning: response.reasoning_content }
              : publishedLlmData,
        },
      );

      // 执行 AfterLlm 钩子
      await this.hooks.run(HookType.AfterLlm, hookCtx);

      // 检查完成原因。
      // 0.6.1 P1：finish_reason 不可靠——存在实际 tool_calls 时优先继续工具轮，
      // 只有「无 tool_calls 且 stop」才视为终稿（对齐 Claude Code query.ts 的 tool_use 判定）。
      const toolCalls = response.tool_calls;
      const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

      if (!hasToolCalls && response.finish_reason === 'stop') {
        // 应用输出 Guardrail
        const outputResult = await this.guardrails.apply(
          response.content,
          GuardrailStage.Output,
          runId,
          sessionId,
        );
        if (!outputResult.allowed) {
          throw new Error(`Output blocked by guardrail: ${outputResult.reason}`);
        }
        // replacement 生效：改写返回给调用方并持久化的助手文本（C-05）
        const finalContent =
          typeof outputResult.replacement === 'string'
            ? outputResult.replacement
            : response.content;

        // 添加助手消息到上下文（thinking 模式需保存 reasoning_content 供下一轮回传）
        this.addContext(
          {
            role: 'assistant',
            content: finalContent,
            ...(response.reasoning_content
              ? { reasoning_content: response.reasoning_content }
              : {}),
          },
          runId,
        );

        return finalContent;
      }

      if (toolCalls && toolCalls.length > 0) {
        // 先对全部 tool_call 过 Guardrail，得到实际要执行的调用（replacement 可改写，C-05）。
        // 放在写 assistant 消息之前，保证上下文里的 tool_calls 与后续 role:tool 结果严格配对。
        // 阻断不再 throw（0.6.1 P1）：保留调用并折回 role:tool 错误，模型可改道。
        const effectiveCalls: ToolCall[] = [];
        const blockedCalls = new Map<string, string>();
        for (const toolCall of toolCalls) {
          this.limitChecker.incrementToolCall(stats);
          const toolCallResult = await this.guardrails.apply(
            toolCall,
            GuardrailStage.ToolCall,
            runId,
            sessionId,
          );
          if (!toolCallResult.allowed) {
            blockedCalls.set(
              toolCall.id,
              `Tool call blocked by guardrail: ${toolCallResult.reason ?? 'blocked'}`,
            );
            effectiveCalls.push(toolCall);
            continue;
          }
          effectiveCalls.push(
            isToolCall(toolCallResult.replacement) ? toolCallResult.replacement : toolCall,
          );
        }

        // 添加助手消息（包含实际执行的 tool_calls）到上下文；
        // thinking 模式必须带上 reasoning_content，下一次请求要原样回传
        this.addContext(
          {
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: effectiveCalls,
            ...(response.reasoning_content
              ? { reasoning_content: response.reasoning_content }
              : {}),
          },
          runId,
        );

        // 预处理工具调用：参数只解析一次（C-01）；guardrail 阻断/非法 JSON 走折回路径。
        const prepared: PreparedToolCall[] = effectiveCalls.map((toolCall) => {
          const toolName = toolCall.function.name;
          const blockedReason = blockedCalls.get(toolCall.id);
          let args: unknown = {};
          let failureMessage = blockedReason;
          if (blockedReason === undefined) {
            try {
              args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
            } catch (error) {
              failureMessage = `Invalid JSON in tool arguments: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }

          // 发布工具调用开始事件
          this.publishEvent({
            type: 'tool.call.started',
            run_id: runId,
            data: {
              run_id: runId,
              session_id: sessionId,
              tool_call_id: toolCall.id,
              tool_name: toolName,
              arguments: failureMessage !== undefined ? toolCall.function.arguments : args,
            },
            ts: Date.now(),
          });

          return {
            toolCall,
            toolName,
            args,
            startedAt: Date.now(),
            ...(failureMessage !== undefined ? { failureMessage } : {}),
          };
        });

        // 执行工具调用：连续的 concurrencySafe 只读工具并批发车（0.6.1 P1），
        // 其余按原顺序串行；结果始终按原调用顺序写回上下文。
        // 0.14 P0：工具阶段的失败（含管道错误）按 tool 归类。
        execution.phase = 'tool';
        let cursor = 0;
        while (cursor < prepared.length) {
          const first = prepared[cursor];
          if (!first) break;

          const batch: PreparedToolCall[] = [first];
          if (this.isConcurrencySafe(first)) {
            let candidate = prepared[cursor + batch.length];
            while (candidate && this.isConcurrencySafe(candidate)) {
              batch.push(candidate);
              candidate = prepared[cursor + batch.length];
            }
          }

          // BeforeTool 钩子逐调用串行执行，避免并行批次共享 hookCtx 的竞态。
          // 0.6.1 P2：hook 可读取 tool/input；block 折回 tool 错误，updatedInput 改写入参。
          for (const entry of batch) {
            if (entry.failureMessage !== undefined) continue;
            const hookResult = await this.hooks.run(HookType.BeforeTool, {
              ...hookCtx,
              tool: entry.toolName,
              input: entry.args,
            });
            if (hookResult.block) {
              entry.failureMessage = `Tool call blocked by hook: ${hookResult.reason ?? 'blocked'}`;
              continue;
            }
            if (hookResult.updatedInput !== undefined) {
              entry.args = hookResult.updatedInput;
            }
          }

          const outcomes = await Promise.all(
            batch.map((entry) => this.runToolCall(entry, execution, signal)),
          );

          // 上下文严格按原调用顺序写回（并行完成顺序不影响历史顺序）
          for (const outcome of outcomes) {
            if (outcome.ok) {
              // 执行 AfterTool 钩子（0.6.1 P2：携带 tool/input）
              await this.hooks.run(HookType.AfterTool, {
                ...hookCtx,
                tool: outcome.toolCall.function.name,
                input: outcome.input,
              });
            }
            this.addContext(
              {
                role: 'tool',
                tool_call_id: outcome.toolCall.id,
                content: outcome.content,
              },
              runId,
            );
            // 注：不再注入假 assistant 消息（见 ADR-005 / Phase 1 review #3）
            // Provider 负责正确解释 role: tool 消息
          }

          cursor += batch.length;
        }

        // durable checkpoint：本轮 tool-call 结果已全部写入上下文
        await this.writeCheckpoint(execution, 'running');
      } else {
        // 其他完成原因（如 length），直接返回当前内容
        this.addContext(
          {
            role: 'assistant',
            content: response.content,
            ...(response.reasoning_content
              ? { reasoning_content: response.reasoning_content }
              : {}),
          },
          runId,
        );
        return response.content;
      }
    }
  }

  /**
   * 调用 provider，并在 context-overflow（400）时强制压缩一次后重试一次（0.10 R2-17）。
   *
   * 每次真实请求都递增 request 计数并发布 `llm.request`（重试请求看到的是压缩后的上下文）。
   * 第二次仍失败则原样抛出，不包装 provider 错误。
   */
  private async chatWithOverflowRetry(
    execution: RunExecution,
    args: {
      messages: Message[];
      tools: NonNullable<ChatRequest['tools']>;
      sessionId: string;
      signal?: AbortSignal;
      rebuildMessages: () => Message[];
    },
  ): Promise<LLMResponse> {
    const { runId, stats } = execution;
    let messages = args.messages;
    let retried = false;

    while (true) {
      // 0.14 P0：provider / 流式错误按 llm 阶段归类。
      execution.phase = 'llm';
      // 0.18：每次请求重置部分输出；中断时把已流出的文本写进终态 partial_content。
      execution.partialContent = '';
      // 调试元信息（0.10 R2-13）：只记数量/工具名/token 估算，绝不输出 prompt 正文
      this.logger.debug('llm request', {
        run_id: runId,
        message_count: messages.length,
        tool_names: args.tools.map((tool) => tool.function.name),
        estimated_tokens: estimateMessagesTokens(messages),
      });

      // 发布 LLM 请求事件（事件里剔除 reasoning_content，避免思维链泄漏到 TUI/观测）
      this.publishEvent({
        type: 'llm.request',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: args.sessionId,
          messages: this.stripReasoning(messages),
          tools: args.tools,
        },
        ts: Date.now(),
      });

      // 增加请求计数
      this.limitChecker.incrementRequest(stats);

      const request: ChatRequest = {
        messages,
        model: this.model,
        tools: args.tools.length > 0 ? args.tools : undefined,
        session_id: args.sessionId,
        // AbortSignal——Provider 透传给 fetch()，支持 Esc 中断（Hermes/Claude Code 模式）
        signal: args.signal,
        // 0.11.1：仅在显式开启时要求 reasoning 流式增量；默认请求形状不变
        ...(this.includeReasoning ? { include_reasoning: true } : {}),
        // 流式（ADR-007）：始终提供 stream + on_chunk。支持流式的 Provider 边收边经回调吐增量，
        // loop 在此发布 LlmStreamChunk 事件供 TUI 订阅渲染；不支持流式的 Provider 忽略字段、
        // 退化为整段返回（无 chunk 事件，无副作用）。chat() 仍返回完整 LLMResponse。
        stream: true,
        on_chunk: (chunk) => {
          if (chunk.type === 'text_delta' && typeof chunk.delta === 'string') {
            execution.partialContent = `${execution.partialContent ?? ''}${chunk.delta}`;
          }
          this.publishEvent({
            type: 'llm.stream.chunk',
            run_id: runId,
            data: { run_id: runId, chunk },
            ts: Date.now(),
          });
        },
      };

      this.logger.debug('llm call', {
        run_id: runId,
        message_count: messages.length,
        estimated_tokens: estimateMessagesTokens(messages),
      });

      try {
        return await this.provider.chat(request);
      } catch (error) {
        if (retried || !isContextOverflowError(error)) throw error;
        retried = true;
        const removed = await this.forceCompact(execution, 'overflow');
        messages = args.rebuildMessages();
        this.logger.warn('context overflow; compacted and retrying once', {
          run_id: runId,
          removed_messages: removed,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * 0.15 E1：手动压缩上下文，并发布 `context.compacted`（reason=manual）。
   * 供 harness 的 `/compact` 一类入口调用；直接调 ContextManager 不会产生事件。
   * @returns 移除的消息数（0 = 未压缩）
   */
  async compactContext(): Promise<number> {
    const removed = this.context.compactAsync
      ? await this.context.compactAsync()
      : this.context.compact();
    this.publishCompacted(this.activeRun, removed, 'manual');
    return removed;
  }

  /** 强制压缩一次（overflow 重试用）；压缩失败不覆盖 provider 原始错误。 */
  private async forceCompact(
    execution?: RunExecution,
    reason: ContextCompactedReason = 'overflow',
  ): Promise<number> {
    try {
      const removed = this.context.compactAsync
        ? await this.context.compactAsync()
        : this.context.compact();
      this.publishCompacted(execution, removed, reason);
      return removed;
    } catch {
      return 0;
    }
  }

  /** 0.15 E1：removed>0 时发布 `context.compacted` */
  private publishCompacted(
    execution: RunExecution | undefined,
    removed: number,
    reason: ContextCompactedReason,
  ): void {
    if (removed <= 0) return;
    const runId = execution?.runId ?? this.activeRun?.runId ?? 'manual';
    const sessionId = execution?.sessionId ?? this.context.getSessionId();
    this.publishEvent({
      type: 'context.compacted',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        removed,
        remaining: this.context.messages.length,
        reason,
      },
      ts: Date.now(),
    });
  }

  /** 0.15 E2：每 run 每 key 只发一次预警（数据形状为冻结契约） */
  private publishLimitWarnings(execution: RunExecution): void {
    const warnings = evaluateLimitWarnings(
      execution.stats,
      this.limits,
      this.termination,
      LIMIT_WARNING_THRESHOLD,
    );
    for (const warning of warnings) {
      if (this.warnedLimitKeys.has(warning.key)) continue;
      this.warnedLimitKeys.add(warning.key);
      this.publishEvent({
        type: 'agent.limit.warning',
        run_id: execution.runId,
        data: {
          scope: warning.scope,
          key: warning.key,
          current: warning.current,
          max: warning.max,
          source: warning.source,
          threshold: warning.threshold,
          hint: warning.hint,
        },
        ts: Date.now(),
      });
      // 预警同时作为一条持久化尾部消息进入模型上下文（不改 system）。
      // publishLimitWarnings 在每轮请求组装前调用，因此本轮请求即可看到。
      const percent = warning.max > 0 ? Math.round((warning.current / warning.max) * 100) : 0;
      this.addContext(
        {
          role: 'user',
          name: 'vessel:limit',
          content: `[runtime] ${warning.key}: ${warning.current}/${warning.max} (${percent}%) — ${warning.hint}`,
          timestamp: Date.now(),
        },
        execution.runId,
      );
    }
  }

  /** 0.15 E9：本次 run 的 systemPrompt（含 Self Card）；缺省与 this.systemPrompt 相同 */
  private composeRunSystemPrompt(): string | undefined {
    if (!this.selfCard) return this.systemPrompt;
    const card = formatSelfCard(this.selfCard);
    return this.systemPrompt ? `${this.systemPrompt}\n\n${card}` : card;
  }

  /**
   * 释放资源（0.9）：按逆安装顺序 best-effort 调用插件 dispose（异常只发
   * `plugin.dispose.failed`，不外抛），最后关闭 session。重复调用幂等。
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeRuntime();
    return this.disposePromise;
  }

  /**
   * 热应用权限规则（配置变更后调用）。下一轮工具调用按新规则判定，不需要重建 runtime。
   * 已记住的 "always" 不受影响；`autoApprove` / `neverAutoApprove` 整体替换。
   */
  applyPermissionRules(
    rules: Pick<RuntimePermissionConfig, 'default' | 'autoApprove' | 'neverAutoApprove'>,
  ): void {
    this.permissionPolicy.replaceRules(rules);
  }

  private async disposeRuntime(): Promise<void> {
    this.eventLogUnsubscribe?.();
    for (let i = this.installedPlugins.length - 1; i >= 0; i -= 1) {
      const plugin = this.installedPlugins[i] as Plugin;
      if (plugin.dispose === undefined) continue;
      try {
        await plugin.dispose();
      } catch (error) {
        this.publishEvent({
          type: 'plugin.dispose.failed',
          run_id: 'plugin',
          data: { name: plugin.name, error: errorText(error) },
          ts: Date.now(),
        });
      }
    }
    await this.flushEventLogWrites();
    this.session?.close?.();
  }

  /**
   * 记录一次工具失败：OnError hook → tool.call.failed 事件 → 返回错误文本（C-01）。
   * 错误文本由调用方按原顺序折回上下文；工具失败不终止 run，模型可自行纠错。
   */
  private async recordToolFailure(
    execution: RunExecution,
    opts: {
      toolCallId: string;
      toolName: string;
      startTime: number;
      errorMessage: string;
      /** 原始错误；缺省时用 errorMessage 构造，仅按文本分类 */
      error?: unknown;
      /** 本次调用实际使用的参数（additive，便于日志还原工具卡） */
      arguments?: unknown;
      details?: Record<string, unknown>;
    },
  ): Promise<string> {
    // OnError hook 已由 HookRunner 隔离；这里再兜底，工具失败不得升级为 run 失败（C2）。
    try {
      await this.hooks.run(HookType.OnError, {
        run_id: execution.runId,
        session_id: execution.sessionId,
        error: opts.errorMessage,
        phase: 'tool_execution',
        tool_name: opts.toolName,
      });
    } catch (hookError) {
      this.publishEvent({
        type: 'hook.error',
        run_id: execution.runId,
        data: {
          run_id: execution.runId,
          session_id: execution.sessionId,
          hook_type: HookType.OnError,
          error: errorText(hookError),
        },
        ts: Date.now(),
      });
    }
    // 0.14 P0：保留原 error 文本，追加结构化 envelope（tool 阶段）。
    const envelope = toErrorEnvelope(opts.error ?? opts.errorMessage, {
      phase: 'tool',
      category: 'tool',
      details: { tool_name: opts.toolName, ...opts.details },
    });
    this.publishEvent({
      type: 'tool.call.failed',
      run_id: execution.runId,
      data: {
        run_id: execution.runId,
        session_id: execution.sessionId,
        tool_call_id: opts.toolCallId,
        tool_name: opts.toolName,
        ...(opts.arguments !== undefined ? { arguments: opts.arguments } : {}),
        error: opts.errorMessage,
        duration_ms: Date.now() - opts.startTime,
        ...envelope,
        error_envelope: envelope,
      },
      ts: Date.now(),
    });
    return `Error: ${opts.errorMessage}`;
  }

  /**
   * 连续只读工具可并发执行（0.6.1 P1）：仅当插件显式标记 `concurrencySafe`
   * 且该调用没有预处理失败时成立。
   */
  private isConcurrencySafe(entry: PreparedToolCall): boolean {
    if (entry.failureMessage !== undefined) return false;
    return this.pluginHost.getTool(entry.toolName)?.concurrencySafe === true;
  }

  /**
   * 执行单个工具调用（不含 BeforeTool / AfterTool，钩子由批次循环串行编排）。
   * 返回结果文本与成功标记；失败已通过 OnError hook 与 tool.call.failed 记录。
   */
  private async runToolCall(
    entry: PreparedToolCall,
    execution: RunExecution,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const { toolCall, toolName } = entry;
    const { runId, sessionId } = execution;

    if (entry.failureMessage !== undefined) {
      return {
        toolCall,
        input: entry.args,
        ok: false,
        content: await this.recordToolFailure(execution, {
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: entry.failureMessage,
          error: entry.failureMessage,
          arguments: entry.args,
        }),
      };
    }

    try {
      // 统一执行管道（0.8.2 Wave 2B1）：permission + handler(timeout/signal) + ToolResult guardrail。
      // BeforeTool / ToolCall guardrail / AfterTool 仍由外层批次与写回逻辑编排，故在此关闭。
      const result = await this.toolPipeline.execute({
        runId,
        sessionId,
        toolCall,
        args: entry.args,
        messages: this.context.messages,
        // F10：把当前 run 的 signal 交给工具，便于 handler 响应取消
        ...(signal ? { signal } : {}),
        stages: {
          beforeToolHook: false,
          toolCallGuardrail: false,
          afterToolHook: false,
        },
      });

      if (!result.ok) {
        return {
          toolCall,
          input: entry.args,
          ok: false,
          content: await this.recordToolFailure(execution, {
            toolCallId: toolCall.id,
            toolName,
            startTime: entry.startedAt,
            errorMessage: result.error ?? result.content,
            error: result.error ?? result.content,
            arguments: result.input,
          }),
        };
      }

      // 发布工具调用完成事件
      this.publishEvent({
        type: 'tool.call.completed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          tool_call_id: toolCall.id,
          tool_name: toolName,
          arguments: entry.args,
          result: result.content,
          duration_ms: Date.now() - entry.startedAt,
        },
        ts: Date.now(),
      });

      return { toolCall, input: result.input, ok: true, content: result.content };
    } catch (error) {
      // 权限超时是致命错误（DECISION-022 §2.2）：终止 run，不折回工具错误让模型重试。
      if (error instanceof PermissionTimeoutError) throw error;
      // 0.13（DECISION-024 §2.3）：权限等待被取消同样终止 run，不记成工具失败。
      if (error instanceof PermissionAbortedError) throw error;
      return {
        toolCall,
        input: entry.args,
        ok: false,
        content: await this.recordToolFailure(execution, {
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: errorText(error),
          error,
          arguments: entry.args,
        }),
      };
    }
  }

  /**
   * 消费 BeforeLlm 的 `ctx.messages`（0.16 E5）：逐条写入上下文一次。
   * 已注入的消息按稳定键（`name` / `timestamp`）去重；两者都缺失时按对象引用去重。
   */
  private appendInjectedMessages(runId: string, messages: readonly Message[] | undefined): void {
    if (!messages || messages.length === 0) return;
    for (const message of messages) {
      const key = injectedMessageKey(message);
      if (key !== undefined) {
        if (this.injectedMessageKeys.has(key)) continue;
        this.injectedMessageKeys.add(key);
      } else {
        if (this.injectedMessageRefs.has(message)) continue;
        this.injectedMessageRefs.add(message);
      }
      this.publishEvent({
        type: 'message.injected',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: this.context.getSessionId(),
          message,
        },
        ts: Date.now(),
      });
      this.addContext(message, runId);
    }
  }

  /**
   * 组装本次请求的消息数组（ADR-018 / C-03）。
   * 「持久化上下文 + BeforeLlm hook 写入的 systemPrompt」在此一处收敛：
   * 1) 先归一化成 Provider 可接受的序列（丢掉孤儿 tool 消息、降级不完整的 tool_calls 轮次）；
   * 2) 再处理 system：hook 改写时替换；上下文缺 system 时补回基底 systemPrompt。
   * 注入只影响本次请求，不改动 ContextManager 持久化的消息。
   */
  private buildRequestMessages(injectedSystem: unknown): Message[] {
    const messages = this.normalizeMessages(this.context.messages);
    const systemOverride =
      typeof injectedSystem === 'string' && injectedSystem ? injectedSystem : undefined;
    // 压缩摘要也是 role=system：它不是基底 system，缺省补回与 hook 改写都不能替换它。
    const isBaseSystem = (m: Message): boolean => m.role === 'system' && !m.compaction_summary;
    const hasSystem = messages.some(isBaseSystem);

    // 上下文缺 system（trim / 恢复 / 失败会话）时，补回基底的或 hook 改写后的 system
    if (!hasSystem) {
      return systemOverride ? [{ role: 'system', content: systemOverride }, ...messages] : messages;
    }
    // hook 未改写（或改写为空）且无 Self Card 时保持持久化 system 原样；
    // Self Card 必须覆盖持久化的旧 system，且只出现一次。
    const basePrompt = this.runSystemPrompt ?? this.systemPrompt;
    if (!systemOverride || (systemOverride === basePrompt && !this.selfCard)) {
      return messages;
    }
    return messages.map((m) => (isBaseSystem(m) ? { ...m, content: systemOverride } : m));
  }

  /**
   * 把持久化上下文整理成 Provider 可接受的序列（C-03）：
   * - 丢弃没有对应 assistant(tool_calls) 的 role:tool 消息（trim / compact 可能切断配对）；
   * - assistant(tool_calls) 缺少某些 tool 结果时，整轮降级为普通 assistant 文本
   *   （空文本则丢弃），同时丢弃该轮已出现的部分 tool 结果；
   * - 其余消息保持原顺序与对象引用。
   */
  private normalizeMessages(messages: Message[]): Message[] {
    const normalized: Message[] = [];
    let pending: {
      assistant: Message;
      ids: Set<string>;
      toolMessages: Message[];
    } | null = null;

    const flushPending = (): void => {
      if (!pending) return;
      const { assistant, ids, toolMessages } = pending;
      pending = null;
      if (ids.size === 0) {
        normalized.push(assistant, ...toolMessages);
        return;
      }
      // 有 tool_call 没拿到结果：不发送非法序列；保留 assistant 文本与 reasoning（若有）
      if (assistant.content || assistant.reasoning_content) {
        normalized.push({
          role: 'assistant',
          content: assistant.content,
          ...(assistant.reasoning_content
            ? { reasoning_content: assistant.reasoning_content }
            : {}),
        });
      }
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const id = msg.tool_call_id ?? '';
        if (pending?.ids.has(id)) {
          pending.ids.delete(id);
          pending.toolMessages.push(msg);
        }
        // 孤儿 tool 消息直接丢弃
        continue;
      }

      flushPending();

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        pending = {
          assistant: msg,
          ids: new Set(msg.tool_calls.map((tc) => tc.id)),
          toolMessages: [],
        };
      } else {
        normalized.push(msg);
      }
    }

    flushPending();
    return normalized;
  }

  /**
   * 加入上下文并发布 context.changed 事件（ADR-031：同步写保证关键路径可靠 + 事件观测可回放）
   */
  private addContext(msg: Message, runId: string): void {
    // 0.6.1 P2：逐条消息时间戳（已有值不覆盖，恢复的历史保持原时间）
    const stamped: Message = msg.timestamp === undefined ? { ...msg, timestamp: Date.now() } : msg;
    this.context.add(stamped);
    this.publishEvent({
      type: 'context.changed',
      run_id: runId,
      data: {
        run_id: runId,
        ...(this.activeRun?.sessionId !== undefined
          ? { session_id: this.activeRun.sessionId }
          : {}),
        // 持久化保留 reasoning_content；事件里剔除，避免思维链泄漏到 TUI/观测
        message: this.stripReasoningFromMessage(stamped),
        message_count: this.context.messages.length,
        token_count: this.context.tokenCount,
      },
      ts: Date.now(),
    });
  }

  /** 事件流/观测载荷里不暴露思维链（reasoning_content 只用于 Provider 回传与持久化） */
  private stripReasoningFromMessage(msg: Message): Message {
    if (msg.reasoning_content === undefined) return msg;
    const copy = { ...msg };
    delete copy.reasoning_content;
    return copy;
  }

  private stripReasoning(messages: Message[]): Message[] {
    return messages.map((msg) => this.stripReasoningFromMessage(msg));
  }

  /**
   * 写 checkpoint 并发布开放事件 `run.checkpoint`；未配置 store 时 no-op。
   * 写入失败默认让 run 失败（durable 已开启就不能静默降级）；
   * `bestEffort` 用于失败路径上的最终写入，避免覆盖原始错误。
   */
  private async writeCheckpoint(
    execution: RunExecution,
    status: RunCheckpoint['status'],
    error?: string,
    bestEffort = false,
    errorEnvelope?: ErrorEnvelope,
  ): Promise<void> {
    if (!this.runStore) return;

    if (this.eventLog) await this.flushEventLogWrites();
    const eventCursor = await this.currentEventCursor(execution.sessionId);

    const { runId, sessionId, createdAt, stats, branch } = execution;
    const checkpoint: RunCheckpoint = {
      run_id: runId,
      session_id: sessionId,
      status,
      // 0.18 C2：不再写完整 messages；历史由 session 缓存 + 事件日志重建。
      messages: [],
      ...(eventCursor !== undefined ? { event_cursor: eventCursor } : {}),
      ...(errorEnvelope !== undefined ? { error_envelope: errorEnvelope } : {}),
      usage: this.usageFromStats(stats),
      iteration: stats.requestCount,
      created_at: createdAt || Date.now(),
      updated_at: Date.now(),
      metadata: {
        tool_calls_count: stats.toolCallsCount,
        ...(branch !== undefined ? { branch } : {}),
        // 0.18：checkpoint 不再带 messages；durable 列表的 preview 从这里取。
        preview: deriveSessionMeta(this.context.messages).preview,
      },
      ...(this.agentId !== undefined ? { agent_id: this.agentId } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };

    // 0.14 P0：checkpoint 写失败按 checkpoint 阶段归类；成功后恢复原阶段。
    const previousPhase = execution.phase;
    execution.phase = 'checkpoint';
    try {
      await this.runStore.save(checkpoint);
    } catch (saveError) {
      if (bestEffort) {
        execution.phase = previousPhase;
        return;
      }
      const detail = saveError instanceof Error ? saveError.message : String(saveError);
      throw new Error(`run_checkpoint_failed: ${detail}`);
    }
    execution.phase = previousPhase;

    this.publishEvent({
      type: 'run.checkpoint',
      run_id: runId,
      data: {
        run_id: runId,
        session_id: sessionId,
        status,
        iteration: checkpoint.iteration,
        message_count: checkpoint.messages.length,
      },
      ts: Date.now(),
    });
  }

  /**
   * 0.18：恢复历史（run 启动 / resume 共用）。优先级：
   * 1) session 缓存（含压缩摘要等事件不可重建的消息）+ 事件日志中 `seq > derived_upto_seq` 的增量；
   * 2) 事件日志完整投影（旧缓存无 derived 时做重叠去重）；
   * 3) 旧 checkpoint.messages（仅 resume 的 legacy 只读兼容）。
   *
   * run() 也必须走这里：否则崩溃后新 run 只读缓存，saveSession 会把未重放的
   * 尾段事件错误标记为已覆盖。
   */
  private async loadStoredHistory(
    sessionId: string,
    checkpoint?: RunCheckpoint,
  ): Promise<Message[]> {
    let sessionState: RunState | null = null;
    if (this.session) {
      sessionState = await this.session.load(sessionId);
    }

    const cached = sessionState?.messages?.length ? sessionState.messages : undefined;
    const derived = cached !== undefined ? sessionState?.derived_upto_seq : undefined;
    // 有缓存且知道派生态 → 只读增量；否则必须全量投影（旧 sqlite 行没有该列）。
    const needFullProjection = cached === undefined || typeof derived !== 'number';

    let events: Awaited<ReturnType<SessionEventLogPort['read']>> = [];
    if (this.eventLog) {
      try {
        await this.eventLog.flush(sessionId);
        events = await this.eventLog.read(
          sessionId,
          needFullProjection ? {} : { sinceSeq: derived },
        );
        // 一致性校验（P2）：checkpoint 游标 / session 派生游标不得超前于日志。
        const lastSeq = await this.eventLog.lastSeq?.(sessionId);
        const checkpointCursor = checkpoint?.event_cursor;
        if (
          typeof checkpointCursor === 'number' &&
          checkpointCursor > 0 &&
          (lastSeq === undefined || lastSeq < checkpointCursor)
        ) {
          this.logger.warn('session event log is behind checkpoint', {
            session_id: sessionId,
            event_cursor: checkpointCursor,
            last_seq: lastSeq,
          });
        }
        if (
          typeof derived === 'number' &&
          derived > 0 &&
          (lastSeq === undefined || lastSeq < derived)
        ) {
          this.logger.warn('session cache is ahead of event log', {
            session_id: sessionId,
            derived_upto_seq: derived,
            last_seq: lastSeq,
          });
        }
      } catch (error) {
        this.logger.warn('session event log read failed during resume', {
          session_id: sessionId,
          error: errorText(error),
        });
      }
    }

    if (cached !== undefined) {
      const history = structuredClone(cached);
      const projected = projectMessages(events);
      if (typeof derived === 'number') {
        // 增量：tail 严格在缓存之后，直接追加；崩溃在工具轮中间时 tool 结果在这里。
        if (projected.length > 0) history.push(...projected);
        return history;
      }
      // 旧数据（无 derived）：全量投影可能与缓存重叠，按尾部重叠去重后追加。
      return projected.length > 0 ? mergeHistoryProjection(history, projected) : history;
    }

    if (events.length > 0) {
      const projected = projectMessages(events);
      if (projected.length > 0) return projected;
    }

    return checkpoint !== undefined && Array.isArray(checkpoint.messages)
      ? checkpoint.messages
      : [];
  }

  /** 0.18：best-effort 索引更新；永不向外抛 */
  private async updateSessionIndexBestEffort(runState: RunState): Promise<void> {
    try {
      await this.updateSessionIndex(runState);
    } catch (error) {
      this.logger.warn('session index update failed', {
        session_id: runState.session_id,
        error: errorText(error),
      });
    }
  }

  /** 0.18：best-effort 更新 `index.json` 元数据（失败只记日志，不影响 run） */
  private async updateSessionIndex(runState: RunState): Promise<void> {
    if (!this.eventLog?.updateIndex) return;
    await this.flushEventLogWrites();
    const cursor = await this.currentEventCursor(runState.session_id);
    let stored: RunState | null = null;
    if (this.session) {
      try {
        stored = await this.session.load(runState.session_id);
      } catch (error) {
        this.logger.warn('session load failed during index update', {
          session_id: runState.session_id,
          error: errorText(error),
        });
      }
    }
    const derived = deriveSessionMeta(runState.messages);
    await this.eventLog.updateIndex(runState.session_id, {
      status: runState.status,
      title: runState.title ?? stored?.title ?? derived.title,
      preview: runState.preview ?? stored?.preview ?? derived.preview,
      started_at: runState.started_at,
      updated_at: runState.completed_at ?? Date.now(),
      ...(cursor !== undefined ? { event_count: cursor, derived_upto_seq: cursor } : {}),
    });
  }

  /** 当前会话已落盘的事件游标（内存优先，否则读文件尾） */
  private async currentEventCursor(sessionId: string): Promise<number | undefined> {
    if (!this.eventLog) return undefined;
    const inMemory = this.eventLog.lastPersistedSeq(sessionId);
    if (inMemory !== undefined) return inMemory;
    try {
      return await this.eventLog.lastSeq?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** 保存 session 快照，并发布 `session.saved` */
  private async saveSession(runState: RunState): Promise<void> {
    if (!this.session) return;
    if (this.eventLog) {
      // 先等待已入队事件落盘，再记录缓存覆盖到的 seq；resume 只重放之后的增量。
      await this.flushEventLogWrites();
      const cursor = await this.currentEventCursor(runState.session_id);
      if (cursor !== undefined) runState.derived_upto_seq = cursor;
    }
    await this.session.save(runState);
    this.publishEvent({
      type: 'session.saved',
      run_id: runState.run_id,
      data: {
        run_id: runState.run_id,
        session_id: runState.session_id,
        status: runState.status,
        message_count: runState.messages.length,
      },
      ts: Date.now(),
    });
  }

  /** 用户显式取消（不是 Host 关闭/中断） */
  private isUserCancelled(signal?: AbortSignal): boolean {
    if (!signal?.aborted) return false;
    const reason = signal.reason;
    return !(typeof reason === 'string' && RUN_INTERRUPT_REASONS.has(reason));
  }

  /** AbortSignal 的 checkpoint 终态：Host 关闭 → interrupted，用户取消 → cancelled */
  private failureCheckpointStatus(signal?: AbortSignal): 'failed' | 'cancelled' | 'interrupted' {
    if (!signal?.aborted) return 'failed';
    const reason = signal.reason;
    return typeof reason === 'string' && RUN_INTERRUPT_REASONS.has(reason)
      ? 'interrupted'
      : 'cancelled';
  }

  /**
   * 发布事件（0.18：先落盘再发布）。
   *
   * - 事实事件：`eventLog.append()` → fsync 成功后才 `events.publish()`；
   * - 派生/观测事件（见 `NON_PERSISTED_EVENT_TYPES`）直接发布；
   * - 落盘失败不阻塞事件发布，但必须经 Logger 报告（每个 run 只报一次）。
   *
   * 由于落盘是异步的，事件会在 microtask/IO 完成后到达订阅者；run 终态
   * 返回前会 `flushEventLogWrites()`，调用方 await run() 后事件历史完整。
   */
  protected publishEvent(event: RunEvent, options?: { persistData?: unknown }): void {
    const stamped =
      this.tenantId !== undefined && event.tenant_id === undefined
        ? { ...event, tenant_id: this.tenantId }
        : event;

    if (
      !this.eventLog ||
      NON_PERSISTED_EVENT_TYPES.has(stamped.type) ||
      !this.shouldPersistSessionEvent(stamped)
    ) {
      this.publishRaw(stamped);
      return;
    }

    this.enqueuePersistedEvent(stamped, true, options?.persistData);
  }

  /** harness / 插件直接发布的事件：只补落盘，不二次发布（避免回环） */
  private persistObservedEvent(event: RunEvent): void {
    if (!this.eventLog || !OBSERVED_PERSISTED_EVENT_TYPES.has(event.type)) return;
    if (!this.shouldPersistSessionEvent(event)) return;
    this.enqueuePersistedEvent(event, false);
  }

  /** 能否确定该事件属于某个 session（不能时就只发布、不落盘） */
  private shouldPersistSessionEvent(event: RunEvent): boolean {
    return this.resolveEventSessionId(event) !== undefined;
  }

  /** session_id 优先取 payload；否则用当前 active run 的 run_id 反查 */
  private resolveEventSessionId(event: RunEvent): string | undefined {
    const data = isRecordValue(event.data) ? event.data : undefined;
    const fromData = data !== undefined ? data.session_id : undefined;
    if (typeof fromData === 'string' && fromData.length > 0) return fromData;
    const active = this.activeRun;
    if (active !== undefined && active.runId === event.run_id) return active.sessionId;
    return undefined;
  }

  /**
   * 入队一次 append +（可选）发布。
   * 所有写入按调用顺序串行（日志内部按 session 排队），publish 在 append
   * 成功/失败后执行，因此对外可见顺序始终与 seq 顺序一致。
   */
  private enqueuePersistedEvent(event: RunEvent, publish: boolean, persistData?: unknown): void {
    const log = this.eventLog;
    if (!log) return;
    const sessionId = this.resolveEventSessionId(event);
    if (sessionId === undefined) {
      if (publish) this.publishRaw(event);
      return;
    }

    const done = log
      .append({
        session_id: sessionId,
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
        data: persistData ?? event.data,
      })
      .then(
        () => {
          if (publish) this.publishRaw(event);
        },
        (error: unknown) => {
          this.reportEventLogFailure(error, event, sessionId);
          if (publish) this.publishRaw(event);
        },
      );
    this.pendingEventLogWrites.add(done);
    void done.then(() => {
      this.pendingEventLogWrites.delete(done);
    });
  }

  /** 落盘失败必须可见：Logger（不落盘事件日志本身，避免递归） */
  private reportEventLogFailure(error: unknown, event: RunEvent, sessionId: string): void {
    this.logger.error('session event log write failed', {
      session_id: sessionId,
      run_id: event.run_id,
      type: event.type,
      error: errorText(error),
    });
    if (this.eventLogFailureReported) return;
    this.eventLogFailureReported = true;
    try {
      this.events.publish({
        type: 'session.log.failed',
        run_id: event.run_id,
        data: {
          session_id: sessionId,
          run_id: event.run_id,
          event_type: event.type,
          error: errorText(error),
        },
        ts: Date.now(),
        ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
      });
    } catch {
      // 事件投递失败不得影响 run
    }
  }

  /** 发布到内存事件流；订阅者异常不得从异步日志回调里冒泡成 unhandled rejection */
  private publishRaw(event: RunEvent): void {
    try {
      this.events.publish(event);
    } catch (error) {
      this.logger.warn('event subscriber failed', {
        run_id: event.run_id,
        type: event.type,
        error: errorText(error),
      });
    }
  }

  /** 等待所有已入队事件落盘并发布 */
  private async flushEventLogWrites(): Promise<void> {
    while (this.pendingEventLogWrites.size > 0) {
      await Promise.allSettled([...this.pendingEventLogWrites]);
    }
  }
}
