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
/**
 * 总量**第三次**超限时，给「已交棒 run 的残留」留几项（§8.2 档 3）。
 *
 * 0 = 只留那张折叠卡：该 run 的内容早就有历史替身了，留在 live 里的只有
 * `notice` / `ev-` 这类运行过程行 —— 折成一张带条数的卡仍然可见、可点进运行详情，
 * 但不再占这些行。这是唯一允许把「没有替身的东西」从屏上换成一行的场景（I9 的可见产物）。
 */
export const KEEP_ITEMS_RELEASED_RESIDUE = 0;
/** 折叠卡的合成事件类型（**只存在于 Web 侧**，不上 wire、不写盘）。 */
export const CONDENSED_EVENT_TYPE = 'vessel.ui.condensed';

/**
 * 物化面的写入接缝（`EventStore` 的唯一转发对象）。
 *
 * 五个**管理**动作之外没有第二条写入路径：`ingest` 只由 `EventStore.push` 调用，
 * `freeze` / `resume` 只由回填（`beginBackfill` / `endBackfill`）调用，
 * `closeRuns` 只由「外部终态」对账调用（agent 生命周期 / 会话快照）。
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
   * **按外部终态收口**（对账，不是折叠）：把这些仍 `running` 的 run 收成终态。
   *
   * 存在的理由：chat 的 live 状态只吃事件流，而事件流是**尽力而为**的（背压丢帧 /
   * 回放窗口淘汰 / hub 重启换了 seq 纪元 / 慢客户端），run 自己的终态帧可能永远到不了。
   * 只有事件流一条源 ⇒ 这条 run 会在屏幕上「永远在跑」（停止按钮不消失、「正在思考」
   * 不下线）。本方法是第二条、**可核对**的源：agent 生命周期（`agent.closed`）与会话
   * 快照（`sessions.get` 的 `status` / `run_id` / `completed_at` / `error`）。
   *
   * 纪律（三条，全部由探针守）：
   * - **只在 `running` 上生效**：真终态先到时是 no-op，重复对账也是 no-op（不写第二条记录）；
   * - **不冒充正常完成**：agent 生命周期只说「这个 agent 没了」，run 的结局未知 ⇒ 一律
   *   `cancelled`；只有会话快照明确给了状态才用快照的状态；
   * - **不许杀掉更新的 run**：只收口最后一条事件不晚于 `notAfter`（默认 = `at`）的 run。
   *
   * 收口动作走 `RunFold.close`，与 `run.completed` 分支共用同一个 `flush()`：尾部未闭合的
   * 思考 / 正文落地成 item（`endedAt` = `at`），live 尾巴下线，屏上不留「正在思考」。
   */
  closeRuns(sessionId: string, request: SessionCloseRequest): number;
  /**
   * 游标退化到「什么都没有」之前（服务端重启后 seq 从 1 重新编号 / 陈旧 epoch）：
   * item 的 seq 身份与新事件不可比，整体作废重来。
   */
  reset(): void;
  /** 发布待处理变化（与 `EventStore.flush` 同一 50ms 节拍）。 */
  flush(): void;
  clear(): void;
}

/**
 * 交棒请求（DESIGN.md §8.1）：**这些 item 已经有历史替身**，可以把 live 那份从内存里删掉。
 *
 * 只表达「按身份删哪几个 item」，不表达「这个 run 整个不要了」：
 * - `segments`：正文 / 思考段的 `anchorSeq`（段在 wire 上的坐标，重折叠后仍不变，
 *   所以交棒结论在同一次判定之后是持久的）。
 *
 * **没有工具卡**：工具卡的执行态（`status` / `durationMs` / `truncated`）历史侧不复现
 * （历史只有「调用 + 结果」两条消息），删掉 live 那份就会让卡上的耗时 / 截断标记变样 ——
 * 那不是「零变化」。它要等历史侧携带执行态（或服务端给 run/段锚点）之后再放开
 * （DESIGN.md 裁决 3 的触发条件 a）。
 *
 * `notice:<key>` / `ev-<seq>` / `unknown-<seq>` **永远不在**这里 —— 它们是「运行过程」，
 * 没有任何历史替身，删了就是吞内容（I8 / I9）。
 */
