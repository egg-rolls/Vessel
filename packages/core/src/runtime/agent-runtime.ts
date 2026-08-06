/**
 * AgentRuntime 实现
 * @module @vessel/core/runtime
 */

import { randomUUID } from 'node:crypto';
import { MemoryLimitChecker } from '../limits/limit-checker.js';
import type { ContextManager } from '../types/context.js';
import type { EventStream, RunEvent } from '../types/event.js';
import { EventType } from '../types/event.js';
import { type GuardrailContext, GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type { TerminationPolicy, UsageLimits, UsageStats } from '../types/limits.js';
import type { AgentRuntimeOptions, Plugin, PluginHost } from '../types/plugin.js';
import type { ChatRequest, LLMProvider, Message } from '../types/provider.js';
import type { RunState, SessionBackend } from '../types/session.js';
import type { ToolRegistry } from '../types/tool.js';
import { MemoryPluginHost } from './plugin-host.js';

/** Run 选项 */
export interface RunOptions {
  /** AbortSignal——设置后可在外部中断 run()（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /** 当前 git branch——app 层采集，core 透传存入 RunState.branch */
  branch?: string;
}

/**
 * Agent Runtime
 * 核心运行时，实现 tool-calling loop
 */
export class AgentRuntime {
  private provider: LLMProvider;
  private model: string;
  private tools: ToolRegistry;
  private context: ContextManager;
  private events: EventStream;
  private limits: UsageLimits;
  private termination: TerminationPolicy;
  private session?: SessionBackend;
  private pluginHost: PluginHost;
  private limitChecker: MemoryLimitChecker;
  private stats: UsageStats;
  private systemPrompt?: string;

  private constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = opts.tools;
    this.context = opts.context;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.systemPrompt = opts.systemPrompt;
    this.limitChecker = new MemoryLimitChecker();

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

    // 初始化 PluginHost，并将直接注册的工具同步到 PluginHost（统一入口）
    this.pluginHost = new MemoryPluginHost();
    for (const tool of this.tools.list()) {
      try {
        this.pluginHost.registerTool(tool);
      } catch {
        // 工具名冲突，跳过（插件工具优先已注册的情况下保留直接工具）
      }
    }
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
    const result = plugin.install(this.pluginHost);
    if (result instanceof Promise) {
      await result; // 如果失败，让 async 构造函数抛出
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
    const runId = randomUUID();
    const startTime = Date.now();
    const currentSessionId = sessionId || 'default';
    const signal = opts?.signal;

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
            this.context.add(m);
          }
          restored = true;
        }
      }
      if (!restored && this.systemPrompt) {
        this.context.add({
          role: 'system',
          content: this.systemPrompt,
        });
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
    };

    // 发布 Run 开始事件
    this.publishEvent({
      type: EventType.RunStarted,
      run_id: runId,
      data: { run_id: runId, session_id: currentSessionId, input: userMessage.content },
      ts: Date.now(),
    });

    // 保存初始状态
    if (this.session) {
      await this.session.save(runState);
    }

    try {
      // 添加用户消息到上下文
      this.context.add(userMessage);

      // 应用输入 Guardrail
      const inputResult = await this.applyGuardrails(
        userMessage.content,
        GuardrailStage.Input,
        runId,
        currentSessionId,
      );
      if (!inputResult.allowed) {
        throw new Error(`Input blocked by guardrail: ${inputResult.reason}`);
      }

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
      if (this.session) {
        await this.session.save(runState);
      }

      // 发布 Run 完成事件
      this.publishEvent({
        type: EventType.RunCompleted,
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
      // 更新 Run 状态为失败
      runState.status = 'failed';
      runState.completed_at = Date.now();
      runState.error = error instanceof Error ? error.message : String(error);

      // 触发 OnError Hook（LLM 错误、Guardrail 阻断、限制超限、Abort 等）
      await this.runHooks(HookType.OnError, {
        run_id: runId,
        session_id: currentSessionId,
        error: runState.error,
        phase: 'run',
      });

      // 保存失败状态
      if (this.session) {
        await this.session.save(runState);
      }

      // 发布 Run 失败事件
      this.publishEvent({
        type: EventType.RunFailed,
        run_id: runId,
        data: {
          run_id: runId,
          session_id: currentSessionId,
          error: runState.error,
          duration_ms: Date.now() - startTime,
        },
        ts: Date.now(),
      });

      throw error;
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

      // 执行 BeforeLlm 钩子（hook 可往 ctx.system_prompt 注入内容：skills / memory）
      // 用 this.systemPrompt 种子化，hook 链 prepend 注入；之后把结果作为本次请求的 system 消息
      const hookCtx: HookContext = { run_id: runId, session_id: sessionId };
      if (this.systemPrompt) {
        hookCtx.system_prompt = this.systemPrompt;
      }
      await this.runHooks(HookType.BeforeLlm, hookCtx);
      const injectedSystem: string | undefined =
        typeof hookCtx.system_prompt === 'string' ? hookCtx.system_prompt : undefined;

      // 发布 LLM 请求事件
      // 应用 BeforeLlm 注入的 system prompt（仅影响本次请求，不改动 ContextManager 持久化的消息）
      let messages = this.context.messages;
      if (injectedSystem && injectedSystem !== this.systemPrompt) {
        const hasSystem = messages.some((m) => m.role === 'system');
        messages = messages.map((m) =>
          m.role === 'system' ? { ...m, content: injectedSystem } : m,
        );
        if (!hasSystem) {
          const systemMsg: Message = { role: 'system', content: injectedSystem };
          messages = [systemMsg, ...messages];
        }
      }

      // 统一工具来源：PluginHost（直接注册的工具已在构造时同步进去）
      // SPEC §4.2: default !== false 的工具自动列出；default: false 通过 search_assets 发现
      const allTools = this.pluginHost.listTools();
      const visibleTools = allTools.filter((t) => t.default !== false);
      const toolSchemas = visibleTools.map((tool) => ({
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
          '[Debug] Visible tools:',
          toolSchemas.length,
          '/',
          allTools.length,
          toolSchemas.map((t) => t.function.name),
        );
      }

      this.publishEvent({
        type: EventType.LlmRequest,
        run_id: runId,
        data: { run_id: runId, messages, tools: toolSchemas },
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
            type: EventType.LlmStreamChunk,
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
        // Auto Compact：用 LLM 真实 token 数替代字符估算
        this.context.updateRealTokens(this.stats.totalTokens);
      }

      // 发布 LLM 响应事件
      this.publishEvent({
        type: EventType.LlmResponse,
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
      await this.runHooks(HookType.AfterLlm, hookCtx);

      // 检查完成原因
      if (response.finish_reason === 'stop') {
        // 应用输出 Guardrail
        const outputResult = await this.applyGuardrails(
          response.content,
          GuardrailStage.Output,
          runId,
          sessionId,
        );
        if (!outputResult.allowed) {
          throw new Error(`Output blocked by guardrail: ${outputResult.reason}`);
        }

        // 添加助手消息到上下文
        this.context.add({
          role: 'assistant',
          content: response.content,
        });

        return response.content;
      }

      if (response.finish_reason === 'tool_calls' && response.tool_calls) {
        // 添加助手消息（包含 tool_calls）到上下文
        this.context.add({
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: response.tool_calls,
        });

        // 执行每个工具调用
        for (const toolCall of response.tool_calls) {
          // 增加工具调用计数
          this.limitChecker.incrementToolCall(this.stats);

          // 应用工具调用 Guardrail
          const toolCallResult = await this.applyGuardrails(
            toolCall,
            GuardrailStage.ToolCall,
            runId,
            sessionId,
          );
          if (!toolCallResult.allowed) {
            throw new Error(`Tool call blocked by guardrail: ${toolCallResult.reason}`);
          }

          // 发布工具调用开始事件
          const toolStartTime = Date.now();
          this.publishEvent({
            type: EventType.ToolCallStarted,
            run_id: runId,
            data: {
              run_id: runId,
              tool_call_id: toolCall.id,
              tool_name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments),
            },
            ts: Date.now(),
          });

          // 执行 BeforeTool 钩子
          await this.runHooks(HookType.BeforeTool, hookCtx);

          try {
            // 统一工具调用：只从 PluginHost 查找
            const toolName = toolCall.function.name;
            const pluginTool = this.pluginHost.getTool(toolName);

            if (!pluginTool) {
              throw new Error(`Tool "${toolName}" not found`);
            }

            let args: unknown;
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch {
              args = {};
            }

            const result = await pluginTool.handler(args, {
              run_id: runId,
              session_id: sessionId,
              messages: this.context.messages,
            });

            // 应用工具结果 Guardrail
            const toolResultResult = await this.applyGuardrails(
              result,
              GuardrailStage.ToolResult,
              runId,
              sessionId,
            );
            if (!toolResultResult.allowed) {
              throw new Error(`Tool result blocked by guardrail: ${toolResultResult.reason}`);
            }

            // 发布工具调用完成事件
            this.publishEvent({
              type: EventType.ToolCallCompleted,
              run_id: runId,
              data: {
                run_id: runId,
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,
                result,
                duration_ms: Date.now() - toolStartTime,
              },
              ts: Date.now(),
            });

            // 执行 AfterTool 钩子
            await this.runHooks(HookType.AfterTool, hookCtx);

            // 添加工具结果到上下文（标准 role: tool 消息）
            this.context.add({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
            // 注：不再注入假 assistant 消息（见 ADR-005 / Phase 1 review #3）
            // Provider 负责正确解释 role: tool 消息
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // 触发 OnError Hook（工具执行失败）
            await this.runHooks(HookType.OnError, {
              run_id: runId,
              session_id: sessionId,
              error: errorMessage,
              phase: 'tool_execution',
              tool_name: toolCall.function.name,
            });

            // 发布工具调用失败事件
            this.publishEvent({
              type: EventType.ToolCallFailed,
              run_id: runId,
              data: {
                run_id: runId,
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,
                error: errorMessage,
                duration_ms: Date.now() - toolStartTime,
              },
              ts: Date.now(),
            });

            // 添加错误结果到上下文
            this.context.add({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${errorMessage}`,
            });
          }
        }
      } else {
        // 其他完成原因（如 length），直接返回当前内容
        this.context.add({
          role: 'assistant',
          content: response.content,
        });
        return response.content;
      }
    }
  }

  /**
   * 应用 Guardrails
   * @param value 要检查的值
   * @param stage Guardrail 阶段
   * @param run_id Run ID
   * @param session_id 会话 ID
   * @returns Guardrail 结果
   */
  protected async applyGuardrails(
    value: unknown,
    stage: GuardrailStage,
    runId: string,
    sessionId?: string,
  ): Promise<{ allowed: boolean; replacement?: unknown; reason?: string }> {
    const guardrails = this.pluginHost.getGuardrails().filter((g) => g.stage === stage);
    const ctx: GuardrailContext = { run_id: runId, session_id: sessionId, stage };

    let currentValue = value;

    for (const guardrail of guardrails) {
      const result = await guardrail.check(currentValue, ctx);
      if (!result.allowed) {
        this.publishEvent({
          type: EventType.GuardrailBlocked,
          run_id: runId,
          data: {
            run_id: runId,
            guardrail_name: guardrail.name,
            stage,
            reason: result.reason ?? 'blocked',
          },
          ts: Date.now(),
        });
        return {
          allowed: false,
          replacement: currentValue,
          reason: result.reason,
        };
      }
      if (result.replacement !== undefined) {
        currentValue = result.replacement;
      }
    }

    return { allowed: true, replacement: currentValue };
  }

  /**
   * 释放资源（关闭连接、保存状态等）
   */
  dispose(): void {
    this.session?.close?.();
  }

  /**
   * 运行 Hooks
   * @param type Hook 类型
   * @param ctx Hook 上下文
   */
  protected async runHooks(type: HookType, ctx: HookContext): Promise<void> {
    const hooks = this.pluginHost.getHooks().filter((h) => h.type === type);
    for (const hook of hooks) {
      await hook.run(ctx);
    }
  }

  /**
   * 发布事件
   * @param event 运行事件
   */
  protected publishEvent(event: RunEvent): void {
    this.events.publish(event);
  }
}
