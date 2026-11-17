/**
 * 统一工具执行管道（0.8.2 Wave 2B1）。
 *
 * ExecutionUnit、delegate 子 runtime 共用同一套工具执行语义：
 * ToolCall guardrail → BeforeTool hook → **PII 句柄替换（0.52，3.5）**
 * → 权限判定（最终工具与参数）→ handler（timeout/abort）
 * → ToolResult guardrail → AfterTool hook。
 *
 * 0.56 闸上移：handler 自己裁过结果（`boundToolResult`）时会在 ctx 上登记一张回执，
 * 管道认领后带成 `ToolPipelineResult.bounded` —— 出口闸本体在 loop（`tool-calling-loop.ts`），
 * 管道只负责把「已经裁过」这个事实传上去，不重复实现裁剪 / 落盘。
 *
 * 权限判定必须对 guardrail/hook 改写后的最终工具与参数执行，避免旧工具/旧参数放行；
 * PII 句柄替换也必须在权限判定**之前**，否则人批的是占位符而不是真实参数。
 *
 * 管道不发布 `tool.call.*` 事件（调用方负责，避免重复）。
 *
 * @module @vessel-agent/core/runtime
 */

import { getPiiVault } from '../pii/vault.js';
import type { EventStream } from '../types/event.js';
import { GuardrailStage } from '../types/guardrail.js';
import { HookType } from '../types/hook.js';
import type { PluginHost, RuntimePermissionConfig } from '../types/plugin.js';
import type { Message } from '../types/provider.js';
import type { ToolCall, ToolContext, ToolDefinition } from '../types/tool.js';
import { GuardrailRunner } from './guardrail-runner.js';
import { HookRunner } from './hook-runner.js';
import {
  PermissionAbortedError,
  PermissionPolicy,
  PermissionTimeoutError,
} from './permission-policy.js';
import { takeToolResultGateReceipt } from './tool-result-gate.js';

export interface ToolPipelineDeps {
  pluginHost: PluginHost;
  events: EventStream;
  permission: PermissionPolicy;
  guardrails: GuardrailRunner;
  hooks: HookRunner;
  /**
   * 0.52 PII 句柄替换（工具参数求值前）。
   *
   * 缺省 = 进程级 `getPiiVault()`（与请求构造层 / 入站脱敏同源）。
   * 传 `false` 关闭；`onHandleFailure` 让上层感知「句柄解不开」这类**动作错误**
   * （上层据此发系统级提示卡 —— 只有 broker 重启这种面上的事件才发，见 `pii/notice.ts`）。
   */
  pii?: false | PiiHandleBoundary;
}

/** 工具参数边界的句柄替换口。 */
export interface PiiHandleBoundary {
  substitute: (args: unknown, sessionId: string) => unknown;
  onHandleFailure?: (error: unknown, sessionId: string) => void;
}

/** 可选阶段开关；默认全开。调用方已在外层处理的阶段可关闭，避免重复。 */
export interface ToolPipelineStages {
  beforeToolHook?: boolean;
  toolCallGuardrail?: boolean;
  toolResultGuardrail?: boolean;
  afterToolHook?: boolean;
}

export interface ToolPipelineOptions {
  runId: string;
  sessionId: string;
  /** 保留原始 name/arguments 形状，供 guardrail/hook 使用 */
  toolCall: ToolCall;
  /** 已解析参数 */
  args: unknown;
  signal?: AbortSignal;
  /** 工具上下文中的消息快照；未提供时为空数组 */
  messages?: Message[];
  /** 权限请求来源（0.13）；缺省 `runtime` */
  source?: 'runtime' | 'host';
  /**
   * 0.51：成员 cwd，原样注入 `ToolContext.cwd`。
   * 管道不解释它（也不校验目录），工具自己决定怎么用。
   */
  cwd?: string;
  stages?: ToolPipelineStages;
}

export interface ToolPipelineResult {
  ok: boolean;
  /** 可能被 BeforeTool hook / ToolCall guardrail 改写后的参数 */
  input: unknown;
  /** 成功结果或错误文本 */
  content: string;
  /** 失败原因（成功时缺省）；调用方可据此决定是否加 `Error:` 前缀 */
  error?: string;
  /**
   * 结果**已过出口闸**（≤ 16k token）：handler 自己裁过并登记了回执
   * （`markToolResultBounded`，见 `tool-result-gate.ts`）。
   * loop 见到就原样写回，不再裁第二次 —— 否则省略标注行会被裁掉。
   */
  bounded?: true;
  /** 裁剪前字符数（与 `bounded` 同时出现；仅供日志 / 事件参考） */
  original_chars?: number;
}

export interface ToolPipeline {
  execute(options: ToolPipelineOptions): Promise<ToolPipelineResult>;
}

