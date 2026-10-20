/**
 * 统一工具执行管道（0.8.2 Wave 2B1）。
 *
 * AgentRuntime、workflow `type: tool`、delegate 子 runtime 共用同一套工具执行语义：
 * ToolCall guardrail → BeforeTool hook → 权限判定（最终工具与参数）
 * → handler（timeout/abort）→ ToolResult guardrail → AfterTool hook。
 *
 * 权限判定必须对 guardrail/hook 改写后的最终工具与参数执行，避免旧工具/旧参数放行。
 *
 * 管道不发布 `tool.call.*` 事件（调用方负责，避免重复）。
 *
 * @module @vessel-agent/core/runtime
 */

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

export interface ToolPipelineDeps {
  pluginHost: PluginHost;
  events: EventStream;
  permission: PermissionPolicy;
  guardrails: GuardrailRunner;
  hooks: HookRunner;
  tenantId?: string;
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
  source?: 'runtime' | 'workflow' | 'host';
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
      let toolName = toolCall.function.name;
      let args = options.args;

      const fail = (error: string): ToolPipelineResult => ({
        ok: false,
        input: args,
        content: error,
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
            toolName = replacement.function.name;
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
          result = outcome.replacement;
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

      return { ok: true, input: args, content: result };
    },
  };
}

/** 便捷工厂依赖：内部构造三个编排器，供 harness 装配层使用。 */
export interface ToolPipelineFactoryDeps {
  pluginHost: PluginHost;
  events: EventStream;
  /** 默认权限策略（未声明 checkPermission 的工具） */
  permission?: RuntimePermissionConfig;
  tenantId?: string;
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
    permission: new PermissionPolicy(deps.events, deps.permission, deps.tenantId),
    guardrails: new GuardrailRunner(deps.pluginHost, deps.events, deps.tenantId),
    hooks: new HookRunner(deps.pluginHost, deps.events, deps.tenantId),
    ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
  });
}
