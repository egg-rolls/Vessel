/**
 * 用户配置监听 → 自动热应用（CONTRACT-hot-apply §2）。
 *
 * `fs.watch` 用户配置（通常 `~/.vessel/config.yaml`），写入抖动按 debounce 合并
 * （缺省 300ms，可注入 0 供测试），之后用 `loadConfig()` 重新读取：
 *
 * - **只有 `validation.valid === true` 且无 errors 才应用**：调 `gateway.reload(...)`；
 * - 语法 / 语义错误 → **不应用**，只记日志 + 广播一条失败 notice；
 * - 连续失败后一旦校验通过必须能正常应用（每次变更独立判定，不锁死）；
 * - `close()` 取消监听与未到期的 debounce，不泄漏句柄 / 定时器。
 *
 * 本模块不 import 具体 applier：`apply` 由装配层注入 `gateway.reload` 的调用方，
 * 保证「唯一热应用入口」不被绕过。
 *
 * @module vessel/config-watch
 */

import { type FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../packages/core/src/index';
import type { RuntimeNotice } from './runtime-notice';

/** debounce 缺省值（契约 §2：常量集中一处）。 */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

/** 配置重新读取的结果（与 `loadConfig()` 对齐的最小形状）。 */
export interface ConfigReloadOutcome {
  valid: boolean;
  /** 校验错误的可读描述；`valid === true` 时为空 */
  errors: string[];
}

export interface ConfigWatchOptions {
  /** 被监听的文件路径（`getUserConfigPath()`） */
  configPath: string;
  /**
   * 重新读取并校验配置。抛错等价于校验失败（不应用）。
   * 返回 `valid: true` 时才会触发 `apply`。
   */
  validate: () => Promise<ConfigReloadOutcome>;
  /**
   * 校验通过后应用。返回值用于生成成功 notice（逐条差异摘要）。
   * 抛错时视为应用失败（发失败 notice，不吞掉日志）。
   */
  apply: () => Promise<string[]>;
  /** 失败 / 成功的通知出口（形状见契约 §3） */
  notify: (notice: RuntimeNotice) => void;
  logger?: Logger;
  /** debounce 毫秒；缺省 300，测试可传 0 */
  debounceMs?: number;
  /** 每个 scope 的失败 notice 里 scope 字段；缺省 'config' */
  scope?: string;
  /** 测试注入：替代 `fs.watch` */
  watchFactory?: (
    filePath: string,
    listener: () => void,
  ) => { close(): void } | FSWatcher | undefined;
  /** 测试注入：替代 setTimeout */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** 测试注入：替代 clearTimeout */
  cancelSchedule?: (handle: unknown) => void;
}

export interface ConfigWatchHandle {
  /** 停止监听并取消未到期的 debounce；幂等 */
  close(): void;
  /** 手动触发一次「变更」（测试 / `SIGHUP` 用） */
  trigger(): Promise<void>;
  /** 当前是否在监听 */
  readonly watching: boolean;
}

function defaultWatchFactory(
  filePath: string,
  listener: () => void,
): { close(): void } | undefined {
  try {
    // persistent: true —— 进程生命周期内保持监听（gateway 常驻）。
    return watch(filePath, { persistent: true }, () => listener());
  } catch {
    // 文件不存在 / 平台不支持：返回 undefined，装配层按「未监听」处理。
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** watcher 的 close 可能不存在（测试 fake），统一兜底。 */
function closeWatcher(watcher: { close(): void } | undefined): void {
  if (watcher === undefined) return;
  try {
    watcher.close();
  } catch {
    // 关闭失败不影响进程退出
  }
}

/**
 * 启动监听。
 *
 * 返回 `undefined` 表示未能监听（文件不存在 / 平台不支持）——调用方只记日志，
 * 不影响 gateway 本身。
 */
export function startConfigWatch(options: ConfigWatchOptions): ConfigWatchHandle | undefined {
  const debounceMs = options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number): unknown => {
      const timer = setTimeout(fn, ms);
      // 监听器不阻断进程退出（gateway 自己保持存活）。
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  const watchFactory = options.watchFactory ?? defaultWatchFactory;
  let closed = false;
  let pending: unknown;
  /** 串行化应用：连续变更不叠加并发 reload。 */
  let chain: Promise<void> = Promise.resolve();
  const scope = options.scope ?? 'config';
  const target = path.resolve(options.configPath);

  const runOnce = async (): Promise<void> => {
    if (closed) return;
    let outcome: ConfigReloadOutcome;
    try {
      outcome = await options.validate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger?.warn('config.watch.invalid', { path: target, error: detail });
      options.notify({
        scope,
        summary: `config not applied: ${detail}`,
        ok: false,
      });
      return;
    }

    if (!outcome.valid || outcome.errors.length > 0) {
      // 不应用，也不推进任何状态：下一次校验通过就能正常应用。
      options.logger?.warn('config.watch.invalid', {
        path: target,
        errors: outcome.errors.length,
      });
      options.notify({
        scope,
        summary:
          outcome.errors.length > 0
            ? `config not applied: ${outcome.errors[0]}`
            : 'config not applied: validation failed',
        ...(outcome.errors.length > 0 ? { details: outcome.errors.slice(0, 10) } : {}),
        ok: false,
      });
      return;
    }

    let summaries: string[];
    try {
      summaries = await options.apply();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger?.error('config.watch.apply_failed', { path: target, error: detail });
      options.notify({ scope, summary: `config apply failed: ${detail}`, ok: false });
      return;
    }
    if (closed) return;
    options.logger?.info('config.watch.applied', {
      path: target,
      scopes: summaries.length,
    });
    options.notify({
      scope,
      summary: summaries[0] ?? 'config applied',
      ...(summaries.length > 1 ? { details: summaries } : {}),
      ok: true,
    });
  };

  const trigger = (): Promise<void> => {
    chain = chain.then(runOnce, runOnce);
    return chain;
  };

  const scheduleRun = (): void => {
    if (closed) return;
    if (pending !== undefined) cancelSchedule(pending);
    pending = schedule(() => {
      pending = undefined;
      if (closed) return;
      void trigger();
    }, debounceMs);
  };

  const watcher = watchFactory(target, scheduleRun);
  if (watcher === undefined) {
    if (pending !== undefined) cancelSchedule(pending);
    return undefined;
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (pending !== undefined) {
        cancelSchedule(pending);
        pending = undefined;
      }
      closeWatcher(watcher);
    },
    trigger,
    get watching(): boolean {
      return !closed;
    },
  };
}

/** 把 `loadConfig()` 的结果转成 `ConfigReloadOutcome`（装配层用，便于测试）。 */
export function toConfigReloadOutcome(loaded: {
  validation?: { valid?: boolean; errors?: Array<{ path?: string; message?: string }> };
}): ConfigReloadOutcome {
  const validation = isRecord(loaded.validation) ? loaded.validation : undefined;
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const described = errors.map((error) =>
    isRecord(error)
      ? `${typeof error.path === 'string' ? error.path : 'config'}: ${
          typeof error.message === 'string' ? error.message : 'invalid'
        }`
      : String(error),
  );
  return {
    valid: validation?.valid === true && described.length === 0,
    errors: described,
  };
}
