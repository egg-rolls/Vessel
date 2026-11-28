/**
 * node 重启 / durable resume 面（P1 批5，自 bootstrap.ts 迁出；ADR-107 strangler）。
 * 两个纯闭包工厂（构造期零副作用）：
 * - createDurableResumeSurface：startResume / runs / resumeRun（原 Durable resume 段）；
 * - createNodeRestartSurface：updateResumeMarker / selfRestart / gatewayRestart（原预约受理段）。
 * 晚绑定语义不变：agentControl 经 ctx.resolveAgentControl getter 读 trunk 活引用。
 * 接线改动 = 3 行（clock / memberService / pendingInboxIds 改读 ctx）；其余移动体逐字节（缩进 -2）。
 * restart 工厂在 trunk 先于 agent 装配创建：updateResumeMarker 原为提升函数声明，
 * 供启动恢复段共用；工厂无构造期副作用，时序语义不变。
 */

import type { VesselConfig } from '../../packages/config/src/index';
import {
  type Logger,
  type RunOptions,
  type Runtime,
  sameRestartMarker,
  type TenantPaths,
} from '../../packages/core/src/index';
import type { ResumeAfterRestart } from '../../packages/core/src/types/session';
import {
  type GatewayRestartInput,
  type GatewayRestartResult,
  RpcError,
  type SelfRestartInput,
  type SelfRestartResult,
} from '../../packages/serve/src/index';
import { deliverAnsweredAsksToSession, orphanPendingAsksForRun } from '../cli/ask-channel';
import { selfRestartReserveCommand } from '../cli/commands/fleet/restart-command';
import { resolveInteractionsDir } from '../gateway/interactions-dir';
import {
  type DurableRunHandleLike,
  type DurableRunsControlLike,
  listRunSummaries,
  loadResumableCheckpoint,
  resumeError,
} from '../run/durable-wiring';
import { acquireSessionLock } from '../session/session-lock';
import type { BootstrapResult } from './bootstrap-types';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** durable resume 输入：trunk 稳定引用 + agentControl 活引用 getter。 */
export interface DurableResumeContext {
  bundle: TenantRuntimeBundle;
  runStore: TenantRuntimeBundle['runStore'];
  tenantPaths: TenantPaths;
  clock: (() => number) | undefined;
  dataDir: string;
  tenantId: string;
  logger: Logger;
  eventLog: TenantRuntimeBundle['eventLog'];
  resolveAgentControl: () => BootstrapResult['agent'];
}

