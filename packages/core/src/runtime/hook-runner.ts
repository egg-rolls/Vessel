/**
 * Hook 编排器（五阶段）。
 * 从 ExecutionUnit 抽出（ADR-033 编排逻辑外推），保持单一职责。
 *
 * 0.5：发 `hook.started` / `hook.completed` / `hook.failed`（DECISION-010 §2.2）。
 * 0.8 C2：单个 hook 抛错不再向上传播——发 `hook.error`（并保留 `hook.failed` 兼容），
 * 继续执行后续 hook。坏插件不得拖垮整个 run。
 *
 * @module @vessel-agent/core/runtime
 */

import type { EventStream } from '../types/event.js';
import { type HookContext, type HookResult, HookType } from '../types/hook.js';
import type { PluginHost } from '../types/plugin.js';

/**
 * 聚合两个 requestExtras（additive，q-thinking-plugin）：顶层键浅合并，后到覆盖先到
 * （与 updatedInput「后写生效」同口径）；同键不同值被覆盖时经 onConflict 发一次冲突信号。
 */
function mergeRequestExtras(
  base: HookResult['requestExtras'],
  incoming: NonNullable<HookResult['requestExtras']>,
  onConflict: (key: string) => void,
): NonNullable<HookResult['requestExtras']> {
  const out: NonNullable<HookResult['requestExtras']> = {};
  const headers: Record<string, string> = { ...(base?.headers ?? {}) };
  for (const [key, value] of Object.entries(incoming.headers ?? {})) {
    if (key in headers && headers[key] !== value) onConflict(`headers.${key}`);
    headers[key] = value;
  }
  const params: Record<string, unknown> = { ...(base?.params ?? {}) };
  for (const [key, value] of Object.entries(incoming.params ?? {})) {
    if (key in params && params[key] !== value) onConflict(`params.${key}`);
    params[key] = value;
  }
  if (Object.keys(headers).length > 0) out.headers = headers;
  if (Object.keys(params).length > 0) out.params = params;
  return out;
}

/**
 * 依次运行某阶段的 hook。
 *
 * 0.6.1 P2：聚合 hook 返回值——`updatedInput` 写回 ctx.input 供后续 hook/handler 使用，
 * `additionalContext` 拼接（deprecated：runtime 只把它作为尾消息，不再拼进 system），
 * `block` 短路后续 hook。返回 `{}` 表示全部不干预，因此旧的
 * `await runner.run(...)`（忽略返回值）保持兼容。
 */
export class HookRunner {
  constructor(
    private host: PluginHost,
    private events?: EventStream,
  ) {}

  async run(type: HookType, ctx: HookContext): Promise<HookResult> {
    const hooks = this.host.getHooks().filter((h) => h.type === type);
    const merged: HookResult = {};

    for (const hook of hooks) {
      const startedAt = Date.now();
      this.publish('hook.started', {
        hook_name: hook.name,
        hook_type: type,
        run_id: ctx.run_id,
        ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
      });

      try {
        const result = await hook.run(ctx);
        this.publish('hook.completed', {
          hook_name: hook.name,
          hook_type: type,
          run_id: ctx.run_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          duration_ms: Date.now() - startedAt,
        });

        if (!result) continue;

        if (result.updatedInput !== undefined) {
          // 后续 hook 与工具 handler 看到改写后的输入
          ctx.input = result.updatedInput;
          merged.updatedInput = result.updatedInput;
        }
        if (result.additionalContext) {
          merged.additionalContext = merged.additionalContext
            ? `${merged.additionalContext}\n${result.additionalContext}`
            : result.additionalContext;
        }
        if (type === HookType.BeforeLlm && result.requestExtras) {
          const next = mergeRequestExtras(merged.requestExtras, result.requestExtras, (key) => {
            this.publish('hook.request_extras_conflict', {
              hook_name: hook.name,
              key,
              run_id: ctx.run_id,
              ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
            });
          });
          if (next.headers !== undefined || next.params !== undefined) {
            merged.requestExtras = next;
          }
        }
        if (result.block) {
          merged.block = true;
          if (result.reason !== undefined) merged.reason = result.reason;
          return merged;
        }
      } catch (error) {
        const payload = {
          hook_name: hook.name,
          hook_type: type,
          run_id: ctx.run_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
        // 0.8 C2：隔离故障。`hook.failed` 保留给既有订阅方，`hook.error` 为统一信号。
        this.publish('hook.failed', payload);
        this.publish('hook.error', payload);
        // 继续下一个 hook：单点故障不能终止 run，也不能丢弃已聚合的结果。
      }
    }

    return merged;
  }

  private publish(type: string, data: Record<string, unknown>): void {
    if (!this.events) return;
    const runId = typeof data.run_id === 'string' ? data.run_id : 'hook';
    this.events.publish({
      type,
      run_id: runId,
      data,
      ts: Date.now(),
    });
  }
}
