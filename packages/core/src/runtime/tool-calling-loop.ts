/**
 * Tool-calling loop
 *
 * Loop 只做算法编排：LLM 请求 → tool_calls 解析 → 工具执行 → 结果写回 → 循环。
 * 所有协作者（provider / 窗口 / 工具 / 事件 / run 控制）都经 `LoopContext` 注入；
 * 本模块不感知 durable 存储实现，也不从任何 barrel 导出。
 *
 * @module @vessel-agent/core/runtime
 */

import { LimitExceededError } from '../limits/index.js';
import type { ContextCompactedReason } from '../types/context.js';
import type { RunEvent } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { type HookContext, HookType } from '../types/hook.js';
import type {
  LimitBlock,
  LimitChecker,
  TerminationPolicy,
  UsageLimits,
  UsagePricing,
  UsageStats,
} from '../types/limits.js';
import type { ChatRequest, LLMResponse, Message, MessageRef } from '../types/provider.js';
import type { Run } from '../types/run.js';
import type { ToolCall } from '../types/tool.js';
import type { GuardrailRunner } from './guardrail-runner.js';
import type { HookRunner } from './hook-runner.js';
import type { PrefixChangeReason, PromptPrefixGuard } from './prompt-prefix-guard.js';
import { isToolCall } from './tool-pipeline.js';

/** Loop 的最终结果；usage/facts 已通过 Run 拥有的 execution/context 原地写回。 */
export type LoopResult = string;

/** Run 内一次 loop 的完整依赖面；每 run 构造一次，无跨 run 状态。 */
export interface LoopContext {
  readonly execution: Run;
  /** 本次请求的模型标识；计价按它查价格表。 */
  readonly model: string;
  /** opt-in 计价；缺省不累计 `totalCost`。 */
  readonly pricing?: UsagePricing;
  /**
   * 本轮输入的附件引用（0.52）：只透传给 BeforeLlm 的 `HookContext.refs`，
   * loop 自己不读、不改、不进请求体。缺省（无引用）= 旧行为。
   */
  readonly inputRefs?: readonly MessageRef[];
  readonly window: MessageWindowPort;
  readonly provider: ProviderPort;
  readonly tools: ToolExecutor;
  readonly events: EventSink;
  readonly controls: RunControls;
}

/** WorkingContext / MessageWindowPort：只读写本次 run 的内存窗口。 */
export interface MessageWindowPort {
  addMessage(message: Message, runId: string): void;
  buildRequestMessages(systemOverride: unknown): Message[];
  /**
   * 0.52：请求 messages 只许 append ⇒ 句柄失效/容量耗尽这种「面上的」事件，
   * 只能在发请求前**追加一张 env 卡**（不许回改历史）。缺省实现 = 不追加。
   */
  appendPiiDeadNotice?(): Promise<void>;
  appendInjectedMessages(runId: string, messages: readonly Message[] | undefined): void;
  updateRealTokens(total: number): void;
  /** 对应 `context.autoCompactAsync?.()`；实现缺省时返回 undefined。 */
  autoCompact(): Promise<number | undefined>;
}

/** Provider：一次 chat 调用（含 context-overflow 压缩重试）。 */
export interface ProviderPort {
  chat(args: {
    messages: Message[];
    tools: NonNullable<ChatRequest['tools']>;
    sessionId: string;
    signal?: AbortSignal;
    rebuildMessages: () => Message[];
  }): Promise<LLMResponse>;
}

/** ToolExecutor：工具 schema、并发判定、单调用执行。 */
export interface ToolExecutor {
  listToolSchemas(): NonNullable<ChatRequest['tools']>;
  isConcurrencySafe(entry: PreparedToolCall): boolean;
  runToolCall(entry: PreparedToolCall, signal?: AbortSignal): Promise<ToolExecutionOutcome>;
}

/** EventSink：Loop 的唯一事件出口；持久化由 Run 的实现决定，Loop 不感知。 */
export interface EventSink {
  emit(event: RunEvent, options?: { persistData?: unknown }): void;
}