export function createDurableResumeSurface(ctx: DurableResumeContext) {
  const {
    bundle,
    runStore,
    tenantPaths,
    clock,
    dataDir,
    tenantId,
    logger,
    eventLog,
    resolveAgentControl,
  } = ctx;
  const startResume = async (
    runId: string,
    opts?: RunOptions,
  ): Promise<DurableRunHandleLike & { mode: 'single-agent' }> => {
    if (!runStore) {
      throw resumeError('durable_disabled', runId, 'durable.enabled is false');
    }

    const checkpoint = await loadResumableCheckpoint(runStore, runId);
    // 0.15: one writer per run across processes.
    const runLock = await acquireSessionLock({
      tenantDir: tenantPaths.root,
      kind: 'run',
      id: runId,
      ...(clock ? { now: clock } : {}),
    });

    // 0.33 A：headless ask 的回答在 resume 前以 `user.message` 事件注入历史。
    // 走既有 projection 路径（见 ask-channel），不改 core resume 契约；重复 resume
    // 由 `source + request_id` 去重。
    const interactionsDir = resolveInteractionsDir(dataDir);
    try {
      const delivered = await deliverAnsweredAsksToSession({
        ...(eventLog !== undefined ? { eventLog } : {}),
        dir: interactionsDir,
        tenantId,
        runId,
        sessionId: checkpoint.session_id,
      });
      if (delivered > 0) {
        logger.info('ask.resume.answers_delivered', { run_id: runId, count: delivered });
      }
    } catch (error) {
      logger.warn('ask.resume.deliver_failed', {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const controller = new AbortController();
    // 调用方的 signal（headless ask 挂起用 abort('timeout')）桥接到内部 controller；
    // 原先直接覆盖会丢掉外部中断，导致 resume 无法从 headless 收口。
    const externalSignal = opts?.signal;
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else {
        externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
          once: true,
        });
      }
    }
    const resumeOptions = { ...opts, signal: controller.signal };
    // Stage 4：成员 run 有 agent_id，回到 AgentService（scheduler 串行 / active run
    // 记账 / lease 续租都复用）；tenant run 直接按 session 取 EU 恢复。不新增 RPC。
    const memberService = resolveAgentControl()?.service;
    const promise =
      checkpoint.agent_id !== undefined && memberService !== undefined
        ? memberService.resumeRun(runId, resumeOptions)
        : // tenant run：走 bundle 的 per-session 门面，复用 owner Self Card / context
          // 覆盖与 run 级文件锁（startResume 已持有一次，session-lock 引用计数消化）。
          typeof bundle.runtime.resumeRun === 'function'
          ? bundle.runtime.resumeRun(runId, resumeOptions)
          : Promise.reject(
              resumeError('resume_unavailable', runId, 'runtime does not support resumeRun'),
            );
    const done = promise
      .then(
        (message) => ({ status: 'completed' as const, message }),
        (error) =>
          controller.signal.aborted
            ? { status: 'cancelled' as const }
            : { status: 'failed' as const, error },
      )
      .then(async (outcome) => {
        // run 真正收口后，遗留的 pending ask 不再可回答。
        // `timeout` 是 headless ask 挂起（checkpoint interrupted），必须保留。
        const suspended = controller.signal.aborted && controller.signal.reason === 'timeout';
        if (!suspended && (outcome.status === 'completed' || outcome.status === 'cancelled')) {
          try {
            const orphaned = await orphanPendingAsksForRun({
              dir: interactionsDir,
              tenantId,
              runId,
            });
            if (orphaned > 0) {
              logger.info('ask.resume.orphaned', { run_id: runId, count: orphaned });
            }
          } catch (error) {
            logger.warn('ask.resume.orphan_failed', {
              run_id: runId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return outcome;
      })
      .finally(() => {
        void runLock.release();
      });

    return {
      runId,
      sessionId: checkpoint.session_id,
      done,
      cancel: () => controller.abort(),
      mode: 'single-agent',
    };
  };

  const runs: DurableRunsControlLike | undefined = runStore
    ? {
        list: (listOptions) => listRunSummaries(runStore, listOptions),
        resume: (runId) => startResume(runId),
      }
    : undefined;

  const resumeRun: BootstrapResult['resumeRun'] = async (runId, opts) => {
    const started = await startResume(runId, opts);
    const outcome = await started.done;
    if (outcome.status === 'cancelled') {
      throw resumeError('resume_cancelled', runId);
    }
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error
        ? outcome.error
        : resumeError('resume_failed', runId, String(outcome.error));
    }
    return {
      sessionId: started.sessionId,
      result: outcome.message ?? '',
      mode: started.mode,
    };
  };
  return { runs, resumeRun };
}

/** 重启预约面输入：trunk 稳定引用 + agentControl 活引用 getter。 */
export interface NodeRestartContext {
  bundle: TenantRuntimeBundle;
  executionRuntime: Runtime;
  config: VesselConfig;
  dataDir: string;
  logger: Logger;
  resolveAgentControl: () => BootstrapResult['agent'];
}

export function createNodeRestartSurface(ctx: NodeRestartContext) {
  const { bundle, executionRuntime, config, dataDir, logger, resolveAgentControl } = ctx;
  const { session, journalFactory, runtimeEvents } = bundle;
  // ── 自重启 Option A：预约受理（node.restart.self 的 asm 实现）─────────
  // 写 continuation 标记（RunJournal 单写口 + 注册表竞态防护）后**立即返回**：
  // 工具调用不跨进程死亡（避 run lost）。触发者 run 自然完成 → detached 编排者
  // 等 quiesce → 优雅 stop/start → 新进程按标记续作（node-continuation）。

  /**
   * 标记单写口更新（函数声明，提升供启动恢复段与本实现共用）：只更新「还是同一份
   * 标记」的那一个，transform 返回 undefined = 清除。落盘走 RunJournal（唯一写口）。
   * 注意：若标记已在本进程注册表武装（预约受理），journal 合并会把它带回来——
   * 清除类操作必须先 bundle.resumeMarkers.clear（见 cancel 分支）。
   */
  async function updateResumeMarker(
    sessionId: string,
    key: { run_id: string; interrupted_at: number },
    transform: (marker: ResumeAfterRestart) => ResumeAfterRestart | undefined,
  ): Promise<boolean> {
    const state = await session.load(sessionId);
    if (state === null) return false;
    if (!sameRestartMarker(state.resume_after_restart, key)) return false;
    const current = state.resume_after_restart;
    if (current === undefined) return false;
    const next = transform(current);
    const journal = journalFactory.transient({
      runId: 'manual',
      events: runtimeEvents,
      sessionId,
    });
    if (next === undefined) {
      const { resume_after_restart: _cleared, ...rest } = state;
      await journal.saveSessionState(rest);
    } else {
      await journal.saveSessionState({ ...state, resume_after_restart: next });
    }
    return true;
  }

  const selfRestart = async (input: SelfRestartInput): Promise<SelfRestartResult> => {
    const sessionId = input.session_id;
    if (input.cancel === true) {
      // 编排者等待超时撤销：先卸注册表（否则 journal 合并会把标记带回来），再清盘。
      bundle.resumeMarkers.clear(sessionId);
      const state = await session.load(sessionId);
      const marker = state?.resume_after_restart;
      if (state === null || marker === undefined || marker.continuation === undefined) {
        return { cancelled: false, session_id: sessionId };
      }
      const cancelled = await updateResumeMarker(
        sessionId,
        { run_id: marker.run_id, interrupted_at: marker.interrupted_at },
        () => undefined,
      );
      logger.info('node.self_restart.cancelled', { session_id: sessionId, cancelled });
      return { cancelled, session_id: sessionId };
    }
    // 受理：触发者必须是该会话此刻的活跃 run（自重启从 run 内发起）。
    type SelfRestartUnit = ReturnType<typeof executionRuntime.listExecutionUnits>[number];
    let unit: SelfRestartUnit | undefined;
    let activeRunId: string | undefined;
    for (const candidate of executionRuntime.listExecutionUnits()) {
      const snapshot = candidate.activeRunSnapshot();
      if (snapshot !== undefined && snapshot.session_id === sessionId) {
        unit = candidate;
        activeRunId = snapshot.run_id;
        break;
      }
    }
    if (unit === undefined || activeRunId === undefined) {
      throw new RpcError(
        'no_active_run',
        'node.restart.self must be triggered from an active run of the session',
      );
    }
    if (input.run_id !== undefined && input.run_id !== activeRunId) {
      throw new RpcError(
        'run_mismatch',
        `run_id ${input.run_id} is not the active run of the session`,
      );
    }
    const requestedAt = Date.now();
    const marker: ResumeAfterRestart = {
      run_id: activeRunId,
      interrupted_at: requestedAt,
      reason: 'shutdown',
      pending_input_ids: [
        ...(resolveAgentControl()?.service.pendingInboxIdsBySession().get(sessionId) ?? []),
      ],
      background_stopped: false,
      intent: 'restart',
      continuation: { prompt: input.prompt ?? '', requested_at: requestedAt },
    };
    // 先登记竞态保护再落盘：run 终态保存会重建会话状态，注册表让它别把标记冲掉。
    bundle.resumeMarkers.arm(sessionId, marker);
    const persisted = await unit.armResumeAfterRestart(sessionId, marker);
    if (!persisted) {
      bundle.resumeMarkers.clear(sessionId);
      throw new RpcError('marker_failed', 'failed to persist the continuation marker');
    }
    logger.info('node.self_restart.accepted', { session_id: sessionId, run_id: activeRunId });
    return { accepted: true, run_id: activeRunId, session_id: sessionId };
  };

  /**
   * q-restart-tool：请求级重启的缺省续作点火文本（用户裁定 B）。
   * prompt 缺省时替代模型嘱托写入 continuation.prompt——重启后新 run 自动起跑，
   * 模型无需给自己写启动提示词；投递仍走既有 resumeContinuations startup:true 通道。
   */
  const REQUEST_LEVEL_CONTINUATION_PROMPT =
    '【系统·请求级重启恢复】节点刚完成一次请求边界重启（gateway.restart）；你上一回合的 run 已正常结束，' +
    '重启不是故障。请检查对话上下文、inbox 与待办事项，从断点继续未完成的工作；' +
    '若没有待办，简要确认状态后正常收尾。';

  /**
   * q-restart-tool：`gateway.restart` 的完整预约（vessel 工具面 op=rpc 入口）。
   * 整体复用 CLI 的 selfRestartReserveCommand：认触发者 → loopback node.restart.self
   * 写 continuation 标记 → handoff → spawn detached 编排者（windowsHide）→ 回填 pid
   * → 立即返回。编排者等 run 终态 / fail-safe 超时不重启 / 续作投递全部不变。
   * config 用启动快照（token/TLS 判定与 CLI loadConfig 同口径；热应用极少改 node 段）。
   */
  const gatewayRestart = async (input: GatewayRestartInput): Promise<GatewayRestartResult> => {
    const requestLevel = input.prompt === undefined || input.prompt.trim() === '';
    const prompt = requestLevel ? REQUEST_LEVEL_CONTINUATION_PROMPT : (input.prompt as string);
    let reserved:
      | { session_id: string; run_id: string; orchestrator_pid: number; wait_timeout_ms: number }
      | undefined;
    const errors: string[] = [];
    const code = await selfRestartReserveCommand({
      deps: {},
      env: process.env,
      config,
      dataDir,
      prompt,
      session: input.session_id,
      ...(input.run_id !== undefined ? { run: input.run_id } : {}),
      ...(input.wait_timeout_ms !== undefined ? { waitTimeoutMs: input.wait_timeout_ms } : {}),
      print: () => undefined,
      printErr: (line) => errors.push(line),
      onReserved: (info) => {
        reserved = info;
      },
    });
    if (code !== 0 || reserved === undefined) {
      throw new RpcError(
        'restart_reserve_failed',
        errors.join('\n') || 'self-restart reservation failed',
      );
    }
    logger.info('gateway.restart.accepted', {
      session_id: reserved.session_id,
      run_id: reserved.run_id,
      orchestrator_pid: reserved.orchestrator_pid,
      request_level: requestLevel,
    });
    return { accepted: true, ...reserved };
  };
  return { updateResumeMarker, selfRestart, gatewayRestart };
}
