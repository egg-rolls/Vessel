/**
 * 0.2 Scheduler（R2）
 *
 * - 全局并发上限（默认 1）
 * - FIFO 队列（默认上限 100），同成员串行（默认开启）
 * - 排队取消 / 运行取消 / stats / close 清理
 * - `AgentHandle.run` 经本调度器；通过 `ScheduledTask.executor` 或内部符号
 *   直接执行，避免 submit → agent.run → submit 递归。
 *
 * @module @vessel-agent/core/kernel
 */

import { randomUUID } from 'node:crypto';
import type { EventStream } from '../types/event.js';
import type { Usage } from '../types/provider.js';
import {
  type InternalAgentHandle,
  type InternalScheduler,
  kCancelAgentRuns,
  kExecuteAgentRun,
} from './internal.js';
import type {
  RunHandle,
  RunSnapshot,
  RunStatus,
  ScheduledTask,
  SchedulerOptions,
  SchedulerSnapshot,
  SchedulerStats,
  WaitReason,
} from './types.js';

interface QueueEntry {
  task: ScheduledTask;
  run: QueuedRunHandle;
  cancelled: boolean;
  /** 入队时间（Unix ms） */
  enqueuedAt: number;
  /** 开始执行时间（Unix ms） */
  startedAt?: number;
  /** 已发布 `agent.queue.entered` 时的位置与原因；用于配对 `left` */
  announced?: { position: number; waitReason: WaitReason };
}

/** 排队中的 RunHandle：id 在入队时确定，运行后委托给真实 handle */
class QueuedRunHandle implements RunHandle {
  readonly id: string;
  readonly agentId: string;
  readonly result: Promise<string>;

  private sessionIdValue: string;
  private state: RunStatus = 'queued';
  private real?: RunHandle;
  private resolveResult!: (value: string) => void;
  private rejectResult!: (reason?: unknown) => void;

  constructor(id: string, agentId: string, sessionId: string) {
    this.id = id;
    this.agentId = agentId;
    this.sessionIdValue = sessionId;
    this.result = new Promise<string>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // 调用方可以不 await result；避免未处理拒绝告警
    void this.result.catch(() => {});
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** @internal 采用 Scheduler 最终传入的 sessionId（F9） */
  setSessionId(sessionId: string): void {
    this.sessionIdValue = sessionId;
  }

  status(): RunStatus {
    return this.real ? this.real.status() : this.state;
  }

  usage(): Usage | undefined {
    return this.real?.usage();
  }

  cancel(reason?: string): void {
    if (this.real) {
      this.real.cancel(reason);
      return;
    }
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') {
      return;
    }
    this.state = 'cancelled';
    this.rejectResult(new Error(reason ?? 'run cancelled'));
  }

  /** @internal 开始执行 */
  setRunning(): void {
    if (!this.real) this.state = 'running';
  }

  /** @internal 执行失败（尚未 attach 真实 handle） */
  markFailed(error: unknown): void {
    if (this.real) return;
    this.state = 'failed';
    this.rejectResult(error instanceof Error ? error : new Error(String(error)));
  }

  /** @internal 绑定真实 RunHandle，转发结果与取消 */
  attach(real: RunHandle): void {
    this.real = real;
    real.result.then(
      (value) => this.resolveResult(value),
      (error) => this.rejectResult(error),
    );
    if (this.state === 'cancelled') real.cancel('run cancelled');
  }
}

