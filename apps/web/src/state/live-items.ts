/**
 * 物化面：`LiveItemStore` —— 事件到达时增量折叠、item 就地物化（DESIGN.md §2）。
 *
 * 为什么需要它：用户报的 bug 是「缓冲列表达到上限，已渲染的内容跟着消失」。根因是渲染
 * 每 50ms 从 `EventStore.entries`（**有界**的传输窗口）重投影整条时间线：`entries` 少一条，
 * 屏上就少一张卡。这里把「事件 → item」的投影从**每次重算**改成**事件到达即折叠**，
 * 于是 `entries` 退化为纯传输窗口（订阅接缝 / 重连回放 / 回填暂存 / 运行详情），
 * 渲染只读这里物化的 item 流。
 *
 * 不变量（与 DESIGN.md §2.3 一一对应）：
 * - **I1**：渲染侧不读 `entries`；本 store 的 `ingest` 是**唯一**写入点（`EventStore.push`
 *   之后转发）。`check-live-items` 的 tripwire 守这条。
 * - **I4 / I6**：缓冲裁剪（per-run 上限 / 总量上限 / `truncateAfter`）**不改变 item**：
 *   本 store 不订阅裁剪，只订阅 `push` 进来的事件。
 * - **I5**：同一 seq 只 fold 一次（`ingestedSeq` 单调水位，只在 `clear()` 归零）；
 *   重连回放 / 回填重放的幂等性由它兜住。
 * - **I9**：item 侧任何上限都必须有**可见**产物：超限只会把「更旧的」折成一张带条数的
 *   折叠卡（`vessel.ui.condensed`），永不静默丢；实在折不动就置 `overBudget`（数据层
 *   提示钩子，提示行文案在阶段 4）。
 *
 * 与 `RunFold` 的关系：**同一段 switch**。`buildGroup` 是「一次性喂完」，`ingest` 是
 * 「事件到达时喂一条」，`resume` / `setVisibility` 是「按 run 重喂一遍」。所以
 * 「增量 == 重建」是结构性结论（`check-live-items` 的 G-A 就是这条对拍）。
 */
import type { RunEvent } from '../gateway/types';
import type { ErrorVisibility } from './error-visibility';
import {
  createFold,
  isVisibleForGrouping,
  type RunFold,
  type RunGroup,
  type StoredEvent,
  type TimelineItem,
} from './events';

/** 单个 run 的 item 硬上界（≈ 1000 次工具调用；正常 run 几十条）。 */
export const MAX_ITEMS_PER_RUN = 2000;
/** 跨 run 的 item 硬上界（安全网；正常订阅范围摸不到）。 */
export const MAX_ITEMS_TOTAL = 20000;
/** 触发折叠后，该 run 保留的最近项数（更早的折成一张卡 + 运行详情深链）。 */
export const KEEP_ITEMS_PER_RUN = 200;
/** 总量仍然超限时的加强折叠：终态 run 只留最近这些项（仍然不删除）。 */
export const KEEP_ITEMS_PER_RUN_URGENT = 20;
/** 折叠卡的合成事件类型（**只存在于 Web 侧**，不上 wire、不写盘）。 */
export const CONDENSED_EVENT_TYPE = 'vessel.ui.condensed';

/**
 * 物化面的写入接缝（`EventStore` 的唯一转发对象）。
 *
 * 四个**管理**动作之外没有第二条写入路径：`ingest` 只由 `EventStore.push` 调用，
 * `freeze` / `resume` 只由回填（`beginBackfill` / `endBackfill`）调用。
 */
