/**
 * closed / 归档 team 数据的定时自动回收（auto-gc P1，环3）。
 *
 * 复刻 `startImageBlobGc` 的成熟形态（首趟 dry-run / interval 夹取 / unref /
 * in-flight 不叠加 / runOnce / stop），判据与删除核心**完全复用** `pruneTenantData`
 * （状态判据：归档 team ∪ closed；olderThan 只是可选时间叠加，与 CLI `--older-than`
 * 同一个 `olderThanMs` 入口）。本模块只做调度，不新增第二套判老 / 删除逻辑。
 *
 * ## live resolver（用户裁定：热重载从一开始，不做「P1 重启生效 P3 再热」的过渡态）
 *
 * `resolveConfig` 闭包**每趟求值**：enabled / intervalHours / olderThanHours / dryRun
 * 全部活生效。cadence 不冻结启动值 —— 定时器是自重排链（每趟结束后按**最新** interval
 * 排下一趟），配置热重载换掉 interval 后下一趟即按新节奏。enabled=false 只跳过趟、
 * 链不断：再开即活，无需重启。装配层把重载配置喂进闭包持有的活引用（applyAutoPrune）。
 *
 * ## 纪律（全部有先例背书）
 *
 * 1. **首趟永远 dry-run**（进程刚启动最可能装配不完整；删除不可逆）——同 blob GC。
 * 2. 定时器 `unref()`；`stop()` 后不再触发，在飞的一趟跑完；`idle()` 供 dispose 排序
 *    （在线趟会调 service.flushSnapshot，必须先于 agent 拆机收口，否则终态 flush 复活）。
 * 3. **in-flight 不叠加**：上一趟未完 → 本趟 `skipped_pass:'previous pass still running'`。
 *    手动趟（P3 prune.run）与定时趟共用同一单飞闸。
 * 4. 启动首趟 `setTimeout 0` 不阻塞首帧（同 pruneAfterFirstFrame / blob GC firstPass）。
 * 5. **锁纪律**：真删趟持短程 exclusive data-lock（与 gateway trace.prune 同模式，
 *    同进程重入由 withDataLock 识别）；拿不到锁 = 本趟跳过（skipped_pass），不重试、
 *    不降级、不 partial。dry-run 趟不加锁（报告不该让 gateway 起不来）。
 * 6. **在线模式经 registry**（D3）：gateway 存活时 agent 记录摘除走 OnlinePrunePort，
 *    绝不直接改快照文件（整份 registry 定时重写会复活已删记录）。
 * 7. 每趟报告（含跳过 / 异常）→ onReport（装配层接日志 / gc.agents 事件 / noticeBus）。
 *
 * @module vessel/auto-prune
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { TenantPaths } from '../../packages/core/src/index';
import { DataLockError, withDataLock } from './data-lock';
import {
  type OnlinePrunePort,
  type PruneContext,
  type PruneReport,
  pruneTenantData,
} from './prune-wiring';

/** 定时间隔的缺省与上下界（同 blob GC 夹取风格）。 */
export const DEFAULT_AUTO_PRUNE_INTERVAL_HOURS = 24;
export const MIN_AUTO_PRUNE_INTERVAL_HOURS = 1;
export const MAX_AUTO_PRUNE_INTERVAL_HOURS = 168;
/** 自动模式判老叠加缺省（D2：比 CLI 保守，保住 reinstate 复活窗口）；0 = 纯状态判据。 */
export const DEFAULT_AUTO_PRUNE_OLDER_THAN_HOURS = 168;

const HOUR_MS = 3_600_000;

/**
 * 一趟的报告：PruneReport 原样 + 调度层 additive 字段。
 * `skipped_pass` / `aborted` 趟的 categories / skipped / totals 全零（没做就是没做，
 * 不补假数字）；CLI 的 PruneNote 联合不扩展（CLI 输出面逐字节不变）。
 */
export type AutoPrunePassReport = PruneReport & {
  /** 本趟被跳过的原因（in-flight 叠加 / 锁占用）；正常趟缺省 */
  skipped_pass?: string;
  /** 整趟放弃（扫描 / 读盘异常）：零删除，照实报告 */
  aborted?: { reason: string };
};

