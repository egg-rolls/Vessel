/**
 * AgentRuntime 实现
 * @module @vessel/core/runtime
 */

import { randomUUID } from 'node:crypto';
import { MemoryLimitChecker } from '../limits/limit-checker.js';
import type { ContextManager } from '../types/context.js';
import type { EventStream, RunEvent } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type { LimitChecker, TerminationPolicy, UsageLimits, UsageStats } from '../types/limits.js';
import type { AgentRuntimeOptions, Plugin, PluginHost } from '../types/plugin.js';
import type { ChatRequest, LLMProvider, Message } from '../types/provider.js';
import type { RunState, SessionBackend } from '../types/session.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';
import { GuardrailRunner } from './guardrail-runner.js';
import { HookRunner } from './hook-runner.js';
import { PermissionPolicy } from './permission-policy.js';
import { MemoryPluginHost } from './plugin-host.js';

/** Run 选项 */
export interface RunOptions {
  /** AbortSignal——设置后可在外部中断 run()（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /** 当前 git branch——app 层采集，core 透传存入 RunState.branch */
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 ContextManager。
   */
  messages?: Message[];
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

  private constructor(opts: AgentRuntimeOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.context = opts.context;
    this.events = opts.events;
    this.limits = opts.limits;
    this.termination = opts.termination;
    this.session = opts.session;
    this.systemPrompt = opts.systemPrompt;
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
    this.permissionPolicy = new PermissionPolicy(this.events, opts.permission);
    this.guardrails = new GuardrailRunner(this.pluginHost, this.events);
    this.hooks = new HookRunner(this.pluginHost);
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
    };

    // 发布 Run 开始事件
    this.publishEvent({
      type: 'run.started',
      run_id: runId,
      data: { run_id: runId, session_id: currentSessionId, input: userMessage.content },
      ts: Date.now(),
    });

    // 保存初始状态
    if (this.session) {
      await this.session.save(runState);
    }

    try {
      // 注入消息（C5）：core 不解释其语义（skill / 附件 / 引用文件……），先于用户输入写入并持久化
      for (const injected of opts?.messages ?? []) {
        this.addContext(injected, runId);
      }

      // 添加用户消息到上下文
      this.addContext(userMessage, runId);

      // 应用输入 Guardrail
      const inputResult = await this.guardrails.apply(
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
      // 更新 Run 状态为失败
      runState.status = 'failed';
      runState.completed_at = Date.now();
      runState.error = error instanceof Error ? error.message : String(error);

      // 触发 OnError Hook（LLM 错误、Guardrail 阻断、限制超限、Abort 等）
      await this.hooks.run(HookType.OnError, {
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
        type: 'run.failed',
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

      // 发布 LLM 请求事件
      this.publishEvent({
        type: 'llm.request',
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
        // Auto Compact：用 LLM 真实 token 数替代字符估算
        this.context.updateRealTokens(this.stats.totalTokens);
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

      // 检查完成原因
      if (response.finish_reason === 'stop') {
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

        // 添加助手消息到上下文
        this.addContext(
          {
            role: 'assistant',
            content: response.content,
          },
          runId,
        );

        return response.content;
      }

      if (response.finish_reason === 'tool_calls' && response.tool_calls) {
        // 添加助手消息（包含 tool_calls）到上下文
        this.addContext(
          {
            role: 'assistant',
            content: response.content ?? '',
            tool_calls: response.tool_calls,
          },
          runId,
        );

        // 执行每个工具调用
        for (const toolCall of response.tool_calls) {
          // 增加工具调用计数
          this.limitChecker.incrementToolCall(this.stats);

          // 应用工具调用 Guardrail
          const toolCallResult = await this.guardrails.apply(
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
            type: 'tool.call.started',
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
          await this.hooks.run(HookType.BeforeTool, hookCtx);

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

            const toolCtx: ToolContext = {
              run_id: runId,
              session_id: sessionId,
              messages: this.context.messages,
              events: this.events,
            };

            // 权限判定（ADR-026/029，逻辑在 PermissionPolicy，ADR-033）
            await this.permissionPolicy.authorize(pluginTool, args, toolCtx);

            const result = await this.invokeTool(pluginTool, args, toolCtx);

            // 应用工具结果 Guardrail
            const toolResultResult = await this.guardrails.apply(
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
              type: 'tool.call.completed',
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
            await this.hooks.run(HookType.AfterTool, hookCtx);

            // 添加工具结果到上下文（标准 role: tool 消息）
            this.addContext(
              {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result,
              },
              runId,
            );
            // 注：不再注入假 assistant 消息（见 ADR-005 / Phase 1 review #3）
            // Provider 负责正确解释 role: tool 消息
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // 触发 OnError Hook（工具执行失败）
            await this.hooks.run(HookType.OnError, {
              run_id: runId,
              session_id: sessionId,
              error: errorMessage,
              phase: 'tool_execution',
              tool_name: toolCall.function.name,
            });

            // 发布工具调用失败事件
            this.publishEvent({
              type: 'tool.call.failed',
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
            this.addContext(
              {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: `Error: ${errorMessage}`,
              },
              runId,
            );
          }
        }
      } else {
        // 其他完成原因（如 length），直接返回当前内容
        this.addContext(
          {
            role: 'assistant',
            content: response.content,
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
   * 组装本次请求的消息数组（ADR-018）。
   * 「持久化上下文 + BeforeLlm hook 写入的 systemPrompt」在此一处收敛：
   * hook 未改写（或改写为空）时直接用持久化消息；改写时以注入内容替换首条 system
   * 消息（无 system 则前置一条）。注入只影响本次请求，不改动 ContextManager 持久化的消息。
   */
  private buildRequestMessages(injectedSystem: unknown): Message[] {
    const messages = this.context.messages;
    // 非字符串 / 空串视为「未注入」——hook 没写就保持持久化消息原样
    if (
      typeof injectedSystem !== 'string' ||
      !injectedSystem ||
      injectedSystem === this.systemPrompt
    ) {
      return messages;
    }
    const hasSystem = messages.some((m) => m.role === 'system');
    if (!hasSystem) {
      return [{ role: 'system', content: injectedSystem }, ...messages];
    }
    return messages.map((m) => (m.role === 'system' ? { ...m, content: injectedSystem } : m));
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
        message: msg,
        message_count: this.context.messages.length,
        token_count: this.context.tokenCount,
      },
      ts: Date.now(),
    });
  }

  /**
   * 发布事件
   * @param event 运行事件
   */
  protected publishEvent(event: RunEvent): void {
    this.events.publish(event);
  }
}
