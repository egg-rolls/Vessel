/**
 * DR15-1：退出链步骤级进度日志的共享接缝（永久代码，非临时探针）。
 *
 * 为什么需要它：ISSUE-DR15-1 里 graceful stop 后进程挂死 12min+，而整条退出链
 * （activeCleanup → shutdownServeStack → result.shutdown → gateway.stop 内部）
 * **零步骤日志**——挂起 = 静默，事后无法从日志判断卡在哪个 await。这是挂起无法
 * 定位的直接原因。本模块给每个退出步打 `node.shutdown.step` 结构事件：
 *
 * - `status=start`（info）：进入该步。**挂起时日志里最后一条 start 就是挂点**；
 * - `status=done`（info）+ `duration_ms`：该步完成，复验可实证哪步慢；
 * - `status=timeout_bounded`（warn）+ `timeout_ms`：有界等待到点，best-effort 推进；
 * - `status=failed`（warn）+ `error`：该步抛错（原样重抛，调用方既有 catch /
 *   reportShutdownFailure 模式不变）。
 *
 * start/done 用 info 而非 debug：core 日志中枢缺省过滤 debug，挂起诊断必须让
 * 「最后一条 start」在缺省级别可见。退出每进程只发生一次，info 量可接受。
 *
 * 事件名 `node.shutdown.step` 在 node / 平台 / serve 三侧保持稳定（同一 grep 目标）；
 * emit 形状由调用方注入：node 侧接 logger.info/warn，serve 侧接 logEvent，
 * 平台侧接 formatEventLine + print。
 *
 * @module @vessel-agent/serve/shutdown-step
 */

/** 步骤事件的统一名称（cli 复验 / 事后诊断的唯一 grep 目标）。 */
export const SHUTDOWN_STEP_EVENT = 'node.shutdown.step';

/** 日志发射口：调用方把自己的 logger / logEvent / print 接进来。 */
export type ShutdownStepEmit = (
  level: 'info' | 'warn',
  event: string,
  fields: Record<string, unknown>,
) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 包一个退出步：start → await fn → done(duration_ms)。
 * 异常打 failed 后**原样重抛**——各调用方既有的逐段隔离 catch 不动。
 */
export async function runShutdownStep<T>(
  emit: ShutdownStepEmit,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  emit('info', SHUTDOWN_STEP_EVENT, { step, status: 'start' });
  const startedAt = Date.now();
  try {
    const result = await fn();
    emit('info', SHUTDOWN_STEP_EVENT, {
      step,
      status: 'done',
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    emit('warn', SHUTDOWN_STEP_EVENT, {
      step,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      error: errorText(error),
    });
    throw error;
  }
}

/**
 * 有界等待一个退出步（DR15-1 挂点修复用；DR15-2 改 thunk 形）：
 * - 先打 start（可附 startFields 诊断字段），**再**调用 start() 发起该步 ——
 *   旧 promise 实参形会先求值实参，stop 同步抛错时 start 丢失、挂点不可归因；
 * - ms 内 settle → done；
 * - 到点未 settle → 打 `timeout_bounded`（warn）并返回 'timeout'，调用方
 *   **best-effort 推进**后续退出步（进程退出路径上不该有无限等待）；
 * - 拒绝/同步抛错 → 打 failed 并原样重抛（调用方既有 reportStopError 模式不变）。
 *
 * 超时后原 promise 不被取消（也取消不了）：它继续在后台跑，这里只停止等待；
 * 挂一个 catch 吞掉迟到失败，防止超时分支返回后出现 unhandled rejection。
 * 残余句柄/连接最终随 process.exit 一起终止。
 */
export async function raceShutdownTimeout(
  emit: ShutdownStepEmit,
  step: string,
  start: () => Promise<void>,
  timeoutMs: number,
  startFields?: Record<string, unknown>,
): Promise<'done' | 'timeout'> {
  emit('info', SHUTDOWN_STEP_EVENT, { step, status: 'start', ...(startFields ?? {}) });
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  // 定时器不该反过来把进程挂住（退出路径上进程本就要死）。
  (timer as { unref?: () => void } | undefined)?.unref?.();
  try {
    const pending = start();
    const outcome = await Promise.race([pending.then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      emit('warn', SHUTDOWN_STEP_EVENT, {
        step,
        status: 'timeout_bounded',
        duration_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
      });
      // 原 promise 继续后台跑；迟到失败只吞不抛（防 unhandled rejection）。
      void pending.catch(() => undefined);
    } else {
      emit('info', SHUTDOWN_STEP_EVENT, {
        step,
        status: 'done',
        duration_ms: Date.now() - startedAt,
      });
    }
    return outcome;
  } catch (error) {
    emit('warn', SHUTDOWN_STEP_EVENT, {
      step,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      error: errorText(error),
    });
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
