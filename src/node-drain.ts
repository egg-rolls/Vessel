/**
 * node 优雅退出的第一段（0.52 S1a）。
 *
 * 目标只有一条：**进程被 SIGTERM / vessel node stop 打断时，正在跑的活不白跑**。
 * 顺序是硬要求，不能换：
 *
 *   1. fence 准入  —— 先关闸：新的 runs.start 立刻被拒（gateway_restarting），
 *                     agent→agent 投递只进 durable inbox（语义 queued）；
 *   2. 写 resume 标记 —— **只给有在跑 run 的会话**写一条，走 RunJournal 单写口；
 *   3. interrupt('shutdown') —— 打断在跑 run（checkpoint 落 interrupted）；
 *   4. settle —— 最多 2s 等这些 run 收口；
 *   5. flush —— 把在途会话状态刷干净（半截回复也要落地）。
 *
 * 边界（S1a 不做，别在这里顺手加）：
 * - 不 await 任何模型流 / 长工具 / 后台进程：预算只有 2s，超时就走；
 * - 不做启动侧重放（S1c）、不做 restart 工具（S2）、不碰 gateway / handoff / lease；
 * - 不为静止会话预打标记（没在跑 run 就一条都不写）。
 *
 * 幂等：退出期间连收信号是常态，重复 beginDrain() 只回报第一次的结果，
 * 不会重复写标记、不会重复 interrupt。
 *
 * @module vessel/node-drain
 */

import type { ResumeAfterRestart } from '../packages/core/src/types/session.js';

/** settle 预算（毫秒）：S1a 的硬上限，超时直接进入 flush。 */
export const NODE_DRAIN_SETTLE_MS = 2000;

/** settle 轮询间隔（毫秒）：只查同步快照，不起任何 run。 */
const SETTLE_POLL_MS = 10;

/**
 * 退出路径要的执行面最小契约。
 *
 * 故意用结构类型而不是直接吃 ExecutionUnit：探针可以拿替身顶上来，
 * 装配层也只需要这三个动作（快照 / 写标记 / 打断）。
 */
export interface NodeDrainUnit {
  /** 在跑 run 的只读快照；没有就 undefined。 */
  activeRunSnapshot(): { run_id: string; session_id: string } | undefined;
  /** 写续跑标记（必须走 RunJournal 单写口）；返回是否真的写了。 */
  armResumeAfterRestart(sessionId: string, marker: ResumeAfterRestart): Promise<boolean>;
  /** 发中断；同步、幂等。 */
  interrupt(reason: 'shutdown'): void;
  /** 刷在途状态写入（可选：老执行面没有就跳过）。 */
  flushStateWrites?(): Promise<void>;
}

