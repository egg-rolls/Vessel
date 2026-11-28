/**
 * node 退出序列 + 关闭序列（P1 批6，自 bootstrap.ts 迁出；ADR-107 strangler）。
 * createShutdownSequence：drain-to-quiesce（fence → 不限时等活跃 run → flush）+
 * 幂等 shutdown；步骤顺序在工厂内显式顺序书写（原主干顺序逐字节保留）。
 * 晚绑定语义不变：trunk let 经 ctx getter 原地读、setter 原地清（清引用时序不变）。
 * 接线改动 = 17 行 getter/setter 替换；其余移动体逐字节（缩进 -2）。
 */

import type { EngineClient, PoolTransport } from '@vessel-agent/engine-client';
import type { Logger, Runtime } from '../../packages/core/src/index';
import {
  type createGatewayEventHub,
  type LocalRpcDispatcher,
  runShutdownStep,
  type ShutdownStepEmit,
} from '../../packages/serve/src/index';
import type { PeerNoticeRouter } from '../agent/peer-notices';
import type { StagingGcRunner } from '../data/attachment-staging';
import type { AutoPruneRunner } from '../data/auto-prune';
import type { ImageBlobGcRunner } from '../data/image-blob-gc';
import { reportShutdownFailure } from '../gateway/shutdown-report';
import { createNodeDrainer } from '../node/node-drain';
import type { createPluginHostManager } from '../plugin/plugin-host-assembly';
import type { startPluginWatch } from '../plugin/plugin-watch';
import type { SessionLock } from '../session/session-lock';
import type { EngineSupervisor } from '../tools-engine/supervisor';
import type { AgentActivityWatch } from './agent-activity-watch';
import type { BootstrapResult } from './bootstrap-types';
import type { NodeHealthWatch } from './node-health-watch';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** 关闭序列输入：稳定引用 + trunk 晚绑定 let 的 getter/setter 对。 */
export interface ShutdownSequenceContext {
  bundle: TenantRuntimeBundle;
  executionRuntime: Runtime;
  engineClient: EngineClient;
  engineSupervisor: EngineSupervisor | undefined;
  poolTransportRef: { current?: PoolTransport };
  localPluginWatch: ReturnType<typeof startPluginWatch>;
  localPluginHostManager: ReturnType<typeof createPluginHostManager>;
  localDispatcher: LocalRpcDispatcher;
  localEventHub: ReturnType<typeof createGatewayEventHub>;
  logger: Logger;
  tenantId: string;
  resolveProcessSessionLock: () => SessionLock | undefined;
  resolveAgentControl: () => BootstrapResult['agent'];
  resolveUnsubPermissionPersist: () => (() => void) | undefined;
  clearUnsubPermissionPersist: () => void;
  resolvePeerNotices: () => PeerNoticeRouter | undefined;
  clearPeerNotices: () => void;
  resolveNodeHealthWatch: () => NodeHealthWatch | undefined;
  clearNodeHealthWatch: () => void;
  resolveAgentActivityWatch: () => AgentActivityWatch | undefined;
  clearAgentActivityWatch: () => void;
  resolveImageBlobGc: () => ImageBlobGcRunner | undefined;
  clearImageBlobGc: () => void;
  resolveStagingGc: () => StagingGcRunner | undefined;
  clearStagingGc: () => void;
  resolveAutoPrune: () => AutoPruneRunner | undefined;
  clearAutoPrune: () => void;
  clearNoticeAgentService: () => void;
}

