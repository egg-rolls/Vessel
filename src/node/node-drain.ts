/**
 * node 优雅退出（drain-to-quiesce，用户裁定：stop/restart 缺省 = 完全优雅）。
 *
 * 目标只有一条：**进程退出前，已收下的活全部自然跑完，不白跑、不打断**。
 * 顺序是硬要求，不能换：
 *
 *   1. fence 准入  —— 先关闸：新的投递（人类 runs.start 与 agent→agent）只进
 *                     durable inbox（语义 deferred(draining)，q-inbox-ux-fix：不再
 *                     拒绝人类输入，正文持久化、node 回来重投）；无 durable inbox
 *                     才拒（gateway_restarting）。
 *                     fence 之后 live run 集合只减不增（没有任何路径再起新 run）。
 *   2. quiesce 等待 —— **不限时**等所有活跃 run 自然到达终态（completed/failed/cancelled）：
 *                     判定集 = 执行面 activeRunSnapshot ∪ scheduler 的 queued+running
 *                     （已受理排队的 run 也会起跑，必须一并等完）。
 *                     不 interrupt、不写 resume 标记——run 自然完成就没有欠账，
 *                     终态 checkpoint 由 run 生命周期自己落盘。
 *                     等待期间每 progressIntervalMs（缺省 5s）记一条进度日志
 *                     （哪些 run 还在跑、已等多久）；停止方另有 runs.list 采样进度。
 *   3. flush —— 把在途会话状态刷干净。
 *
 * **--force 是唯一的非优雅路径**：停止方快照在跑 run + SIGKILL/无条件终止 +
 * `stop.forced` 审计（abnormal_exit / runs_cut），进程内代码根本不执行；
 * 事后由启动 sweep 对账（run lost）+ 恢复链路兜底。本模块不做任何强杀。
 *
 * 历史注记：0.52 S1a 的旧实现是「写 resume 标记 + interrupt('shutdown') + ≤2s settle」，
 * run 被打断落 interrupted checkpoint。用户裁定升级为完全优雅 drain-to-quiesce：
 * 等 run 真跑完再退出，打断 + 标记路径从缺省退出序列中移除。
 *
 * 幂等：退出期间连收信号是常态，重复 beginDrain() 只回报第一次的结果。
 *
 * @module vessel/node-drain
 */

/** quiesce 轮询间隔（毫秒）：只查同步快照，不起任何 run。 */
const QUIESCE_POLL_MS = 100;

/** 进度日志间隔（毫秒）：不限时 ≠ 无反馈，与停止方 5s 采样同节奏。 */
const QUIESCE_PROGRESS_MS = 5_000;

/**
 * 退出路径要的执行面最小契约。
 *
 * 故意用结构类型而不是直接吃 ExecutionUnit：装配层只需要这两个动作
 * （快照 / 刷盘）。drain-to-quiesce 不打断、不写标记，故契约里没有
 * interrupt / armResumeAfterRestart。
 */
export interface NodeDrainUnit {
  /** 在跑 run 的只读快照；没有就 undefined。 */
  activeRunSnapshot(): { run_id: string; session_id: string } | undefined;
  /** 刷在途状态写入（可选：老执行面没有就跳过）。 */
  flushStateWrites?(): Promise<void>;
}

/** quiesce 判定 / 进度日志里的一条 live run（scheduler 口径：queued + running）。 */
export interface NodeDrainLiveRun {
  run_id: string;
  session_id: string;
  status: string;
}

/** 退出路径的数据来源（由装配层注入）。 */
export interface NodeDrainSources {
  /** 当前全部执行面（tenant EU + 成员 EU 都要在）。 */
  units(): ReadonlyArray<NodeDrainUnit>;
  /**
   * scheduler 的 live run 快照（queued + running）。
   *
   * 为什么除了执行面快照还要它：fence 之前已受理、尚在排队的 run 会在 drain 期间
   * 起跑——只等「此刻在跑」会漏掉它们（进程退出时它们刚起跑就被杀）。
   * 两个来源取并集（按 run_id 去重），全空才算 quiesce。
   * 可选：没有 scheduler 的极简入口退化为只看执行面快照。
   */
  liveRuns?(): ReadonlyArray<NodeDrainLiveRun>;
  /**
   * 打开准入 fence。返回 true = 本次真的开了；false = 之前就开着。
   * fence 的语义由装配层实现（AgentService.beginDrain + runs.start 闸门）。
   */
  beginFence(): boolean;
  /** 时钟（缺省 Date.now）。 */
  now?(): number;
  /** quiesce 轮询间隔覆盖（缺省 QUIESCE_POLL_MS）。 */
  pollMs?: number;
  /** 进度日志间隔覆盖（缺省 QUIESCE_PROGRESS_MS）。 */
  progressIntervalMs?: number;
  /** 警告日志（缺省静默）。 */
  warn?(message: string, fields?: Record<string, unknown>): void;
  /** 进度日志（缺省静默）。 */
  info?(message: string, fields?: Record<string, unknown>): void;
}