export interface HandoverRequest {
  segments: readonly number[];
}

/**
 * 一次「按外部终态收口」的请求（`ItemSink.closeRuns`）。
 *
 * 两个来源共用这个形状，差别只在证据：
 * - `agent-closed`：该会话的 agent 已被关掉（`agent.closed`），**结局未知** ⇒ 调用侧
 *   固定传 `status: 'cancelled'`，且不带 `runIds`（这条会话里还开着的 run 全部收口）；
 * - `session-snapshot`：`sessions.get` 的会话快照说这一 run 已是终态 ⇒ 带 `runIds`
 *   （快照的 `run_id`）+ 快照自己的状态与 `error`。
 */
export interface SessionCloseRequest {
  /** 要收口的 run（快照路径给 `run_id`）；省略 = 该会话所有仍 `running` 的 run。 */
  runIds?: readonly string[];
  status: 'completed' | 'failed' | 'cancelled';
  /** 收口时刻（终态帧本该出现的时间）：`completedAt` 与落地段的 `endedAt` 都用它。 */
  at: number;
  error?: string;
  via: 'agent-closed' | 'session-snapshot';
  /** 只收口「最后一条事件不晚于它」的 run（默认 = `at`）：不许杀掉之后新起的 run。 */
  notAfter?: number;
}

/** 一条 run 的对账结论（`LiveItemStore` 的 run 级台账 `closedRuns` 的元素）。 */
interface ReconciledClose {
  status: 'completed' | 'failed' | 'cancelled';
  at: number;
  error?: string;
  via: 'agent-closed' | 'session-snapshot';
}

export interface ItemStoreStats {
  /** 按 run 重折叠次数（回填 resume / 可见性切换）。 */
  refolds: number;
  /** 被单调水位拦下的重放条数（I5 的可观测面）。 */
  replaySkipped: number;
  /** 被折成折叠卡的 item 条数（不是「丢掉的」——条数记在折叠卡上）。 */
  condensed: number;
  /**
   * 已交棒移出内存的 item 条数（DESIGN.md §8.1）。
   *
   * 「内存不随轮数线性增长」的可观测面：这个数随轮数增长，而 `group.items` 的
   * 总量不增长（长会话里两者是互补的）。
   */
  released: number;
  /** 发生过交棒的 run 数（终态且历史完全覆盖的轮次数）。 */
  releasedRuns: number;
  /**
   * 按外部终态收口的 run 数（`closeRuns`）。
   *
   * 「服务端说完了、客户端还在跑」的可观测面：这个数 > 0 就说明确实发生过「终态帧没到、
   * 靠 agent 生命周期 / 会话快照收的口」。它是**好事**（对账生效），不是丢事件计数。
   */
  reconciled: number;
  /**
   * 总量上限已经折无可折（DESIGN.md §8.2 第 4 档）。
   *
   * 数据层钩子：**不许**只置一个标志就算完 —— 只要它是 true，就必然存在可见的折叠卡
   * （`condensed > 0`）或全部内容都被保留（`condensed === 0` 但一条没丢），
   * 否则就是静默丢内容（I9，G-K 守）。UI 顶部提示行属阶段 4（要 i18n 文案）。
   */
  overBudget: boolean;
}

