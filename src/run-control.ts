/**
 * AgentService + InProcessScheduler → canonical `runs.*` 控制面适配（0.27）。
 *
 * 只做形状映射：受理 / 取消 / 快照的生命周期全部在 `@vessel-agent/agent`
 * 与 core scheduler。`runs.start` 统一走 `AgentService.admit`（run_id 由
 * admit 生成，适配层不自造）；`runs.cancel` / live snapshot 直连 tenant
 * bundle 的唯一 scheduler（spec §5.1）。与 `agent-control.ts` 同构。
 *
 * @module vessel/run-control
 */

import type { AdmitInput, AgentService } from '@vessel-agent/agent';
import type { RunStatus, Scheduler, SchedulerSnapshot, WaitReason } from '@vessel-agent/core';
import type {
  LiveRunSnapshotLike,
  RunControlLike,
  RunControlSnapshotLike,
  RunControlStatus,
  RunStartLikeInput,
  RunStartLikeResult,
} from '../packages/serve/src/run-control.js';

function statusOf(state: RunStatus): RunControlStatus {
  return state;
}

/**
 * 适配层返回形状：`AdmitResult.session_id` 是本次解析 / 创建的 body id。
 *
 * `RunStartLikeResult` 只约束 run 状态，没有 session；但 gateway 的
 * `runs.start` 会把控制面回传的 `session_id` 原样带给 Web（不编造）。
 * 新会话首次发送依赖它回填路由，所以这里必须透传，不能丢。
 */
interface RunStartResultWithSession extends RunStartLikeResult {
  session_id?: string;
}

/** camelCase `RunSnapshot` → snake_case `LiveRunSnapshotLike`。 */
function mapRun(run: {
  runId: string;
  agentId: string;
  sessionId: string;
  state: RunStatus;
  queuePosition?: number;
  waitReason?: WaitReason;
  queuedAt?: number;
  startedAt?: number;
}): LiveRunSnapshotLike {
  return {
    run_id: run.runId,
    agent_id: run.agentId,
    session_id: run.sessionId,
    status: statusOf(run.state),
    ...(run.queuePosition !== undefined ? { queue_position: run.queuePosition } : {}),
    ...(run.waitReason !== undefined ? { wait_reason: run.waitReason } : {}),
    ...(run.queuedAt !== undefined ? { queued_at: run.queuedAt } : {}),
    ...(run.startedAt !== undefined ? { started_at: run.startedAt } : {}),
  };
}

/**
 * `snapshot()` 在 `Scheduler` 接口上是可选的；缺实现时降级为 stats 计数
 * （queue 长度未知，用 0 长度数组，serve 侧按 live 为空处理）。
 */
function snapshotOf(scheduler: Scheduler): RunControlSnapshotLike {
  const snapshot = scheduler.snapshot?.();
  if (snapshot === undefined) {
    return {
      as_of: Date.now(),
      queued: [],
      running: [],
      stats: scheduler.stats(),
    };
  }
  const { asOf, queued, running, stats } = snapshot as SchedulerSnapshot;
  return {
    as_of: asOf,
    queued: queued.map(mapRun),
    running: running.map(mapRun),
    stats,
  };
}

/** 用 app 侧的 AgentService + scheduler 构造注入给 gateway 的 run 控制面。 */
export function createRunControl(
  service: AgentService,
  scheduler: Scheduler,
  tenantId: string,
): RunControlLike {
  return {
    tenantId,
    async start(input: RunStartLikeInput): Promise<RunStartLikeResult> {
      // run_id 由 admit 生成（与 body / dispatch / team 同一入口，0.27 D4）。
      const admit: AdmitInput = {
        content: input.input,
        ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      };
      const result = await service.admit(admit);
      const mapped: RunStartResultWithSession = {
        run_id: result.run_id,
        status: statusOf(result.status),
        ...(result.queue_position !== undefined ? { queue_position: result.queue_position } : {}),
        // 新会话由服务端在本 agent 下建 body；不回填这个 session，Web 无法把草稿
        // 切到真实会话（没有本地兜底，缺失即视为契约失败）。
        ...(result.session_id ? { session_id: result.session_id } : {}),
      };
      return mapped;
    },
    cancel(runId: string, reason?: string): boolean {
      return scheduler.cancel(runId, reason);
    },
    snapshot(): RunControlSnapshotLike {
      return snapshotOf(scheduler);
    },
  };
}
