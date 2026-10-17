/**
 * R1 受限 Scheduler。
 *
 * 只提供 submit / cancel / stats / close；不做队列：
 * 同一成员已有活跃 run 时由 AgentHandle 直接拒绝（R2 换成完整队列实现）。
 * 该实现满足 F2 的「R1 可用受限实现」要求，类型契约见 types.ts。
 *
 * @module @vessel/core/kernel
 */

import type { RunHandle, ScheduledTask, Scheduler, SchedulerStats } from './types.js';

/** R1 串行调度器：无队列、无优先级、并发由 AgentHandle 拒绝 */
export class SerialScheduler implements Scheduler {
  private readonly active = new Map<string, RunHandle>();
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private closed = false;

  async submit(task: ScheduledTask): Promise<RunHandle> {
    if (this.closed) throw new Error('scheduler is closed');

    // R1：sessionId / priority 只冻结不消费；session 由 AgentSpec 固定
    const run = await task.agent.run(task.input, task.opts);
    this.active.set(run.id, run);

    // 结算时更新计数并移除；不吞掉调用方的 result
    void run.result.then(
      () => {
        this.active.delete(run.id);
        this.completed++;
      },
      () => {
        this.active.delete(run.id);
        if (run.status() === 'cancelled') this.cancelled++;
        else this.failed++;
      },
    );

    return run;
  }

  cancel(runId: string, reason?: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.cancel(reason);
    return true;
  }

  stats(): SchedulerStats {
    return {
      queued: 0,
      running: this.active.size,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of [...this.active.values()]) {
      run.cancel('scheduler closed');
    }
    this.active.clear();
  }
}
