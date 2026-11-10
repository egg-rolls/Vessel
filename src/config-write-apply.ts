/**
 * config.set 写后热应用（0.50）。
 *
 * 背景：config.set 只落盘，config.get 服务的是内存快照 liveConfig，必须等文件
 * 监听热应用（debounce 300ms + reload）才更新。实测写后立即 config.get 仍是旧值，
 * 收敛 370–800ms —— 这个窗口里写入方以为“已生效”，而读方拿到旧值（Web 开关、
 * 会话渲染用的 configStore、CLI 三者不同步）。所以写成功后同步跑一次唯一热应用
 * 入口 ConfigWatchHandle.trigger()。
 *
 * 契约（main 0.50 裁决）：
 * - **单飞行**：已有 apply 在飞就 await 它，并置位“再跑一次”，绝不叠加并发；
 * - **有上界**：超时只记 warn 后返回——落盘已成功，不能把 RPC 挂死；
 * - **apply 失败不回 ok:false**：磁盘已经写了，只记 warn，运行时未应用由文件监听
 *   的下一轮 debounce 重试收敛；
 * - **去重**：config-watch 的 trigger() 会先作废 pending debounce，一次写入只产生
 *   一次 apply / 一条 runtime.notice。
 *
 * @module vessel/config-write-apply
 */

import type { Logger } from '../packages/core/src/index';

/** 等待上界（缺省 2s：覆盖实测 370–800ms 收敛并留余量）。 */
export const CONFIG_SET_APPLY_TIMEOUT_MS = 2_000;

export interface WrittenConfigApplierOptions {
  /** 触发唯一热应用入口；返回 undefined 表示当前无法热应用（例如监听不可用）。 */
  trigger: () => Promise<void> | undefined;
  /** 等待上界；缺省 {@link CONFIG_SET_APPLY_TIMEOUT_MS}。 */
  timeoutMs?: number;
  logger?: Logger;
}

export interface WrittenConfigApplier {
  /** 写后调用：等到本轮的 apply 结束（或超时）才 resolve。 */
  (): Promise<void>;
  /** 是否有 apply 在飞（诊断 / 测试用）。 */
  readonly busy: boolean;
}

/**
 * 构造单飞行的写后热应用器。返回的函数永不 reject：写盘已经成功，调用方必须
 * 继续按成功处理，否则会误导用户「没写进去」。
 */
export function createWrittenConfigApplier(
  options: WrittenConfigApplierOptions,
): WrittenConfigApplier {
  const timeoutMs = options.timeoutMs ?? CONFIG_SET_APPLY_TIMEOUT_MS;
  const logger = options.logger;
  let inFlight: Promise<void> | null = null;
  let again = false;

  const warn = (event: string, error: unknown): void => {
    logger?.warn(event, { error: error instanceof Error ? error.message : String(error) });
  };

  const withTimeout = (applied: Promise<void>): Promise<void> =>
    Promise.race([
      applied.catch((error: unknown) => {
        warn('config.set.apply_failed', error);
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);

  const applier = async (): Promise<void> => {
    if (inFlight !== null) {
      again = true;
      await inFlight;
      // 置位没被 in-flight 循环消费（竞态窗口）时补一次，保证自己的写被应用。
      if (again) await applier();
      return;
    }
    inFlight = (async () => {
      try {
        do {
          again = false;
          const applied = options.trigger();
          if (applied === undefined) return;
          await withTimeout(applied);
        } while (again);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  return Object.assign(applier, {
    get busy(): boolean {
      return inFlight !== null;
    },
  });
}
