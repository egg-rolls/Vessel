/**
 * 有界事件缓冲（ring buffer）+ 订阅。
 *
 * - 每个 run 最多 2000 条，总数最多 10000 条；超出丢弃最旧并标记 truncated。
 * - 按 seq 去重（重连回放不会产生重复卡片）。
 * - 通知节流到 ~50ms，避免每个 token 重渲染整棵树。
 * - 快照对象在通知时整体替换，`entries` 也必须是新数组：消费者（ChatView / RunDetail）
 *   用 `useMemo(..., [snapshot.entries])` 派生视图，复用可变数组会让流式事件不触发重算，
 *   表现为“必须刷新才看到内容”。
 * - **锚点事件不参与按 run 裁剪**：`run.started` / `user.message` / 终态事件承载
 *   `session_id`、`input`、`status`，裁掉就会让整段 live run 从会话时间线消失（见
 *   `RUN_ANCHOR_EVENT_TYPES`）。`session_id` 另外按 run 记住，裁剪后仍能归属会话。
 */
import type { RunEvent } from '../gateway/types';
import type { StoredEvent } from './events';

export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_EVENTS_TOTAL = 10000;
export const NOTIFY_INTERVAL_MS = 50;

/**
 * 单 run 裁剪时必须保留的锚点事件。
 *
 * 流式增量（`llm.stream.chunk`）按 delta 计，一条长正文就能把同一个 run 的 2000 条
 * 额度吃满；老实现从 run 头部逐条丢，`run.started` 一旦被丢：
 * `group.sessionId` 变 undefined → 会话窗口按 sessionId 过滤时整段 live run 消失，
 * 用户表现为「跑的时候看不见正文/工具卡，run 结束刷新后才一次性出现」。
 * 这里只丢非锚点条目，并保留 run 首尾的语义事件。
 */
export const RUN_ANCHOR_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'user.message',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export interface EventMeta {
  seq: number;
  jobId?: string;
}

export interface EventStoreSnapshot {
  entries: readonly StoredEvent[];
  /** 累计被裁剪过的 run（自首次 flush 起）。 */
  truncatedRuns: ReadonlySet<string>;
  /** 自上一次快照以来被裁剪过的 run；group-cache 用它做局部重建。 */
  truncatedSince: ReadonlySet<string>;
  /** 最近一次通知时的 seq；重连/hello 判断用。 */
  lastSeq: number;
  version: number;
}

