/**
 * gateway 侧版本检查（CONTRACT-hot-apply §3 / update scope）。
 *
 * 与 TUI REPL 的后台检查共用 `checkForUpdate` 与 24h 本地缓存，区别是 gateway 常驻：
 * - 启动后延迟一次，之后每小时 tick；是否真的发网络请求仍由 24h 缓存决定；
 * - 有新版本时只发一条 `runtime.notice`（scope=update），走与热应用相同的通路：
 *   Web 事件流可见、模型经 BeforeLlm hook 在下一轮看到；
 * - 断网 / 清单损坏完全静默（只写 Logger），更新检查不制造噪音；
 * - 只读：不下载、不校验、不自替换。
 *
 * @module vessel/update/gateway-check
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { Logger } from '../../packages/core/src/index';
import type { RuntimeNoticeBus } from '../runtime-notice';
import { readPackageVersion } from '../version';
import { resolveUpdateChannel } from './background';
import { readUpdateCache, shouldCheck, writeUpdateCache } from './cache';
import { checkForUpdate } from './check';
import { platformAssetKey, type UpdateManifest } from './manifest';
import { type StageOutcome, stageUpdate } from './stage';

/** 常驻进程的检查节拍：每小时 tick 一次；真正的网络请求由 24h 缓存节流。 */
export const GATEWAY_UPDATE_TICK_MS = 60 * 60 * 1000;
/** 启动后等待订阅者挂载再检查。 */
export const GATEWAY_UPDATE_INITIAL_DELAY_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface GatewayUpdateCheckOptions {
  /** 通知总线：有新版本时发 `runtime.notice`。 */
  notice: Pick<RuntimeNoticeBus, 'publish'>;
  /** 只看 `update.autoCheck` / `update.channel` / `update.source`。 */
  config: Pick<VesselConfig, 'update'>;
  logger?: Logger;
  /** 当前版本；缺省读 package.json。 */
  currentVersion?: string;
  /** tick 间隔；缺省 1h，测试注入小值。 */
  intervalMs?: number;
  /** 首次检查延迟；缺省 5s，测试注入 0。 */
  initialDelayMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** 测试注入。 */
  check?: typeof checkForUpdate;
  /** 更新资产暂存；缺省下载 + sha256 校验到 `~/.vessel/updates`。 */
  stage?: (manifest: UpdateManifest) => Promise<StageOutcome>;
  /** 测试注入的暂存根目录。 */
  updatesDir?: string;
  cache?: {
    read: typeof readUpdateCache;
    write: typeof writeUpdateCache;
    due: typeof shouldCheck;
  };
  /** 测试注入的定时器。 */
  timers?: {
    set: (fn: () => void, ms: number) => TimerHandle;
    clear: (handle: TimerHandle) => void;
  };
}

export interface GatewayUpdateCheckHandle {
  /** 立即检查一次（仍受 24h 缓存与开关约束）。 */
  checkNow(): Promise<void>;
  /** 取消后续 tick 与首次检查；幂等。 */
  stop(): void;
}

function defaultTimers(): NonNullable<GatewayUpdateCheckOptions['timers']> {
  return {
    set: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // gateway 自身保持存活；更新检查不阻止进程退出。
      (handle as { unref?: () => void }).unref?.();
      return handle;
    },
    clear: (handle) => clearTimeout(handle),
  };
}

function resolveCheckSource(
  config: Pick<VesselConfig, 'update'>,
  env: Record<string, string | undefined>,
): string | undefined {
  return env.VESSEL_UPDATE_SOURCE ?? config.update?.source;
}

/**
 * 启动 gateway 版本检查。调用方负责在 gateway 关闭路径上调用 `stop()`。
 * 返回的 handle 在 `update.autoCheck === false` / `VESSEL_NO_UPDATE_CHECK` 时也会
 * 正常返回——只是 `checkNow()` 什么都不做，调用方不必分支。
 */
export function startGatewayUpdateCheck(
  options: GatewayUpdateCheckOptions,
): GatewayUpdateCheckHandle {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const timers = options.timers ?? defaultTimers();
  const cache = options.cache ?? {
    read: readUpdateCache,
    write: writeUpdateCache,
    due: shouldCheck,
  };
  const check = options.check ?? checkForUpdate;
  const stage =
    options.stage ??
    ((manifest: UpdateManifest) =>
      stageUpdate({
        manifest,
        ...(options.updatesDir !== undefined ? { updatesDir: options.updatesDir } : {}),
      }));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? GATEWAY_UPDATE_TICK_MS;
  const initialDelayMs = options.initialDelayMs ?? GATEWAY_UPDATE_INITIAL_DELAY_MS;

  let stopped = false;
  let inFlight = false;
  let tickHandle: TimerHandle | undefined;
  let initialHandle: TimerHandle | undefined;

  const enabled =
    options.config.update?.autoCheck !== false && env.VESSEL_NO_UPDATE_CHECK === undefined;

  const checkNow = async (): Promise<void> => {
    if (stopped || !enabled || inFlight) return;
    inFlight = true;
    try {
      const cached = await cache.read();
      if (!cache.due(cached, now())) return;

      const result = await check({
        currentVersion: options.currentVersion ?? readPackageVersion(),
        channel: resolveUpdateChannel(options.config, env),
        source: resolveCheckSource(options.config, env),
        timeoutMs: 3000,
      });

      await cache.write({
        checkedAt: now(),
        current: result.current,
        latest: result.latest,
        channel: result.channel,
      });

      if (result.upToDate || stopped) return;

      // 只暂存、不安装、不重启：下一轮 hook 把结果告诉模型，Web 事件流也能看到。
      const staged = await stage(result.manifest);
      if (stopped) return;
      if (staged.staged) {
        options.notice.publish({
          scope: 'update',
          summary: `update: ${result.latest} staged (${platformAssetKey()})`,
          details: [`staged: ${staged.path}`, result.installHint],
          ok: true,
        });
      } else if (staged.skipped) {
        options.notice.publish({
          scope: 'update',
          summary: `update: ${result.latest} available (current ${result.current})`,
          details: [staged.reason, result.installHint],
          ok: true,
        });
      } else {
        options.notice.publish({
          scope: 'update',
          summary: `update: ${result.latest} found; staging failed`,
          details: [staged.reason, result.installHint],
          ok: false,
        });
      }
    } catch (error) {
      // 断网 / 清单损坏：静默，只留诊断日志。更新检查不能影响 gateway。
      logger?.warn('update.check.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    tickHandle = timers.set(() => {
      void checkNow().finally(() => scheduleNext());
    }, intervalMs);
  };

  initialHandle = timers.set(() => {
    initialHandle = undefined;
    void checkNow().finally(() => scheduleNext());
  }, initialDelayMs);

  return {
    checkNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (initialHandle !== undefined) {
        timers.clear(initialHandle);
        initialHandle = undefined;
      }
      if (tickHandle !== undefined) {
        timers.clear(tickHandle);
        tickHandle = undefined;
      }
    },
  };
}