/** 完整 Scheduler（R2） */
export class InProcessScheduler implements InternalScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly active = new Map<string, QueueEntry>();
  private readonly agentRunning = new Set<string>();
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly perAgentSerial: boolean;
  /** 0.15 E4：队列事件发布流；缺省不发 */
  private readonly events?: EventStream;
  private readonly tenantId?: string;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private closed = false;

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 100);
    this.perAgentSerial = options.perAgentSerial ?? true;
    this.events = options.events;
    this.tenantId = options.tenantId;
  }

  async submit(task: ScheduledTask): Promise<RunHandle> {
    if (this.closed) throw new Error('scheduler is closed');
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`scheduler queue is full (max ${this.maxQueueSize})`);
    }
    // 0.14.1：固定 runId 用于 resume；同一 id 不得同时排队 / 运行
    if (task.runId !== undefined && this.hasRun(task.runId)) {
      throw new Error(`run already scheduled: ${task.runId}`);
    }

    const run = new QueuedRunHandle(
      task.runId ?? randomUUID(),
      task.agent.id,
      task.sessionId ?? 'default',
    );
    const entry: QueueEntry = { task, run, cancelled: false, enqueuedAt: Date.now() };
    this.queue.push(entry);
    this.drain();
    // drain 后仍在队列里才算真正进入等待；直接启动的任务不发 queue 事件。
    this.announceEntered(entry);
    return run;
  }

  cancel(runId: string, reason?: string): boolean {
    const active = this.active.get(runId);
    if (active) {
      active.run.cancel(reason);
      return true;
    }

    const index = this.queue.findIndex((entry) => entry.run.id === runId);
    if (index === -1) return false;
    const [entry] = this.queue.splice(index, 1);
    if (!entry) return false;
    this.announceLeft(entry, index + 1);
    entry.cancelled = true;
    entry.run.cancel(reason);
    this.cancelled++;
    return true;
  }

  stats(): SchedulerStats {
    return {
      queued: this.queue.length,
      running: this.active.size,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
    };
  }

  /** 0.14.1：只读、可序列化的队列 / 运行快照 */
  snapshot(): SchedulerSnapshot {
    const asOf = Date.now();
    const queued: RunSnapshot[] = [];
    for (const entry of this.queue) {
      if (entry.cancelled) continue;
      queued.push({
        runId: entry.run.id,
        agentId: entry.task.agent.id,
        sessionId: entry.run.sessionId,
        state: 'queued',
        queuePosition: queued.length + 1,
        waitReason: this.waitReasonFor(entry),
        queuedAt: entry.enqueuedAt,
      });
    }

    const running: RunSnapshot[] = [...this.active.values()].map((entry) => ({
      runId: entry.run.id,
      agentId: entry.task.agent.id,
      sessionId: entry.run.sessionId,
      state: 'running' as const,
      queuedAt: entry.enqueuedAt,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
    }));

    return { asOf, queued, running, stats: this.stats() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const remaining = this.queue.splice(0);
    remaining.forEach((entry, index) => {
      this.announceLeft(entry, index + 1);
    });
    for (const entry of remaining) {
      entry.cancelled = true;
      entry.run.cancel('scheduler closed');
      this.cancelled++;
    }
    for (const entry of [...this.active.values()]) {
      entry.run.cancel('scheduler closed');
      // settle 不会再次计数（active 已清空）
      this.cancelled++;
    }
    this.active.clear();
    this.agentRunning.clear();
  }

  /** @internal 按成员取消排队与运行中的 run（Host.closeMember） */
  [kCancelAgentRuns](agentId: string, reason?: string): number {
    let count = 0;

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (entry && entry.task.agent.id === agentId) {
        this.queue.splice(i, 1);
        this.announceLeft(entry, i + 1);
        entry.cancelled = true;
        entry.run.cancel(reason ?? 'agent closed');
        this.cancelled++;
        count++;
      }
    }

    for (const entry of [...this.active.values()]) {
      if (entry.task.agent.id === agentId) {
        entry.run.cancel(reason ?? 'agent closed');
        count++;
      }
    }

    return count;
  }

  /** 有空位时按 FIFO 取第一个可执行任务（同成员串行时跳过忙碌成员） */
  private drain(): void {
    while (!this.closed && this.active.size < this.maxConcurrency) {
      const index = this.queue.findIndex(
        (entry) =>
          !entry.cancelled && (!this.perAgentSerial || !this.agentRunning.has(entry.task.agent.id)),
      );
      if (index === -1) break;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) break;
      this.announceLeft(entry, index + 1);
      void this.start(entry);
    }
  }

  /**
   * 0.15 E4：该任务为何排队。
   * 容量已满优先；其次同成员串行。core 不会产出 paused / dependency / quota。
   */
  private waitReasonFor(entry: QueueEntry): WaitReason {
    if (this.active.size >= this.maxConcurrency) return 'capacity';
    if (this.perAgentSerial && this.agentRunning.has(entry.task.agent.id)) {
      return 'per_agent_serial';
    }
    return 'capacity';
  }

  /** 入队观测：只有 submit 后仍留在队列里的任务才发布 */
  private announceEntered(entry: QueueEntry): void {
    if (entry.cancelled || !this.events) return;
    const index = this.queue.indexOf(entry);
    if (index === -1) return;
    const position = index + 1;
    const waitReason = this.waitReasonFor(entry);
    entry.announced = { position, waitReason };
    this.publishQueueEvent('agent.queue.entered', entry, position, waitReason);
  }

  /** 出队观测：与 `entered` 配对；直接启动的任务没有 `entered`，也不发 `left` */
  private announceLeft(entry: QueueEntry, position: number): void {
    const announced = entry.announced;
    if (!announced) return;
    entry.announced = undefined;
    this.publishQueueEvent('agent.queue.left', entry, position, announced.waitReason);
  }

  /** 队列事件 data 为冻结的 snake_case 形状（0.15 E4） */
  private publishQueueEvent(
    type: 'agent.queue.entered' | 'agent.queue.left',
    entry: QueueEntry,
    position: number,
    waitReason: WaitReason,
  ): void {
    if (!this.events) return;
    this.events.publish({
      type,
      run_id: entry.run.id,
      data: {
        agent_id: entry.task.agent.id,
        run_id: entry.run.id,
        position,
        wait_reason: waitReason,
        since: entry.enqueuedAt,
      },
      ts: Date.now(),
      ...(this.tenantId !== undefined ? { tenant_id: this.tenantId } : {}),
    });
  }

  /** 启动一个排队任务 */
  private async start(entry: QueueEntry): Promise<void> {
    const agentId = entry.task.agent.id;
    entry.startedAt = Date.now();
    this.active.set(entry.run.id, entry);
    this.agentRunning.add(agentId);
    // F9：采用 task 上最终确定的 sessionId（自定义 Scheduler 可能改写）
    entry.run.setSessionId(entry.task.sessionId ?? 'default');
    entry.run.setRunning();

    try {
      const real = await this.executeTask(entry.task, entry.run.id);
      entry.run.attach(real);
      real.result.then(
        () => this.settle(entry, 'completed'),
        () => this.settle(entry, real.status() === 'cancelled' ? 'cancelled' : 'failed'),
      );
    } catch (error) {
      entry.run.markFailed(error);
      this.settle(entry, 'failed');
    }
  }

  /** 直接执行入口：executor > Host 内部符号 > 第三方 handle.run */
  private executeTask(task: ScheduledTask, runId: string): Promise<RunHandle> {
    if (task.executor) return task.executor(runId);

    const internal = task.agent as Partial<InternalAgentHandle>;
    const execute = internal[kExecuteAgentRun];
    if (typeof execute === 'function') {
      return execute.call(task.agent, task.input, { ...task.opts, runId }, task.sessionId);
    }

    return task.agent.run(task.input, { ...task.opts, runId });
  }

  /** 是否已有同 id 的排队 / 运行项 */
  private hasRun(runId: string): boolean {
    if (this.active.has(runId)) return true;
    return this.queue.some((entry) => entry.run.id === runId);
  }

  /** 结算：更新计数、释放槽位、继续 drain */
  private settle(entry: QueueEntry, outcome: 'completed' | 'failed' | 'cancelled'): void {
    if (!this.active.delete(entry.run.id)) return;
    this.agentRunning.delete(entry.task.agent.id);
    if (outcome === 'completed') this.completed++;
    else if (outcome === 'cancelled') this.cancelled++;
    else this.failed++;
    this.drain();
  }
}

/** @deprecated R1 名称；使用 InProcessScheduler */
export { InProcessScheduler as SerialScheduler };