export interface ItemSink {
  ingest(entry: StoredEvent): void;
  /** 回填开始：帧只进环，不动 item（屏上一动不动）。 */
  freeze(): void;
  /** 回填结束：按 run 重折叠 + 锚点合并（Rule R），并解除冻结。 */
  resume(entries: readonly StoredEvent[]): void;
  /** 可见性口径变化：按环里的全部事件重折叠（唯一合法的整表重算）。 */
  setVisibility(
    showInternal: boolean,
    errorLevel: ErrorVisibility,
    entries: readonly StoredEvent[],
  ): void;
  /** 语义删除（rewind / 作用域变化）：`runIds` 是 EventStore 已判定属于该会话的 run。 */
  dropSession(sessionId: string, runIds?: readonly string[]): void;
  /**
   * 游标退化到「什么都没有」之前（服务端重启后 seq 从 1 重新编号 / 陈旧 epoch）：
   * item 的 seq 身份与新事件不可比，整体作废重来。
   */
  reset(): void;
  /** 发布待处理变化（与 `EventStore.flush` 同一 50ms 节拍）。 */
  flush(): void;
  clear(): void;
}

export interface ItemStoreStats {
  /** 按 run 重折叠次数（回填 resume / 可见性切换）。 */
  refolds: number;
  /** 被单调水位拦下的重放条数（I5 的可观测面）。 */
  replaySkipped: number;
  /** 被折成折叠卡的 item 条数（不是「丢掉的」——条数记在折叠卡上）。 */
  condensed: number;
}

export interface ItemStoreSnapshot {
  /** 按 run 起始时间升序，与 `groupEvents` 的输出同构。 */
  groups: readonly RunGroup[];
  version: number;
  /**
   * 总量超限且已经没有可折叠的对象。
   *
   * 数据层钩子：**不许**只置一个标志就算完 —— 只要它是 true，`stats.condensed > 0`
   * 就必然成立（有可见的折叠卡），否则就是静默丢内容（I9，G-K 守）。
   */
  overBudget: boolean;
  stats: ItemStoreStats;
}

export interface ItemStoreOptions {
  showInternal?: boolean;
  errorLevel?: ErrorVisibility;
  maxItemsPerRun?: number;
  maxItemsTotal?: number;
}

/** 一张折叠卡的数据（同一 run 只一张，重复折叠累加 `count`、key 不换）。 */
interface CondensedSummary {
  count: number;
  fromSeq?: number;
  toSeq?: number;
}

function emptySnapshot(): ItemStoreSnapshot {
  return {
    groups: [],
    version: 0,
    overBudget: false,
    stats: { refolds: 0, replaySkipped: 0, condensed: 0 },
  };
}

