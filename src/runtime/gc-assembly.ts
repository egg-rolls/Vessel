/**
 * GC 装配（P1 批7，自 bootstrap.ts 迁出；ADR-107 strangler）。
 * 三工厂同形态：image blob 池 GC / 附件暂存 TTL GC / auto-gc（closed/归档回收）。
 * 晚绑定语义不变：noticeBus / agentControl 经 ctx getter 原地读；产出经返回值
 * 回填 trunk let（shutdown getter / return 透传不变）。接线改动 = 4 行 getter。
 * 其余移动体逐字节（缩进 -2）。
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { Logger } from '../../packages/core/src/index';
import { imageBlobRoot, type TenantPaths } from '../../packages/core/src/index';
import { type StagingGcRunner, startStagingGc } from '../data/attachment-staging';
import {
  type AutoPrunePassReport,
  type AutoPruneRunner,
  formatAutoPruneReport,
  startAutoPrune,
} from '../data/auto-prune';
import {
  formatImageBlobGcReport,
  type ImageBlobGcRunner,
  isBlobRootInsideDataDir,
  startImageBlobGc,
} from '../data/image-blob-gc';
import { createOnlinePrunePort } from '../data/prune-wiring';
import type { BootstrapResult } from './bootstrap-types';
import type { RuntimeNoticeBus } from './runtime-notice';
import type { TenantRuntimeBundle } from './tenant-runtime-factory';

/** GC 装配输入：trunk 稳定引用 + 晚绑定 getter。 */
export interface GcAssemblyContext {
  config: VesselConfig;
  tenantPaths: TenantPaths;
  tenantId: string;
  logger: Logger;
  localWrites: boolean;
  timelineLog: TenantRuntimeBundle['timelineLog'];
  runtimeEvents: TenantRuntimeBundle['runtimeEvents'];
  resolveNoticeBus: () => RuntimeNoticeBus | undefined;
  resolveAgentControl: () => BootstrapResult['agent'];
}

