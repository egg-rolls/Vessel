/**
 * 按 run 增量的 `RunGroup` 缓存（0.15 P0，DESIGN-0.14 §2.3）。
 *
 * EventStore 每 50ms 发一次新快照；`entries` 按 `StoredEvent.seq` 升序。
 * 这里用单调 seq 找出真正的追加段，只把**新增条目**并入对应 run 的 bucket，
 * 并且只对受影响的 run 重跑 `buildGroup`；未变化的 `RunGroup` 保持引用不变，
 * 配合 `memo(RunItems)` 避免流式 token 触发整棵树重渲染。
 *
 * run 超过上限后 EventStore 会从头部裁剪该 run 的旧条目（数组长度不再增长）。
 * 快照携带 `truncatedSince`，缓存只重建被裁剪的 run，而不是整表重建。
 * 没有裁剪信息却出现旧条目消失（reset / gap / 异常输入）时才退回全量重建。
 * 可见性设置（showInternal / errorLevel）变化时同样整表重建。
 */
import type { ErrorVisibility } from './error-visibility';
import { buildGroup, isVisibleForGrouping, type RunGroup, type StoredEvent } from './events';

export interface GroupCacheStats {
  /** 本轮真正调用 buildGroup 的 run 数（含裁剪后的局部重建）。 */
  rebuiltRuns: number;
  /** 本轮直接复用旧 RunGroup 的 run 数。 */
  reusedRuns: number;
  /** 本轮新并入的条目数（不含全量重建）。 */
  appendedEntries: number;
  /** 触发整表重建的次数（首轮 / 无裁剪信息的回退 / 设置变化）。 */
  fullRebuilds: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function optionKey(showInternal: boolean, errorLevel: ErrorVisibility): string {
  return `${showInternal ? '1' : '0'}:${errorLevel}`;
}

function groupStart(group: RunGroup): number {
  return group.startedAt ?? group.firstTs ?? 0;
}

/** 首个 `seq > lastSeq` 的下标（entries 按 seq 升序）。 */
function firstSeqGreaterThan(entries: readonly StoredEvent[], lastSeq: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((entries[mid]?.seq ?? 0) <= lastSeq) low = mid + 1;
    else high = mid;
  }
  return low;
}

type UpdateMode = 'append' | 'partial' | 'full';

export class EventGroupCache {
  private opts: string | null = null;
  private entries: readonly StoredEvent[] = [];
  /** 已处理条目的最大 seq；下一轮据此切出追加段。 */
  private lastSeq = 0;
  private buckets = new Map<string, StoredEvent[]>();
  private groups = new Map<string, RunGroup>();
  private order: string[] = [];
  private orderSet = new Set<string>();
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
    truncatedRuns: ReadonlySet<string> = EMPTY_SET,
  ): RunGroup[] {
    const key = optionKey(showInternal, errorLevel);
    if (this.opts === key && entries === this.entries) return this.result;

    const mode = this.resolveMode(entries, key, truncatedRuns);
    const survivors = mode === 'full' ? 0 : firstSeqGreaterThan(entries, this.lastSeq);

    if (mode === 'full') {
      this.buckets.clear();
      this.groups.clear();
      this.order = [];
      this.orderSet.clear();
      this.result = [];
    } else if (mode === 'partial') {
      // 只丢弃被裁剪 run 的旧 bucket；order 保留，空 bucket 稍后统一清理。
      for (const runId of truncatedRuns) {
        this.buckets.delete(runId);
        this.groups.delete(runId);
      }
      // 单次扫描存活前缀，重建这些 run 的 bucket（复用同一可见性口径）。
      for (let index = 0; index < survivors; index += 1) {
        const entry = entries[index];
        if (!entry || !truncatedRuns.has(entry.event.run_id)) continue;
        if (!isVisibleForGrouping(entry, showInternal, errorLevel)) continue;
        this.ensureBucket(entry.event.run_id).push(entry);
      }
    }

    const dirty = new Set<string>();
    let appended = 0;
    for (let index = survivors; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || !isVisibleForGrouping(entry, showInternal, errorLevel)) continue;
      const runId = entry.event.run_id;
      this.ensureBucket(runId).push(entry);
      dirty.add(runId);
      appended += 1;
    }
    // 裁剪 run 即使没有新事件也必须重算（bucket 已重建）。
    if (mode === 'partial') for (const runId of truncatedRuns) dirty.add(runId);

    let rebuilt = 0;
    for (const runId of dirty) {
      const bucket = this.buckets.get(runId);
      if (bucket && bucket.length > 0) {
        this.groups.set(runId, buildGroup(runId, bucket));
        rebuilt += 1;
      } else {
        // 全部条目都被裁掉的 run 不得留下幽灵 group。
        this.buckets.delete(runId);
        this.groups.delete(runId);
      }
    }
    this.pruneEmptyOrder();

    if (mode !== 'append' || dirty.size > 0 || this.result.length !== this.order.length) {
      this.result = this.order
        .map((runId) => this.groups.get(runId))
        .filter((group): group is RunGroup => group !== undefined)
        .sort((a, b) => groupStart(a) - groupStart(b));
    }

    this.opts = key;
    this.entries = entries;
    this.lastSeq = entries.length > 0 ? (entries[entries.length - 1]?.seq ?? 0) : 0;
    this.lastStats = {
      rebuiltRuns: rebuilt,
      reusedRuns: this.order.length - rebuilt,
      appendedEntries: mode === 'full' ? entries.length : appended,
      fullRebuilds: this.lastStats.fullRebuilds + (mode === 'full' ? 1 : 0),
    };
    return this.result;
  }

  /** 纯追加 / 按 truncatedRuns 局部重建 / 整表重建。 */
  private resolveMode(
    entries: readonly StoredEvent[],
    key: string,
    truncatedRuns: ReadonlySet<string>,
  ): UpdateMode {
    if (this.opts !== key) return 'full';
    // reset 或无裁剪信息却出现旧条目消失：只能整表重建。
    if (entries.length === 0 && this.entries.length > 0) return 'full';
    // seq 回退：输入不再单调，无法用后缀做增量。
    if (entries.length > 0 && (entries[entries.length - 1]?.seq ?? 0) < this.lastSeq) return 'full';
    const survivors = firstSeqGreaterThan(entries, this.lastSeq);
    if (survivors === this.entries.length) return 'append';
    if (survivors < this.entries.length && truncatedRuns.size > 0) return 'partial';
    // survivors > 旧长度（插入旧 seq）或旧条目消失但无裁剪信息。
    return 'full';
  }

  private ensureBucket(runId: string): StoredEvent[] {
    let bucket = this.buckets.get(runId);
    if (!bucket) {
      bucket = [];
      this.buckets.set(runId, bucket);
    }
    if (!this.orderSet.has(runId)) {
      this.orderSet.add(runId);
      this.order.push(runId);
    }
    return bucket;
  }

  private pruneEmptyOrder(): void {
    if (this.order.length === this.buckets.size) {
      let allPresent = true;
      for (const runId of this.order) {
        if (!this.buckets.has(runId)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) return;
    }
    const removed: string[] = [];
    this.order = this.order.filter((runId) => {
      if (this.buckets.has(runId)) return true;
      removed.push(runId);
      return false;
    });
    for (const runId of removed) {
      this.orderSet.delete(runId);
      this.groups.delete(runId);
    }
  }
}
