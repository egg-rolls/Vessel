/**
 * RunnableAgent 的 run 写锁包装（0.15 DESIGN-0.14 §1.2 / 0.34 Stage 3）。
 *
 * Session 级排他已迁移到 `LeaseServicePort`（ExecutionUnit 在首个 run 前 acquire
 * SessionLease）；本包装只保留 `resumeRun()` 的 `run` 级文件写锁。
 * REPL 进程级长锁由 bootstrap 另行持有，同进程重复获取由 session-lock 的引用计数消化。
 *
 * @module vessel/session-lock-runtime
 */

import type { Message, RunnableAgent, RunOptions } from '../packages/core/src/index';
import { acquireSessionLock } from './session-lock';

export interface SessionWriteLockOptions {
  tenantDir: string;
  /** false 时原样返回（memory 后端 / 只读入口） */
  enabled?: boolean;
}

/** 给 runtime 的 run / resumeRun 套上跨进程写锁。 */
export function withSessionWriteLock(
  runtime: RunnableAgent,
  options: SessionWriteLockOptions,
): RunnableAgent {
  if (options.enabled === false) return runtime;
  const tenantDir = options.tenantDir;

  const wrapped: RunnableAgent = {
    events: runtime.events,
    pluginHost: runtime.pluginHost,
    async run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string> {
      // session 级排他由 ExecutionUnit 持有的 SessionLease 负责；这里不再取文件锁。
      return runtime.run(input, sessionId, opts);
    },
    async dispose(): Promise<void> {
      await runtime.dispose();
    },
  };

  if (typeof runtime.resumeRun === 'function') {
    const resumeRun = runtime.resumeRun.bind(runtime);
    wrapped.resumeRun = async (runId: string, opts?: RunOptions): Promise<string> => {
      const lock = await acquireSessionLock({ tenantDir, kind: 'run', id: runId });
      try {
        return await resumeRun(runId, opts);
      } finally {
        await lock.release();
      }
    };
  }

  return wrapped;
}
