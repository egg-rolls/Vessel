/**
 * 按 run 增量的 `RunGroup` 缓存（0.15 P0，DESIGN-0.14 §2.3）。
 *
 * EventStore 每 50ms 发一次新快照；`entries` 在未截断时只追加、条目对象不变。
 * 这里只把**新增条目**并入对应 run 的 bucket，并且只对受影响的 run 重跑
 * `buildGroup`；未变化的 `RunGroup` 保持引用不变，配合 `memo(RunItems)`
 * 避免流式 token 触发整棵树重渲染。
 *
 * 截断（总数上限/reset/gap）会让首条或中段条目变化，此时整表重建。
 * 可见性设置（showInternal / errorLevel）变化时同样整表重建。
 */
import type { ErrorVisibility } from './error-visibility';
import { buildGroup, isVisibleForGrouping, type RunGroup, type StoredEvent } from './events';

export interface GroupCacheStats {
  /** 本轮真正调用 buildGroup 的 run 数。 */
  rebuiltRuns: number;
  /** 本轮直接复用旧 RunGroup 的 run 数。 */
  reusedRuns: number;
  /** 本轮新并入的条目数（不含全量重建）。 */
  appendedEntries: number;
  /** 触发整表重建的次数（首轮 / 截断 / 设置变化）。 */
  fullRebuilds: number;
}

function optionKey(showInternal: boolean, errorLevel: ErrorVisibility): string {
  return `${showInternal ? '1' : '0'}:${errorLevel}`;
}

function groupStart(group: RunGroup): number {
  return group.startedAt ?? group.firstTs ?? 0;
}

/** 判断新快照是否只是在旧快照尾部追加（条目对象保持同一引用）。 */
function isAppendOnly(previous: readonly StoredEvent[], next: readonly StoredEvent[]): boolean {
  if (next.length < previous.length) return false;
  if (previous.length === 0) return true;
  return next[previous.length - 1] === previous[previous.length - 1];
}

export class EventGroupCache {
  private opts: string | null = null;
  private entries: readonly StoredEvent[] = [];
  private buckets = new Map<string, StoredEvent[]>();
  private groups = new Map<string, RunGroup>();
  private order: string[] = [];
  private result: RunGroup[] = [];
  private lastStats: GroupCacheStats = {
    rebuiltRuns: 0,
    reusedRuns: 0,
    appendedEntries: 0,
    fullRebuilds: 0,
  };

  /** 最近一次 `group()` 的增量统计（测试与性能诊断用）。 */
  get stats(): GroupCacheStats {
    return this.lastStats;
  }

  /**
   * 返回按开始时间排序的 run 分组。
   * 同一份 entries + 同一组可见性设置再次调用时直接返回缓存数组。
   */
  group(
    entries: readonly StoredEvent[],
    showInternal: boolean,
    errorLevel: ErrorVisibility = 'user',
  ): RunGroup[] {
    const key = optionKey(showInternal, errorLevel);
    if (this.opts === key && entries === this.entries) return this.result;

    const appendOnly = this.opts === key && isAppendOnly(this.entries, entries);
    if (!appendOnly) {
      this.buckets.clear();
      this.groups.clear();
      this.order = [];
      this.result = [];
    }

    let start = appendOnly ? this.entries.length : 0;
    const dirty = new Set<string>();
    let appended = 0;
    for (; start < entries.length; start += 1) {
      const entry = entries[start];
      if (!entry || !isVisibleForGrouping(entry, showInternal, errorLevel)) continue;
      const runId = entry.event.run_id;
      let bucket = this.buckets.get(runId);
      if (!bucket) {
        bucket = [];
        this.buckets.set(runId, bucket);
        this.order.push(runId);
      }
      bucket.push(entry);
      dirty.add(runId);
      appended += 1;
    }

    for (const runId of dirty) {
      const bucket = this.buckets.get(runId);
      if (bucket) this.groups.set(runId, buildGroup(runId, bucket));
    }

    if (dirty.size > 0 || this.result.length !== this.order.length) {
      this.result = this.order
        .map((runId) => this.groups.get(runId))
        .filter((group): group is RunGroup => group !== undefined)
        .sort((a, b) => groupStart(a) - groupStart(b));
    }

    this.opts = key;
    this.entries = entries;
    this.lastStats = {
      rebuiltRuns: dirty.size,
      reusedRuns: this.order.length - dirty.size,
      appendedEntries: appendOnly ? appended : entries.length,
      fullRebuilds: this.lastStats.fullRebuilds + (appendOnly ? 0 : 1),
    };
    return this.result;
  }
}
