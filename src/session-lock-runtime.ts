/**
 * RunnableAgent 的 session / run 写锁包装（0.15 DESIGN-0.14 §1.2）。
 *
 * 每次 `run()` 取目标 session 的写锁，`resume()` 取 run 锁；
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

/** 给 runtime 的 run / resume 套上跨进程写锁。 */
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
      const id = sessionId !== undefined && sessionId !== '' ? sessionId : 'default';
      const lock = await acquireSessionLock({ tenantDir, kind: 'session', id });
      try {
        return await runtime.run(input, sessionId, opts);
      } finally {
        await lock.release();
      }
    },
    async dispose(): Promise<void> {
      await runtime.dispose();
    },
  };

  if (typeof runtime.resume === 'function') {
    const resume = runtime.resume.bind(runtime);
    wrapped.resume = async (runId: string, opts?: RunOptions): Promise<string> => {
      const lock = await acquireSessionLock({ tenantDir, kind: 'run', id: runId });
      try {
        return await resume(runId, opts);
      } finally {
        await lock.release();
      }
    };
  }

  return wrapped;
}
