/**
 * 有界事件缓冲（ring buffer）+ 订阅。
 *
 * - 每个 run 最多 2000 条，总数最多 10000 条；超出丢弃最旧并标记 truncated。
 * - 按 seq 去重（重连回放不会产生重复卡片）。
 * - 通知节流到 ~50ms，避免每个 token 重渲染整棵树。
 * - 快照对象在通知时整体替换，兼容 React `useSyncExternalStore`。
 */
import type { RunEvent } from '../gateway/types';
import type { StoredEvent } from './events';

export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_EVENTS_TOTAL = 10000;
export const NOTIFY_INTERVAL_MS = 50;

export interface EventMeta {
  seq: number;
  jobId?: string;
}

export interface EventStoreSnapshot {
  entries: readonly StoredEvent[];
  truncatedRuns: ReadonlySet<string>;
  /** 最近一次通知时的 seq；重连/hello 判断用。 */
  lastSeq: number;
  version: number;
}

function emptySnapshot(): EventStoreSnapshot {
  return { entries: [], truncatedRuns: new Set(), lastSeq: 0, version: 0 };
}

export class EventStore {
  private entries: StoredEvent[] = [];
  private runCounts = new Map<string, number>();
  private truncated = new Set<string>();
  private lastSeq = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: EventStoreSnapshot = emptySnapshot();

  constructor(private readonly notifyDelayMs = NOTIFY_INTERVAL_MS) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EventStoreSnapshot => this.snapshot;

  /** 当前已接收的最大 seq（不等待 50ms 合批）。 */
  get currentSeq(): number {
    return this.lastSeq;
  }

  /**
   * 写入一条事件；seq 不大于已见值时忽略（回放去重）。
   * 返回是否实际写入。
   */
  push(event: RunEvent, meta: EventMeta): boolean {
    if (!Number.isFinite(meta.seq) || meta.seq <= this.lastSeq) return false;
    this.lastSeq = meta.seq;
    this.entries.push({
      event,
      seq: meta.seq,
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
    });
    const runId = event.run_id;
    const count = (this.runCounts.get(runId) ?? 0) + 1;
    this.runCounts.set(runId, count);

    // 每 run 上限：删该 run 最旧的一条。
    if (count > MAX_EVENTS_PER_RUN) {
      const index = this.entries.findIndex((entry) => entry.event.run_id === runId);
      if (index >= 0) this.entries.splice(index, 1);
      this.runCounts.set(runId, count - 1);
      this.truncated.add(runId);
    }

    // 总上限：从最旧开始丢。
    while (this.entries.length > MAX_EVENTS_TOTAL) {
      const removed = this.entries.shift();
      if (!removed) break;
      const removedRun = removed.event.run_id;
      const remaining = (this.runCounts.get(removedRun) ?? 1) - 1;
      if (remaining <= 0) this.runCounts.delete(removedRun);
      else this.runCounts.set(removedRun, remaining);
      this.truncated.add(removedRun);
    }

    this.scheduleNotify();
    return true;
  }

  /** 清空缓冲（gateway 重启 / 切 tenant / gap 重新同步）。 */
  reset(nextSeq = 0): void {
    this.entries = [];
    this.runCounts.clear();
    this.truncated.clear();
    this.lastSeq = nextSeq;
    this.version += 1;
    this.snapshot = {
      entries: this.entries,
      truncatedRuns: new Set(),
      lastSeq: nextSeq,
      version: this.version,
    };
    this.cancelTimer();
    this.notify();
  }

  /** 立即发布待处理事件（测试与路由切换前使用）。 */
  flush(): void {
    this.cancelTimer();
    this.version += 1;
    this.snapshot = {
      entries: this.entries,
      truncatedRuns: new Set(this.truncated),
      lastSeq: this.lastSeq,
      version: this.version,
    };
    this.notify();
  }

  destroy(): void {
    this.cancelTimer();
    this.listeners.clear();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.flush();
    }, this.notifyDelayMs);
  }

  private cancelTimer(): void {
    if (this.notifyTimer === undefined) return;
    clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