/** 事件自报的 session 归属：优先顶层字段，其次 `data.session_id`；缺失时 undefined。 */
function eventSessionId(event: RunEvent): string | undefined {
  const topLevel = (event as { session_id?: unknown }).session_id;
  if (typeof topLevel === 'string' && topLevel.length > 0) return topLevel;
  const value = (event.data as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function emptySnapshot(): EventStoreSnapshot {
  return {
    entries: [],
    truncatedRuns: new Set(),
    truncatedSince: new Set(),
    lastSeq: 0,
    version: 0,
  };
}

export class EventStore {
  private entries: StoredEvent[] = [];
  private runCounts = new Map<string, number>();
  /** run_id → session_id：裁剪掉 `run.started` 后仍能把事件归属到会话。 */
  private runSessions = new Map<string, string>();
  private truncated = new Set<string>();
  /** 待发布到下一份快照的裁剪增量；flush 后清空。 */
  private truncatedSince = new Set<string>();
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
    const runId = event.run_id;
    // 归属会话的字段最先记住：即使本 run 的 `run.started` 之后被裁掉，仍能归属会话。
    const sessionId = eventSessionId(event);
    if (sessionId !== undefined) this.runSessions.set(runId, sessionId);
    const owner = this.runSessions.get(runId);
    this.entries.push({
      event,
      seq: meta.seq,
      ...(owner !== undefined ? { sessionId: owner } : {}),
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
    });
    const count = (this.runCounts.get(runId) ?? 0) + 1;
    this.runCounts.set(runId, count);

    // 每 run 上限：优先丢该 run 最旧的非锚点条目（锚点见 RUN_ANCHOR_EVENT_TYPES）。
    if (count > MAX_EVENTS_PER_RUN) {
      const index = this.oldestEvictableIndex(runId);
      if (index >= 0) this.entries.splice(index, 1);
      this.runCounts.set(runId, count - 1);
      this.truncated.add(runId);
      this.truncatedSince.add(runId);
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
      this.truncatedSince.add(removedRun);
    }

    this.scheduleNotify();
    return true;
  }

  /**
   * 删除某个会话的全部事件（rewind 后这些历史已不存在）。
   *
   * 归属判定：事件顶层 / `data.session_id` 等于目标会话的 run 记为目标的 run；该 run
   * 中未带 session_id 的条目一并删除。先按 session 判定而不是直接按 run_id，
   * 避免 `session.rewound` 共用 `run_id: 'manual'` 时误删其它会话的条目。
   * 删除后重建 run 计数，并把受影响的 run 写进 `truncatedSince`：group-cache
   * 据此做局部重建，否则同一窗口内的 partial 更新可能留下幽灵分组。
   * 立即发布快照。返回删除的条目数。
   */
  dropSession(sessionId: string): number {
    const runIds = new Set<string>();
    for (const entry of this.entries) {
      if (this.ownerOf(entry) === sessionId) runIds.add(entry.event.run_id);
    }
    if (runIds.size === 0) return 0;

    const before = this.entries.length;
    const removedRunIds = new Set<string>();
    this.entries = this.entries.filter((entry) => {
      const owner = this.ownerOf(entry);
      const remove = owner === sessionId || (owner === undefined && runIds.has(entry.event.run_id));
      if (remove) removedRunIds.add(entry.event.run_id);
      return !remove;
    });
    const removed = before - this.entries.length;
    if (removed === 0) return 0;

    this.runCounts.clear();
    for (const entry of this.entries) {
      const runId = entry.event.run_id;
      this.runCounts.set(runId, (this.runCounts.get(runId) ?? 0) + 1);
    }
    for (const runId of removedRunIds) {
      // 局部重建信号：bucket 里可能还留着被删条目的旧副本。
      this.truncatedSince.add(runId);
      // 已没有条目的 run 不再需要累计“被裁剪”标记。
      if (!this.runCounts.has(runId)) {
        this.truncated.delete(runId);
        this.runSessions.delete(runId);
      }
    }
    this.flush();
    return removed;
  }

  /** 清空缓冲（gateway 重启 / 切 tenant / gap 重新同步）。 */
  reset(nextSeq = 0): void {
    this.entries = [];
    this.runCounts.clear();
    this.runSessions.clear();
    this.truncated.clear();
    this.truncatedSince.clear();
    this.lastSeq = nextSeq;
    this.version += 1;
    this.snapshot = {
      entries: [],
      truncatedRuns: new Set(),
      truncatedSince: new Set(),
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
      // 复制数组：entries 在 push 中原地追加，复用引用会让 memo 消费者永远看到旧视图。
      entries: [...this.entries],
      truncatedRuns: new Set(this.truncated),
      truncatedSince: new Set(this.truncatedSince),
      lastSeq: this.lastSeq,
      version: this.version,
    };
    // 增量只对下一份快照有效；消费后即使没有新事件也不重复报告。
    this.truncatedSince.clear();
    this.notify();
  }

  destroy(): void {
    this.cancelTimer();
    this.listeners.clear();
  }

  /** 条目归属的会话：push 时记住的 run→session 优先，其次事件自报的字段。 */
  private ownerOf(entry: StoredEvent): string | undefined {
    return entry.sessionId ?? eventSessionId(entry.event);
  }

  /**
   * 该 run 最旧的可裁剪条目下标。
   *
   * 优先返回非锚点条目；整段都是锚点时退回最旧一条（极小 run 不该卡死上限），
   * 没有任何条目时返回 -1。
   */
  private oldestEvictableIndex(runId: string): number {
    let fallback = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.event.run_id !== runId) continue;
      if (fallback < 0) fallback = index;
      if (!RUN_ANCHOR_EVENT_TYPES.has(entry.event.type)) return index;
    }
    return fallback;
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
