/**
 * AgentRuntime 实现
 * @module @vessel/core/runtime
 */

import { randomUUID } from 'node:crypto';
import { MemoryLimitChecker } from '../limits/index.js';
import type { ContextManager } from '../types/context.js';
import type { EventStream, RunEvent } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type { LimitChecker, TerminationPolicy, UsageLimits, UsageStats } from '../types/limits.js';
import type { AgentRuntimeOptions, Plugin, PluginHost } from '../types/plugin.js';
import type { ChatRequest, LLMProvider, Message } from '../types/provider.js';
import type { RunOptions } from '../types/run.js';
import type { RunCheckpoint, RunStore } from '../types/run-store.js';
import { RUN_INTERRUPT_REASONS, RunResumeError } from '../types/run-store.js';
import type { RunState, SessionBackend } from '../types/session.js';

export type { RunOptions } from '../types/run.js';

import type { ToolCall, ToolContext, ToolDefinition } from '../types/tool.js';
import { GuardrailRunner } from './guardrail-runner.js';
import { HookRunner } from './hook-runner.js';
import { PermissionPolicy } from './permission-policy.js';
import { MemoryPluginHost } from './plugin-host.js';

/** 类型守卫：Guardrail replacement 是否是合法的 ToolCall（C-05） */
function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const fn = record.function;
  if (typeof record.id !== 'string' || typeof fn !== 'object' || fn === null) return false;
  const fnRecord = fn as Record<string, unknown>;
  return typeof fnRecord.name === 'string' && typeof fnRecord.arguments === 'string';
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
  private stats: UsageStats;
  private systemPrompt?: string;
  private permissionPolicy: PermissionPolicy;
  private guardrails: GuardrailRunner;
  private hooks: HookRunner;
  /** durable run 检查点（0.3）；缺省不写、零开销 */
  private readonly runStore?: RunStore;
  /** E1：按插件名提供的安装配置 */
  private readonly pluginConfigs?: Record<string, Record<string, unknown>>;
  private readonly agentId?: string;
  /** 0.5：tenant；事件 / RunState / RunCheckpoint 在缺失时补齐 */
  private readonly tenantId?: string;
  /** 同一 run 的并发 resume 锁（进程内；DECISION-008 Addendum A-2） */
  private readonly resuming = new Set<string>();
  /** 当前执行的 checkpoint 元数据（run() 或 resume() 时设置） */
  private runCreatedAt = 0;
  private runBranch?: string;

  private constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.context = opts.context;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.systemPrompt = opts.systemPrompt;
    this.runStore = opts.runStore;
    this.pluginConfigs = opts.pluginConfigs;
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId;
    // 依赖倒置（ADR-033）：LimitChecker / PluginHost 可注入，默认 Memory 实现
    this.limitChecker = opts.limitChecker ?? new MemoryLimitChecker();

    // 初始化使用量统计
    this.stats = {
      requestCount: 0,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };

    // 初始化 PluginHost（唯一工具来源与注册表）——插件在 install() 里 registerTool
    this.pluginHost = opts.pluginHost ?? new MemoryPluginHost();

    // 编排器（ADR-033）：权限策略 / guardrail / hook 各自独立，AgentRuntime 只协调。
    this.permissionPolicy = new PermissionPolicy(this.events, opts.permission, opts.tenantId);
    this.guardrails = new GuardrailRunner(this.pluginHost, this.events, opts.tenantId);
    this.hooks = new HookRunner(this.pluginHost, this.events, opts.tenantId);
  }

  /** 创建并异步初始化 AgentRuntime。用此替代 new AgentRuntime()。 */
  static async create(opts: AgentRuntimeOptions): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(opts);
    await runtime.installPlugins(opts.plugins ?? []);
    return runtime;
  }

  private async installPlugins(plugins: Plugin[]): Promise<void> {
    for (const plugin of plugins) {
      await this.installPlugin(plugin);
    }
  }

  /**
   * 安装插件（fail-fast：安装失败则构造函数失败）
   * @param plugin 插件
   */
  private async installPlugin(plugin: Plugin): Promise<void> {
    try {
      const config = this.pluginConfigs?.[plugin.name];
      const result =
        config === undefined
          ? plugin.install(this.pluginHost)
          : plugin.install(this.pluginHost, { config });
      if (result instanceof Promise) {
        await result; // 如果失败，让 async 构造函数抛出
      }
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
      this.publishEvent({
        type: 'plugin.failed',
        run_id: 'plugin',
        data: {
          name: plugin.name,
          error: error instanceof Error ? error.message : String(error),
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
    const startTime = Date.now();
    const currentSessionId = sessionId || 'default';
    const signal = opts?.signal;
    // checkpoint 元数据：created_at 在 run 内固定，branch 透传
    this.runCreatedAt = startTime;
    this.runBranch = opts?.branch;

    // 重置使用量统计（每次 run 都是新的对话）
    this.stats = {
      requestCount: 0,
      toolCallsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: startTime,
    };

    // 切换到当前会话的 Context
    this.context.setSessionId(currentSessionId);

    // 仅当 context 为空时初始化：
    //   - in-process 同会话续聊：context 已有历史，不重置（多轮记忆）
    //   - cross-process resume / 新进程：context 空，从 SessionBackend 恢复该 session 历史
    //   - 无 backend 或无历史：加 system prompt 起新对话
    // 不再无条件 clear() -- 那会丢多轮历史（debug-notes 当年为修累积 bug 的过度修复）。
    // 只在 context 为空时加载一次，不会累积。
    if (this.context.messages.length === 0) {
      let restored = false;
      if (this.session) {
        const saved = await this.session.load(currentSessionId);
        if (saved?.messages?.length) {
          for (const m of saved.messages) {
            this.addContext(m, runId);
          }
          restored = true;
        }
      }
      if (!restored && this.systemPrompt) {
        this.addContext(
          {
            role: 'system',
            content: this.systemPrompt,
          },
          runId,
        );
      }
    }

    // 准备用户消息
    const userMessage: Message =
      typeof input === 'string' ? { role: 'user', content: input } : input;

    // 创建 Run 状态
    const runState: RunState = {
      run_id: runId,
      session_id: currentSessionId,
      messages: [userMessage],
      started_at: startTime,
      status: 'running',
      branch: opts?.branch,
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };

    // 发布 Run 开始事件
    this.publishEvent({
      type: 'run.started',
      run_id: runId,
      data: { run_id: runId, session_id: currentSessionId, input: userMessage.content },
      ts: Date.now(),
    });

    try {
      // 注入消息（C5）：core 不解释其语义（skill / 附件 / 引用文件……），先于用户输入写入并持久化
      for (const injected of opts?.messages ?? []) {
        this.addContext(injected, runId);
      }

      // 应用输入 Guardrail（先于写上下文：replacement 要成为持久化的用户消息，C-05）
      const inputResult = await this.guardrails.apply(
        userMessage.content,
        GuardrailStage.Input,
        runId,
        currentSessionId,
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

      // 初始状态保存真实上下文（恢复历史 + 注入 + 用户输入），运行中崩溃不再丢历史（C-02）
      runState.messages = this.context.messages;
      await this.saveSession(runState);

      // durable checkpoint：run 开始（用户消息已写入上下文）
      await this.writeCheckpoint(runId, currentSessionId, 'running');

      // 执行 tool-calling loop
      const response = await this.toolCallingLoop(runId, currentSessionId, signal);

      // 更新 Run 状态
      runState.status = 'completed';
      runState.completed_at = Date.now();
      runState.usage = {
        prompt_tokens: this.stats.inputTokens,
        completion_tokens: this.stats.outputTokens,
        total_tokens: this.stats.totalTokens,
        total_cost: this.stats.totalCost,
      };
      runState.messages = this.context.messages;

      // 保存最终状态
      await this.saveSession(runState);

      // durable checkpoint：完成
      await this.writeCheckpoint(runId, currentSessionId, 'completed');

      // 发布 Run 完成事件
      this.publishEvent({
        type: 'run.completed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: currentSessionId,
          output: response,
          usage: runState.usage,
          duration_ms: Date.now() - startTime,
          iterations: this.stats.requestCount,
        },
        ts: Date.now(),
      });

      return response;
    } catch (error) {
      // 用户显式取消 → cancelled；Host 中断/普通错误 → failed（与事件口径一致）
      const cancelled = this.isUserCancelled(signal);
      runState.status = cancelled ? 'cancelled' : 'failed';
      runState.completed_at = Date.now();
      runState.error = error instanceof Error ? error.message : String(error);
      // 失败也保存真实上下文，避免用单条 user 消息覆盖既有历史（C-02）
      runState.messages = this.context.messages;

      // 触发 OnError Hook（LLM 错误、Guardrail 阻断、限制超限、Abort 等）
      await this.hooks.run(HookType.OnError, {
        run_id: runId,
        session_id: currentSessionId,
        error: runState.error,
        phase: 'run',
      });

      // 保存失败状态
      await this.saveSession(runState);

      // durable checkpoint：失败 / 取消 / 中断（best-effort，不覆盖原始错误）
      await this.writeCheckpoint(
        runId,
        currentSessionId,
        this.failureCheckpointStatus(signal),
        runState.error,
        true,
      );

      // 用户显式取消发 run.cancelled；Host 关闭/中断与普通失败保持 run.failed
      this.publishEvent({
        type: cancelled ? 'run.cancelled' : 'run.failed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: currentSessionId,
          error: runState.error,
          duration_ms: Date.now() - startTime,
          ...(cancelled && typeof signal?.reason === 'string' ? { reason: signal.reason } : {}),
        },
        ts: Date.now(),
      });

      throw error;
    }
  }

  /**
   * 从 RunStore 恢复并继续一次 run（0.3 durable）。
   *
   * - 会话历史 / usage / iteration 来自 checkpoint；
   * - 不注入新的用户消息；
   * - run id 保持不变，返回值语义与 run() 一致。
   */
  async resume(runId: string, opts?: RunOptions): Promise<string> {
    const signal = opts?.signal;
    if (!this.runStore) throw new RunResumeError('run_store_required', runId);
    if (this.resuming.has(runId)) throw new RunResumeError('run_already_running', runId);

    this.resuming.add(runId);
    const startTime = Date.now();
    try {
      const checkpoint = await this.runStore.load(runId);
      if (!checkpoint) throw new RunResumeError('run_not_found', runId);
      if (checkpoint.status !== 'running' && checkpoint.status !== 'interrupted') {
        throw new RunResumeError('run_not_resumable', runId, checkpoint.status);
      }
      if (checkpoint.messages.length === 0) {
        throw new RunResumeError('run_not_resumable', runId, 'empty checkpoint');
      }

      const sessionId = checkpoint.session_id;
      this.runCreatedAt = checkpoint.created_at;
      this.runBranch =
        typeof checkpoint.metadata?.branch === 'string' ? checkpoint.metadata.branch : undefined;

      // 恢复统计，保持 limits / termination 连续
      this.stats = {
        requestCount: checkpoint.iteration ?? 0,
        toolCallsCount:
          typeof checkpoint.metadata?.tool_calls_count === 'number'
            ? checkpoint.metadata.tool_calls_count
            : 0,
        inputTokens: checkpoint.usage?.prompt_tokens ?? 0,
        outputTokens: checkpoint.usage?.completion_tokens ?? 0,
        totalTokens: checkpoint.usage?.total_tokens ?? 0,
        totalCost: checkpoint.usage?.total_cost ?? 0,
        startTime,
      };

      // checkpoint 的历史是恢复的唯一权威来源
      this.context.clear();
      this.context.setSessionId(sessionId);
      for (const message of checkpoint.messages) {
        this.addContext(message, runId);
      }

      const runState: RunState = {
        run_id: runId,
        session_id: sessionId,
        messages: this.context.messages,
        started_at: this.runCreatedAt,
        status: 'running',
        ...(this.runBranch !== undefined ? { branch: this.runBranch } : {}),
        ...((this.tenantId ?? checkpoint.tenant_id) !== undefined
          ? { tenant_id: this.tenantId ?? checkpoint.tenant_id }
          : {}),
      };
      await this.saveSession(runState);

      // 标记已被接管（唯一写者：AgentRuntime）
      await this.writeCheckpoint(runId, sessionId, 'running');

      this.publishEvent({
        type: 'run.resumed',
        run_id: runId,
        data: {
          run_id: runId,
          session_id: sessionId,
          from_status: checkpoint.status,
          iteration: this.stats.requestCount,
        },
        ts: Date.now(),
      });

      try {
        const response = await this.toolCallingLoop(runId, sessionId, signal);

        runState.status = 'completed';
        runState.completed_at = Date.now();
        runState.usage = {
          prompt_tokens: this.stats.inputTokens,
          completion_tokens: this.stats.outputTokens,
          total_tokens: this.stats.totalTokens,
          total_cost: this.stats.totalCost,
        };
        runState.messages = this.context.messages;
        await this.saveSession(runState);
        await this.writeCheckpoint(runId, sessionId, 'completed');

        this.publishEvent({
          type: 'run.completed',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            output: response,
            usage: runState.usage,
            duration_ms: Date.now() - startTime,
            iterations: this.stats.requestCount,
          },
          ts: Date.now(),
        });

        return response;
      } catch (error) {
        runState.status = 'failed';
        runState.completed_at = Date.now();
        runState.error = error instanceof Error ? error.message : String(error);
        runState.messages = this.context.messages;

        await this.hooks.run(HookType.OnError, {
          run_id: runId,
          session_id: sessionId,
          error: runState.error,
          phase: 'run',
        });

        await this.saveSession(runState);
        await this.writeCheckpoint(
          runId,
          sessionId,
          this.failureCheckpointStatus(signal),
          runState.error,
          true,
        );

        this.publishEvent({
          type: 'run.failed',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: sessionId,
            error: runState.error,
            duration_ms: Date.now() - startTime,
          },
          ts: Date.now(),
        });

        throw error;
      }
    } finally {
      this.resuming.delete(runId);
    }
  }

  /**
   * Tool-calling loop
   * 核心循环：调用 LLM -> 解析 tool_calls -> 执行工具 -> 注入结果 -> 循环
   * @param runId Run ID
   * @param sessionId 会话 ID
   * @param signal 可选的 AbortSignal（Hermes/Claude Code 模式——Esc 中断）
   */
  protected async toolCallingLoop(
    runId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    while (true) {
      // AbortSignal 中断（Hermes/Claude Code 模式——外部 Esc）
      if (signal?.aborted) {
        throw new Error(signal.reason ?? 'Run cancelled');
      }

      // 检查终止条件
      if (this.limitChecker.checkTermination(this.stats, this.termination)) {
        throw new Error('Termination policy triggered: max iterations or runtime exceeded');
      }

      // 检查使用量限制（含 request_limit、tool_calls_limit、token/cost 预算）——硬上限
      if (!this.limitChecker.checkLimits(this.stats, this.limits)) {
        throw new Error('Usage limits exceeded');
      }

      // 0.6.1 E3：按阈值触发真实摘要压缩（旧 ContextManager 无此方法则跳过）。
      // 必须在组装请求前完成，保证本轮请求看到压缩后的历史。
      await this.context.autoCompactAsync?.();

      // 执行 BeforeLlm 钩子（hook 可往 ctx.systemPrompt 注入内容：skills / memory）
      // 用 this.systemPrompt 作基底，hook 链 prepend 注入
      const hookCtx: HookContext = { run_id: runId, session_id: sessionId };
      if (this.systemPrompt) {
        hookCtx.systemPrompt = this.systemPrompt;
      }
      await this.hooks.run(HookType.BeforeLlm, hookCtx);

      // 组装本次请求的消息（持久化上下文 + BeforeLlm 注入的 system prompt）
      const messages = this.buildRequestMessages(hookCtx.systemPrompt);

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

      // 调试日志（仅在 VESSEL_DEBUG 环境变量设置时输出）
      if (process.env.VESSEL_DEBUG) {
        console.log(
          '[Debug] Tools:',
          toolSchemas.length,
          toolSchemas.map((t) => t.function.name),
        );
      }

      // 发布 LLM 请求事件（事件里剔除 reasoning_content，避免思维链泄漏到 TUI/观测）
      this.publishEvent({
        type: 'llm.request',
        run_id: runId,
        data: {
          run_id: runId,
          messages: this.stripReasoning(messages),
          tools: toolSchemas,
        },
        ts: Date.now(),
      });

      // 增加请求计数
      this.limitChecker.incrementRequest(this.stats);

      // 调用 LLM
      const request: ChatRequest = {
        messages,
        model: this.model,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        session_id: sessionId,
        // AbortSignal——Provider 透传给 fetch()，支持 Esc 中断（Hermes/Claude Code 模式）
        signal,
        // 流式（ADR-007）：始终提供 stream + on_chunk。支持流式的 Provider 边收边经回调吐增量，
        // loop 在此发布 LlmStreamChunk 事件供 TUI 订阅渲染；不支持流式的 Provider 忽略字段、
        // 退化为整段返回（无 chunk 事件，无副作用）。chat() 仍返回完整 LLMResponse。
        stream: true,
        on_chunk: (chunk) => {
          this.publishEvent({
            type: 'llm.stream.chunk',
            run_id: runId,
            data: { run_id: runId, chunk },
            ts: Date.now(),
          });
        },
      };

      // 调试日志（仅在 VESSEL_DEBUG 环境变量设置时输出）
      if (process.env.VESSEL_DEBUG) {
        console.log('[Debug] Messages sent to AI:');
        for (const msg of messages) {
          console.log(`  [${msg.role}]: ${msg.content?.substring(0, 100)}...`);
        }
      }

      const response = await this.provider.chat(request);

      // 更新 token 使用量
      if (response.usage) {
        this.limitChecker.addTokens(
          this.stats,
          response.usage.prompt_tokens ?? 0,
          response.usage.completion_tokens ?? 0,
        );
        // Auto Compact：用**本次请求**的真实 token 数替代字符估算。
        // 不能用累计 stats.totalTokens——多轮会线性放大，第二轮就误触发 compact（C-04）。
        this.context.updateRealTokens(
          (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
        );
      }

      // 发布 LLM 响应事件
      this.publishEvent({
        type: 'llm.response',
        run_id: runId,
        data: {
          run_id: runId,
          content: response.content,
          tool_calls: response.tool_calls,
          finish_reason: response.finish_reason,
          usage: response.usage,
        },
        ts: Date.now(),
      });

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
          this.limitChecker.incrementToolCall(this.stats);
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

          // BeforeTool 钩子逐调用串行执行，避免并行批次共享 hookCtx 的竞态
          for (const entry of batch) {
            if (entry.failureMessage !== undefined) continue;
            await this.hooks.run(HookType.BeforeTool, hookCtx);
          }

          const outcomes = await Promise.all(
            batch.map((entry) => this.runToolCall(entry, runId, sessionId, signal)),
          );

          // 上下文严格按原调用顺序写回（并行完成顺序不影响历史顺序）
          for (const outcome of outcomes) {
            if (outcome.ok) {
              // 执行 AfterTool 钩子
              await this.hooks.run(HookType.AfterTool, hookCtx);
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
        await this.writeCheckpoint(runId, sessionId, 'running');
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
   * 释放资源（关闭连接、保存状态等）
   */
  dispose(): void {
    this.session?.close?.();
  }

  /**
   * 记录一次工具失败：OnError hook → tool.call.failed 事件 → 返回错误文本（C-01）。
   * 错误文本由调用方按原顺序折回上下文；工具失败不终止 run，模型可自行纠错。
   */
  private async recordToolFailure(opts: {
    runId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    startTime: number;
    errorMessage: string;
  }): Promise<string> {
    await this.hooks.run(HookType.OnError, {
      run_id: opts.runId,
      session_id: opts.sessionId,
      error: opts.errorMessage,
      phase: 'tool_execution',
      tool_name: opts.toolName,
    });
    this.publishEvent({
      type: 'tool.call.failed',
      run_id: opts.runId,
      data: {
        run_id: opts.runId,
        tool_call_id: opts.toolCallId,
        tool_name: opts.toolName,
        error: opts.errorMessage,
        duration_ms: Date.now() - opts.startTime,
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
    runId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const { toolCall, toolName } = entry;

    if (entry.failureMessage !== undefined) {
      return {
        toolCall,
        ok: false,
        content: await this.recordToolFailure({
          runId,
          sessionId,
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: entry.failureMessage,
        }),
      };
    }

    try {
      // 统一工具调用：只从 PluginHost 查找
      const pluginTool = this.pluginHost.getTool(toolName);
      if (!pluginTool) {
        throw new Error(`Tool "${toolName}" not found`);
      }

      const toolCtx: ToolContext = {
        run_id: runId,
        session_id: sessionId,
        messages: this.context.messages,
        events: this.events,
        // F10：把当前 run 的 signal 交给工具，便于 handler 响应取消
        ...(signal ? { signal } : {}),
      };

      // 权限判定（ADR-026/029，逻辑在 PermissionPolicy，ADR-033）
      await this.permissionPolicy.authorize(pluginTool, entry.args, toolCtx);

      const result = await this.invokeTool(pluginTool, entry.args, toolCtx);

      // 应用工具结果 Guardrail（replacement 可改写结果，C-05）
      const toolResultResult = await this.guardrails.apply(
        result,
        GuardrailStage.ToolResult,
        runId,
        sessionId,
      );
      if (!toolResultResult.allowed) {
        // 0.6.1 P1：结果阻断折回 tool 错误，不终止 run。
        return {
          toolCall,
          ok: false,
          content: await this.recordToolFailure({
            runId,
            sessionId,
            toolCallId: toolCall.id,
            toolName,
            startTime: entry.startedAt,
            errorMessage: `Tool result blocked by guardrail: ${
              toolResultResult.reason ?? 'blocked'
            }`,
          }),
        };
      }
      const finalResult =
        typeof toolResultResult.replacement === 'string' ? toolResultResult.replacement : result;

      // 发布工具调用完成事件
      this.publishEvent({
        type: 'tool.call.completed',
        run_id: runId,
        data: {
          run_id: runId,
          tool_call_id: toolCall.id,
          tool_name: toolName,
          result: finalResult,
          duration_ms: Date.now() - entry.startedAt,
        },
        ts: Date.now(),
      });

      return { toolCall, ok: true, content: finalResult };
    } catch (error) {
      return {
        toolCall,
        ok: false,
        content: await this.recordToolFailure({
          runId,
          sessionId,
          toolCallId: toolCall.id,
          toolName,
          startTime: entry.startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  /**
   * 调用工具并应用超时。
   * ADR-017(2b)：loop 必须经统一入口执行工具并套 timeout——此前 loop 直调 handler，
   * `ToolDefinition.timeout` 从未在真实执行路径生效。
   */
  private async invokeTool(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<string> {
    if (!tool.timeout || tool.timeout <= 0) {
      return tool.handler(args, ctx);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tool "${tool.name}" timed out after ${tool.timeout}ms`)),
        tool.timeout,
      );
    });
    try {
      return await Promise.race([tool.handler(args, ctx), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
    const hasSystem = messages.some((m) => m.role === 'system');

    // 上下文缺 system（trim / 恢复 / 失败会话）时，补回基底的或 hook 改写后的 system
    if (!hasSystem) {
      return systemOverride ? [{ role: 'system', content: systemOverride }, ...messages] : messages;
    }
    // hook 未改写（或改写为空）时保持持久化 system 原样
    if (!systemOverride || systemOverride === this.systemPrompt) {
      return messages;
    }
    return messages.map((m) => (m.role === 'system' ? { ...m, content: systemOverride } : m));
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
    this.context.add(msg);
    this.publishEvent({
      type: 'context.changed',
      run_id: runId,
      data: {
        run_id: runId,
        // 持久化保留 reasoning_content；事件里剔除，避免思维链泄漏到 TUI/观测
        message: this.stripReasoningFromMessage(msg),
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
    runId: string,
    sessionId: string,
    status: RunCheckpoint['status'],
    error?: string,
    bestEffort = false,
  ): Promise<void> {
    if (!this.runStore) return;

    const checkpoint: RunCheckpoint = {
      run_id: runId,
      session_id: sessionId,
      status,
      messages: structuredClone(this.context.messages),
      usage: {
        prompt_tokens: this.stats.inputTokens,
        completion_tokens: this.stats.outputTokens,
        total_tokens: this.stats.totalTokens,
        total_cost: this.stats.totalCost,
      },
      iteration: this.stats.requestCount,
      created_at: this.runCreatedAt || Date.now(),
      updated_at: Date.now(),
      metadata: {
        tool_calls_count: this.stats.toolCallsCount,
        ...(this.runBranch !== undefined ? { branch: this.runBranch } : {}),
      },
      ...(this.agentId !== undefined ? { agent_id: this.agentId } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    };

    try {
      await this.runStore.save(checkpoint);
    } catch (saveError) {
      if (bestEffort) return;
      const detail = saveError instanceof Error ? saveError.message : String(saveError);
      throw new Error(`run_checkpoint_failed: ${detail}`);
    }

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

  /** 保存 session 快照，并发布 `session.saved` */
  private async saveSession(runState: RunState): Promise<void> {
    if (!this.session) return;
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
   * 发布事件
   * @param event 运行事件
   */
  protected publishEvent(event: RunEvent): void {
    const stamped =
      this.tenantId !== undefined && event.tenant_id === undefined
        ? { ...event, tenant_id: this.tenantId }
        : event;
    this.events.publish(stamped);
  }
}