/** 合并后的顺序 = anchor（事件 seq）升序；没有 anchor 的手工 item 排在最后。 */
function byAnchor(a: TimelineItem, b: TimelineItem): number {
  return (a.anchorSeq ?? Number.MAX_SAFE_INTEGER) - (b.anchorSeq ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Rule R 的**标量**侧：重折叠之后环里可能已经没有身份 / 终态事件，从旧组兜住。
 *
 * 两条判据：
 * - 身份字段（sessionId / input / startedAt / firstSeq…）：新值缺失时用旧值，缺失才填；
 * - 终态**只增不减**：环里没了 `run.completed` 时重折叠会得出 `status: running`，但屏幕
 *   不能把一条已经结束的 run 退回「运行中」（Stop 按钮与「正在思考」会诈尸）。
 *   反过来，新组是终态时**一律以新组为准** —— `run.completed` 会显式清掉 `error`，
 *   若再从旧组填回就会留下一张「已经成功了却显示失败」的幽灵卡（G-G 守）。
 */
function mergeGroupScalars(fresh: RunGroup, base: RunGroup): RunGroup {
  const merged: RunGroup = {
    ...fresh,
    hasRunEvent: fresh.hasRunEvent || base.hasRunEvent,
    ...(fresh.jobId === undefined && base.jobId !== undefined ? { jobId: base.jobId } : {}),
    ...(fresh.sessionId === undefined && base.sessionId !== undefined
      ? { sessionId: base.sessionId }
      : {}),
    ...(fresh.input === undefined && base.input !== undefined ? { input: base.input } : {}),
    ...(fresh.inputName === undefined && base.inputName !== undefined
      ? { inputName: base.inputName }
      : {}),
    ...(fresh.inputRefs === undefined && base.inputRefs !== undefined
      ? { inputRefs: base.inputRefs }
      : {}),
    ...(fresh.startedAt === undefined && base.startedAt !== undefined
      ? { startedAt: base.startedAt }
      : {}),
    ...(fresh.firstTs === undefined && base.firstTs !== undefined ? { firstTs: base.firstTs } : {}),
    ...(fresh.firstSeq === undefined && base.firstSeq !== undefined
      ? { firstSeq: base.firstSeq }
      : {}),
    ...(fresh.lastTs === undefined && base.lastTs !== undefined ? { lastTs: base.lastTs } : {}),
  };
  if (fresh.status !== 'running' || base.status === 'running') return merged;
  return {
    ...merged,
    status: base.status,
    ...(merged.output === undefined && base.output !== undefined ? { output: base.output } : {}),
    ...(merged.error === undefined && base.error !== undefined ? { error: base.error } : {}),
    ...(merged.errorMeta === undefined && base.errorMeta !== undefined
      ? { errorMeta: base.errorMeta }
      : {}),
    ...(merged.completedAt === undefined && base.completedAt !== undefined
      ? { completedAt: base.completedAt }
      : {}),
    ...(merged.durationMs === undefined && base.durationMs !== undefined
      ? { durationMs: base.durationMs }
      : {}),
    ...(merged.iterations === undefined && base.iterations !== undefined
      ? { iterations: base.iterations }
      : {}),
  };
}

/** 折叠卡：站在被折掉的第一项的位置（anchor = 首项 seq），因此时间线顺序不变。 */
function condensedItem(
  runId: string,
  summary: CondensedSummary,
  ts: number | undefined,
): TimelineItem {
  const event: RunEvent = {
    type: CONDENSED_EVENT_TYPE,
    run_id: runId,
    ts: ts ?? 0,
    data: {
      run_id: runId,
      count: summary.count,
      ...(summary.fromSeq !== undefined ? { from_seq: summary.fromSeq } : {}),
      ...(summary.toSeq !== undefined ? { to_seq: summary.toSeq } : {}),
    },
  };
  return {
    kind: 'notice',
    key: `run:${runId}:condensed:${summary.fromSeq ?? 0}`,
    event,
    ...(summary.fromSeq !== undefined ? { anchorSeq: summary.fromSeq } : {}),
  };
}

function isCondensedKey(runId: string, key: string): boolean {
  return key.startsWith(`run:${runId}:condensed:`);
}

export class LiveItemStore implements ItemSink {
  private readonly folds = new Map<string, RunFold>();
  private readonly groups = new Map<string, RunGroup>();
  /** 环里已经取不到、但屏幕上已经显示的 item（Rule R 的「保留」）。 */
  private readonly kept = new Map<string, TimelineItem[]>();
  /** 重折叠前的旧组：只给 `mergeGroupScalars` 做兜底（不参与 item 合并）。 */
  private readonly bases = new Map<string, RunGroup>();
  private readonly condensed = new Map<string, CondensedSummary>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly stats: ItemStoreStats = { refolds: 0, replaySkipped: 0, condensed: 0 };
  private snapshot: ItemStoreSnapshot = emptySnapshot();
  private version = 0;
  /** 已应用的最大 seq（单调水位，I5）：只在 `clear()` 归零。 */
  private ingestedSeq = 0;
  /** 回填冻结中：帧只进环，不动 item（§5.2 ①）。 */
  private frozen = false;
  /** run 集合 / 顺序变化（新增 run、删除 run）：flush 不能因为 dirty 为空就跳过。 */
  private structureDirty = false;
  private overBudget = false;
  private showInternal: boolean;
  private errorLevel: ErrorVisibility;
  private readonly maxItemsPerRun: number;
  private readonly maxItemsTotal: number;

  constructor(options: ItemStoreOptions = {}) {
    this.showInternal = options.showInternal ?? false;
    this.errorLevel = options.errorLevel ?? 'user';
    this.maxItemsPerRun = options.maxItemsPerRun ?? MAX_ITEMS_PER_RUN;
    this.maxItemsTotal = options.maxItemsTotal ?? MAX_ITEMS_TOTAL;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ItemStoreSnapshot => this.snapshot;

  /** 最近一次可见性口径（`setVisibility` 幂等判定用）。 */
  get view(): { showInternal: boolean; errorLevel: ErrorVisibility } {
    return { showInternal: this.showInternal, errorLevel: this.errorLevel };
  }

  /** 唯一写入点（`EventStore.push` 转发）：一条事件 → 一步折叠。 */
  ingest(entry: StoredEvent): void {
    if (this.frozen) return;
    if (entry.seq <= this.ingestedSeq) {
      // I5：同一条事件只生效一次。重连回放 / 回填重放都在这里被挡下，
      // 所以「重放把尾巴又拼一遍」在 item 侧不可能发生。
      this.stats.replaySkipped += 1;
      return;
    }
    this.ingestedSeq = entry.seq;
    // 可见性过滤发生在**进 fold 之前**：被过滤掉的事件等于不存在（它不构成段边界，
    // 也不会产 item），与 `groupEvents` 的口径逐字一致。
    if (!this.visible(entry)) return;
    const runId = entry.event.run_id;
    let fold = this.folds.get(runId);
    if (fold === undefined) {
      fold = createFold(runId);
      this.folds.set(runId, fold);
      this.structureDirty = true;
    }
    fold.apply(entry);
    this.dirty.add(runId);
  }

  freeze(): void {
    this.frozen = true;
  }

  /**
   * 回填结束：按 run 重折叠 + 锚点合并（DESIGN.md §5.2 Rule R）。
   *
   * 为什么不能「把更早的事件插进去」：段缓冲是顺序累积的，往尾部追加更早的 delta 一定
   * 错。整 run 重折叠是唯一正确的做法，它与 `buildGroup` 走同一段 switch。
   *
   * **保留**规则：旧 items 里 key 不在新结果里的那些（环已经淘汰、复现不出来的内容）
   * 全部留下 —— 屏幕上「更早的内容长出来」，已有内容不动（key 相同 → React 复用节点）。
   */
  resume(entries: readonly StoredEvent[]): void {
    this.frozen = false;
    this.refold(entries, true);
    // 立刻落地：回填结束那一帧不能让屏上内容等到下一次 50ms 节拍（也是「不闪」的关键）。
    this.flush();
  }

  /**
   * 可见性口径变化：整表重折叠（**唯一**合法的整表重算，人工、低频，DESIGN.md §6）。
   *
   * 为什么必须重算：`internal` / `observe` 档事件在 fold 之前就被过滤掉，也就是
   * 「不构成段边界」；口径一变，段边界就变了，增量的近似结果不等于「一开始就是这个口径」。
   */
  setVisibility(
    showInternal: boolean,
    errorLevel: ErrorVisibility,
    entries: readonly StoredEvent[],
  ): void {
    if (this.showInternal === showInternal && this.errorLevel === errorLevel) return;
    this.showInternal = showInternal;
    this.errorLevel = errorLevel;
    this.refold(entries, false);
    this.flush();
  }

  /** 语义删除（rewind / 作用域变化）：这些历史真的不存在了，item 跟着删。 */
  dropSession(sessionId: string, runIds: readonly string[] = []): void {
    const targets = new Set(runIds);
    for (const [runId, group] of this.groups) {
      if (group.sessionId === sessionId) targets.add(runId);
    }
    if (targets.size === 0) return;
    for (const runId of targets) {
      this.folds.delete(runId);
      this.groups.delete(runId);
      this.kept.delete(runId);
      this.bases.delete(runId);
      this.condensed.delete(runId);
      this.dirty.delete(runId);
    }
    this.structureDirty = true;
  }

  clear(): void {
    this.folds.clear();
    this.groups.clear();
    this.kept.clear();
    this.bases.clear();
    this.condensed.clear();
    this.dirty.clear();
    this.structureDirty = false;
    this.ingestedSeq = 0;
    this.frozen = false;
    this.overBudget = false;
    this.publish();
  }

  /**
   * Seq 纪元重置（服务端重启后 seq 从 1 重新编号）：旧 item 与新事件的身份不可比，
   * 必须整体作废 —— 否则水位会把新事件全部当成「重放」丢掉，时间线从此定格。
   *
   * **回填期间是空操作**：那段时间的游标回退由 `resume` 的整 run 重折叠接管，
   * 屏上 item 不许动（§5.2 ①）。
   */
  reset(): void {
    if (this.frozen) return;
    if (this.ingestedSeq === 0 && this.folds.size === 0) return;
    this.clear();
  }

  /**
   * 发布待处理的 item 变化（由 `EventStore.flush` 在自己的 50ms 节拍上调用）。
   *
   * 合批的理由与 `EventStore` 一致：每个 token 都重渲染整棵树是不可接受的；item 快照
   * 与 entries 快照同一节拍也保证「运行详情」与「时间线」不会各走一半。
   */
  flush(): void {
    if (this.dirty.size === 0 && !this.structureDirty) return;
    this.structureDirty = false;
    for (const runId of this.dirty) this.materialize(runId);
    this.dirty.clear();
    // 上限策略可能再折掉一些旧的 item（→ 折叠卡），折完要重新物化一次。
    this.enforceBudget();
    for (const runId of this.dirty) this.materialize(runId);
    this.dirty.clear();
    this.publish();
  }

  private visible(entry: StoredEvent): boolean {
    return isVisibleForGrouping(entry, this.showInternal, this.errorLevel);
  }

  /**
   * 按环里的可见事件重折叠 `entries` 覆盖到的每个 run。
   *
   * `keepSurvivors = true`（回填）：环没覆盖到的旧 item 全部保留（宁可重复，绝不吞内容）。
   * `keepSurvivors = false`（可见性切换）：新口径就是真相，环里取不到的旧项**不再保留**。
   *
   * **环里一条可见事件都没有的 run 一律不动**：那说明事件已经被环淘汰（长会话 / 裁到
   * 只剩尾部），此时「重折叠」只能折出空组 —— 那是丢内容，不是换口径。既有缺陷
   * （环外的 run 换了可见性档不会重排）见 DESIGN.md §5.4，方向恒为「宁可多显示」。
   */
  private refold(entries: readonly StoredEvent[], keepSurvivors: boolean): void {
    const byRun = new Map<string, StoredEvent[]>();
    for (const entry of entries) {
      if (!this.visible(entry)) continue;
      const runId = entry.event.run_id;
      const list = byRun.get(runId);
      if (list === undefined) byRun.set(runId, [entry]);
      else list.push(entry);
    }
    for (const [runId, list] of byRun) this.refoldRun(runId, list, keepSurvivors);
    // 水位取「环里出现过的最大 seq」：之后的新事件继续走 `ingest`（I5）。
    for (const entry of entries) {
      if (entry.seq > this.ingestedSeq) this.ingestedSeq = entry.seq;
    }
  }

  private refoldRun(runId: string, entries: readonly StoredEvent[], keepSurvivors: boolean): void {
    const previous = this.groups.get(runId);
    if (previous !== undefined) this.bases.set(runId, previous);
    const fold = createFold(runId);
    for (const entry of entries) fold.apply(entry);
    this.folds.set(runId, fold);
    const freshKeys = new Set(fold.toGroup().items.map((item) => item.key));
    this.kept.set(
      runId,
      keepSurvivors
        ? (previous?.items ?? []).filter(
            (item) => !freshKeys.has(item.key) && !isCondensedKey(runId, item.key),
          )
        : [],
    );
    this.dirty.add(runId);
    this.stats.refolds += 1;
  }

  /** fold 状态 + Rule R 的保留项 + 折叠卡 → 发布用的 `RunGroup`（引用稳定：只在脏时重算）。 */
  private materialize(runId: string): void {
    const fold = this.folds.get(runId);
    if (fold === undefined) {
      this.groups.delete(runId);
      return;
    }
    const fresh = fold.toGroup();
    const base = this.bases.get(runId);
    const merged = base === undefined ? fresh : mergeGroupScalars(fresh, base);
    const extra: TimelineItem[] = [];
    const summary = this.condensed.get(runId);
    if (summary !== undefined) extra.push(condensedItem(runId, summary, merged.firstTs));
    const kept = this.kept.get(runId) ?? [];
    if (kept.length > 0) {
      const freshKeys = new Set(merged.items.map((item) => item.key));
      for (const item of kept) {
        if (!freshKeys.has(item.key)) extra.push(item);
      }
    }
    if (extra.length > 0) {
      merged.items = [...extra, ...merged.items].sort(byAnchor);
    }
    this.groups.set(runId, merged);
  }

  /**
   * item 侧上限（DESIGN.md §8.2 / 裁决 4）：**只折叠，不删除**。
   *
   * ① 每 run 超过 `MAX_ITEMS_PER_RUN` → 折掉最旧的、保留最近 200 项；
   * ② 总量超过 `MAX_ITEMS_TOTAL` → 按「终态 run → running run」加强折叠（保留 20 项）；
   * ③ 仍然超限 → 只置 `overBudget`（**不是静默丢**：折叠卡的条数就是可见产物）。
   */
  private enforceBudget(): void {
    for (const runId of [...this.folds.keys()]) {
      const fold = this.folds.get(runId);
      if (fold === undefined || fold.itemCount <= this.maxItemsPerRun) continue;
      this.condense(runId, Math.min(KEEP_ITEMS_PER_RUN, this.maxItemsPerRun));
    }
    if (this.totalItems() <= this.maxItemsTotal) {
      this.overBudget = false;
      return;
    }
    // 分档：先折终态（它们的「最近 200 项」对用户价值最低），再折仍在跑的。
    for (const status of ['completed', 'cancelled', 'failed', 'running'] as const) {
      for (const runId of [...this.folds.keys()]) {
        if (this.totalItems() <= this.maxItemsTotal) break;
        if (this.groups.get(runId)?.status !== status) continue;
        this.condense(runId, KEEP_ITEMS_PER_RUN_URGENT);
      }
    }
    this.overBudget = this.totalItems() > this.maxItemsTotal;
  }

  private condense(runId: string, keep: number): void {
    const fold = this.folds.get(runId);
    if (fold === undefined) return;
    const trimmed = fold.trim(keep);
    if (trimmed.removed === 0) return;
    const previous = this.condensed.get(runId);
    const next: CondensedSummary = { count: (previous?.count ?? 0) + trimmed.removed };
    // key 只由**首批**被折条的 anchor 决定：重复折叠累加 count，不换号（不重挂）。
    const fromSeq = previous?.fromSeq ?? trimmed.fromSeq;
    if (fromSeq !== undefined) next.fromSeq = fromSeq;
    const toSeq = trimmed.toSeq ?? previous?.toSeq;
    if (toSeq !== undefined) next.toSeq = toSeq;
    this.condensed.set(runId, next);
    this.stats.condensed += trimmed.removed;
    this.dirty.add(runId);
  }

  private totalItems(): number {
    let total = 0;
    for (const fold of this.folds.values()) total += fold.itemCount;
    return total;
  }

  private publish(): void {
    this.version += 1;
    const groups = [...this.groups.values()].sort(
      (a, b) => (a.startedAt ?? a.firstTs ?? 0) - (b.startedAt ?? b.firstTs ?? 0),
    );
    this.snapshot = {
      groups,
      version: this.version,
      overBudget: this.overBudget,
      stats: { ...this.stats },
    };
    for (const listener of [...this.listeners]) listener();
  }
}