/** 类型守卫：Guardrail replacement 是否是合法的 ToolCall（C-05） */
export function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const fn = record.function;
  if (typeof record.id !== 'string' || typeof fn !== 'object' || fn === null) return false;
  const fnRecord = fn as Record<string, unknown>;
  return typeof fnRecord.name === 'string' && typeof fnRecord.arguments === 'string';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 默认 PII 句柄边界 = 进程级 vault（与请求构造层 / 入站脱敏同源）。
 *
 * 上层（ExecutionUnit）注入自己的边界时，可以顺带拿到 `onHandleFailure`
 * 回调 —— 只有「整批失效」这种面上的事件才会被渲染成一张环境信息卡。
 */
const DEFAULT_PII_BOUNDARY: PiiHandleBoundary = {
  substitute: (args, sessionId) => getPiiVault().substituteDeep(args, sessionId),
};

/** 调用 handler 并应用 `ToolDefinition.timeout`（ADR-017(2b)）。 */
async function invokeTool(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<string> {
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
 * 创建工具执行管道。
 *
 * 阶段顺序：getTool → ToolCall guardrail → BeforeTool → permission（最终工具与参数）
 * → handler → ToolResult guardrail → AfterTool（仅成功）。
 */
export function createToolPipeline(deps: ToolPipelineDeps): ToolPipeline {
  const { pluginHost, events, permission, guardrails, hooks } = deps;

  return {
    async execute(options: ToolPipelineOptions): Promise<ToolPipelineResult> {
      const stages = {
        beforeToolHook: options.stages?.beforeToolHook ?? true,
        toolCallGuardrail: options.stages?.toolCallGuardrail ?? true,
        toolResultGuardrail: options.stages?.toolResultGuardrail ?? true,
        afterToolHook: options.stages?.afterToolHook ?? true,
      };

      let toolCall = options.toolCall;
      /**
       * 0.55：工具名别名（旧名 → 现行名）。
       *
       * 表在注册表里（`TOOL_NAME_ALIASES`，一处），这里只消费结果：
       * - `toolName` 一律换成**现行名**再往下走（权限规则 / hook / 事件都对新名生效，
       *   否则「改名后旧名还能绕开 auto_approve 之外的新规则」是很难查的一类问题）；
       * - `aliasNotice` 在结果里附一行弃用提示 —— **不静默**，模型和人都能看见。
       */
      const requestedName = toolCall.function.name;
      const requestedAlias = pluginHost.getToolAlias?.(requestedName);
      let aliasNotice = requestedAlias?.notice;
      let toolName = requestedAlias?.target ?? requestedName;
      let args = options.args;

      /** 命中别名时把弃用提示追加到回给模型的文本（错误路径也带，免得「静默失败」）。 */
      const withAliasNotice = (text: string): string =>
        aliasNotice === undefined ? text : `${text}\n${aliasNotice}`;

      const fail = (error: string): ToolPipelineResult => ({
        ok: false,
        input: args,
        content: withAliasNotice(error),
        error,
      });

      const ctx: ToolContext = {
        run_id: options.runId,
        session_id: options.sessionId,
        // 0.13：权限请求按 tool_call_id 关联到 tool.call.*
        tool_call_id: toolCall.id,
        messages: options.messages ?? [],
        events,
        source: options.source ?? 'runtime',
        ...(options.signal ? { signal: options.signal } : {}),
        // 0.51：成员 cwd 只做默认起点；工具级显式参数与路径边界都不受影响。
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      };

      // 1. 工具查找（唯一来源：PluginHost）
      let tool = pluginHost.getTool(toolName);
      if (!tool) return fail(`Tool "${toolName}" not found`);

      // 2. ToolCall guardrail：replacement 可改写 name/arguments
      if (stages.toolCallGuardrail) {
        const outcome = await guardrails.apply(
          toolCall,
          GuardrailStage.ToolCall,
          options.runId,
          options.sessionId,
        );
        if (!outcome.allowed) {
          return fail(`Tool call blocked by guardrail: ${outcome.reason ?? 'blocked'}`);
        }
        if (isToolCall(outcome.replacement)) {
          const replacement = outcome.replacement;
          // GuardrailRunner 在无 guardrail 时也会回传原值；只有真正改写才重解析。
          const nameChanged = replacement.function.name !== toolName;
          const argsChanged = replacement.function.arguments !== toolCall.function.arguments;
          toolCall = replacement;
          if (nameChanged || argsChanged) {
            // 0.55：改写后的名字重新过别名表（guardrail 可能写成旧名，语义同入口一次）。
            const replacementAlias = pluginHost.getToolAlias?.(replacement.function.name);
            toolName = replacementAlias?.target ?? replacement.function.name;
            aliasNotice = replacementAlias?.notice;
            try {
              args = replacement.function.arguments
                ? JSON.parse(replacement.function.arguments)
                : {};
            } catch (error) {
              return fail(`Invalid JSON in tool arguments: ${errorText(error)}`);
            }
            tool = pluginHost.getTool(toolName);
            if (!tool) return fail(`Tool "${toolName}" not found`);
          }
        }
      }

      // 3. BeforeTool hook：block 短路；updatedInput 改写入参
      if (stages.beforeToolHook) {
        const hookResult = await hooks.run(HookType.BeforeTool, {
          run_id: options.runId,
          session_id: options.sessionId,
          tool: toolName,
          input: args,
        });
        if (hookResult.block) {
          return fail(`Tool call blocked by hook: ${hookResult.reason ?? 'blocked'}`);
        }
        if (hookResult.updatedInput !== undefined) {
          args = hookResult.updatedInput;
        }
      }

      // 3.5 PII 句柄替换（0.52）：`«pii:…»` → 真值。
      //     刻意放在权限判定**之前** —— 人批准的必须是真实参数，而不是占位符；
      //     解不开就整调用失败（宁可失败，也不能把占位符原样发给外部系统）。
      if (deps.pii !== false) {
        const boundary = deps.pii ?? DEFAULT_PII_BOUNDARY;
        try {
          args = boundary.substitute(args, options.sessionId);
        } catch (error) {
          boundary.onHandleFailure?.(error, options.sessionId);
          return fail(errorText(error));
        }
      }

      // 4. 权限判定：必须针对 guardrail/hook 改写后的最终工具与参数
      try {
        await permission.authorize(tool, args, ctx);
      } catch (error) {
        // 权限超时是致命错误（DECISION-022 §2.2）：不得折成普通工具错误回给模型。
        if (error instanceof PermissionTimeoutError) throw error;
        // 0.13（DECISION-024 §2.3）：run 取消时权限等待立即结束；取消不是工具错误，
        // 原样抛出，由 run 终态按 cancelled 收尾。
        if (error instanceof PermissionAbortedError || ctx.signal?.aborted) throw error;
        return fail(errorText(error));
      }

      // 5. handler（timeout + ctx.signal）
      let result: string;
      try {
        result = await invokeTool(tool, args, ctx);
      } catch (error) {
        return fail(errorText(error));
      }

      // 5.5 出口闸回执（0.56 闸上移）：handler 自己裁过就在 ctx 上登记过一张回执。
      //     结果字符串一旦被 ToolResult guardrail 改写，回执就失效（改写后的文本没裁过）。
      const gateReceipt = takeToolResultGateReceipt(ctx);
      let resultBounded = gateReceipt?.bounded === true;
      let resultOriginalChars = gateReceipt?.originalChars;

      // 6. ToolResult guardrail：block 折回错误；字符串 replacement 改写结果
      if (stages.toolResultGuardrail) {
        const outcome = await guardrails.apply(
          result,
          GuardrailStage.ToolResult,
          options.runId,
          options.sessionId,
        );
        if (!outcome.allowed) {
          return fail(`Tool result blocked by guardrail: ${outcome.reason ?? 'blocked'}`);
        }
        if (typeof outcome.replacement === 'string') {
          // GuardrailRunner 无 guardrail / 未改写时也会回传**原值**，只有真改写才作数
          // —— 否则每次工具调用都会把回执误判成失效。
          if (outcome.replacement !== result) {
            result = outcome.replacement;
            resultBounded = false;
            resultOriginalChars = undefined;
          }
        }
      }

      // 7. AfterTool hook（仅成功，与 runtime 既有语义一致）
      if (stages.afterToolHook) {
        await hooks.run(HookType.AfterTool, {
          run_id: options.runId,
          session_id: options.sessionId,
          tool: toolName,
          input: args,
        });
      }

      return {
        ok: true,
        input: args,
        content: withAliasNotice(result),
        ...(resultBounded
          ? { bounded: true as const, original_chars: resultOriginalChars ?? result.length }
          : {}),
      };
    },
  };
}

/** 便捷工厂依赖：内部构造三个编排器，供 harness 装配层使用。 */
export interface ToolPipelineFactoryDeps {
  pluginHost: PluginHost;
  events: EventStream;
  /** 默认权限策略（未声明 checkPermission 的工具） */
  permission?: RuntimePermissionConfig;
  /** 0.52：PII 句柄边界（缺省走进程级 vault；传 false 关闭） */
  pii?: false | PiiHandleBoundary;
}

/**
 * 基于 PluginHost/EventStream 构造完整工具执行管道。
 *
 * 与 `createToolPipeline` 的区别：编排器（PermissionPolicy / GuardrailRunner /
 * HookRunner）由本函数按同一 PluginHost/events/tenant 构造，调用方只需提供装配层依赖。
 */
export function createToolPipelineFor(deps: ToolPipelineFactoryDeps): ToolPipeline {
  return createToolPipeline({
    pluginHost: deps.pluginHost,
    events: deps.events,
    permission: new PermissionPolicy(deps.events, deps.permission),
    guardrails: new GuardrailRunner(deps.pluginHost, deps.events),
    hooks: new HookRunner(deps.pluginHost, deps.events),
    ...(deps.pii !== undefined ? { pii: deps.pii } : {}),
  });
}