/** quiesce 结局：没有在跑 run / 全部自然跑完。不限时 ⇒ 没有 timeout 态。 */
export type NodeDrainSettle = 'idle' | 'settled';

/** 一次 drain 的完整报告（日志用）。 */
export interface NodeDrainReport {
  reason: 'shutdown';
  /** true = 本次调用没有真正开 fence（之前就在 drain 中）。 */
  already_draining: boolean;
  settle: NodeDrainSettle;
  /** drain 期间观察到并等到终态的 run 数（按 run_id 去重）。 */
  drained_runs: number;
  duration_ms: number;
}

/** 退出序列门面。 */
export interface NodeDrainer {
  /**
   * 执行退出序列（幂等）。
   *
   * 第一次调用走完整流程并缓存报告；之后每次都返回同一份报告。
   */
  beginDrain(reason?: 'shutdown'): Promise<NodeDrainReport>;
  /** fence 是否已打开（含「上一次 drain 已完成」）。 */
  isDraining(): boolean;
  /** 已完成 / 进行中的报告。 */
  report(): NodeDrainReport | undefined;
}

/** 睡给定毫秒（quiesce 轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * 造一个退出序列执行器。
 *
 * 只依赖注入进来的执行面快照 / live run 快照 / fence，自己不做 IO。
 */
export function createNodeDrainer(sources: NodeDrainSources): NodeDrainer {
  const now = sources.now ?? (() => Date.now());
  const pollMs = Math.max(1, sources.pollMs ?? QUIESCE_POLL_MS);
  const progressIntervalMs = Math.max(pollMs, sources.progressIntervalMs ?? QUIESCE_PROGRESS_MS);
  const warn = sources.warn ?? (() => undefined);
  const info = sources.info ?? (() => undefined);
  let draining = false;
  let inFlight: Promise<NodeDrainReport> | undefined;
  let settledReport: NodeDrainReport | undefined;

  /** 当前全部 live run（执行面 ∪ scheduler，按 run_id 去重）。 */
  function activeRuns(): NodeDrainLiveRun[] {
    const byId = new Map<string, NodeDrainLiveRun>();
    for (const unit of sources.units()) {
      const snapshot = unit.activeRunSnapshot();
      if (snapshot === undefined) continue;
      if (!byId.has(snapshot.run_id)) {
        byId.set(snapshot.run_id, { ...snapshot, status: 'running' });
      }
    }
    for (const run of sources.liveRuns?.() ?? []) {
      // scheduler 口径优先（queued/running 更精确）；执行面快照兜底无 scheduler 的入口。
      byId.set(run.run_id, run);
    }
    return [...byId.values()];
  }

  /**
   * 2 步：不限时等所有 live run 自然终态。只看同步快照，不持任何 run promise。
   * fence 已关闸 ⇒ live 集合只减不增，全空即稳定 quiesce。
   */
  async function quiesce(startedAt: number): Promise<{ settle: NodeDrainSettle; drained: number }> {
    const drained = new Set<string>();
    let nextProgressAt = now() + progressIntervalMs;
    for (;;) {
      const active = activeRuns();
      if (active.length === 0) {
        return { settle: drained.size > 0 ? 'settled' : 'idle', drained: drained.size };
      }
      for (const run of active) drained.add(run.run_id);
      const at = now();
      if (at >= nextProgressAt) {
        nextProgressAt = at + progressIntervalMs;
        info('node.drain.waiting', {
          waited_ms: at - startedAt,
          runs: active.map((run) => ({
            run_id: run.run_id,
            session_id: run.session_id,
            status: run.status,
          })),
        });
      }
      await sleep(pollMs);
    }
  }

  /** 3 步：flush 在途状态写入（失败只记日志，绝不让退出卡住）。 */
  async function flush(): Promise<void> {
    const flushes = sources
      .units()
      .map((unit) => unit.flushStateWrites?.())
      .filter((pending): pending is Promise<void> => pending !== undefined);
    if (flushes.length === 0) return;
    await Promise.all(
      flushes.map((pending) =>
        pending.catch((error: unknown) => {
          warn('node.drain.flush_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );
  }

  async function run(): Promise<NodeDrainReport> {
    const startedAt = now();
    // 1. fence：先关闸，此后没有任何路径再起新 run。
    const opened = sources.beginFence();
    draining = true;
    // 2. 不限时等活跃 run 自然完成（不 interrupt、不写标记）。
    const { settle, drained } = await quiesce(startedAt);
    // 3. flush。
    await flush();
    const report: NodeDrainReport = {
      reason: 'shutdown',
      already_draining: !opened,
      settle,
      drained_runs: drained,
      duration_ms: now() - startedAt,
    };
    settledReport = report;
    return report;
  }

  return {
    beginDrain(_reason = 'shutdown') {
      if (settledReport !== undefined) return Promise.resolve(settledReport);
      if (inFlight !== undefined) return inFlight;
      inFlight = run();
      return inFlight;
    },
    isDraining() {
      return draining;
    },
    report() {
      return settledReport;
    },
  };
}
