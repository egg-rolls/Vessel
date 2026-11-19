/**
 * tools-engine supervisor（P2 seams 契约 §2.1；装配层基础设施）。
 *
 * 复用 ChildPluginProcess + manager 重启预算常量（≤3 次 / 10 分钟滑动窗口，同口径）。
 * engine child 不是注册插件：合成 descriptor，不进 PluginLoader / catalog。
 * 预算尽 → disabled + logger.error（转发 fail-closed，**不静默回退 in-process**）。
 *
 * @module tools-engine/supervisor
 */

import { type Logger, noopLogger } from '@vessel-agent/core';
import {
  ENGINE_ERROR,
  ENGINE_MAX_MESSAGE_BYTES,
  type EngineTransport,
} from '@vessel-agent/engine-client';
import {
  type ChildExitInfo,
  ChildPluginProcess,
  PLUGIN_MAX_RESTARTS,
  PLUGIN_RESTART_WINDOW_MS,
  type PluginDescriptor,
} from '@vessel-agent/serve';

export interface EngineSupervisorOptions {
  /** src/tools-engine/entry.ts 绝对路径（装配层用 import.meta.dir 算）。 */
  entryPath: string;
  /** 仓库根（child cwd，workspace 源码解析）。 */
  rootDir: string;
  /** 私有可写目录（日志）：<globalDataDir>/tools-engine。 */
  dataDir: string;
  /** { dataDir?, toolOutputDir? } → VESSEL_PLUGIN_CONFIG（entry 读）。 */
  settings?: Record<string, unknown>;
  logger?: Logger;
  onToolCallback(params: unknown): Promise<unknown>;
  onEngineNotification(method: string, params: unknown): void;
  /** 每次 start / 重启成功后调（装配层据此 pushRegistry 对账）。 */
  onReady(): void;
  restartWindowMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  now?: () => number;
}

export interface EngineSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly transport: EngineTransport;
  readonly restarts: number;
  readonly disabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createEngineSupervisor(options: EngineSupervisorOptions): EngineSupervisor {
  const logger = options.logger ?? noopLogger;
  const restartWindowMs = options.restartWindowMs ?? PLUGIN_RESTART_WINDOW_MS;
  const maxRestarts = options.maxRestarts ?? PLUGIN_MAX_RESTARTS;
  const restartDelayMs = options.restartDelayMs ?? 1_000;
  const now = options.now ?? Date.now;

  // 合成 descriptor：engine child 不是注册插件（不进 PluginLoader / catalog）。
  const descriptor: PluginDescriptor = {
    id: 'tools-engine',
    name: 'tools-engine',
    version: '0.54.0',
    entry: options.entryPath,
    pluginDir: options.rootDir,
    builtin: true,
    permissions: { fs: [] },
  };

  let child: ChildPluginProcess | undefined;
  let disabled = false;
  let stopped = false;
  let restartTimestamps: number[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartCount = 0;
  let startResolve: (() => void) | undefined;
  let startReject: ((error: unknown) => void) | undefined;
  let startPromise: Promise<void> | undefined;

  function resolveStart(): void {
    startResolve?.();
    startResolve = undefined;
    startReject = undefined;
  }

  function rejectStart(error: unknown): void {
    startReject?.(error);
    startResolve = undefined;
    startReject = undefined;
  }

  function spawnChild(): ChildPluginProcess {
    const next = new ChildPluginProcess({
      descriptor,
      settings: options.settings ?? {},
      dataDir: options.dataDir,
      maxMessageBytes: ENGINE_MAX_MESSAGE_BYTES,
      hooks: {
        onToolCallback: (params) => options.onToolCallback(params),
        onEngineNotification: (method, params) => options.onEngineNotification(method, params),
        onExit: (info) => {
          // 只认当前 child 的退出（旧 child 的迟到上报不触发重启）。
          if (child === next) handleExit(info);
        },
      },
    });
    return next;
  }

  /** 滑动窗口预算（同 manager 口径）；排上重启 → true，预算尽 / 已停 → false。 */
  function scheduleRestart(): boolean {
    if (stopped || disabled) return false;
    if (restartTimer !== undefined) return true; // 已排上（start 失败与 onExit 可能同批到达）
    const timestamp = now();
    restartTimestamps = restartTimestamps.filter((ts) => timestamp - ts < restartWindowMs);
    if (restartTimestamps.length >= maxRestarts) {
      disabled = true;
      logger.error('tools-engine disabled after repeated failures', {
        restarts: restartTimestamps.length,
        windowMs: restartWindowMs,
      });
      return false;
    }
    restartTimestamps.push(timestamp);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      attemptStart(true);
    }, restartDelayMs);
    return true;
  }

  function handleExit(info: ChildExitInfo): void {
    if (info.expected || stopped || disabled) return;
    logger.warn('tools-engine child exited unexpectedly', {
      code: info.code,
      signal: info.signal,
      errorCode: info.errorCode,
      message: info.message,
    });
    scheduleRestart();
  }

  function attemptStart(isRestart: boolean): void {
    const next = spawnChild();
    child = next;
    void next.start().then(
      () => {
        if (stopped) {
          void next.terminate();
          resolveStart();
          return;
        }
        if (isRestart) restartCount += 1;
        logger.info('tools-engine child ready', { restart: isRestart });
        try {
          options.onReady();
        } catch (error) {
          logger.error('tools-engine onReady failed', { message: errorMessage(error) });
        }
        resolveStart();
      },
      (error: unknown) => {
        // 握手 / spawn 失败：同预算路径重试；预算尽 → disabled（start 抛最后一次错误）。
        logger.error('tools-engine child start failed', { message: errorMessage(error) });
        if (scheduleRestart()) return;
        if (disabled) rejectStart(error);
        else resolveStart();
      },
    );
  }

  async function start(): Promise<void> {
    if (startPromise !== undefined) return startPromise;
    if (stopped) throw new Error('tools-engine supervisor is stopped');
    startPromise = new Promise<void>((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    attemptStart(false);
    return startPromise;
  }

  /** 幂等停止：expectedExit → 不触发重启；重启定时器清理。 */
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    resolveStart();
    const current = child;
    if (current !== undefined) await current.terminate();
  }

  const transport: EngineTransport = {
    get active() {
      return !disabled && child !== undefined && child.status === 'active';
    },
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
      const current = child;
      if (disabled || current === undefined || current.status !== 'active') {
        return Promise.reject(new Error(ENGINE_ERROR.unavailable));
      }
      try {
        return current.engineRequest(method, params, timeoutMs);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    notify(method: string, params: unknown): void {
      const current = child;
      if (disabled || current === undefined) return;
      current.engineNotify(method, params);
    },
  };

  return {
    start,
    stop,
    transport,
    get restarts() {
      return restartCount;
    },
    get disabled() {
      return disabled;
    },
  };
}