/** 定时执行的参数 */
export interface AutoPruneScheduleOptions {
  /**
   * 活配置解析器：每趟求值（热重载 = live 闭包，不冻结启动值）。
   * 装配层传 `() => liveConfigRef.current`；嵌入方缺省可传常量闭包。
   */
  resolveConfig: () => VesselConfig;
  tenantPaths: TenantPaths;
  tenantId: string;
  /**
   * 在线执行适配（gateway 模式必传）：agent 记录删除经活 registry（D3）。
   * 缺省 = 离线文件模式（仅适用于无活 AgentService 的进程）。
   */
  online?: OnlinePrunePort;
  /** 每趟的报告（装配层接日志 / 事件 / 环境卡） */
  onReport: (report: AutoPrunePassReport) => void;
  /** 定时器工厂（测试缝；缺省 setTimeout 自重排链） */
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  /** 时钟缝（缺省 Date.now）；dry-run 与真删同一口径 */
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

/** 定时执行器（`stop()` 之后不再触发；在飞的这一趟照旧跑完）。 */
export interface AutoPruneRunner {
  /** 手动跑一趟（`dryRun` 缺省跟随首趟 / 观察模式规则）；与定时趟共用单飞闸 */
  runOnce(dryRun?: boolean): Promise<AutoPrunePassReport>;
  stop(): void;
  /** 在飞趟收口承诺（dispose 排序：先停调度并等在飞趟，再拆 agent 执行面） */
  idle(): Promise<void>;
}

/** 一行人类可读的读数（日志 / gc.agents 事件 / 通知卡共用同一句话）。 */
export function formatAutoPruneReport(report: AutoPrunePassReport): string {
  const window = report.dry_run ? 'dry-run' : 'apply';
  if (report.skipped_pass !== undefined) {
    return `auto prune (${window}): skipped (${report.skipped_pass})`;
  }
  if (report.aborted !== undefined) {
    return `auto prune (${window}): aborted, nothing deleted (${report.aborted.reason})`;
  }
  const verb = report.dry_run ? 'would delete' : 'deleted';
  const { categories, skipped, totals } = report;
  const kept =
    skipped.active_sessions +
    skipped.refused_sessions +
    skipped.kept_agents +
    skipped.kept_teams +
    skipped.unknown_time;
  return (
    `auto prune (${window}): ${verb} ${totals.deleted} objects (${totals.bytes} bytes; ` +
    `teams ${categories.teams.deleted}, agents ${categories.agents.deleted}, ` +
    `sessions ${categories.sessions.deleted}, runs ${categories.runs.deleted}, ` +
    `trace ${categories.trace.deleted_runs + categories.trace.cascade_files}; kept ${kept})`
  );
}

/** 夹取 interval（消费方夹取，validator 只拒非法形状 —— blob GC 先例）。 */
function clampInterval(hours: number | undefined): number {
  return Math.min(
    Math.max(hours ?? DEFAULT_AUTO_PRUNE_INTERVAL_HOURS, MIN_AUTO_PRUNE_INTERVAL_HOURS),
    MAX_AUTO_PRUNE_INTERVAL_HOURS,
  );
}

/** 零账目报告底（跳过 / 异常趟用；没做就是没做）。 */
function emptyPassReport(
  options: AutoPruneScheduleOptions,
  dryRun: boolean,
  olderThanMs: number | undefined,
): AutoPrunePassReport {
  return {
    dry_run: dryRun,
    data_dir: options.tenantPaths.root,
    tenant_id: options.tenantId,
    ...(olderThanMs !== undefined ? { older_than_ms: olderThanMs } : {}),
    categories: {
      teams: { deleted: 0, bytes: 0 },
      agents: { deleted: 0, bytes: 0 },
      sessions: { deleted: 0, bytes: 0 },
      runs: { deleted: 0, bytes: 0 },
      trace: {
        deleted_runs: 0,
        kept_runs: 0,
        deleted_bytes: 0,
        cascade_files: 0,
        cascade_bytes: 0,
      },
    },
    skipped: {
      active_sessions: 0,
      refused_sessions: 0,
      kept_agents: 0,
      kept_teams: 0,
      unknown_time: 0,
    },
    totals: { deleted: 0, bytes: 0 },
    notes: [],
  };
}

/**
 * 启动自动回收调度：**第一趟永远 dry-run**，之后按最新 interval 定时真删。
 *
 * enabled 缺省 true（用户裁定：系统应自清洁；安全性由保护不变量保证）。显式 false
 * 只跳过趟、链不断（热重载再开即活）。connectMode 装配层不启动本调度（红线 8）。
 */
export function startAutoPrune(options: AutoPruneScheduleOptions): AutoPruneRunner {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const now = options.now ?? Date.now;
  let stopped = false;
  let first = true;
  let inFlight: Promise<AutoPrunePassReport> | undefined;
  let timer: { unref?: () => void } | undefined;

  /** 每趟求值最新配置（live resolver）：判老叠加 0 = 纯状态判据（不传 olderThanMs）。 */
  function resolvePass(): {
    dryRun: boolean;
    olderThanMs: number | undefined;
    config: VesselConfig;
  } {
    const config = options.resolveConfig();
    const block = config.autoPrune;
    const olderThanHours = block?.olderThanHours ?? DEFAULT_AUTO_PRUNE_OLDER_THAN_HOURS;
    return {
      config,
      dryRun: block?.dryRun === true,
      olderThanMs: olderThanHours > 0 ? olderThanHours * HOUR_MS : undefined,
    };
  }

  function probeOptions(): {
    now: () => number;
    hostname?: string;
    pid?: number;
    isPidAlive?: (pid: number) => boolean;
  } {
    return {
      now,
      ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.isPidAlive !== undefined ? { isPidAlive: options.isPidAlive } : {}),
    };
  }