export interface ItemStoreSnapshot {
  /** 按 run 起始时间升序，与 `groupEvents` 的输出同构。 */
  groups: readonly RunGroup[];
  version: number;
  /** 见 `ItemStoreStats.overBudget`（诊断 / 将来顶部提示行的输入）。 */
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
    stats: {
      refolds: 0,
      replaySkipped: 0,
      condensed: 0,
      released: 0,
      releasedRuns: 0,
      reconciled: 0,
      overBudget: false,
    },
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

/**
 * 这条 item 是不是「已经交给历史」的那一份（`RunFold.drop` 的同一判据）。
 *
 * 与 fold 内的删除逻辑必须同源：能删的只有**正文段 / 思考段**（按段锚点）——
 * `notice` / `ev-` / `unknown-` 没有历史替身；工具卡的执行态历史侧不复现（删了卡上的
 * 耗时 / 截断标记就变样），所以也不在这里。
 */
function isReleased(released: { anchors: ReadonlySet<number> }, item: TimelineItem): boolean {
  if (item.kind !== 'text' && item.kind !== 'reasoning') return false;
  return item.anchorSeq !== undefined && released.anchors.has(item.anchorSeq);
}

export class LiveItemStore implements ItemSink {
  private readonly folds = new Map<string, RunFold>();
  private readonly groups = new Map<string, RunGroup>();
  /** 环里已经取不到、但屏幕上已经显示的 item（Rule R 的「保留」）。 */
  private readonly kept = new Map<string, TimelineItem[]>();
  /** 重折叠前的旧组：只给 `mergeGroupScalars` 做兜底（不参与 item 合并）。 */
  private readonly bases = new Map<string, RunGroup>();
  private readonly condensed = new Map<string, CondensedSummary>();
  /**
   * 已交棒移出内存的 item 身份（run → 段锚点）。
   *
   * 为什么留一份「删过什么」而不是直接忘了：重折叠（回填 `resume` / 可见性切换）会用
   * **环里的全量事件**把该 run 重建一遍，被交棒的段会原样回来 —— 那时屏上就会出现
   * 「历史一份 + live 又长回来一份」。这份记录是「这个 run 的这段内容已经由历史负责」
   * 的唯一凭据，`materialize` 据此再过滤一次。run 被 `dropSession` / `clear` 语义删除时
   * 一起清掉（rewind 之后历史不再提供那段内容，交棒结论必须作废）。
   */
  private readonly released = new Map<string, { anchors: Set<number> }>();
  /** 发生过交棒的 run（上限策略档 3 的输入：这些 run 的残留最该被折掉）。 */
  private readonly releasedRuns = new Set<string>();
  /**
   * 对账台账①（会话级）：「这个会话在 `at` 之后不会再有 run 终态帧」。
   *
   * `agent.closed` 折出来的结论，Live 路径在 `ingest` 里登记、回填路径在 `refold`
   * 里从环扫出来。`refoldRun` 用它收口「重折叠出来的 running 组」—— 否则重连 / 回填
   * 会把已经对账过的 run 复活成 running（本地残留推翻终态）。
   */
  private readonly sessionClosed = new Map<string, { at: number; via: 'agent-closed' }>();
  /** 对账台账②（run 级）：直接写进 fold 的收口结论（快照路径可能带具体状态与 error）。 */
  private readonly closedRuns = new Map<string, ReconciledClose>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly stats: ItemStoreStats = {
    refolds: 0,
    replaySkipped: 0,
    condensed: 0,
    released: 0,
    releasedRuns: 0,
    reconciled: 0,
    overBudget: false,
  };
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
    // 生命周期对账在**可见性过滤之前**：`agent.closed` 是 `observe` 档（不产 item），
    // 但它恰恰是「这一会话再也不会有 run 终态帧」的唯一凭据。被 `visible()` 挡下就等于
    // 这个真相永远到不了 chat —— 那正是「成员已关闭、屏上还在跑」的成因。
    // 收口不是折叠：它不产 item、不构成段边界，只是把仍 `running` 的组收成终态。
    this.reconcileLifecycle(entry);
    // 可见性过滤发生在**进 fold 之前**：被过滤掉的事件等于不存在（它不构成段边界，
    // 也不会产 item），与 `groupEvents` 的口径逐字一致。
    if (!this.visible(entry)) return;
    const runId = entry.event.run_id;
    let fold = this.folds.get(runId);
    let created = false;
    if (fold === undefined) {
      fold = createFold(runId);
      this.folds.set(runId, fold);
      this.structureDirty = true;
      created = true;
    }
    fold.apply(entry);
    // 快照 / 关闭帧可能**先于**这条 run 的帧到达（帧全丢 / 还没回填）：台账在这里补刀。
    // 必须放在 `apply` 之后 —— `run.started` 会把 status 拉回 running。
    // 热路径上只做一次 Map 命中（`closedRuns`），会话级台账只在「这个 run 刚建起来」时查一次。
    if (this.closedRuns.has(runId) || (created && this.sessionClosed.size > 0)) {
      this.applyCloses(runId, fold);
    }
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

