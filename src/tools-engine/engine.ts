/**
 * tools-engine 核心调度执行器（P2 seams 契约 §2.2）。
 *
 * 不判权限、不管会话、不独立发现工具：注册表内容只来自 host 喂的 registry.sync；
 * 派发前只做机械 schema 校验（不是权限判定）；按信封 exec 机械路由 worker / callback。
 * 并发到达直接派发（内存 in-flight 表 = 排队；无并发上限、无 durable 队列）。
 *
 * 错误口径：业务错误一律折 { content: 稳定文本 }（工具错误口径，run 继续）；
 * 只有形状校验不过 / 意外异常才 throw（entry 折 JSON-RPC error 回包）。
 *
 * @module tools-engine/engine
 */

import {
  ENGINE_ERROR,
  ENGINE_WIRE,
  type EngineHealthParams,
  type RegistryEntry,
  type RegistrySyncResult,
  type ToolInvokeParams,
  type ToolInvokeResult,
} from '@vessel-agent/engine-client';
import {
  firstSchemaViolation,
  parseCancelParams,
  parseImplReject,
  parseInvokeEnvelope,
  parseInvokeResult,
  parseRegistrySync,
} from './validate.js';
import { executeWorker } from './worker.js';

/** entry 提供的 host 通道：tool.callback 受限反向请求 + impl.swapped / health 通知。 */
export interface EngineHostChannel {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
}

/** worker 背停宽限：runBash 内部 timer 在先，背停只兜底（契约 §2.2）。 */
const WORKER_BACKSTOP_GRACE_MS = 5_000;

/** in-flight 记录键：与 host pending 表同约定（JSON 数组，无分隔符歧义）。 */
function callKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

interface InFlightCall {
  tool_name: string;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  /** 折结果收口（幂等）：cancel / timeout / remove / dispose 都经此。 */
  finish(result: ToolInvokeResult): void;
  /** 意外异常收口（entry 折 -32000）。 */
  fail(error: unknown): void;
}

export class ToolsEngine {
  private readonly registry = new Map<string, RegistryEntry & { rejected: boolean }>();
  private readonly inFlight = new Map<string, InFlightCall>();
  private disposed = false;

  constructor(private readonly hostChannel: EngineHostChannel) {}

  /** 注册表增量喂入（host 权威）；形状不过 → throw。 */
  handleRegistrySync(params: unknown): RegistrySyncResult {
    const sync = parseRegistrySync(params);
    for (const entry of sync.upsert) {
      const existing = this.registry.get(entry.name);
      if (existing !== undefined && existing.schema_fingerprint !== entry.schema_fingerprint) {
        // 指纹变化 → 自报替换；校验权在 host（对拍不一致会回 impl.reject）。
        this.hostChannel.notify(ENGINE_WIRE.implSwapped, {
          name: entry.name,
          schema_fingerprint: entry.schema_fingerprint,
        });
      }
      this.registry.set(entry.name, { ...entry, rejected: false });
    }
    for (const name of sync.remove) {
      this.registry.delete(name);
      // 在途调用折稳定错误（retryable:false 语义，run 继续）。
      for (const call of this.inFlight.values()) {
        if (call.tool_name === name) {
          call.controller.abort();
          call.finish({ content: ENGINE_ERROR.notRegistered(name) });
        }
      }
    }
    return { ok: true, loaded: [...this.registry.keys()] };
  }

  /** host 指纹对拍不一致 → 标记 rejected（转发侧 fail-closed；重新 upsert 清零）。 */
  handleImplReject(params: unknown): void {
    const { name } = parseImplReject(params);
    const entry = this.registry.get(name);
    if (entry !== undefined) entry.rejected = true;
  }

  /** 信封形状校验 → 注册表 / rejected / schema 子集 → 按 exec 机械路由。 */
  async handleInvoke(params: unknown): Promise<ToolInvokeResult> {
    if (this.disposed) throw new Error('tools engine is disposed');
    const envelope = parseInvokeEnvelope(params);
    const entry = this.registry.get(envelope.tool_name);
    if (entry === undefined) return { content: ENGINE_ERROR.notRegistered(envelope.tool_name) };
    if (entry.rejected) return { content: ENGINE_ERROR.implRejected(envelope.tool_name) };
    const violation = firstSchemaViolation(envelope.args, entry.inputSchema, '$');
    if (violation !== undefined) return { content: ENGINE_ERROR.invalidParams(violation) };
    return this.dispatch(envelope);
  }

  /** worker：abort 折 cancelled；callback：清 in-flight（host 迟到回包忽略）。 */
  handleCancel(params: unknown): void {
    const { run_id, tool_call_id } = parseCancelParams(params);
    const call = this.inFlight.get(callKey(run_id, tool_call_id));
    if (call === undefined) return;
    call.controller.abort();
    call.finish({ content: ENGINE_ERROR.cancelled });
  }

  health(): EngineHealthParams {
    return { status: 'ok', loaded: [...this.registry.keys()] };
  }

  /** abort 全部 in-flight（child 退出路径）。 */
  dispose(): void {
    this.disposed = true;
    for (const call of this.inFlight.values()) {
      call.controller.abort();
      call.finish({ content: ENGINE_ERROR.cancelled });
    }
  }

  private dispatch(envelope: ToolInvokeParams): Promise<ToolInvokeResult> {
    const key = callKey(envelope.run_id, envelope.tool_call_id);
    if (this.inFlight.has(key)) {
      throw new Error(`duplicate in-flight tool call: ${key}`);
    }
    const controller = new AbortController();
    let resolve!: (result: ToolInvokeResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ToolInvokeResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: InFlightCall = {
      tool_name: envelope.tool_name,
      controller,
      settled: false,
      finish: (result) => {
        if (call.settled) return;
        call.settled = true;
        this.inFlight.delete(key);
        if (call.timer !== undefined) clearTimeout(call.timer);
        resolve(result);
      },
      fail: (error) => {
        if (call.settled) return;
        call.settled = true;
        this.inFlight.delete(key);
        if (call.timer !== undefined) clearTimeout(call.timer);
        reject(error);
      },
    };
    this.inFlight.set(key, call);

    if (envelope.exec === 'worker') {
      const timeoutMs = envelope.timeout_ms;
      if (timeoutMs !== undefined) {
        call.timer = setTimeout(() => {
          controller.abort();
          call.finish({ content: ENGINE_ERROR.timeout(envelope.tool_name, timeoutMs) });
        }, timeoutMs + WORKER_BACKSTOP_GRACE_MS);
      }
      void executeWorker(envelope, controller.signal).then(call.finish, call.fail);
      return promise;
    }

    // callback：只带关联 id；host 按在途记录执行原 handler（fail-closed）。
    void this.hostChannel
      .request(ENGINE_WIRE.toolCallback, {
        run_id: envelope.run_id,
        tool_call_id: envelope.tool_call_id,
      })
      .then(
        (result) => {
          try {
            call.finish(parseInvokeResult(result));
          } catch (error) {
            call.fail(error);
          }
        },
        (error: unknown) => {
          // 业务错误折稳定文本：host 原 handler 错误文本 / callbackRejected 稳定文本。
          // cancel / dispose 已收口时 finish 幂等忽略（迟到回包不执行）。
          call.finish({ content: error instanceof Error ? error.message : String(error) });
        },
      );
    return promise;
  }
}