  const runOnce = async (dryRun?: boolean): Promise<AutoPrunePassReport> => {
    const pass = resolvePass();
    const effectiveDryRun = dryRun ?? (first || pass.dryRun);
    // 上一趟还没跑完就不叠（扫全库是重活，叠加只会互相拖慢）；手动趟同闸。
    if (inFlight !== undefined) {
      const skipped: AutoPrunePassReport = {
        ...emptyPassReport(options, effectiveDryRun, pass.olderThanMs),
        skipped_pass: 'previous pass still running',
      };
      options.onReport(skipped);
      return skipped;
    }

    const ctx: PruneContext = {
      config: pass.config,
      tenantPaths: options.tenantPaths,
      tenantId: options.tenantId,
      ...(pass.olderThanMs !== undefined ? { olderThanMs: pass.olderThanMs } : {}),
      // PruneContext.now 是固定毫秒（dry-run 与真删同一口径）；探针的函数时钟另走 probeOptions。
      now: now(),
      ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.isPidAlive !== undefined ? { isPidAlive: options.isPidAlive } : {}),
    };
    const online = options.online;

    const flight = (async (): Promise<AutoPrunePassReport> => {
      try {
        if (effectiveDryRun) {
          // dry-run 不加锁（CLI 先例）；在线模式同样不碰 registry（红线 7）。
          return await pruneTenantData(ctx, {
            dryRun: true,
            ...(online !== undefined ? { online } : {}),
          });
        }
        try {
          // 真删持短程 exclusive 锁（与 gateway trace.prune 同模式；同进程重入识别）。
          return await withDataLock({ dataDir: options.tenantPaths.root, ...probeOptions() }, () =>
            pruneTenantData(ctx, {
              dryRun: false,
              ...(online !== undefined ? { online } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof DataLockError) {
            // 拿不到锁 = 本趟跳过：不重试、不降级、不 partial，等下一趟。
            return {
              ...emptyPassReport(options, false, pass.olderThanMs),
              skipped_pass: 'data dir locked by another process',
            };
          }
          throw error;
        }
      } catch (error) {
        // 扫描 / 读盘异常：整趟放弃（一个字节都不删），照实报告，不崩定时器。
        return {
          ...emptyPassReport(options, effectiveDryRun, pass.olderThanMs),
          aborted: { reason: error instanceof Error ? error.message : String(error) },
        };
      } finally {
        first = false;
      }
    })();
    inFlight = flight;
    try {
      const report = await flight;
      options.onReport(report);
      return report;
    } finally {
      inFlight = undefined;
    }
  };

  /** 自重排链：每趟结束后按**最新** interval 排下一趟（cadence 活生效）。 */
  function scheduleNext(): void {
    if (stopped) return;
    const intervalHours = clampInterval(options.resolveConfig().autoPrune?.intervalHours);
    timer = schedule(() => {
      void tick();
    }, intervalHours * HOUR_MS);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    // enabled 每趟求值：显式 false 只跳过趟、链不断（热重载再开即活，无需重启）。
    if (options.resolveConfig().autoPrune?.enabled === false) {
      scheduleNext();
      return;
    }
    await runOnce();
    scheduleNext();
  }

  // 启动后的第一趟（dry-run）立刻排进队列：不阻塞首帧（setTimeout 0）。
  timer = schedule(() => {
    void tick();
  }, 0);
  timer.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    },
    async idle() {
      await inFlight;
    },
  };
}