  /**
   * 交棒（DESIGN.md §8.1）：把这些 run 的「已有历史替身」的 item **移出内存**。
   *
   * 触发者是装配面的 post-commit effect（`useChatTranscript`）：它先用 `ClaimLedger`
   * 证明「历史那份确实会渲染」（`handover` 只包含有替身的段 / 卡），这里才真删。
   * 于是**屏幕上零变化**：被删的那些已经让位（历史那份正在渲染同一段正文 / 思考）。
   *
   * 三条硬约束：
   * - **只删正文段 / 思考段**（判据在 `RunFold.drop`：按段锚点）；`notice` / `ev-` /
   *   `unknown-`、**工具卡**与失败卡永远留着 —— 失败卡不在 `items` 里（由
   *   `group.status` / `group.error` 派生），工具卡的执行态历史侧不复现（见
   *   `HandoverRequest` 的说明），所以「失败永远可见、卡片不变样」不依赖这里的运气。
   * - **幂等**：重复交棒同一批 key 不产生第二次删除，也不多计一次 stats。
   * - **可作废**：`dropSession` / `clear` 会连同「交棒记录」一起清掉 —— rewind 之后
   *   历史不再提供那段内容，交棒结论必须失效，否则就是吞内容（宁可重新长出来）。
   */
  release(requests: ReadonlyMap<string, HandoverRequest>): void {
    let removed = 0;
    for (const [runId, request] of requests) {
      const state = this.released.get(runId) ?? { anchors: new Set<number>() };
      for (const anchor of request.segments) state.anchors.add(anchor);
      this.released.set(runId, state);
      if (state.anchors.size === 0) continue;
      this.releasedRuns.add(runId);
      const fold = this.folds.get(runId);
      // 用**累计**集合删（而不是只删这一批）：重折叠把更早交棒的段又长回来时，
      // 这一次调用顺手把它们再删一次。
      if (fold !== undefined) removed += fold.drop(state.anchors);
      this.dirty.add(runId);
    }
    this.stats.released += removed;
    this.stats.releasedRuns = this.releasedRuns.size;
    // 交棒发生在 post-commit：立刻落地，别等下一次 50ms 节拍（屏上零变化，数据面立刻瘦身）。
    this.flush();
  }

  /**
   * 按外部终态收口（对账路径的实现，见 `ItemSink.closeRuns`）。
   *
   * 只碰**仍 `running`** 的组：真终态先到 ⇒ 一个都不碰（`RunFold.close` 自己也会再挡一次），
   * 所以「终态先到再 close」不会写出第二条记录，`stats.reconciled` 也不会重复计数。
   */
  closeRuns(sessionId: string, request: SessionCloseRequest): number {
    const notAfter = request.notAfter ?? request.at;
    const wanted = request.runIds === undefined ? undefined : new Set(request.runIds);
    if (request.via === 'agent-closed' && wanted === undefined) {
      // 会话级结论：登记台账，之后 `refoldRun` 折出来的 running 组同样收口。
      this.sessionClosed.set(sessionId, { at: request.at, via: request.via });
    }
    const targets: string[] = [];
    for (const [runId, fold] of this.folds) {
      const group = this.groups.get(runId) ?? fold.toGroup();
      if (group.sessionId !== sessionId) continue;
      if (group.status !== 'running') continue;
      if (wanted !== undefined && !wanted.has(runId)) continue;
      // 快照 / 关闭帧都是「过去时」：之后才起事件的那个 run 不能被它杀掉。
      if (group.lastTs !== undefined && group.lastTs > notAfter) continue;
      targets.push(runId);
    }
    let closed = 0;
    for (const runId of targets) {
      const fold = this.folds.get(runId);
      if (fold === undefined) continue;
      // `close` 自己也挡一次：组已经是终态（并发 / 陈旧 materialize）就什么都不写。
      const applied = fold.close(request.status, request.at, {
        error: request.error,
        via: request.via,
      });
      if (!applied) continue;
      this.closedRuns.set(runId, {
        status: request.status,
        at: request.at,
        error: request.error,
        via: request.via,
      });
      this.dirty.add(runId);
      closed += 1;
    }
    if (wanted !== undefined) {
      // 快照点名了 run 但本地还没有它的 fold（帧全丢 / 还没回填）：先把结论记进台账，
      // 等它从环里折出来时由 `applyCloses` 收口 —— 否则「快照先到、run 后到」会正好错开。
      for (const runId of wanted) {
        if (this.folds.has(runId)) continue;
        this.closedRuns.set(runId, {
          status: request.status,
          at: request.at,
          error: request.error,
          via: request.via,
        });
      }
    }
    this.stats.reconciled += closed;
    // 立刻落地：收口的意义就是「屏上下一帧就不再是 running」，不能等 50ms 节拍。
    if (closed > 0) this.flush();
    return closed;
  }

