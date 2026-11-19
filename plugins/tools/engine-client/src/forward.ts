/**
 * engine-client 转发 handler 工厂（P2 接缝契约 §1.2；设计契约 §3/§5/§8）。
 *
 * 就地替换 def.handler，逐调用：exec 谓词 → O4 transport 打标（派发前）→ 信封
 * （三元组 / host 权威 cwd / boundary / 预算）→ callback 先登 pending → abort 监听
 * → transport.request(toolInvoke)（host 宽限 +10s，worker 预算自杀在先）→ 结果
 * 形状校验 + 出口闸回执跨进程认领 → 返回 content。
 *
 * 权限判定不在这里：管道 authorize(最终工具, 最终参数) 在派发之前完成
 * （设计契约 §8）；checkPermission 原闭包留 host，本工厂不碰。
 * transport 异常折 ENGINE_ERROR.unavailable 稳定前缀（error-envelope 折
 * tool_error retryable:false，run 继续）；cancelled 原样透传。
 *
 * @module @vessel-agent/engine-client
 */

import {
  DEFAULT_BASH_TIMEOUT_MS,
  resolveCallCwd,
  serializeBoundary,
} from '@vessel-agent/basic-tools';
import {
  type Logger,
  markToolResultBounded,
  markToolTransport,
  type ToolContext,
  type ToolDefinition,
  type ToolHandler,
} from '@vessel-agent/core';
import type { ToolRoute } from './client.js';
import { isRecord, type PendingTable } from './pending.js';
import {
  ENGINE_ERROR,
  ENGINE_WIRE,
  type EngineTransport,
  type ExecClass,
  type ToolCancelParams,
  type ToolInvokeParams,
} from './protocol.js';

/** host 侧宽限：worker 预算自杀在先，host timer 只兜底（接缝契约 §1.2）。 */
const HOST_TIMEOUT_GRACE_MS = 10_000;

export interface ForwardHandlerDeps {
  def: ToolDefinition;
  route: ToolRoute;
  /** wire 时捕获的原 handler（callback pending 记录执行它）。 */
  originalHandler: ToolHandler;
  getTransport(): EngineTransport | undefined;
  /** 账本 rejected 状态（impl.swapped 指纹不一致；校验权在 host）。 */
  isRejected(name: string): boolean;
  pending: PendingTable;
  logger?: Logger;
}

/** 信封预算（接缝契约 §1.2）：def.timeout 优先；bash worker 落 args.timeout_ms / 缺省 120s。 */
function resolveTimeoutMs(def: ToolDefinition, exec: ExecClass, args: unknown): number | undefined {
  if (def.timeout !== undefined && def.timeout > 0) return def.timeout;
  if (def.name === 'bash' && exec === 'worker') {
    if (isRecord(args)) {
      const value = args.timeout_ms;
      if (typeof value === 'number' && value > 0) return value;
    }
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  return undefined;
}

export function createForwardHandler(deps: ForwardHandlerDeps): ToolHandler {
  const { def, route, originalHandler, getTransport, isRejected, pending, logger } = deps;
  return async (args: unknown, ctx: ToolContext): Promise<string> => {
    const transport = getTransport();
    if (transport === undefined || !transport.active) {
      throw new Error(ENGINE_ERROR.unavailable);
    }
    if (isRejected(def.name)) throw new Error(ENGINE_ERROR.implRejected(def.name));

    const exec = route.exec?.(args) ?? route.execClass;
    markToolTransport(ctx, exec === 'worker' ? 'engine_worker' : 'engine_callback');

    const runId = ctx.run_id;
    const toolCallId = ctx.tool_call_id ?? '';
    const timeoutMs = resolveTimeoutMs(def, exec, args);
    const envelope: ToolInvokeParams = {
      run_id: runId,
      session_id: ctx.session_id ?? '',
      tool_call_id: toolCallId,
      tool_name: def.name,
      // PII 已替换的真值原样；非 record 按 {} 兜底，由 engine 机械校验拒。
      args: isRecord(args) ? args : {},
      exec,
      cwd: route.config !== undefined ? resolveCallCwd(route.config, ctx.cwd).path : ctx.cwd,
      boundary:
        exec === 'worker' && route.boundary !== undefined
          ? serializeBoundary(route.boundary)
          : undefined,
      timeout_ms: timeoutMs,
    };
    const cancelParams: ToolCancelParams = { run_id: runId, tool_call_id: toolCallId };

    // callback：先登 pending 再发 invoke（engine 的 tool.callback 随时可能到达）。
    if (exec === 'callback') {
      pending.register({
        run_id: runId,
        tool_call_id: toolCallId,
        tool_name: def.name,
        args,
        ctx,
        originalHandler,
      });
    }

    const signal = ctx.signal;
    const requestTimeoutMs =
      timeoutMs !== undefined ? timeoutMs + HOST_TIMEOUT_GRACE_MS : undefined;
    let abortListener: (() => void) | undefined;
    let result: unknown;
    try {
      if (signal?.aborted === true) throw new Error(ENGINE_ERROR.cancelled);
      let aborted: Promise<never> | undefined;
      if (signal !== undefined) {
        let rejectAbort: ((error: Error) => void) | undefined;
        aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        abortListener = () => {
          pending.settle(runId, toolCallId);
          transport.notify(ENGINE_WIRE.toolCancel, cancelParams);
          rejectAbort?.(new Error(ENGINE_ERROR.cancelled));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      const requestPromise = transport.request(ENGINE_WIRE.toolInvoke, envelope, requestTimeoutMs);
      result = await (aborted !== undefined
        ? Promise.race([requestPromise, aborted])
        : requestPromise);
    } catch (error) {
      // cancelled 原样透传；其余 transport 异常折稳定前缀（原 message 附后）。
      if (error instanceof Error && error.message === ENGINE_ERROR.cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${ENGINE_ERROR.unavailable} (${message})`);
    } finally {
      if (signal !== undefined && abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
      if (exec === 'callback') pending.settle(runId, toolCallId);
    }

    // 结果形状校验 {content: string}；不过 = engine 协议违规，折稳定 unavailable。
    if (!isRecord(result) || typeof result.content !== 'string') {
      logger?.warn('engine tool.invoke result shape invalid', { tool_name: def.name });
      throw new Error(ENGINE_ERROR.unavailable);
    }
    // worker 自己裁过 ⇒ host ctx 登记出口闸回执（跨进程不丢；管道认领后 loop 不再裁）。
    if (result.bounded === true) {
      const originalChars = result.original_chars;
      markToolResultBounded(
        ctx,
        typeof originalChars === 'number' ? originalChars : result.content.length,
      );
    }
    return result.content;
  };
}
