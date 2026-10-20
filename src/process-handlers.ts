/**
 * CLI / serve 的未捕获异常兜底（0.10 R2-15）。
 *
 * 行为：
 * - `unhandledRejection` / `uncaughtException` → logger.error + `process.error` 事件；
 * - 同步设置非 0 退出码（脚本可观测）；
 * - 不吞异常：事件只记一次，随后限时执行 shutdown 并 `process.exit(1)`；
 * - shutdown 缺失或失败也退出，且不覆盖第一个退出码。
 *
 * 注意：事件只带 kind 与 message，不带 stack / 原始对象（可能含 prompt 或密钥）。
 *
 * @module vessel/process-handlers
 */

import {
  createDefaultTraceRedactor,
  type EventStream,
  type Logger,
} from '../packages/core/src/index';

/** 兜底处理的失败类型（开放集合，当前只有 Node 的两个入口） */
export type ProcessFailureKind = 'unhandledRejection' | 'uncaughtException';

export interface ProcessErrorHandlerOptions {
  logger: Logger;
  /** 晚绑定：bootstrap 完成前为 undefined */
  events?: () => EventStream | undefined;
  /** 晚绑定：bootstrap 完成前为 undefined；异常时用于释放锁 / 关闭 gateway */
  shutdown?: () => Promise<void>;
  /** 测试注入；默认 `process.exit` */
  exit?: (code: number) => void;
  /** 测试注入；默认写 `process.exitCode` */
  setExitCode?: (code: number) => void;
  /** shutdown 最长期限；默认 5000ms */
  shutdownTimeoutMs?: number;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 与 logger 同源：事件里的 message 也走默认 redactor（异常文本可能带密钥） */
function redactMessage(message: string): string {
  const redacted = createDefaultTraceRedactor().redact({
    type: 'process.error',
    run_id: 'process',
    data: { message },
    ts: 0,
  });
  const value = (redacted.data as Record<string, unknown>).message;
  return typeof value === 'string' ? value : '[redacted]';
}

/**
 * 创建错误处理器。返回的函数可重复调用：只有第一次触发 shutdown/exit，
 * 后续只记录（避免 unhandledRejection 之后紧跟 uncaughtException 时重复清理）。
 */
export function createProcessErrorHandler(
  options: ProcessErrorHandlerOptions,
): (kind: ProcessFailureKind, error: unknown) => void {
  const { logger } = options;
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.shutdownTimeoutMs ?? 5000;
  let handling = false;

  return (kind, error) => {
    // 同步设置退出码：即使 shutdown 卡住，调用方（测试 / shell）也能看到非 0。
    setExitCode(1);

    const message = errorMessage(error);
    try {
      logger.error('process error', { kind, error: message });
    } catch {
      // 日志 sink 故障不得影响退出
    }

    try {
      const events = options.events?.();
      events?.publish({
        type: 'process.error',
        run_id: 'process',
        data: { kind, message: redactMessage(message) },
        ts: (options.now ?? Date.now)(),
      });
    } catch {
      // 事件发布失败不阻断退出
    }

    if (handling) return;
    handling = true;

    const finish = (): void => {
      try {
        exit(1);
      } catch {
        // 已退出 / 测试注入抛错：忽略
      }
    };

    const shutdown = options.shutdown;
    if (!shutdown) {
      finish();
      return;
    }

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      finish();
    };

    const timer = setTimeout(settle, timeoutMs);
    timer.unref?.();

    void shutdown()
      .catch((shutdownError: unknown) => {
        try {
          logger.error('shutdown failed while handling process error', {
            error: errorMessage(shutdownError),
          });
        } catch {
          // best-effort
        }
      })
      .finally(() => {
        clearTimeout(timer);
        settle();
      });
  };
}

/**
 * 在进程上安装两个入口。返回卸载函数（重复安装前先卸载；测试用）。
 */
export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions): () => void {
  const handler = createProcessErrorHandler(options);
  const onRejection = (reason: unknown): void => handler('unhandledRejection', reason);
  const onException = (error: unknown): void => handler('uncaughtException', error);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