/** 退出路径的数据来源（由装配层 / 探针注入）。 */
export interface NodeDrainSources {
  /** 当前全部执行面（tenant EU + 成员 EU 都要在）。 */
  units(): ReadonlyArray<NodeDrainUnit>;
  /** 按会话汇总的 durable inbox 待处理条目 id（只读）。 */
  pendingInboxIdsBySession(): ReadonlyMap<string, string[]>;
  /**
   * 把标记登记到「已武装」注册表（可选）。
   *
   * 这不是第二份真相：标记的真身仍然由 armResumeAfterRestart 经 RunJournal 落盘。
   * 这里是竞态保护——settle 期间被打断 run 的终态保存会用自己那份投影重建会话状态，
   * 读了注册表就不会把标记冲掉。没提供就退化成「只写一次」。
   */
  armResumeMarker?(sessionId: string, marker: ResumeAfterRestart): void;
  /**
   * 打开准入 fence。返回 true = 本次真的开了；false = 之前就开着。
   * fence 的语义由装配层实现（AgentService.beginDrain + runs.start 闸门）。
   */
  beginFence(): boolean;
  /** 时钟（探针注入；缺省 Date.now）。 */
  now?(): number;
  /** settle 预算覆盖（探针用；缺省 NODE_DRAIN_SETTLE_MS）。 */
  settleMs?: number;
  /** 日志（缺省静默）。 */
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** 一条标记的落盘结果（报告用：写成功 / 失败都要能看见）。 */
export interface NodeDrainMark {
  session_id: string;
  run_id: string;
  persisted: boolean;
}

/** settle 结局：没有在跑 run / 全部收口 / 超时。 */
export type NodeDrainSettle = 'idle' | 'settled' | 'timeout';

/** 一次 drain 的完整报告（日志 + 探针断言用）。 */
export interface NodeDrainReport {
  reason: 'shutdown';
  /** true = 本次调用没有真正开 fence（之前就在 drain 中）。 */
  already_draining: boolean;
  /** 写下的标记（按会话去重）。 */
  marks: NodeDrainMark[];
  /** 发过 interrupt 的执行面数。 */
  interrupted: number;
  settle: NodeDrainSettle;
  settle_ms: number;
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

/** 睡给定毫秒（settle 轮询用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * 造一个退出序列执行器。
 *
 * 只依赖注入进来的三件事（执行面快照 / inbox 汇总 / fence），自己不做 IO。
 */
export function createNodeDrainer(sources: NodeDrainSources): NodeDrainer {
  const now = sources.now ?? (() => Date.now());
  const settleBudget = Math.max(0, sources.settleMs ?? NODE_DRAIN_SETTLE_MS);
  const warn = sources.warn ?? (() => undefined);
  let draining = false;
  let inFlight: Promise<NodeDrainReport> | undefined;
  let settledReport: NodeDrainReport | undefined;

  /** 1-3 步：fence → 写标记 → interrupt。标记全部落定后才发中断。 */
  async function armAndInterrupt(): Promise<{
    marks: NodeDrainMark[];
    interrupted: number;
  }> {
    const pendingBySession = sources.pendingInboxIdsBySession();
    const units = sources.units();
    // 一个会话一条标记：同一会话理论上只有一个 active run，多执行面重复时按 session 去重。
    const snapped = new Map<string, { unit: NodeDrainUnit; run_id: string }>();
    for (const unit of units) {
      const snapshot = unit.activeRunSnapshot();
      if (snapshot === undefined) continue;
      if (snapped.has(snapshot.session_id)) continue;
      snapped.set(snapshot.session_id, { unit, run_id: snapshot.run_id });
    }

    const interruptedAt = now();
    const marks: NodeDrainMark[] = [];
    const writes: Array<Promise<void>> = [];
    for (const [sessionId, entry] of snapped) {
      const marker: ResumeAfterRestart = {
        run_id: entry.run_id,
        interrupted_at: interruptedAt,
        reason: 'shutdown',
        pending_input_ids: [...(pendingBySession.get(sessionId) ?? [])],
        // S1a 不碰后台进程（也不 await 它们）⇒ 恒 false，见 ResumeAfterRestart 注释。
        background_stopped: false,
      };
      const mark: NodeDrainMark = { session_id: sessionId, run_id: entry.run_id, persisted: false };
      marks.push(mark);
      // 先登记竞态保护，再落盘：反过来的话，落盘与登记之间正好有一次终态保存就会丢标记。
      try {
        sources.armResumeMarker?.(sessionId, marker);
      } catch (error) {
        warn('node.drain.arm_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      writes.push(
        entry.unit
          .armResumeAfterRestart(sessionId, marker)
          .then((persisted) => {
            mark.persisted = persisted;
          })
          .catch((error: unknown) => {
            mark.persisted = false;
            warn('node.drain.marker_failed', {
              session_id: sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }
    // 标记先落盘，再打断：反过来的话 run 的终态保存可能先把标记覆盖掉。
    await Promise.all(writes);

    let interrupted = 0;
    // 中断覆盖**所有**在跑 run（含没写标记的同会话重复执行面）：打断本身就是目的。
    for (const unit of units) {
      if (unit.activeRunSnapshot() === undefined) continue;
      try {
        unit.interrupt('shutdown');
        interrupted += 1;
      } catch (error) {
        warn('node.drain.interrupt_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { marks, interrupted };
  }

  /** 4 步：等 run 收口，最多 settleBudget；只看同步快照，不持任何 run promise。 */
  async function settle(): Promise<NodeDrainSettle> {
    const deadline = now() + settleBudget;
    let sawActive = false;
    for (;;) {
      const active = sources.units().some((unit) => unit.activeRunSnapshot() !== undefined);
      if (!active) return sawActive ? 'settled' : 'idle';
      sawActive = true;
      if (now() >= deadline) return 'timeout';
      await sleep(Math.min(SETTLE_POLL_MS, Math.max(1, deadline - now())));
    }
  }

  /** 5 步：flush 在途状态写入（失败只记日志，绝不让退出卡住）。 */
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
    // 1. fence：先关闸，后面写标记 / 打断期间不会有新的写入溜进来。
    const opened = sources.beginFence();
    draining = true;
    // 2-3. 标记 + 打断。
    const { marks, interrupted } = await armAndInterrupt();
    // 4. settle（≤ settleBudget）。
    const settleOutcome = await settle();
    // 5. flush。
    await flush();
    const report: NodeDrainReport = {
      reason: 'shutdown',
      already_draining: !opened,
      marks,
      interrupted,
      settle: settleOutcome,
      settle_ms: settleBudget,
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
