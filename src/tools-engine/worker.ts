/**
 * tools-engine worker 执行（P2 seams 契约 §2.3）。
 *
 * 白名单工具 = basic-tools **同一份包源码**（无第二实现）：createBasicTools({}) 一次，
 * config 为空 ⇒ resolveCallCwd 落 ctx.cwd = 信封 cwd；boundary 由调用期 scope 注入，
 * 覆盖安装期 fallback。engine 不是沙箱：worker 拥有完整用户权限，外置买到的是崩溃隔离。
 *
 * 业务错误折 { content: 稳定文本 }（run 继续）；意外异常向上抛（entry 折 -32000 回包）。
 *
 * @module tools-engine/worker
 */

import {
  type BasicToolsCallScope,
  createBasicTools,
  deserializeBoundary,
  runWithBasicToolsCallScope,
} from '@vessel-agent/basic-tools';
import {
  type EventStream,
  type ToolContext,
  type ToolDefinition,
  takeToolResultGateReceipt,
} from '@vessel-agent/core';
import {
  ENGINE_ERROR,
  type ToolInvokeParams,
  type ToolInvokeResult,
} from '@vessel-agent/engine-client';

/** 路径类工具：信封必带 host 权威 boundary（缺 → fail-closed）。 */
const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'bash']);

/** 与 host in-process 路径同一份工具定义；模块加载时建一次。 */
const workerTools: ReadonlyMap<string, ToolDefinition> = new Map(
  createBasicTools({}).map((def): [string, ToolDefinition] => [def.name, def]),
);

/**
 * EventStream 空 shim：白名单工具不读 messages/events，shim 只为类型闭合 + 防御。
 * waitFor 挂起；signal abort 时 reject（与 run 取消同语义）。
 */
function createEventStreamShim(signal: AbortSignal): EventStream {
  return {
    subscribe: () => () => {},
    publish: () => {},
    clear: () => {},
    getHistory: () => [],
    waitFor: (_name, opts) =>
      new Promise<unknown>((_resolve, reject) => {
        const effective = opts?.signal ?? signal;
        const onAbort = (): void => {
          const reason: unknown = effective.reason;
          reject(reason instanceof Error ? reason : new Error('The operation was aborted'));
        };
        if (effective.aborted) {
          onAbort();
          return;
        }
        effective.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

/**
 * 执行一次 worker 调用。per-call signal 驱动取消（bash abort → killProcessTree）；
 * 出口闸回执经 takeToolResultGateReceipt 认领，bounded / original_chars 跨进程不丢。
 * dirs（engine 池 S13，additive 可选）：pool entry 传 NodeScope 的 host 装配 dirs，
 * 经 scope 注入落盘作用域与 bash 子进程 env；child 模式不传 → env fallback 零回归。
 */
export async function executeWorker(
  envelope: ToolInvokeParams,
  signal: AbortSignal,
  dirs?: { dataDir?: string; toolOutputDir?: string },
): Promise<ToolInvokeResult> {
  const def = workerTools.get(envelope.tool_name);
  if (def === undefined) return { content: ENGINE_ERROR.notRegistered(envelope.tool_name) };
  // async bash 的编排（jobs map / 通知槽）留 host：分流是 host 转发工厂职责，worker fail-closed。
  if (envelope.tool_name === 'bash' && envelope.args.async === true) {
    return { content: ENGINE_ERROR.invalidParams('async bash executes on host only') };
  }
  let scope: BasicToolsCallScope | undefined;
  if (PATH_TOOL_NAMES.has(envelope.tool_name)) {
    if (envelope.boundary === undefined) {
      return { content: ENGINE_ERROR.invalidParams('boundary required') };
    }
    try {
      scope = { boundary: deserializeBoundary(envelope.boundary), ...dirs };
    } catch {
      return { content: ENGINE_ERROR.invalidParams('boundary malformed') };
    }
  }
  const ctxShim: ToolContext = {
    run_id: envelope.run_id,
    session_id: envelope.session_id,
    tool_call_id: envelope.tool_call_id,
    cwd: envelope.cwd,
    signal,
    messages: [],
    events: createEventStreamShim(signal),
  };
  const content =
    scope !== undefined
      ? await runWithBasicToolsCallScope(scope, () => def.handler(envelope.args, ctxShim))
      : await def.handler(envelope.args, ctxShim);
  const receipt = takeToolResultGateReceipt(ctxShim);
  return receipt !== undefined
    ? { content, bounded: true, original_chars: receipt.originalChars }
    : { content };
}