/** RunControls：abort / limits / termination / 每 run 策略与安全点。 */
export interface RunControls {
  readonly signal?: AbortSignal;
  readonly limits: UsageLimits;
  readonly termination: TerminationPolicy;
  readonly hooks: HookRunner;
  readonly guardrails: GuardrailRunner;
  readonly prefixGuard: PromptPrefixGuard;
  readonly limitChecker: LimitChecker;
  getPausedMs(): number;
  evaluateTermination(stats: UsageStats): LimitBlock | null;
  evaluateUsageLimits(stats: UsageStats): LimitBlock | null;
  publishLimitWarnings(): void;
  publishContextPressureWarning(): void;
  publishCompacted(removed: number, reason: ContextCompactedReason): void;
  ensurePrefixReason(reason: PrefixChangeReason): void;
  takePrefixReason(): PrefixChangeReason | undefined;
  getBaseSystemPrompt(): string | undefined;
  /** 已报告过返回 false；否则置位并返回 true。 */
  markSystemPromptIgnored(): boolean;
  markAdditionalContextDeprecated(): boolean;
  hasSeenLegacyContext(content: string): boolean;
  markLegacyContextSeen(content: string): void;
  /** 每轮工具结果写回后的 durable 安全点；由 Run 实现。 */
  onSafePoint(): Promise<void>;
}

/** 预处理后的工具调用（0.6.1 P1：安全批次并发） */
export interface PreparedToolCall {
  toolCall: ToolCall;
  toolName: string;
  args: unknown;
  startedAt: number;
  /** 已定性的失败（guardrail 阻断 / 非法 JSON）；不执行工具，直接折回 */
  failureMessage?: string;
}

/** 单个工具调用的执行结果（上下文按原顺序写回） */
export interface ToolExecutionOutcome {
  toolCall: ToolCall;
  /** 实际使用的输入（BeforeTool hook 改写后）；供 AfterTool 读取 */
  input: unknown;
  ok: boolean;
  content: string;
}

/**
 * Tool-calling loop
 * 核心循环：调用 LLM -> 解析 tool_calls -> 执行工具 -> 注入结果 -> 循环
 * @param ctx 本次 run 的完整依赖面（run/session/usage 的唯一来源）
 */