export function createShutdownSequence(ctx: ShutdownSequenceContext) {
  const {
    bundle,
    executionRuntime,
    engineClient,
    engineSupervisor,
    poolTransportRef,
    localPluginWatch,
    localPluginHostManager,
    localDispatcher,
    localEventHub,
    logger,
    tenantId,
    resolveProcessSessionLock,
    resolveAgentControl,
    resolveUnsubPermissionPersist,
    clearUnsubPermissionPersist,
    resolvePeerNotices,
    clearPeerNotices,
    resolveNodeHealthWatch,
    clearNodeHealthWatch,
    resolveAgentActivityWatch,
    clearAgentActivityWatch,
    resolveImageBlobGc,
    clearImageBlobGc,
    resolveStagingGc,
    clearStagingGc,
    resolveAutoPrune,
    clearAutoPrune,
    clearNoticeAgentService,
  } = ctx;
  // ── node 退出序列（drain-to-quiesce，用户裁定：缺省完全优雅）─────
  //   1) fence 准入（新投递只进 durable inbox 并返 deferred(draining)，
  //      q-inbox-ux-fix：人类输入不再拒绝；无 inbox 才 gateway_restarting）
  //      ——此后 live run 集合只减不增
  //   2) 不限时等所有活跃 run（含已受理排队的）自然跑完 + 每 5s 进度日志
  //   3) flush 会话状态
  // 不 interrupt、不写 resume 标记：run 自然完成就没有欠账。--force 是唯一
  // 非优雅路径（停止方 SIGKILL + stop.forced 审计，进程内代码不执行）。
  // 幂等：SIGTERM 连发 / vessel node stop 与 shutdown() 同时触发都只做一次。
  // 挂在 BootstrapResult.beginDrain 上，由 CLI 的退出路径在 gateway.stop() 之前调。
  const nodeDrainer = createNodeDrainer({
    units: () => executionRuntime.listExecutionUnits(),
    // scheduler 口径的 queued+running：fence 前已受理排队的 run 会在 drain 期间
    // 起跑，必须一并等完（只等执行面「此刻在跑」会漏掉它们）。
    liveRuns: () => {
      const snapshot = bundle.scheduler.snapshot?.();
      if (snapshot === undefined) return [];
      return [...snapshot.queued, ...snapshot.running].map((run) => ({
        run_id: run.runId,
        session_id: run.sessionId,
        status: run.state,
      }));
    },
    // 没有 AgentService（agent 关闭 / 极简入口）就没有 agent→agent 投递要排队：
    // beginFence 返回 false（fence 由 runs.start 闸门之后的调用方兜底判断）。
    beginFence: () => resolveAgentControl()?.service.beginDrain() ?? false,
    warn: (message, fields) => {
      logger.warn(message, fields);
    },
    info: (message, fields) => {
      logger.info(message, fields);
    },
  });

  /** 执行 node 退出序列（幂等，可在任何退出路径上重复调用）。 */
  const beginDrain = async (): Promise<void> => {
    try {
      const report = await nodeDrainer.beginDrain('shutdown');
      logger.info('node.drain.done', {
        settle: report.settle,
        drained_runs: report.drained_runs,
        duration_ms: report.duration_ms,
        already_draining: report.already_draining,
      });
    } catch (error) {
      // 退出序列失败不阻断退出（各步已自带日志）。
      logger.warn('node.drain.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // ── 关闭 ────────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (shutdownOptions: { drain?: boolean } = {}): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // DR15-1：退出步永久进度日志（挂起时最后一条 start 即挂点；复验实证哪步慢）。
    const emit: ShutdownStepEmit = (level, event, fields) => {
      if (level === 'warn') logger.warn(event, fields);
      else logger.info(event, fields);
    };
    // 0.52 S1a：退出序列第一段（幂等）。serve 壳在 gateway.stop() 之前已经调过一次；
    // 这里兜住「直接 shutdown() 的路径」——REPL 的 onExit、cleanup、uncaught 收尾。
    await runShutdownStep(emit, 'shutdown.beginDrain', () => beginDrain());

    try {
      resolveUnsubPermissionPersist()?.();
    } catch {
      // 退订是 best-effort
    }
    clearUnsubPermissionPersist();

    // 成员停下通知：先停路由器（清窗口定时器 + 退订 run.* 事件），再拆执行面。
    try {
      resolvePeerNotices()?.stop();
    } catch {
      // 退订 / 清定时器是 best-effort
    }
    clearPeerNotices();
    // q-health-subscription：健康探测节拍器停掉（在飞 tick 自然跑完，不阻塞退出）。
    try {
      resolveNodeHealthWatch()?.stop();
    } catch {
      // 清定时器是 best-effort
    }
    clearNodeHealthWatch();
    // q-sub-unify-p1：agent 活动 watcher 停掉（双流 unsubscribe + 清定时器；在飞 tick 自然跑完）。
    try {
      resolveAgentActivityWatch()?.stop();
    } catch {
      // 断链 / 清定时器是 best-effort
    }
    clearAgentActivityWatch();
    // 0.56 P1：blob GC 定时器（在飞的那一趟照旧跑完，不阻塞退出）。
    resolveImageBlobGc()?.stop();
    clearImageBlobGc();
    // file-ref-ux：暂存 TTL GC 定时器（在飞的那一趟照旧跑完）。
    resolveStagingGc()?.stop();
    clearStagingGc();
    // auto-gc P1：先停调度并**等在飞趟收口**再拆 agent 执行面 —— 在线趟会调
    // service.flushSnapshot，若 agent dispose 的终态 flush 先跑，已摘记录会被复活。
    resolveAutoPrune()?.stop();
    await resolveAutoPrune()?.idle();
    clearAutoPrune();
    // 0.53 notice-rotate：重解析口的宿主一并摘掉（router 已停，flush 不会再发生）。
    clearNoticeAgentService();

    // 0.17：先停 owner 端点，CLI 不再有机会在 teardown 中途入队。
    try {
      await runShutdownStep(emit, 'shutdown.agent.dispose', async () => {
        await resolveAgentControl()?.dispose();
      });
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'agent.dispose',
        error,
        tenantId,
      });
    }

    try {
      localPluginWatch.close();
    } catch {
      // watcher 关闭失败不阻断关停。
    }

    try {
      await runShutdownStep(emit, 'shutdown.plugin.stopAll', () =>
        localPluginHostManager.stopAll(),
      );
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'plugin.stopAll',
        error,
        tenantId,
      });
    }

    // tools-engine P2：expectedExit 停 engine child（不触发重启）+ 清 pending 关联。
    // run 已在 beginDrain 等到自然终态（drain-to-quiesce），无在途转发。
    // 池 S20：pool 模式 dispose PoolTransport（关连接/定时器；detached engine 归 gateway 生命周期，
    // node 退出不杀池）；child 模式语义不变（engineSupervisor 有值时 optional chain 等价原调用）。
    try {
      await runShutdownStep(emit, 'shutdown.toolsEngine.stop', async () => {
        await engineSupervisor?.stop();
        poolTransportRef.current?.dispose();
        engineClient.dispose();
      });
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'tools-engine.stop',
        error,
        tenantId,
      });
    }

    try {
      localDispatcher.dispose();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'dispatcher.dispose',
        error,
        tenantId,
      });
    }

    try {
      localEventHub.close();
    } catch (error) {
      reportShutdownFailure({
        events: bundle.events,
        logger,
        step: 'eventHub.close',
        error,
        tenantId,
      });
    }

    // bundle 关闭顺序：feishu → metrics → MCP → runtime
    // → trace → runStore → session；session 写锁由 bootstrap 在最后释放。
    await runShutdownStep(emit, 'shutdown.bundle.close', () => bundle.close(shutdownOptions));

    const sessionLock = resolveProcessSessionLock();
    if (sessionLock) {
      try {
        await runShutdownStep(emit, 'shutdown.sessionLock.release', () => sessionLock.release());
      } catch (error) {
        reportShutdownFailure({
          events: bundle.events,
          logger,
          step: 'sessionLock.release',
          error,
          tenantId,
        });
      }
    }
  };
  return { beginDrain, shutdown };
}