  /**
   * 生命周期对账：`agent.closed` ⇒ 该会话的开放 run 全部收成 `cancelled`。
   *
   * 只认 `agent.closed`，**刻意不认 `agent.retired`**：retired 是 rotate 工具在旧 body
   * 上发的（此时旧 run 可能还没结束，会话会继续交棒给新 body，见
   * `docs/architecture/events.md` 的 agent 生命周期一节）。拿 retired 收口 = 把一次正常
   * 交棒记成取消。`agent.stale` 同理（可能恢复）。
   */
  private reconcileLifecycle(entry: StoredEvent): void {
    const closed = this.recordLifecycle(entry);
    if (closed === undefined) return;
    this.closeRuns(closed.sessionId, {
      status: 'cancelled',
      at: closed.at,
      via: 'agent-closed',
      notAfter: closed.at,
    });
  }

  /**
   * 登记一条生命周期证据（不产生 item）：只认 `agent.closed`，返回它的会话与时刻。
   *
   * 会话 id 取 `data.session_id`（成员/子 agent 的 `agent.closed` 都带它），退化为
   * `run_id`（成员自己的 agent 流里两者相等，见事件日志 `events/<session>.jsonl`）。
   */
  private recordLifecycle(entry: StoredEvent): { sessionId: string; at: number } | undefined {
    if (entry.event.type !== 'agent.closed') return undefined;
    const data = entry.event.data;
    const explicit = typeof data.session_id === 'string' ? data.session_id : undefined;
    const raw = explicit ?? entry.sessionId ?? entry.event.run_id;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const at = typeof entry.event.ts === 'number' ? entry.event.ts : undefined;
    if (at === undefined) return undefined;
    const known = this.sessionClosed.get(raw);
    if (known === undefined || at > known.at) this.sessionClosed.set(raw, { at, via: 'agent-closed' });
    return { sessionId: raw, at };
  }

  /**
   * 把台账里这条 run 的对账结论写回 fold（重折叠之后 / 帧晚到之后）。
   *
   * `closedRuns` 优先（它带具体状态 / error，来自会话快照）；否则看会话级台账
   * （`agent.closed`）：只收「最后一条事件不晚于关闭时刻」的组。
   * 真终态已经折出来时（`close` 返回 false）就把 run 级记录作废 —— 真证据优先。
   *
   * 收口成功时**回写 `closedRuns`**：之后的增量事件（delta 会把 live 尾巴拼回来）也走
   * `closedRuns.has(runId)` 这条热路径，被收口的 run 不会半路又变成「正在思考」。
   */
  private applyCloses(runId: string, fold: RunFold): void {
    const direct = this.closedRuns.get(runId);
    if (direct !== undefined) {
      const applied = fold.close(direct.status, direct.at, {
        error: direct.error,
        via: direct.via,
      });
      if (!applied) this.closedRuns.delete(runId);
      return;
    }
    if (this.sessionClosed.size === 0) return;
    const fresh = fold.toGroup();
    if (fresh.status !== 'running') return;
    if (fresh.sessionId === undefined) return;
    const closed = this.sessionClosed.get(fresh.sessionId);
    if (closed === undefined) return;
    if (fresh.lastTs !== undefined && fresh.lastTs > closed.at) return;
    if (!fold.close('cancelled', closed.at, { via: closed.via })) return;
    this.closedRuns.set(runId, { status: 'cancelled', at: closed.at, via: closed.via });
    this.dirty.add(runId);
  }

