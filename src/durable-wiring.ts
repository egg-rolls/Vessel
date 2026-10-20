/**
 * Durable run 接线（0.3 A1）。
 *
 * - 列表：running + interrupted，排序/上限由 core 的 RunStore 保证
 *   （updated_at 倒序、同值 run_id 升序；默认 50、最大 200）。
 * - 恢复路由（按 checkpoint.agent_id）：
 *   - 缺失 / owner / 宿主成员 → `host.resume()`；
 *   - 有 agent_id 且不是宿主成员 → 单 agent `AgentRuntime.resume()`；
 *   - `host.resume` 抛 `agent_not_found` 时**不回退**（避免双跑），原样上报。
 * - 禁止「seed session + 合成续跑消息」：恢复只走 core 的 resume。
 */

import type { RunCheckpoint, RunStore } from '../packages/core/src/index';
import type { DurableGatewayOptions } from '../packages/serve/src/index';
import type { TenantRuntimeFactory } from './tenant-runtime-factory';

/** TUI `/runs` 与 CLI 列表共用的摘要（只含可恢复状态） */
export interface DurableRunSummary {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted';
  updated_at: number;
  iteration?: number;
  preview?: string;
}

/** 恢复结局；`done` 约定不 reject */
export type DurableRunOutcome =
  | { status: 'completed'; message?: string }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };

/** TUI `/runs resume` 返回的句柄 */
export interface DurableRunHandleLike {
  runId: string;
  sessionId: string;
  done: Promise<DurableRunOutcome>;
  cancel(): void;
}

/** TUI `/runs` 控制面（durable 未启用时注入 undefined） */
export interface DurableRunsControlLike {
  list(opts?: {
    status?: 'running' | 'interrupted';
    session_id?: string;
    limit?: number;
  }): Promise<DurableRunSummary[]>;
  resume(runId: string): Promise<DurableRunHandleLike>;
}

/** 带稳定 code 的 resume 错误（与 core RunResumeError 的结构对齐） */
export interface ResumeErrorLike extends Error {
  code: string;
  runId: string;
}

/** 构造稳定错误 */
export function resumeError(code: string, runId: string, detail?: string): ResumeErrorLike {
  const error = new Error(detail ? `${code}: ${detail}` : code) as ResumeErrorLike;
  error.name = 'ResumeError';
  error.code = code;
  error.runId = runId;
  return error;
}

/** 类型守卫：错误是否带稳定 code */
export function isResumeError(error: unknown): error is ResumeErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** 提取列表预览：metadata.preview > 最后一条 user 消息（截断 60） */
export function previewOf(checkpoint: RunCheckpoint): string | undefined {
  const fromMeta = checkpoint.metadata?.preview;
  if (typeof fromMeta === 'string' && fromMeta.trim() !== '') return fromMeta;

  for (let i = checkpoint.messages.length - 1; i >= 0; i--) {
    const message = checkpoint.messages[i];
    if (message?.role !== 'user') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}...` : text;
  }
  return undefined;
}

/** 列出 running/interrupted run（排序/上限交给 core） */
export async function listRunSummaries(
  store: RunStore,
  opts?: {
    status?: 'running' | 'interrupted';
    session_id?: string;
    limit?: number;
  },
): Promise<DurableRunSummary[]> {
  const checkpoints = await store.list(opts);
  return checkpoints
    .filter(
      (checkpoint): checkpoint is RunCheckpoint & { status: 'running' | 'interrupted' } =>
        checkpoint.status === 'running' || checkpoint.status === 'interrupted',
    )
    .map((checkpoint) => ({
      run_id: checkpoint.run_id,
      session_id: checkpoint.session_id,
      ...(checkpoint.agent_id !== undefined ? { agent_id: checkpoint.agent_id } : {}),
      status: checkpoint.status,
      updated_at: checkpoint.updated_at,
      ...(checkpoint.iteration !== undefined ? { iteration: checkpoint.iteration } : {}),
      ...(previewOf(checkpoint) !== undefined ? { preview: previewOf(checkpoint) } : {}),
    }));
}

/**
 * 读取并校验可恢复 checkpoint。
 * @throws ResumeErrorLike `run_not_found` / `run_not_resumable`
 */
export async function loadResumableCheckpoint(
  store: RunStore,
  runId: string,
): Promise<RunCheckpoint> {
  const checkpoint = await store.load(runId);
  if (!checkpoint) throw resumeError('run_not_found', runId);
  if (checkpoint.status !== 'running' && checkpoint.status !== 'interrupted') {
    throw resumeError('run_not_resumable', runId, checkpoint.status);
  }
  if (!Array.isArray(checkpoint.messages) || checkpoint.messages.length === 0) {
    throw resumeError('run_not_resumable', runId, 'empty checkpoint');
  }
  return checkpoint;
}

/** resume 路由所需的宿主结构（避免依赖具体实现） */
export interface HostRouteLike {
  get(id: string): unknown;
  resume?(runId: string): Promise<unknown>;
}

/**
 * 选择恢复路径。
 * @param ownerId 本进程 owner 的 agent id（checkpoint 缺失 agent_id 时视为 owner）
 */
export function routeResume(
  checkpoint: RunCheckpoint,
  host: HostRouteLike | undefined,
  ownerId: string | undefined,
): 'host' | 'single-agent' {
  if (!host || typeof host.resume !== 'function') return 'single-agent';

  const agentId = checkpoint.agent_id;
  if (agentId === undefined) return 'host';
  if (ownerId !== undefined && agentId === ownerId) return 'host';
  if (host.get(agentId) !== undefined) return 'host';

  // 有 agent_id 但不是宿主成员：单 agent 恢复，避免把别的成员拉进宿主。
  return 'single-agent';
}

/** 把任意错误归一为 `done` 的 failed 结局（不 reject） */
export function toFailedOutcome(error: unknown): DurableRunOutcome {
  return { status: 'failed', error };
}

/**
 * 0.6.1 P0-2：gateway `durableFor(tenantId)` 的装配。
 *
 * - default tenant 返回 undefined：由 gateway 的 `durable`（bootstrap bundle）提供；
 * - 非 default tenant 只使用自己的 runStore；没有则 undefined（gateway 返回 403）；
 * - resume 只等待“受理”（host 创建 handle）；AgentRuntime.resume 的完成 Promise 不等待。
 */
export function createDurableFor(
  factory: Pick<TenantRuntimeFactory, 'bundleFor'> | undefined,
  defaultTenantId: string,
): (tenantId: string) => DurableGatewayOptions | undefined {
  return (tenantId) => {
    if (tenantId === defaultTenantId) return undefined;
    const bundle = factory?.bundleFor(tenantId);
    const store = bundle?.runStore;
    if (!store) return undefined;

    const host = bundle?.host;
    const hostResume = host?.resume;
    if (host && typeof hostResume === 'function') {
      return {
        store,
        resume: async (runId: string) => {
          const handle = await hostResume.call(host, runId);
          // 受理即返回；run 结束/失败不阻塞 HTTP。
          void handle.result.catch(() => {});
        },
      };
    }

    const runtime = bundle?.runtime;
    const runtimeResume = runtime?.resume;
    if (runtime && typeof runtimeResume === 'function') {
      return {
        store,
        resume: (runId: string) => {
          // AgentRuntime.resume 在 run 结束时才 resolve：不等待。
          void runtimeResume.call(runtime, runId).catch(() => {});
        },
      };
    }

    return { store };
  };
}
