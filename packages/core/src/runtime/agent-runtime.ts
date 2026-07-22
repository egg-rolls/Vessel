/**
 * AgentRuntime 实现
 * @module @vessel/core/runtime
 */

import { randomUUID } from 'node:crypto';
import type { LLMProvider, Message, ChatRequest } from '../types/provider.js';
import type { ToolRegistry } from '../types/tool.js';
import type { ContextManager } from '../types/context.js';
import type { EventStream, RunEvent } from '../types/event.js';
import { EventType } from '../types/event.js';
import type { UsageLimits, TerminationPolicy, UsageStats } from '../types/limits.js';
import type { SessionBackend, RunState } from '../types/session.js';
import type { Plugin, PluginHost, AgentRuntimeOptions } from '../types/plugin.js';
import type { Guardrail, GuardrailContext, GuardrailStage } from '../types/guardrail.js';
import type { Hook, HookType, HookContext } from '../types/hook.js';
import { MemoryPluginHost } from './plugin-host.js';
import { MemoryLimitChecker } from '../limits/limit-checker.js';
import { MemoryContextManager } from '../context/context-manager.js';

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

  constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = opts.tools;
    this.context = opts.context;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.limitChecker = new MemoryLimitChecker();

    // 初始化使用量统计
    this.stats = {
      request_count: 0,
      tool_calls_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      start_time: Date.now(),
    };

    // 初始化 PluginHost
    this.pluginHost = new MemoryPluginHost();

    // 安装插件
    if (opts.plugins) {
      for (const plugin of opts.plugins) {
        this.installPlugin(plugin);
      }
    }
  }

  /**
   * 安装插件
   * @param plugin 插件
   */
  private installPlugin(plugin: Plugin): void {
    const result = plugin.install(this.pluginHost);
    if (result instanceof Promise) {
      result.catch((err) => {
        console.error(`Failed to install plugin "${plugin.name}": ${err}`);
      });
    }
  }

  /**
   * 执行一次 run
   * @param input 用户输入
   * @param session_id 可选的会话 ID
   * @returns 最终响应文本
   */
  async run(input: string | Message, session_id?: string): Promise<string> {
    const run_id = randomUUID();
    const startTime = Date.now();
    const currentSessionId = session_id || 'default';

    // 重置使用量统计（每次 run 都是新的对话）
    this.stats = {
      request_count: 0,
      tool_calls_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      start_time: startTime,
    };

    // 切换到当前会话的 Context（而不是清空）
    if (this.context instanceof MemoryContextManager) {
      this.context.setSessionId(currentSessionId);
      
      // 从数据库加载之前的消息到 Context
      if (this.session) {
        const saved = await this.session.load(currentSessionId);
        if (saved && saved.messages.length > 0) {
          // 清空当前 Context，然后加载数据库中的消息
          this.context.clear();
          for (const msg of saved.messages) {
            this.context.add(msg);
          }
        }
      }
    }

    // 准备用户消息
    const userMessage: Message = typeof input === 'string'
      ? { role: 'user', content: input }
      : input;

    // 创建 Run 状态
    const runState: RunState = {
      run_id,
      session_id: currentSessionId,
      messages: [userMessage],
      started_at: startTime,
      status: 'running',
    };

    // 发布 Run 开始事件
    this.publishEvent({
      type: EventType.RunStarted,
      run_id,
      data: { run_id, session_id: currentSessionId, input: userMessage.content },
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
        'input',
        run_id,
        currentSessionId
      );
      if (!inputResult.allowed) {
        throw new Error(`Input blocked by guardrail: ${inputResult.reason}`);
      }

      // 执行 tool-calling loop
      const response = await this.toolCallingLoop(run_id, currentSessionId);

      // 更新 Run 状态
      runState.status = 'completed';
      runState.completed_at = Date.now();
      runState.usage = {
        prompt_tokens: this.stats.input_tokens,
        completion_tokens: this.stats.output_tokens,
        total_tokens: this.stats.total_tokens,
        total_cost: this.stats.total_cost,
      };
      runState.messages = this.context.messages;

      // 保存最终状态
      if (this.session) {
        await this.session.save(runState);
      }

      // 发布 Run 完成事件
      this.publishEvent({
        type: EventType.RunCompleted,
        run_id,
        data: {
          run_id,
          session_id: currentSessionId,
          output: response,
          usage: runState.usage,
          duration_ms: Date.now() - startTime,
          iterations: this.stats.request_count,
        },
        ts: Date.now(),
      });

      return response;
    } catch (error) {
      // 更新 Run 状态为失败
      runState.status = 'failed';
      runState.completed_at = Date.now();
      runState.error = error instanceof Error ? error.message : String(error);

      // 保存失败状态
      if (this.session) {
        await this.session.save(runState);
      }

      // 发布 Run 失败事件
      this.publishEvent({
        type: EventType.RunFailed,
        run_id,
        data: {
          run_id,
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
   */
  private async toolCallingLoop(
    run_id: string,
    session_id: string
  ): Promise<string> {
    while (true) {
      // 检查终止条件
      if (this.limitChecker.checkTermination(this.stats, this.termination)) {
        throw new Error('Termination policy triggered: max iterations or runtime exceeded');
      }

      // 检查使用量限制
      if (!this.limitChecker.checkLimits(this.stats, this.limits)) {
        throw new Error('Usage limits exceeded');
      }

      // 执行 BeforeLlm 钩子
      const hookCtx: HookContext = { run_id, session_id };
      await this.runHooks('before_llm', hookCtx);

      // 发布 LLM 请求事件
      const messages = this.context.messages;
      const toolSchemas = this.tools.schemas();
      this.publishEvent({
        type: EventType.LlmRequest,
        run_id,
        data: { run_id, messages, tools: toolSchemas },
        ts: Date.now(),
      });

      // 增加请求计数
      this.limitChecker.incrementRequest(this.stats);

      // 调用 LLM
      const request: ChatRequest = {
        messages,
        model: this.model,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        session_id: session_id,  // 传递 session_id 给 Provider
      };

      const response = await this.provider.chat(request);

      // 更新 token 使用量
      if (response.usage) {
        this.limitChecker.addTokens(
          this.stats,
          response.usage.prompt_tokens ?? 0,
          response.usage.completion_tokens ?? 0
        );
      }

      // 发布 LLM 响应事件
      this.publishEvent({
        type: EventType.LlmResponse,
        run_id,
        data: {
          run_id,
          content: response.content,
          tool_calls: response.tool_calls,
          finish_reason: response.finish_reason,
          usage: response.usage,
        },
        ts: Date.now(),
      });

      // 执行 AfterLlm 钩子
      await this.runHooks('after_llm', hookCtx);

      // 检查完成原因
      if (response.finish_reason === 'stop') {
        // 应用输出 Guardrail
        const outputResult = await this.applyGuardrails(
          response.content,
          'output',
          run_id,
          session_id
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
            'tool_call',
            run_id,
            session_id
          );
          if (!toolCallResult.allowed) {
            throw new Error(`Tool call blocked by guardrail: ${toolCallResult.reason}`);
          }

          // 发布工具调用开始事件
          const toolStartTime = Date.now();
          this.publishEvent({
            type: EventType.ToolCallStarted,
            run_id,
            data: {
              run_id,
              tool_call_id: toolCall.id,
              tool_name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments),
            },
            ts: Date.now(),
          });

          // 执行 BeforeTool 钩子
          await this.runHooks('before_tool', hookCtx);

          try {
            // 调用工具
            const result = await this.tools.invoke(toolCall, {
              run_id,
              session_id,
              messages: this.context.messages,
            });

            // 应用工具结果 Guardrail
            const toolResultResult = await this.applyGuardrails(
              result,
              'tool_result',
              run_id,
              session_id
            );
            if (!toolResultResult.allowed) {
              throw new Error(`Tool result blocked by guardrail: ${toolResultResult.reason}`);
            }

            // 发布工具调用完成事件
            this.publishEvent({
              type: EventType.ToolCallCompleted,
              run_id,
              data: {
                run_id,
                tool_call_id: toolCall.id,
                tool_name: toolCall.function.name,
                result,
                duration_ms: Date.now() - toolStartTime,
              },
              ts: Date.now(),
            });

            // 执行 AfterTool 钩子
            await this.runHooks('after_tool', hookCtx);

            // 添加工具结果到上下文
            this.context.add({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // 发布工具调用失败事件
            this.publishEvent({
              type: EventType.ToolCallFailed,
              run_id,
              data: {
                run_id,
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
  private async applyGuardrails(
    value: unknown,
    stage: GuardrailStage,
    run_id: string,
    session_id?: string
  ): Promise<{ allowed: boolean; replacement?: unknown; reason?: string }> {
    const guardrails = this.pluginHost.getGuardrails().filter((g) => g.stage === stage);
    const ctx: GuardrailContext = { run_id, session_id, stage };

    let currentValue = value;
    let allowed = true;
    let reason: string | undefined;

    for (const guardrail of guardrails) {
      const result = await guardrail.check(currentValue, ctx);
      if (!result.allowed) {
        allowed = false;
        reason = result.reason;
        break;
      }
      if (result.replacement !== undefined) {
        currentValue = result.replacement;
      }
    }

    if (!allowed) {
      this.publishEvent({
        type: EventType.GuardrailBlocked,
        run_id,
        data: { run_id, guardrail_name: 'unknown', stage, reason: reason ?? 'blocked' },
        ts: Date.now(),
      });
    }

    return { allowed, replacement: currentValue, reason };
  }

  /**
   * 运行 Hooks
   * @param type Hook 类型
   * @param ctx Hook 上下文
   */
  private async runHooks(type: HookType, ctx: HookContext): Promise<void> {
    const hooks = this.pluginHost.getHooks().filter((h) => h.type === type);
    for (const hook of hooks) {
      await hook.run(ctx);
    }
  }

  /**
   * 发布事件
   * @param event 运行事件
   */
  private publishEvent(event: RunEvent): void {
    this.events.publish(event);
  }
}