export function createGcAssembly(ctx: GcAssemblyContext) {
  const {
    config,
    tenantPaths,
    tenantId,
    logger,
    localWrites,
    timelineLog,
    runtimeEvents,
    resolveNoticeBus,
    resolveAgentControl,
  } = ctx;
  // 产出 let（原 trunk 函数级声明；经返回值回填 trunk，时序不变）。
  let imageBlobGc: ImageBlobGcRunner | undefined;
  let stagingGc: StagingGcRunner | undefined;
  let autoPrune: AutoPruneRunner | undefined;
  let applyAutoPruneConfig: ((next: VesselConfig) => string[]) | undefined;
  // ── 0.56 P1：图片 blob 池 GC（第一趟 dry-run，之后定时真删）────────────────────
  // 三条纪律：① 引用集合扫「会话壳 + 事件日志」两处（漏一处 = 删在用图）；
  // ② 证明不了引用集合就整趟放弃（`aborted`，一个字节都不删）；
  // ③ 超上限**不静默**（warn + 事件 + 一张通知卡）。
  const blobGcEnabled = config.vision?.blobGcEnabled !== false;
  // 安全闸：blob 池必须落在**这个数据目录**里。`VESSEL_BLOB_DIR` 可以把池指到别处
  // （多节点 / 多租户共享一份池），而引用集合只能扫到本目录的会话 —— 那时删任何东西
  // 都是「删别人还在用的图」。宁可不做（漏水），也不猜。
  const blobPoolRoot = imageBlobRoot();
  const blobPoolInside = isBlobRootInsideDataDir(tenantPaths.root, blobPoolRoot);
  if (blobGcEnabled && localWrites && timelineLog !== undefined && !blobPoolInside) {
    logger.warn('image blob gc skipped: blob root outside data dir', {
      data_dir: tenantPaths.root,
      blob_root: blobPoolRoot,
    });
  }
  if (blobGcEnabled && localWrites && timelineLog !== undefined && blobPoolInside) {
    const gcLog = timelineLog;
    imageBlobGc = startImageBlobGc({
      sessionsDir: tenantPaths.sessions_dir,
      log: { read: (sessionId: string) => gcLog.read(sessionId) },
      root: blobPoolRoot,
      ...(config.vision?.orphanGraceHours !== undefined
        ? { orphanGraceHours: config.vision.orphanGraceHours }
        : {}),
      ...(config.vision?.imageBlobTtlDays !== undefined
        ? { ttlDays: config.vision.imageBlobTtlDays }
        : {}),
      ...(config.vision?.blobGcIntervalHours !== undefined
        ? { intervalHours: config.vision.blobGcIntervalHours }
        : {}),
      ...(config.vision?.blobGcDryRun === true ? { dryRun: true } : {}),
      onUnreadable: (sessionId: string, error: unknown) => {
        // 旧格式会话（0.54 之前）没有 blob 池，读不出来是可声明的；**不是静默**。
        logger.warn('image blob gc: session events unreadable', {
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onReport: (report) => {
        const line = formatImageBlobGcReport(report);
        if (report.aborted !== undefined) {
          logger.warn('image blob gc aborted', {
            reason: report.aborted.reason,
            scanned: report.scanned,
          });
          return;
        }
        logger.info('image blob gc pass', { line, scanned: report.scanned });
        // 报告进事件流：人（Web/TUI）能看到「将删 / 已删」，不必翻日志。
        runtimeEvents.publish({
          type: 'gc.image_blobs',
          run_id: 'gc',
          data: { line, dry_run: report.dryRun, scanned: report.scanned, result: report.result },
          ts: Date.now(),
        });
        if (report.result?.overLimit === true) {
          const summary = `Image pool over limit (${report.result.totalBytes} bytes): new images will not be inlined`;
          console.warn(`⚠ ${summary}`);
          resolveNoticeBus()?.publish({
            scope: 'config',
            summary,
            details: [line],
            ok: false,
          });
        }
      },
    });
  }

  // ── file-ref-ux A2：附件暂存区 TTL GC（60min + 1h 宽限，按 mtime）─────────────
  // 与 blob GC 同闸（localWrites）同形态（第一趟 dry-run、unref）。暂存副本是
  // 用户上传的临时字节，过期回收不需要引用集合扫描（TTL + 宽限即判据）。
  if (localWrites) {
    stagingGc = startStagingGc({
      onReport: (report) => {
        logger.info('attachment staging gc pass', {
          dry_run: report.dryRun,
          scanned: report.scanned,
          reclaimed: report.reclaimed,
          bytes: report.bytes,
        });
      },
    });
  }

  // ── auto-gc P1：closed / 归档 team 数据自动回收（环3）────────────────────────
  // 闸与 blob GC 同口径：connectMode（远程网关的本地进程）绝不跑本地 prune。
  // enabled 缺省 true（用户裁定：系统应自清洁），显式 false 只跳过趟、链不断
  // （live resolver 每趟求值，热重载再开即活）。headless 一次性进程天然不触发
  // （unref + 首趟 setTimeout 0），与 blob GC 同形态，不另设闸。
  if (localWrites) {
    // D3：有活 AgentService 就必须经 registry 摘除（直接改文件会被整份 flush 复活）；
    // 端口建不起来（旧内核缺方法）宁可不做。无 AgentService 时无活 registry，
    // 离线文件模式安全（与 CLI 同路）。
    const agentControl = resolveAgentControl();
    const onlinePrune =
      agentControl !== undefined ? createOnlinePrunePort(agentControl.service) : undefined;
    if (agentControl !== undefined && onlinePrune === undefined) {
      logger.warn('auto prune skipped: agent service lacks online prune port', {
        data_dir: tenantPaths.root,
      });
    } else {
      // 活配置引用：调度器闭包每趟求值；applyAutoPruneConfig 热应用时原地替换。
      const autoPruneConfigRef: { current: VesselConfig } = { current: config };
      autoPrune = startAutoPrune({
        resolveConfig: () => autoPruneConfigRef.current,
        tenantPaths,
        tenantId,
        ...(onlinePrune !== undefined ? { online: onlinePrune } : {}),
        onReport: (report: AutoPrunePassReport) => {
          const line = formatAutoPruneReport(report);
          if (report.aborted !== undefined) {
            logger.warn('auto prune aborted', { reason: report.aborted.reason });
          } else if (report.skipped_pass !== undefined) {
            logger.info('auto prune pass skipped', { reason: report.skipped_pass });
          } else {
            logger.info('auto prune pass', {
              line,
              dry_run: report.dry_run,
              totals: report.totals,
            });
          }
          // 报告进事件流：人（Web/TUI）能看到「将删 / 已删」，不必翻日志。
          runtimeEvents.publish({
            type: 'gc.agents',
            run_id: 'gc',
            data: { line, ...report },
            ts: Date.now(),
          });
          // 异常 / 拒删（记录摘除失败）不静默：一张通知卡（同 blob GC overLimit 三路）。
          const refused = report.notes.includes('agents_snapshot_write_failed');
          if (report.aborted !== undefined || refused) {
            const summary =
              report.aborted !== undefined
                ? `Auto prune aborted: ${report.aborted.reason}`
                : 'Auto prune: agent snapshot write failed (records kept)';
            console.warn(`⚠ ${summary}`);
            resolveNoticeBus()?.publish({ scope: 'config', summary, details: [line], ok: false });
          }
        },
      });
      applyAutoPruneConfig = (next) => {
        autoPruneConfigRef.current = next;
        // O4：热改即重排 —— 只换引用不重排的话，挂定的缺省 24h 定时器要明天才按新
        // interval 走。reschedule 清挂起 timer 按当前 interval 立即重排（在飞趟不动）。
        autoPrune?.reschedule();
        return [
          `autoPrune: hot-applied (live resolver; enabled=${next.autoPrune?.enabled !== false}, next pass rescheduled to new interval)`,
        ];
      };
    }
  }
  return { imageBlobGc, stagingGc, autoPrune, applyAutoPruneConfig };
}