  /** 语义删除（rewind / 作用域变化）：这些历史真的不存在了，item 跟着删。 */
  dropSession(sessionId: string, runIds: readonly string[] = []): void {
    const targets = new Set(runIds);
    for (const [runId, group] of this.groups) {
      if (group.sessionId === sessionId) targets.add(runId);
    }
    if (targets.size === 0) return;
    // rewind / 作用域变化：台账也要跟着失效，否则被删的 run 一重现就被收口。
    this.sessionClosed.delete(sessionId);
    for (const runId of targets) {
      this.folds.delete(runId);
      this.groups.delete(runId);
      this.kept.delete(runId);
      this.bases.delete(runId);
      this.condensed.delete(runId);
      this.released.delete(runId);
      this.releasedRuns.delete(runId);
      this.closedRuns.delete(runId);
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
    this.released.clear();
    this.releasedRuns.clear();
    // 台账跟着清：seq 纪元重置后环也空了，留着旧台账只会误杀新纪元的 run。
    this.sessionClosed.clear();
    this.closedRuns.clear();
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
    // 生命周期真相也在环里：先把「这些会话已经不会再有 run 终态帧」登记进台账，再按 run
    // 重折叠 —— 折出来的 running 组由 `refoldRun` 里的 `applyCloses` 收口。回填 / 重连
    // 回放这两条路径因此和对账同样成立，不会把已收口的 run 复活成 running。
    for (const entry of entries) this.recordLifecycle(entry);
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
    // 重折叠只认环里的证据 ⇒ 已对账过的 run 会「复活」成 running。台账就是这条路径的补丁。
    this.applyCloses(runId, fold);
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
    // 交棒过滤（§8.1）：重折叠会把「已经交给历史」的段按环里的事件重建回来 —— 那些
    // item 的历史替身仍然在，屏上绝不能因此多出一份。这是 profile 面的最后一道闸。
    const released = this.released.get(runId);
    if (released !== undefined && merged.items.length > 0) {
      merged.items = merged.items.filter((item) => !isReleased(released, item));
    }
    this.groups.set(runId, merged);
  }

  /**
   * item 侧上限（DESIGN.md §8.2 / 裁决 4）：**只折叠，不删除**。
   *
   * 触发顺序（四档，每一档都有可见产物，都不静默）：
   * 0. 每 run 超过 `MAX_ITEMS_PER_RUN`（2000）→ 折掉最旧的、保留最近 200 项；
   * 1. 总量超过 `MAX_ITEMS_TOTAL`（20000）→ **最旧的已终态 run** 加大折叠（保留 20 项）；
   * 2. 仍超 → **最旧的 running run** 同样加大折叠（极端：单个 run 就超总量一半）；
   * 3. 仍超 → 把**已交棒 run 的残留**（notice / ev 行）折成该 run 仅剩的**一张**折叠卡
   *    （`KEEP_ITEMS_RELEASED_RESIDUE = 0`）：这些 run 的内容全都有历史替身，留下来的
   *    只有运行过程行，折成「本轮更早的 N 项已折叠」仍然可见、可点进运行详情（I9）；
   * 4. 仍超（病态：一条 run 的 2000 项都在跑）→ **放弃删除**，只置 `stats.overBudget`；
   *    UI 顶部提示行属阶段 4（要 i18n 文案），但「多占内存 + 一行提示」远好于
   *    「静默删掉用户正在看的内容」（I9 / G-K）。
   *
   * 折叠**不会**吞掉失败卡：失败卡由 `group.status / error` 派生，不在 `items` 里。
   * 顺序按 `folds` 的插入序（= 各 run 首次出现的时间序），即「最旧的先折」。
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
    // 档 3：已交棒 run 的残留 —— 内容早已由历史渲染，这里只剩运行过程行。
    for (const runId of [...this.folds.keys()]) {
      if (this.totalItems() <= this.maxItemsTotal) break;
      if (!this.releasedRuns.has(runId)) continue;
      this.condense(runId, KEEP_ITEMS_RELEASED_RESIDUE);
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
      stats: { ...this.stats, overBudget: this.overBudget },
    };
    for (const listener of [...this.listeners]) listener();
  }
}