export async function runToolCallingLoop(ctx: LoopContext): Promise<LoopResult> {
  const { runId, sessionId, stats } = ctx.execution;
  while (true) {
    // AbortSignal 中断（Hermes/Claude Code 模式——外部 Esc）
    if (ctx.controls.signal?.aborted) {
      throw new Error(ctx.controls.signal.reason ?? 'Run cancelled');
    }

    // 权限等待不计入 max_runtime（ADR-084 Errata）：每轮同步累计暂停时长。
    stats.pausedMs = ctx.controls.getPausedMs();

    // 0.15 E2：90% 预警（每 run 每 key 一次，不改变执行）
    ctx.controls.publishLimitWarnings();

    // 检查终止条件
    const terminationBlock = ctx.controls.evaluateTermination(stats);
    if (terminationBlock) {
      ctx.events.emit({
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

    // 检查使用量限制。request / token / cost 都是硬上限；循环由
    // max_iterations / max_runtime_seconds 兜底，不再有工具调用次数预算。
    const limitBlock = ctx.controls.evaluateUsageLimits(stats);
    if (limitBlock) {
      ctx.events.emit({
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

    // 90%–95%：不压缩，只提示换 ExecutionUnit；>95% 交给 autoCompactAsync。
    // 自动压缩关闭时没有后续压缩降水位，提示不设上界（见 publishContextPressureWarning）。
    ctx.controls.publishContextPressureWarning();

    // 0.6.1 E3：按阈值触发真实摘要压缩（旧 WorkingContext 无此方法则跳过）。
    // 必须在组装请求前完成，保证本轮请求看到压缩后的历史。
    const compacted = await ctx.window.autoCompact();
    if (typeof compacted === 'number') {
      ctx.controls.publishCompacted(compacted, 'auto');
      // 压缩会删除中间的旧消息：必须显式标记，否则守卫会把它当成前缀重写。
      if (compacted > 0) ctx.controls.ensurePrefixReason('compaction');
    }

    // CONTRACT-prefix-invariant §2：system 冻结。hook 可以读基底 system，
    // 但写入被忽略（首次写入发一次事件），system 始终是会话级基底 + Self Card。
    // 附件引用（0.52）：只告诉 hook「本轮带哪些引用」（路径与种类），正文永不在此出现。
    const inputRefs = ctx.inputRefs;
    const hookCtx: HookContext = {
      run_id: runId,
      session_id: sessionId,
      ...(inputRefs !== undefined && inputRefs.length > 0 ? { refs: inputRefs } : {}),
    };
    const baseSystemPrompt = ctx.controls.getBaseSystemPrompt();
    Object.defineProperty(hookCtx, 'systemPrompt', {
      enumerable: true,
      // 不可重定义：hook 只能读，写入被忽略并记一次事件。
      configurable: false,
      get: () => baseSystemPrompt,
      set: () => {
        if (!ctx.controls.markSystemPromptIgnored()) return;
        ctx.events.emit({
          type: 'hook.system_prompt_ignored',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId },
          ts: Date.now(),
        });
      },
    });
    const beforeLlm = await ctx.controls.hooks.run(HookType.BeforeLlm, hookCtx);

    // §3：旧 additionalContext 不再拼进 system，改为一条尾消息（每 run 去重）。
    const legacyContext = beforeLlm.additionalContext;
    if (typeof legacyContext === 'string' && legacyContext.length > 0) {
      if (ctx.controls.markAdditionalContextDeprecated()) {
        ctx.events.emit({
          type: 'hook.additional_context_deprecated',
          run_id: runId,
          data: { run_id: runId, session_id: sessionId },
          ts: Date.now(),
        });
      }
      if (!ctx.controls.hasSeenLegacyContext(legacyContext)) {
        ctx.controls.markLegacyContextSeen(legacyContext);
        hookCtx.messages = [
          ...(hookCtx.messages ?? []),
          {
            role: 'user',
            name: 'vessel:hook',
            content: legacyContext,
            timestamp: Date.now(),
          },
        ];
      }
    }

    // 0.16 E5：BeforeLlm 注入的消息按返回顺序写入上下文一次（进入本次请求，
    // 后续轮次直接从上下文可见；重复返回同一批消息不重复写入）。
    ctx.window.appendInjectedMessages(runId, hookCtx.messages);

    // 0.52：句柄失效 / 容量耗尽以**追加一张 env 卡**表达（append-only，不回改历史）。
    // 必须在组装请求**之前**：卡要进本次请求，UI 也读同一份 store（可见性对等）。
    await ctx.window.appendPiiDeadNotice?.();

    // 组装本次请求的消息：system 只来自会话级基底（含 Self Card），
    // 不接受每轮拼接的 additionalContext（CONTRACT-prefix-invariant §2）。
    const messages = ctx.window.buildRequestMessages(baseSystemPrompt);

    // 统一工具来源：PluginHost（插件在 install() 里 registerTool）。
    const toolSchemas = ctx.tools.listToolSchemas();

    // §4：请求前检查 system / tools / messages 是否保持前缀；显式 reason 消费后清空。
    const requestSystem =
      messages.find((message) => message.role === 'system' && !message.compaction_summary)
        ?.content ?? '';
    const prefixReason = ctx.controls.takePrefixReason();
    ctx.controls.prefixGuard.check({
      sessionId,
      runId,
      system: requestSystem,
      tools: JSON.stringify(toolSchemas),
      messages,
      ...(prefixReason !== undefined ? { reason: prefixReason } : {}),
    });

    // 调用 LLM（context-overflow 时强制压缩一次并重试一次，0.10 R2-17）
    const response = await ctx.provider.chat({
      messages,
      tools: toolSchemas,
      sessionId,
      ...(ctx.controls.signal !== undefined ? { signal: ctx.controls.signal } : {}),
      rebuildMessages: () => ctx.window.buildRequestMessages(baseSystemPrompt),
    });

    // 更新 token 使用量
    let requestCost: number | undefined;
    if (response.usage) {
      ctx.controls.limitChecker.addTokens(
        stats,
        response.usage.prompt_tokens ?? 0,
        response.usage.completion_tokens ?? 0,
      );
      // CONTRACT-0.29 B1：缓存两项绕过 `addTokens`（`types/limits.ts` 的公开端口，
      // 签名不变）在这里直接累加；它们是 `prompt_tokens` 的**子集**，只做计数，
      // 不进 `inputTokens` / `totalTokens`（§1.2 禁止相加）。
      // 「未上报」用 `undefined` 保持缺省，一旦某轮上报过就持续累加。
      const cacheRead = response.usage.cache_read_input_tokens;
      if (cacheRead !== undefined) {
        stats.cacheReadTokens = (stats.cacheReadTokens ?? 0) + cacheRead;
      }
      const cacheCreation = response.usage.cache_creation_input_tokens;
      if (cacheCreation !== undefined) {
        stats.cacheCreationTokens = (stats.cacheCreationTokens ?? 0) + cacheCreation;
      }
      // Auto Compact：用**本次请求**的真实 token 数替代字符估算。
      // 不能用累计 stats.totalTokens——多轮会线性放大，第二轮就误触发 compact（C-04）。
      // 0.29 U1：`prompt_tokens` 已由 adapter 统一为「含缓存的全部输入」
      // （CONTRACT-0.29 §1），因此这里**不得**再加 cache_read / cache_creation
      // ——它们是 prompt_tokens 的子集，再加会重复计数（§5.1）。
      ctx.window.updateRealTokens(
        (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0),
      );
      // 0.51：按分项费率累计成本；无价格表 / 该模型未配置时不产生金额。
      requestCost = ctx.pricing?.costOf(ctx.model, response.usage);
      if (requestCost !== undefined) ctx.controls.limitChecker.addCost(stats, requestCost);
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
      ...(requestCost !== undefined ? { cost: requestCost } : {}),
    };
    ctx.events.emit(
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
    await ctx.controls.hooks.run(HookType.AfterLlm, hookCtx);

    // 检查完成原因。
    // 0.6.1 P1：finish_reason 不可靠——存在实际 tool_calls 时优先继续工具轮，
    // 只有「无 tool_calls 且 stop」才视为终稿（对齐 Claude Code query.ts 的 tool_use 判定）。
    const toolCalls = response.tool_calls;
    const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

    if (!hasToolCalls && response.finish_reason === 'stop') {
      // 应用输出 Guardrail
      const outputResult = await ctx.controls.guardrails.apply(
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
        typeof outputResult.replacement === 'string' ? outputResult.replacement : response.content;

      // 添加助手消息到上下文（thinking 模式需保存 reasoning_content 供下一轮回传）
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: finalContent,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
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
        ctx.controls.limitChecker.incrementToolCall(stats);
        const toolCallResult = await ctx.controls.guardrails.apply(
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
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: effectiveCalls,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
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
        ctx.events.emit({
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
      ctx.execution.phase = 'tool';
      let cursor = 0;
      while (cursor < prepared.length) {
        const first = prepared[cursor];
        if (!first) break;

        const batch: PreparedToolCall[] = [first];
        if (ctx.tools.isConcurrencySafe(first)) {
          let candidate = prepared[cursor + batch.length];
          while (candidate && ctx.tools.isConcurrencySafe(candidate)) {
            batch.push(candidate);
            candidate = prepared[cursor + batch.length];
          }
        }

        // BeforeTool 钩子逐调用串行执行，避免并行批次共享 hookCtx 的竞态。
        // 0.6.1 P2：hook 可读取 tool/input；block 折回 tool 错误，updatedInput 改写入参。
        for (const entry of batch) {
          if (entry.failureMessage !== undefined) continue;
          const hookResult = await ctx.controls.hooks.run(HookType.BeforeTool, {
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
          batch.map((entry) => ctx.tools.runToolCall(entry, ctx.controls.signal)),
        );

        // 上下文严格按原调用顺序写回（并行完成顺序不影响历史顺序）
        for (const outcome of outcomes) {
          if (outcome.ok) {
            // 执行 AfterTool 钩子（0.6.1 P2：携带 tool/input）
            await ctx.controls.hooks.run(HookType.AfterTool, {
              ...hookCtx,
              tool: outcome.toolCall.function.name,
              input: outcome.input,
            });
          }
          ctx.window.addMessage(
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

      // durable 安全点：本轮 tool-call 结果已全部写入上下文
      await ctx.controls.onSafePoint();
    } else {
      // 其他完成原因（如 length），直接返回当前内容
      ctx.window.addMessage(
        {
          role: 'assistant',
          content: response.content,
          ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
        },
        runId,
      );
      return response.content;
    }
  }
}
