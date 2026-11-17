/**
 * 有界事件缓冲（ring buffer）+ 订阅。
 *
 * - 每个 run 最多 5000 条，总数最多 20000 条；超出丢弃最旧（口径与依据见下面两个常量
 *   的注释：条目数 ≈ 工具调用数 × 5~6，不是 token 数）。裁剪只是传输面的事，**不影响
 *   屏上的 item**（`LiveItemStore` 已经物化，见 DESIGN.md I4）。
 * - 按 seq 去重（重连回放不会产生重复卡片）。
 * - 通知节流到 ~50ms，避免每个 token 重渲染整棵树。
 * - 快照对象在通知时整体替换，`entries` 也必须是新数组：消费者（ChatView / RunDetail）
 *   用 `useMemo(..., [snapshot.entries])` 派生视图，复用可变数组会让流式事件不触发重算，
 *   表现为“必须刷新才看到内容”。
 * - **锚点事件不参与裁剪**（按 run 的两道闸都算）：`run.started` / `user.message` / 终态
 *   事件承载 `session_id`、`input`、`status`，裁掉就会让整段 live run 从会话时间线消失
 *   （见 `RUN_ANCHOR_EVENT_TYPES`）。`session_id` 另外按 run 记住，裁剪后仍能归属会话。
 *   按 run 的那道闸 0.53 起就护锚点；**总量那道闸 0.55 才护** —— 旧实现从环头
 *   `entries.shift()`，锚点与内容一视同仁，于是「某个 run 的内容还在环里、它的终态却
 *   已经被挤出去」是可能的：重折叠 / 重连重建出来的视图是一条**永远 `running`** 的
 *   run（`superseded` 只救得了有后继 run 的那些，会话最后一条 run 没有后继，只能等
 *   会话快照）。口径与上界见 `trimEntries`。
 * - **单游标**（`clientTimelineSeq`）：前端只持**一个**游标（ADR-105 §6 / §7 的
 *   `client_timeline_seq`），回填按**一个区间** `[start_seq, end_seq]` 一次拿全
 *   （`applyTimelineRange`），四条校验（连续性 / `count` / 边界 / 重复）任一不成立就
 *   **不合并**、报 `timeline_gap_reported` 并让 UI 挂出污点条 —— 洞与重复都不许静默
 *   吸收。今天的 `seq <= lastSeq` 静默丢弃就是这条要消掉的行为。
 * - **存储层不做任何跨事件合并**（逐 delta 原样进环，seq 即真相）：
 *   合并曾把相邻同 kind 的增量并进上一条并只留**首 seq**，于是 `truncateAfter` 按条目
 *   seq 判去留、重放时又把尾巴并进同一条目 —— 用户看到「结尾正文重复」。
 *   现在「每个 seq 可见」是硬不变量（见 `docs/dev/reports/run-tail-duplicate/REPORT.md`）；
 *   段内合并发生在**读侧**（`events.ts` 的 fold 累积 `buf`），item 身份锚定首 delta 的 seq。
 * - **不产时间线产物的流式增量不进缓冲**（`tool_call_delta` / `finish` / 未识别的
 *   chunk 子类型，判据见 `events.ts#producesTimelineItem`）：它们一条都不产 item，
 *   却按 delta 计占 per-run 额度 —— 实测一个 run 6.1 万条 `tool_call_delta`，
 *   约 14 次工具调用就把 2000 条额度填满，随后真正产卡的条目被逐条挤出去。
 * - **回填段并入**（`applyTimelineRange`）：刷新 / 重连时环只留得住尾部，更早的那一段由
 *   `sessions.events` 按**一个区间**拉回来并进同一个 `entries`。区间与环共享同一个
 *   `timeline_seq`（ADR-105 §7 的等式：`UI == timeline(≤timeline_head) ∪ WAL(≤wal_head)`），
 *   所以没有任何负数带、没有内容 id 去重 —— `entries` 天然升序。区间并入后按 `entries`
 *   整表重折叠（更早的段往尾部追加 delta 一定错）。
 * - **首屏有界 + 分段滚动加载**（`earliestSeq` / `hasEarlier`）：**首屏必须有界：一次刷新
 *   推 19 万帧会把 WS 压死（2026-11-16 事故）**。刷新只并入尾部窗口
 *   （`TIMELINE_TAIL_WINDOW_EVENTS`）的那一段，更早的段由滚动到顶时一段一段补
 *   （`gateway/subscription.ts#loadEarlier`，左缘随之前移，到 1 为止）。
 */

import {
  contiguousPrefixEnd,
  firstExpectedSeq,
  inHoles,
  planRange,
  type TimelineEvent,
  type TimelineGapReport,
  type TimelineGapState,
  type TimelineRangeHeader,
  toRunEvent,
  validateTimelineRange,
} from '../gateway/timeline-protocol';
import type { RunEvent } from '../gateway/types';
import type { ErrorVisibility } from './error-visibility';
import { producesTimelineItem, type StoredEvent } from './events';
import { type ItemSink, LiveItemStore } from './live-items';

/**
 * 每个 run 在客户端缓冲里保留的条目上限。
 *
 * 口径（2026-11 实测，见 `packages/.../`.scratch/run-event-eviction 报告）：一次工具调用
 * = 一次完整 LLM 往返 = 至少 5 条事件（tool.call.started / llm.request / llm.response /
 * llm.stream.summary / tool.call.completed），再加上 hook 对、run.checkpoint、
 * context.changed 等每轮固定开销。所以「工具调用数 × 5~6」就是条目数的量级。
 *
 * 2000 条 ≈ 300~400 次工具调用 —— 对「跑十分钟的多工具 run」只是勉强够。0.53 起抬到
 * 5000（≈ 800~1000 次工具调用），代价是缓冲内存上界从 ~1.2 MB 抬到 ~3 MB（实测条目
 * 均值约 600 B），flush 浅拷贝在 20 Hz 下仍是亚毫秒级。
 *
 * 注意：**不产 timeline item 的增量**（`tool_call_delta` / `finish`）根本不进缓冲
 * （`producesTimelineItem`，见 `push`）。所以这个上限量的是「真实事件条数」，
 * 不是「token 数」。
 *
 * 0.53 起文本 / 思考的流式增量**也按 delta 计数**（存储层不再合并）：delta 洪水
 * （一个 run 曾 6.1 万条）会把环挤到只剩尾部。这只影响**传输面**——运行详情实时日志
 * 少几行；渲染侧的 item 由 `LiveItemStore` 物化，
 * 裁剪不影响屏上内容（DESIGN.md I4）。要合并必须做成「片段级 seq 集合可见」，
 * 见 REPORT §7 的 `fragSeqs`。
 */
export const MAX_EVENTS_PER_RUN = 5000;

/**
 * 总量裁剪时从环头往后扫「最旧的可裁条目」的最大步数。
 *
 * 环头若堆着一大段**受保护的锚点**（病态流：一个 run 里几千条 `user.message`），逐条跳过
 * 会把每次裁剪退化成 O(锚点数)。超过这个步数就按「最老的 run 整组丢」
 * （`dropOldestRunGroup`）—— 这也是口径上本来就对的粒度：那个 run 的内容本来也要被裁光。
 *
 * 512 的取法：正常流里一个 run 的锚点是 2~5 条（`run.started` / `user.message` / 终态 /
 * 成员边界），512 远大于它，所以这条出口只在病态流上走到。
 */
export const MAX_TRIM_SCAN = 512;

/**
 * **`EPOCH_IDLE_MS` 已删除（0.55）**：那张「400ms 没新帧就认为这趟发完了」的空闲猜测不再
 * 存在。结趟改吃两条**显式事实**，都不是时钟：
 *
 * 1. `timeline-epoch-end` 帧（能力位 `timeline.epoch-end`，0.55）：服务端把本趟声明区间
 *    **整趟发完**后才发，`has_more` 直接给出「还要不要续拉」。入口
 *    `EventStore#endTimelineEpochPass`。
 * 2. 订阅 `res` 已经回来（`SubscriptionController#run` 在 `events.subscribe` 的应答之后
 *    调 `EventStore#settleTimelineEpochIfOpen`）：老服务端（0.54 不发结束帧）/ 服务端撞
 *    背压提前停时，它就是「这一趟不会再发帧了」的显式事实，按**连续前缀**收口续拉。
 *
 * 为什么要删：猜测的代价是双向的 —— 网络慢一点或一次 GC 停顿就误判成「停」，按前缀收口
 * 并续拉（用户看到的是那条假缺口报告）；反过来真没发完时也分不清「没发完」和「发完了
 * 没东西」。线上序列是固定的：hello → event×N → timeline-epoch-end → res，帧与应答都在
 * 事件循环里排好了序，不需要等待一段时间。
 *
 * 两条判据都只对**时间线** epoch 有效：没有 `hello.timeline` 段就没有 epoch（
 * `beginTimelineEpoch` 不会被调用），老 epoch 上它们都是空操作 —— 这正是
 * `serve-epoch` 报告要求的「只在带时间线段的 epoch 上依赖结束帧」（0.55 的判据是形状，
 * `timeline_source` 已在 0.55 删除）。
 */

/**
 * 缓冲总量上限（跨 run 的安全网）。
 *
 * 客户端是**按订阅范围**收事件的（Chat 只收当前会话、Runs 只收 `run.*`、run 详情只收
 * 单个 run；换范围时 `clear()`），所以这个数正常情况下摸不到 —— 它只是防止某个
 * 订阅范围异常宽时把内存吃爆。与 `MAX_EVENTS_PER_RUN` 同比抬高（10000 → 20000），
 * 保证「两个满额 run」不会被总量闸门提前裁掉。
 *
 * **这个上限是硬的**：裁剪后环长度恒 ≤ `maxEventsTotal`（唯一例外：剩下的每一条都是
 * **最新那条 run** 的锚点 —— 那条不许裁，见 `trimEntries`；此时上界退化为
 * `maxEventsPerRun`，仍然有界）。超长会话（实测单会话 17 万条事件）就是靠它在内存上
 * 封顶的，所以「护锚点」不能变成「无上限地护」。
 */
export const MAX_EVENTS_TOTAL = 20000;
export const NOTIFY_INTERVAL_MS = 50;

/**
 * 裁剪时必须保留的锚点事件（**两道闸共用**：按 run 的闸 0.53 起、总量那道闸 0.55 起）。
 *
 * 流式增量（`llm.stream.chunk`）按 delta 计，一条长正文就能把同一个 run 的额度吃满；
 * 老实现从 run 头部逐条丢，`run.started` 一旦被丢：
 * `group.sessionId` 变 undefined → 会话窗口按 sessionId 过滤时整段 live run 消失，
 * 用户表现为「跑的时候看不见正文/工具卡，run 结束刷新后才一次性出现」。
 *
 * 三类条目在这里，判据都是「**丢了就等于那个对象的结局消失**」：
 * - run 的边界：`run.started`（身份 / input / session_id）与三条终态（`status`、
 *   `completedAt`、`error`）。终态丢了 → 重建出来的视图是一条永远 `running` 的 run；
 * - 用户输入：`user.message`（`run.started` 之后到达、可能覆盖 input 的唯一来源）；
 * - **成员终态**（0.55）：`subagent.delegate.started/completed/failed` 是成员树
 *   （`state/agents.ts#reduceAgents`）的终态来源，而成员树是**纯 `entries` 派生**的
 *   ——它没有 `LiveItemStore` 的台账（`closedRuns` / `sessionClosed`）那一层兜底，
 *   终态被总量裁剪挤掉就是「成员永远在跑」，没有任何机制能救回来。
 */
export const RUN_ANCHOR_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.started',
  'user.message',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'subagent.delegate.started',
  'subagent.delegate.completed',
  'subagent.delegate.failed',
]);

export interface EventMeta {
  seq: number;
  jobId?: string;
}

export interface EventStoreSnapshot {
  entries: readonly StoredEvent[];
  /** 单游标（`client_timeline_seq`）的当前值；重连 `since` / hello 判断用。 */
  lastSeq: number;
  /**
   * 还有更早的时间线段没加载（滚动到顶时向前要一段，见 `EventStore#hasEarlier`）。
   *
   * 进快照是因为**滚动触发器**读它：它一变（加载到底 / 清空），滚动区就该停止请求。
   */
  hasEarlier: boolean;
  version: number;
}

/** 传输面的可注入上限（**只给门禁 / 测试**用，生产走默认常量）。 */
export interface EventStoreOptions {
  /** 每个 run 的条目上限（默认 `MAX_EVENTS_PER_RUN`）。 */
  maxEventsPerRun?: number;
  /** 总条目上限（默认 `MAX_EVENTS_TOTAL`）。 */
  maxEventsTotal?: number;
  /** item 侧每 run 上限（默认 `MAX_ITEMS_PER_RUN`，见 `live-items.ts`）。 */
  maxItemsPerRun?: number;
  /** item 侧总量上限（默认 `MAX_ITEMS_TOTAL`）。 */
  maxItemsTotal?: number;
}

/**
 * 一次区间并入的结果（探针 / 日志 / 门禁读它）。
 *
 * `violation` 有值 = 四条校验之一没过，**这一段一条都没并**（`merged` 为 0），缺口已记进
 * `TimelineGapState`（UI 看得见）。`duplicates` = 区间里已经收过的条数（幂等复喂 /
 * 缺口重拉都会命中这里）。
 */
export interface TimelineRangeOutcome {
  merged: number;
  duplicates: number;
  evicted: number;
  violation?: TimelineGapReport;
}

/**
 * 一趟 epoch 收尾时交给订阅层的**续拉判据**。
 *
 * `hasMore` 只在收到 `timeline-epoch-end`（0.55，能力位 `timeline.epoch-end`）时有值：
 * 那是服务端按「后面还有**可读**的」算出来的事实。缺省 = 没有那一帧（0.54 服务端 / 提前停），
 * 订阅层退回自己的判据（本趟末 seq 与应到右端比）。
 */
export interface TimelineEpochSettle {
  hasMore?: boolean;
}

function emptyGapState(): TimelineGapState {
  return { reports: 0, tainted: false };
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
    lastSeq: 0,
    hasEarlier: false,
    version: 0,
  };
}

export class EventStore {
  private entries: StoredEvent[] = [];
  private runCounts = new Map<string, number>();
  /**
   * run_id → 环里属于它的**锚点**条目数（`RUN_ANCHOR_EVENT_TYPES`）。
   *
   * 只服务总量裁剪的保护判据 `runHasContent()`（run 的条目数 > 锚点数 ⇒ 它还有内容在
   * 环里 ⇒ 锚点受保护）。跟着 `runCounts` 走：同两处增删、同一批重建点（见
   * `noteEntry` / `rebuildCounts`）。不另建数据结构：两次 O(1) 的 Map 操作。
   */
  private runAnchorCounts = new Map<string, number>();
  /** run_id → session_id：裁剪掉 `run.started` 后仍能把事件归属到会话。 */
  private runSessions = new Map<string, string>();
  /**
   * 当前事件订阅范围所属的会话（服务端按 `session_id` 过滤时为该会话 id）。
   *
   * **为什么需要**：`packages/serve/src/gateway.ts` 的会话订阅是「按 session_id
   * **过滤**」而不是「给事件**盖**章」——`eventSessionId()` 只读 `data.session_id`，
   * 缺省时靠服务端 `runSessions` LRU 命中决定发不发，命中结果不上 wire。而
   * `llm.stream.chunk` / `tool.call.*` 天生不带 `session_id`；再加上有界回放（最新
   * 1 MiB / 2000 条）可能把 `run.started` 挡在窗口外，客户端的分组就会拿不到
   * sessionId，被 `useChatTranscript` 的会话窗口整段过滤（用户看到「运行中什么都没
   * 有，跑完刷新才出现」）。
   *
   * **不变量**：
   * - 只是 fallback：`push()` 的归属优先级恒为「事件自报 `session_id` >
   *   runSessions 映射 > scopeSession」，已有显式值的条目绝不被作用域覆盖；
   * - 只由 `SubscriptionController` 在**服务端过滤生效的会话订阅**下设置，其它范围
   *   （run / runs / team / none）与旧 gateway 降级路径都**显式置为 undefined**；
   * - `reset()` 保留该值（gap reset 后仍处于同一会话订阅），但订阅范围一旦变化必须
   *   由 `setScopeSession` 立刻覆写——归属来源变了就要重算，见
   *   `serverScopedSessionId()`。
   *
   * 背景见 L-041「事件缓冲不是历史」：缓冲里的条目只是某次订阅的增量快照，不能靠
   * “谁最后写的”推断归属，必须有显式、可清除的作用域。
   */
  private scopeSession: string | undefined;
  /**
   * **单游标**（`client_timeline_seq`，ADR-105 §6）：前端只持这一个。
   *
   * 语义只有三条：① 已并入的最大 `timeline_seq`；② 回填区间从它 +1 起；③ 重连
   * `since` 用它。刷新不清零（由 `state/timeline-cursor.ts` 本地持久化），换会话 /
   * 换作用域才随 `clear()` 归零。
   */
  private clientTimelineSeq = 0;
  /**
   * **已加载窗口的左缘**（最小的「已并入」seq；0 = 还没并入过任何区间）。
   *
   * 为什么要它、而不是直接用单游标：单游标是**右端**（重连 `since` 用它，只许前进），
   * 「还有更早的没加载」问的是**左端**。刷新时首屏只回填尾部窗口
   * （`TIMELINE_TAIL_WINDOW_EVENTS`），左缘就是那个窗口的第一条；滚动到顶时
   * `[左缘 - 窗口 .. 左缘 - 1]` 再要一段，左缘随之前移，直到 1。
   *
   * **首屏必须有界：一次刷新推 19 万帧会把 WS 压死（2026-11-16 事故）。** 那次事故的
   * 形态就是「左缘恒为 1、右端一路追到会话末尾」，所以「还有更早的」必须能被表达出来
   * （{@link hasEarlier}），否则没有人会去分段加载。
   */
  private earliestSeq = 0;
  /**
   * 连接级回放（**hub seq**）的静默开关。
   *
   * 连接级 hello 之后的那段回放走的是进程级 hub seq，时间线订阅走的是会话 seq ——
   * 两套编号不可比（ADR-105 §9 R7）。timeline-capable 服务端的 chat 内容一律由
   * 「回填 + 时间线订阅」负责，所以这段时间的帧对聊天没有价值：只丢，不记账、不报缺口。
   *
   * **不静默吸收的例外**：这些帧本来就不该进这个 seq 空间（不是重复，也不是缺口），
   * 因此也不许写 `timeline_gap_reported` —— 那会让服务端日志被每秒上千条假缺口淹没
   * （2026-11-17 实测 13,854 条）。
   */
  private suppressLegacyFrames = false;
  /**
   * 时间线 seq 的**接受下限**（`reset` 之后只认尾部窗口）。
   *
   * 服务端按 `reset` 从 seq 1 重放时，那些帧属于**已作废的空转**：本地游标已经不可信，
   * 正确动作是丢弃缓冲、重新锚到尾部窗口。比下限更早的帧一律丢（不是缺口，声明里就有）。
   */
  private seqFloor = 0;
  /**
   * 缺口声明面（见 `TimelineGapState`）。
   *
   * 四条校验任一不成立、RPC 拿不全、服务端 gap 帧 —— 三条来源都记在这里。**界面不显示它**
   * （用户明确要求"这条前端提示不应该出现"）：出口只有 console 与 `timeline_gap_reported`
   * 上报。累计值只增，`last` 是最近一次（重拉成功后由 `clearTimelineGap` 收起）。
   */
  private gap: TimelineGapState = emptyGapState();
  /**
   * 本 epoch 由服务端**声明**的时间段（`timeline.hello` 的 `timeline` 字段）。
   *
   * 只有 `hello.timeline` 段在时才有：那时帧带 `timeline_seq`，四条校验就能
   * 在**实时流**上做 —— 收到区间左端时开始记账，收到右端（或攒够 `count` 条）时一次核对。
   * `undefined` = 老 epoch（hub seq），不做四条校验（帧 seq 里有跳空是正常的）。
   */
  private epoch: { header: TimelineRangeHeader; seqs: number[] } | undefined;
  /**
   * 一个 epoch 记完账（收到结束帧 / 订阅 `res` 已回）后的出口。
   *
   * 用途只有一个：服务端每趟最多送 2000 条，声明区间**短于**真实右端
   * （`end_seq < min(wal_head, published_head)`）时，订阅层据此续拉下一趟 ——「续拉循环」
   * 在实时流那一侧的一半（另一半是 `sessions.events` 的分段回填）。
   */
  private epochEndHook:
    | ((header: TimelineRangeHeader, settle: TimelineEpochSettle) => void)
    | undefined;
  /**
   * 缺口上报的出口（订阅层注入：把 `timeline_gap` 帧发回服务端）。
   *
   * 放在 store 外面是因为它要碰 WS；**声明**（`gap` 状态）留在 store 里，两条不混。
   */
  private gapReporter: ((report: TimelineGapReport) => void) | undefined;
  /**
   * 累计被当作「传输噪声」丢掉的流式增量条数（判据 `events.ts#producesTimelineItem`
   * 为 false 的那些）。只为可观测：提示卡那一单要显示「本轮有 N 条事件未在实时视图
   * 里出现」，先只暴露 getter，**不在 UI 里渲染**。
   *
   * 这里丢的东西不产 item，不属于「裁剪」：缓冲裁剪本身已经与渲染无关（I4 / I6），
   * 所以裁剪不再需要任何「通知渲染重算」的信号（旧的 truncatedSince / truncatedRuns
   * 已随 `EventGroupCache` 一起删除，见 `check-live-items` 的 T1）。
   */
  private droppedNoiseCount = 0;
  /**
   * 被归属校验丢掉的跨会话帧条数（0.60，）。
   *
   * 与 droppedNoise 分开记：噪声是「不产时间线物品的增量」，这里丢的是**不该到**的帧。
   * 两者都只增不减；getter 给探针 / 真机读数，UI 不渲染（用户不该为协议问题看到提示）。
   */
  private droppedForeignCount = 0;
  /** 跨会话帧的第一条 warn 只打一次（否则慢客户端会被刷屏）。 */
  private foreignWarned = false;
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: EventStoreSnapshot = emptySnapshot();
  /** 本 run 的条目上限（注入点见 `EventStoreOptions`，默认 `MAX_EVENTS_PER_RUN`）。 */
  private readonly maxEventsPerRun: number;
  /** 总条目上限（默认 `MAX_EVENTS_TOTAL`）。 */
  private readonly maxEventsTotal: number;
  /**
   * 物化面（事件 → item）。**渲染侧只读它的快照**（`getSnapshot().groups`）。
   *
   * 它是 `push()` 的唯一下游：事件进了环就立刻转发一条给 `ingest`，因此「缓冲裁剪
   * 不影响屏上内容」（I4）与「增量 == 全量重建」（同一段 fold）都是结构性的。
   * `entries` 退化为纯传输窗口：订阅接缝 / 重连回放 / 回填暂存 / 运行详情 / 成员树。
   */
  readonly items: LiveItemStore;

  constructor(
    private readonly notifyDelayMs = NOTIFY_INTERVAL_MS,
    options: EventStoreOptions = {},
  ) {
    this.maxEventsPerRun = options.maxEventsPerRun ?? MAX_EVENTS_PER_RUN;
    this.maxEventsTotal = options.maxEventsTotal ?? MAX_EVENTS_TOTAL;
    this.items = new LiveItemStore({
      ...(options.maxItemsPerRun !== undefined ? { maxItemsPerRun: options.maxItemsPerRun } : {}),
      ...(options.maxItemsTotal !== undefined ? { maxItemsTotal: options.maxItemsTotal } : {}),
    });
  }

  /** 物化面的写入接缝（`push` / 回填 / 语义删除会转发；换实现时用它旁路）。 */
  private get sink(): ItemSink {
    return this.items;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EventStoreSnapshot => this.snapshot;

  /** 单游标的当前值（`client_timeline_seq`；不等待 50ms 合批）。 */
  get currentSeq(): number {
    return this.clientTimelineSeq;
  }

  /**
   * 还有更早的时间线段没加载（滚动到顶时向前要一段）。
   *
   * 判据就是左缘（`earliestLoadedSeq`）> 1：**首屏只加载尾部窗口**
   * （`TIMELINE_TAIL_WINDOW_EVENTS`），所以刷新之后它一定是 true，直到用户滚到顶、
   * 一段一段把 1 之前的都补回来为止。
   */
  get hasEarlier(): boolean {
    return this.earliestSeq > 1;
  }

  /**
   * 已加载窗口的左缘（0 = 还没并入过任何区间）。
   *
   * 订阅层用它算「更早的一段」：`[左缘 - 窗口 .. 左缘 - 1]`（`planEarlierRange`）。
   */
  get earliestLoadedSeq(): number {
    return this.earliestSeq;
  }

  /** 缺口声明的只读副本（诊断页 / 探针读它；快照里也有一份，给界面）。 */
  get timelineGap(): TimelineGapState {
    return this.gap;
  }

  /**
   * 累计被丢掉的传输噪声条数（本 store 实例生命周期内的累加值）。
   *
   * 口径见 `droppedNoiseCount`：这些条目本来就不产时间线物品，丢它们对可见内容零影响。
   * 只读、不进快照（避免为一个观测数字让每个 50ms 合批都换一次 snapshot 对象）。
   */
  get droppedNoise(): number {
    return this.droppedNoiseCount;
  }

  /** 被归属校验丢掉的跨会话帧条数（0.60）；正常订阅下恒为 0。 */
  get droppedForeign(): number {
    return this.droppedForeignCount;
  }

  /**
   * 记一次**已声明**的缺口（四条校验不过 / RPC 拿不全 / 服务端 gap 帧）。
   *
   * 这是 `timeline_gap_reported` 的本地落点：进 `gap`（快照 ⇒ UI 污点条）**并**打一条
   * `console.warn`（真机排查的第一落点）。它不阻断渲染 —— 污点标记但不阻断，是 ADR-105
   * §6 写死的行为。返回本次缺口（调用方要拿它去重拉该区间）。
   */
  reportTimelineGap(report: TimelineGapReport): TimelineGapReport {
    this.gap = { reports: this.gap.reports + 1, tainted: true, last: report };
    console.warn(
      `[timeline_gap_reported] seq ${report.from_seq}..${report.to_seq} source=${report.source}` +
        `${report.rule === undefined ? '' : ` rule=${report.rule}`}` +
        ` expected=${report.expected} received=${report.received}`,
    );
    // 立刻发布：缺口是「界面必须看见」的事实，不能等 50ms 合批（也不能等到下一次 flush）。
    this.flush();
    // 声明式上报（proto-b1 的 `timeline_gap` 帧）：只记录、不改事实源，best-effort。
    this.gapReporter?.(report);
    return report;
  }

  /** 注入缺口上报的出口（订阅层把 `timeline_gap` 帧发回服务端；缺省 = 只本地记账）。 */
  setGapReporter(reporter: ((report: TimelineGapReport) => void) | undefined): void {
    this.gapReporter = reporter;
  }

  /**
   * 开始一个**服务端声明**的时间线段（`timeline.hello`，0.54 B1）。
   *
   * 之后每一帧 `push` 都只**记账**；判缺口的时机由「这趟确认发完」的显式事实决定
   * （`timeline-epoch-end` 帧 / 订阅 `res`），见 {@link endTimelineEpochPass} 与
   * {@link settleTimelineEpochIfOpen}。老订阅（没有 `hello.timeline` 段）不调用它 ——
   * 那种帧的 seq 跳空是正常的。
   */
  beginTimelineEpoch(header: TimelineRangeHeader): void {
    // 覆盖在途 epoch：一趟 epoch 只有一套声明（0.55 起没有定时器要清）。
    this.epoch = { header, seqs: [] };
    // 时间线帧到了：连接级 hub 回放的静默窗口到此结束。
    this.suppressLegacyFrames = false;
  }

  /**
   * 连接级回放（hub seq）的静默开关，由订阅层在「连接级 hello 且无时间片段」时置位。
   *
   * 见 {@link suppressLegacyFrames}：这是**作用域事实**（不是错误），所以这里只丢帧，
   * 不写缺口、不动游标。
   */
  setSuppressLegacyFrames(value: boolean): void {
    this.suppressLegacyFrames = value;
  }

  /**
   * 时间线 seq 的接受下限（`reset` 后锚到尾部窗口时调用）。
   *
   * 只影响实时 `push`：回填走 `applyTimelineRange`，用户滚到顶加载更早的段不受影响。
   */
  setSeqFloor(seq: number): void {
    this.seqFloor = Number.isInteger(seq) && seq > 0 ? seq : 0;
  }

  /** 结束本 epoch 的记账（订阅换范围 / 断线 / 服务端回到 legacy）。 */
  endTimelineEpoch(): void {
    this.epoch = undefined;
  }

  /** 当前是否处在服务端声明的时间线段里（订阅层据此决定帧的 seq 空间）。 */
  get timelineEpoch(): boolean {
    return this.epoch !== undefined;
  }

  /**
   * 收到 `timeline-epoch-end`（0.55）：这一趟**显式**发完了。
   *
   * 服务端只在整趟发完时发这一帧（提前停不发），所以到这里可以按四条硬校验核对声明；
   * `has_more` 是它给出的续拉判据 —— 按「后面还有**可读**的」算，尾部只剩洞时为 false
   * （裸的 `end_seq < min(wal_head, published_head)` 在那种会话上恒真，客户端会原地
   * 打转：每趟 0 条、`has_more` 仍为真）。
   *
   * 没有在途 epoch 时是空操作：老服务端不发这一帧，legacy epoch 也不会有 epoch。
   */
  endTimelineEpochPass(end: { end_seq: number; count: number; has_more: boolean }): void {
    const header = this.closeEpoch();
    if (header === undefined) return;
    this.epochEndHook?.(header, { hasMore: end.has_more === true });
  }

  /**
   * 订阅 `res` 已经回来、本趟还没收尾 ⇒ 用这条**显式事实**收尾（0.54 服务端不发结束帧 /
   * 服务端撞背压提前停）。
   *
   * 返回本趟实际覆盖的声明；`undefined` = 没有在途 epoch，或者收口失败并已报过缺口 ——
   * 两种都不该续拉。续拉的决定留给调用方（它才持有「应到右端」与 stall 计数）。
   *
   * 为什么 `res` 算显式事实：线上序列被服务端写死了 —— hello → event×N →
   * `timeline-epoch-end` → `res`。应答回来就意味着这一趟不会再发帧，**不需要等待**任何时间。
   */
  settleTimelineEpochIfOpen(): TimelineRangeHeader | undefined {
    return this.closeEpoch();
  }

  /**
   * 实时流的一段记一条（`push` 调用；区间外的帧不计入期望）。
   *
   * 只记账、**不在这里判缺口，也不在这里结趟**：四条校验要等「这一趟确实发完了」的显式
   * 事实（结束帧 / 订阅应答）。为什么不能按「末条贴住右端 / 攒够 `count`」提前判：服务端
   * 发帧时撞背压会提前停，而它**不发**结束帧 —— 那种情况必须按连续前缀收口续拉，扣一条
   * 缺口就是把「没发完」误报成「少给了」（用户看到的那条 rule 3 假缺口）。
   */
  private recordEpochSeq(seq: number): void {
    const epoch = this.epoch;
    if (epoch === undefined) return;
    if (seq < epoch.header.start_seq || seq > epoch.header.end_seq) {
      // 区间外的帧照常入环（它属于下一趟 / 别的段），但不进这一段的期望集合。
      return;
    }
    epoch.seqs.push(seq);
  }

  /**
   * 收掉在途 epoch，返回「这一趟实际覆盖的声明」（`undefined` = 没有可交回去的一段）。
   *
   * 两段判定（0.55 起的判据只有一个：这趟确实发完了）：
   * 1. **到齐**（末条贴住声明右端 / 条数够）⇒ 四条硬校验（连续性 / count / 边界 / 重复），
   *    对不上才报缺口 —— 到齐了还少，那才是真缺口；
   * 2. **没到齐** ⇒ 按**连续前缀**收口：前缀合法 ⇒ 按实收末 seq 收缩声明交回去续拉
   *    （服务端撞背压提前停不是丢数据）；一条都没收到 / 前缀不合法才是真缺口，且**不**
   *    回调续拉（再订一次只会得到同一条空区间）。
   */
  private closeEpoch(): TimelineRangeHeader | undefined {
    const epoch = this.epoch;
    if (epoch === undefined) return undefined;
    this.epoch = undefined;
    const { header, seqs } = epoch;
    const last = seqs.length > 0 ? (seqs[seqs.length - 1] as number) : undefined;
    const complete = (last !== undefined && last >= header.end_seq) || seqs.length >= header.count;
    if (complete) {
      const violation = validateTimelineRange(header, seqs);
      if (violation !== undefined) this.reportTimelineGap(violation);
      return header;
    }
    const prefixEnd = contiguousPrefixEnd(header, seqs);
    if (prefixEnd === undefined) {
      // 一条都没收到 / 收到的不是"从区间左端起、只跳过声明洞"的连续前缀 ⇒ 真缺口。
      this.reportTimelineGap({
        from_seq: header.start_seq,
        to_seq: header.end_seq,
        source: 'range',
        rule: 3,
        expected: `首 ${String(firstExpectedSeq(header) ?? header.start_seq)} / 末 ${String(header.end_seq)}`,
        received:
          seqs.length === 0
            ? '这一段一条都没收到'
            : `首 ${String(seqs[0])} / 末 ${String(seqs[seqs.length - 1])}（不是连续前缀）`,
        expectedCount: header.count,
        receivedCount: seqs.length,
        at: Date.now(),
      });
      return undefined;
    }
    // 连续前缀：这一趟只是**没发完**。按实收末 seq 收缩声明，交给订阅层续拉。
    return planRange(header.start_seq, prefixEnd, {
      timeline_head: header.timeline_head,
      wal_head: header.wal_head,
      holes: header.holes,
      tainted: header.tainted,
    });
  }

  /** 注入 epoch 结束出口（续拉用；缺省 = 不续拉）。 */
  setEpochEndHook(
    hook: ((header: TimelineRangeHeader, settle: TimelineEpochSettle) => void) | undefined,
  ): void {
    this.epochEndHook = hook;
  }

  /** 缺口已被后续重拉补上：收起 `tainted` / `last`（`reports` 是累计值，只增不减）。
   *
   * 为什么允许收起：`tainted` 的语义是「**现在**有一段读不回来」，不是「历史上曾经坏过」。
   * 洞（`holes`，写者声明的永久事实）不在这里收 —— 它们每次回填都会重新报一次。
   */
  clearTimelineGap(): void {
    if (!this.gap.tainted) return;
    // 声明洞（`source: 'holes'`）是**永久事实**：重拉成功也不许把污点收掉，否则「这一段
    // 读不回来」会变成一次性提示（ADR-105 §6：洞登记后永久保留，不自动修复）。
    if (this.gap.last?.source === 'holes') return;
    this.gap = { reports: this.gap.reports, tainted: false };
    this.scheduleNotify();
  }

  /** 当前订阅作用域所属的会话（缺口重拉要它；未设 = undefined）。 */
  get scopeSessionId(): string | undefined {
    return this.scopeSession;
  }

  /**
   * 设置「订阅范围内的会话」。**必须显式传值**（含 `undefined`）： 换会话要立刻覆写，换到 run / runs / team / none 范围要立刻清空 ——
   * 「不设」会保留上一个会话的残留作用域，把别的会话的增量误归属过来（串台）。
   *
   * 只影响**之后** push 的条目；已在缓冲里的条目保留 push 时的归属，不回写。
   * 归属来源变了就要重算，调用方见 `gateway/subscription.ts#serverScopedSessionId`。
   */
  setScopeSession(sessionId: string | undefined): void {
    if (this.scopeSession === sessionId) return;
    this.scopeSession = sessionId;
  }

  /**
   * 写入一**条**实时帧（订阅流）。去重口径 = **单游标**：
   * `seq <= client_timeline_seq` 的重复帧**记账后丢**，不再静默吸收（ADR-105 §6 第四条）。
   *
   * 存储层**不合并任何事件**（逐 delta 原样进环）：合并会让条目 seq 与内容范围脱钩，
   * 而 `truncateAfter` 按条目 seq 判去留 —— 重放时边界落在合并条目内部就是「结尾正文
   * 重复」的根因（REPORT §0.1）。段内合并只在读侧做（`events.ts` 的 fold 累积 `buf`）。
   *
   * 实时流**不做四条校验**：服务端按 `session_id` / `types` 过滤后 seq 本来就有跳空，
   * 「连续」只对**声明的区间**（`applyTimelineRange`）有意义。
   */
  push(event: RunEvent, meta: EventMeta): boolean {
    if (!Number.isFinite(meta.seq)) return false;
    // `reset` 之后只认尾部窗口：更早的帧是服务端从 1 重放的「空转」，本地游标已经作废。
    // 它们既不该进环，也不是缺口（声明里本来就覆盖），所以在这里静默丢。
    if (meta.seq < this.seqFloor) return false;
    // 连接级 hub 回放（时间线 epoch 未建立）：与时间线不是同一套编号，chat 侧不需要。
    if (this.suppressLegacyFrames && this.epoch === undefined) {
      this.droppedNoiseCount += 1;
      return false;
    }
    // 服务端声明的时间线段（`timeline.hello`）：本帧也要进四条校验的记账。
    if (this.epoch !== undefined) this.recordEpochSeq(meta.seq);
    if (meta.seq <= this.clientTimelineSeq) {
      // 重复吸收不许静默：单游标只认更大的 seq。报一条缺口（console + 上报），
      // 但**不**回退游标、也不重新合并 —— 重复帧没有内容价值，记账就够。
      this.reportTimelineGap({
        from_seq: meta.seq,
        to_seq: meta.seq,
        source: 'range',
        rule: 4,
        expected: `> ${this.clientTimelineSeq}`,
        received: String(meta.seq),
        at: Date.now(),
      });
      return false;
    } else {
      this.clientTimelineSeq = meta.seq;
    }
    // **不产时间线产物的流式增量不进缓冲**（判据唯一来源见 `events.ts#producesTimelineItem`：
    // `buildGroup` 的 chunk 分支只认 text/reasoning，`tool_call_delta` 什么都不做、
    // `finish` 只收口边界）。
    //
    // 丢它们安全：既不产 item，也不是内容权威 —— 正文/思考是 text/reasoning 增量合并出来的，
    // 工具卡与结果由 `tool.call.*` 给，完整回答与用量由 `llm.response` 与磁盘事件日志给。
    // 代价只有一条：运行详情的实时事件流（`useRunTrace` 的 live 部分）里少几行传输噪声。
    // 收益是把「per-run 额度按 delta 计」这件事从根上去掉（实测 61 081 条 tool_call_delta
    // 的 run，此前约 14 次工具调用就把 2000 条额度填满）。
    if (!producesTimelineItem(event)) {
      // 游标照推：这些 seq 已经「见过」，重连回放不该再讨一遍；快照不必发布（屏上没变化）。
      this.droppedNoiseCount += 1;
      return true;
    }
    // 0.60：归属校验（服务端已按会话过滤时，这里恒放行；不匹配的帧丢弃 + 记账）。
    if (!this.acceptOwner(event)) return false;
    const runId = event.run_id;
    // 归属会话的字段最先记住：即使本 run 的 `run.started` 之后被裁掉，仍能归属会话。
    const sessionId = eventSessionId(event);
    if (sessionId !== undefined) this.runSessions.set(runId, sessionId);
    // 归属优先级**恒为**：事件自报 `session_id` > runSessions 映射（同样来自自报）>
    // 当前订阅作用域。scopeSession 只是 fallback —— 事件一旦自带显式归属，绝不被
    // 作用域覆盖（否则切会话的窗口期内会把旧会话事件改判给新会话）。
    // 作用域兜的是「有界回放把 run.started 挡在窗口外」的增量：流式 delta 与工具事件
    // 本身没有 session_id，只能靠订阅范围归属。
    const owner = this.runSessions.get(runId) ?? this.scopeSession;
    const entry: StoredEvent = {
      event,
      seq: meta.seq,
      ...(owner !== undefined ? { sessionId: owner } : {}),
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
    };
    this.entries.push(entry);
    // 唯一 item 写入点：事件进环之后立刻折叠（裁剪与 item 正交，见 I4）。
    this.sink.ingest(entry);
    this.noteEntry(runId, event.type, 1);
    this.trimEntries(runId);
    this.scheduleNotify();
    return true;
  }

  /**
   * 并入**一个声明的区间** `[start_seq, end_seq]`（ADR-105 §6：单游标 + 单区间回填）。
   *
   * 语义（四条，缺一条这个功能就是骗人的）：
   * 1. **先校验再合并**：四条校验（连续性 / `count` / 边界 / 重复）任一不成立 ⇒ **一条都
   *    不并**，报 `timeline_gap_reported`（`reportTimelineGap`，UI 可见），由调用方重拉。
   * 2. **单游标只前进**：并入后游标取 `end_seq`（区间里的洞是被**声明**过的，跳过它们不算
   *    缺口）。区间起点早于游标时先退回去（刷新 / 缺口重拉的唯一入口，`rewound` 记条数）。
   * 3. **一次折叠**：整段并入后按 `entries` 重折叠一遍（`sink.resume`）。更早的段往尾部
   *    追加 delta 一定错，整 run 重折叠是唯一正确做法。
   * 4. **不产 item 的噪声不进环**（与 `push` 同口径）：它们只推游标，不占 per-run 额度。
   * 5. **左缘**（`earliestSeq`）随并入的区间往更早处前移：它是「还有更早的没加载」的判据
   *    （`hasEarlier`），也是滚动加载下一段的右端。首屏的尾部窗口就是靠这一条落位的。
   */
  applyTimelineRange(
    header: TimelineRangeHeader,
    events: readonly TimelineEvent[],
    /**
     * 这一页是**从哪个会话读的**（回填 / 缺口重拉由调用方给出）。
     *
     * 为什么必须显式传：页里的事件来自磁盘，流式增量与工具事件**不带** `session_id`，
     * 而回填发生在实时订阅**之前**（那时 scopeSession 还是空的，见 SubscriptionController）。
     * 不传的话这些条目就没有归属，被聊天窗口的会话过滤整段挡掉 —— 表现为「刷新后
     * 运行中的内容一条都不显示」。
     */
    expectedSessionId?: string,
  ): TimelineRangeOutcome {
    // 归属判据：本页声明的会话优先（它比实时作用域更具体）。
    const pageScope = expectedSessionId ?? this.scopeSession;
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    const violation = validateTimelineRange(
      header,
      ordered.map((event) => event.seq),
    );
    if (violation !== undefined) {
      this.reportTimelineGap(violation);
      return { merged: 0, duplicates: 0, evicted: 0, violation };
    }
    // 按 seq **缺席才插**：区间与实时流共用同一个 seq 空间，所以「已经在环里」就是收过
    // （幂等复喂 / 缺口重拉 / 刷新时环里已有的尾部都走这一条），不需要退游标、也不需要
    // 第二套去重键。洞里的 seq 本来就不该收到（校验按声明已放行），跳过它们。
    const present = new Set<number>();
    for (const entry of this.entries) present.add(entry.seq);
    let merged = 0;
    let duplicates = 0;
    let insertedBefore = false;
    for (const event of ordered) {
      if (present.has(event.seq)) {
        duplicates += 1;
        continue;
      }
      present.add(event.seq);
      // 声明为洞的 seq：没有内容可并，但游标要跨过去（见下）。
      if (inHoles(event.seq, header.holes)) continue;
      const runEvent = toRunEvent(event);
      if (!producesTimelineItem(runEvent)) {
        this.droppedNoiseCount += 1;
        continue;
      }
      // 0.60：时间线 epoch 的帧同样要过归属校验（页读与实时尾共用同一条口径）。
      if (!this.acceptOwner(runEvent, pageScope)) continue;
      if (event.seq <= this.clientTimelineSeq) insertedBefore = true;
      this.appendEntry(runEvent, event.seq, expectedSessionId);
      merged += 1;
    }
    // 单游标只前进：区间里的洞是**声明**，跳过它们不算缺口，游标照样推到右端。
    const advanced = header.end_seq > this.clientTimelineSeq;
    this.clientTimelineSeq = Math.max(this.clientTimelineSeq, header.end_seq);
    if (merged > 0) {
      // entries 必须按 seq 升序（`truncateAfter` 的二分前提）：插入的是更早的一段时重排一次。
      if (insertedBefore)
        this.entries = [...this.entries].sort((left, right) => left.seq - right.seq);
      // 计数表跟着环重建（并入可能改了顺序，也可能插进「更早的段」）。
      this.rebuildCounts();
    }
    const evicted = this.trimEntries();
    // 左缘（见 `earliestSeq`）：这一段把「已加载窗口」往更早的方向接长了多少。
    // 首屏就是这里落位成尾部窗口的左端 —— 于是 `hasEarlier` 立刻为 true，滚动时
    // 才有一段一段往前补的入口（**首屏必须有界**，见该字段的注释）。
    const edgeBefore = this.earliestSeq;
    this.noteCoveredRange(header.start_seq, header.end_seq);
    const edgeMoved = this.earliestSeq !== edgeBefore;
    // 区间带**声明洞** ⇒ 这一段读不回来是永久事实，UI 必须挂污点（ADR-105 §6）。
    //
    // 只认 `holes`：`tainted` 是一个**会话级**标记，没有洞区间时它给不出「哪一段不可读」，
    // 拿它挂条会变成一条指不出区间、也修不掉的假警报（真机上 176k 会话的假缺口就是这种
    // 形态：`holes.ndjson` 0 行、四字段里 `tainted` 却为真）。所以这里不放行它。
    const holesInRange = header.holes.filter(
      (hole) => hole.to_seq >= header.start_seq && hole.from_seq <= header.end_seq,
    );
    if (holesInRange.length > 0) {
      this.reportTimelineGap({
        from_seq: holesInRange[0]?.from_seq ?? header.start_seq,
        to_seq: holesInRange[holesInRange.length - 1]?.to_seq ?? header.end_seq,
        source: 'holes',
        expected: `[${String(header.start_seq)}, ${String(header.end_seq)}] 可读`,
        received: `已声明 ${String(holesInRange.length)} 段不可读（holes）`,
        at: Date.now(),
      });
    }
    if (merged > 0 || !advanced || edgeMoved) {
      // 并入 / 重排之后按环里的全部事件重折叠一遍（Rule R 的保留口径：屏上「更早的那一段
      // 长出来」，已有内容不动）。只推了游标时不必重算。
      this.sink.resume(this.entries);
      this.flush();
    }
    return { merged, duplicates, evicted };
  }

  /**
   * 记录「`[start_seq, end_seq]` 这一段已经并入」，必要时把左缘往更早的方向推进。
   *
   * 只接受**接在已加载窗口上**的区间（`end_seq >= 左缘 - 1`）：滚动加载正是这个形态
   * （`[左缘 - 2000 .. 左缘 - 1]`），首屏的尾部窗口也走这里（左缘为空时直接落位）。
   * 跳着来的区间（缺口重拉 `planRange(from, to)`，`to` 远在窗口之前）**不许**把左缘
   * 拉下去 —— 否则它和窗口之间那一段会永远没人去拉，屏上却以为自己「已经到那儿了」。
   */
  private noteCoveredRange(startSeq: number, endSeq: number): void {
    const start = Number.isInteger(startSeq) && startSeq > 0 ? startSeq : 1;
    if (this.earliestSeq === 0) {
      this.earliestSeq = start;
      return;
    }
    if (endSeq < this.earliestSeq - 1) return;
    this.earliestSeq = Math.min(this.earliestSeq, start);
  }

  /**
   * 帧归属校验（0.60）：**作用域内的会话订阅只接受本会话的帧**。
   *
   * 为什么必须有这一道：服务端在没有会话作用域时是「全发」（见 acceptsEvent 的新默认），
   * 而客户端拿到帧之后原先**不做任何归属校验**，只按
   * 「事件自报 session_id > runSessions 映射 > scopeSession」盖章。于是任何一条
   * 不带 session_id 的帧（llm.stream.chunk / tool.call.*，占实测流量的绝大多数；
   * 或者 run.started 已被环裁掉的那些）都会落进 scopeSession 这个兜底 ——
   * 结果是**别的会话的正文被挂到当前会话上显示**。
   *
   * 判据（三条，缺一不可）：
   * 1. 没有会话作用域 ⇒ 无从判定，放行（UI 按自报 sessionId 过滤）；
   * 2. 帧自报 session_id 且与作用域相同 ⇒ 放行；不同 ⇒ **丢弃并记账**；
   * 3. 帧不自报 ⇒ 看 runSessions 里的已知归属，已知且不同 ⇒ 丢弃并记账；
   *    未知 ⇒ 放行（它是本作用域的新 run，服务端已按会话过滤，见 scopeSession 的不变量）。
   *
   * 丢弃**不是静默**：计数进 droppedForeign（可查），首次打一条 warn（带两个会话 id 与
   * 事件类型，不带事件正文）。
   */
  private acceptOwner(event: RunEvent, scopeOverride?: string): boolean {
    const scope = scopeOverride ?? this.scopeSession;
    if (scope === undefined) return true;
    const claimed = eventSessionId(event);
    if (claimed !== undefined) {
      if (claimed === scope) return true;
      // **先记住它属于谁**，再丢弃：这一帧之后还有同一 run 的增量（llm.stream.chunk /
      // tool.call.*，它们都不自报归属），不记住就会落到 scopeSession 兜底、被盖上当前
      // 会话的章 —— 那正是这一道校验本来要拦的东西。
      this.runSessions.set(event.run_id, claimed);
      this.noteForeignFrame(event.type, claimed, scope);
      return false;
    }
    const known = this.runSessions.get(event.run_id);
    if (known !== undefined && known !== scope) {
      this.noteForeignFrame(event.type, known, scope);
      return false;
    }
    return true;
  }

  /** 丢弃一条不属于当前会话作用域的帧：计数 + 首次 warn（不打印正文）。 */
  private noteForeignFrame(type: string, claimed: string, scope: string): void {
    this.droppedForeignCount += 1;
    if (this.foreignWarned) return;
    this.foreignWarned = true;
    console.warn(
      '[vessel] events: 丢弃不属于当前会话的帧（' +
        'claimed=' +
        claimed +
        ', scope=' +
        scope +
        ', type=' +
        type +
        '）；跨会话帧累计计数见 EventStore#droppedForeign。',
    );
  }

  /** 一条已校验通过的事件进环（`push` 与 `applyTimelineRange` 共用；归属口径一致）。 */
  private appendEntry(event: RunEvent, seq: number, fallbackOwner?: string): void {
    const runId = event.run_id;
    const sessionId = eventSessionId(event);
    if (sessionId !== undefined) this.runSessions.set(runId, sessionId);
    // fallbackOwner：**这次并入的段属于哪个会话**（回填页由调用方显式给出）。
    // 它排在 scopeSession 之后：实时订阅的作用域是确认过的，页面的会话 id 只是
    // 「这一段是从哪个会话读的」，两者一致时无差别；不一致说明这一页有问题，
    // 由 acceptOwner 先拦掉，走不到这里。
    const owner = this.runSessions.get(runId) ?? this.scopeSession ?? fallbackOwner;
    const entry: StoredEvent = {
      event,
      seq,
      ...(owner !== undefined ? { sessionId: owner } : {}),
    };
    this.entries.push(entry);
    this.sink.ingest(entry);
    this.noteEntry(runId, event.type, 1);
  }

  /**
   * 传输窗口的两道上限（每 run / 总量）。
   *
   * 抽出来是为了让**磁盘段并入**（`applyDiskSegment`）走同一套裁剪口径：一次并入几千条
   * 之后再复制一份裁剪逻辑，两条路径迟早会漂（一条按锚点保护、一条不按）。
   * `runId` 缺省 = 检查全部 run（批量并入用）；`push` 只传自己那条 run（热路径 O(1)）。
   *
   * 每 run 上限：丢该 run 最旧的**非锚点**条目（锚点见 `RUN_ANCHOR_EVENT_TYPES`）。
   * 裁剪只影响传输面：屏上的 item 由 LiveItemStore 物化，不随环缩水（I4）。
   * 返回被清出的条数。
   *
   * **总量上限也护锚点（0.55）**，三条口径：
   *
   * 1. **有内容的 run，锚点不裁**（`runHasContent`：该 run 的条目数 > 锚点数，O(1)）。
   *    只要环里还留着这个 run 的任何一条内容，它的 `run.started` / 终态就留着 ——
   *    「重建出来的视图」要么看见完整边界，要么这个 run 一条都不在环里；**不存在
   *    「有内容、没终态 ⇒ 永远正在思考」**这一档。旧实现（环头 `shift()`）正是这一档
   *    的产地：`superseded` 只救得了有后继 run 的那些，会话最后一条 run 没有后继。
   * 2. **最新那条 run 的锚点一律不裁**（`newestRunId`）：它是会话末轮的结局，没有后继
   *    run 顶它、台账也可能是空的（新视图 / `dropSession` 之后），丢了就没人救。
   * 3. **有界**：环长度恒 ≤ `maxEventsTotal`。唯一例外是「剩下的每一条都是最新那条 run
   *    的锚点」（再裁就正好裁掉第 2 条要保的东西）：此时那条 run 的条目数已被每 run
   *    上限夹住（`maxEventsPerRun`），所以上界是 `max(maxEventsTotal, maxEventsPerRun)`，
   *    不是无上限。
   *
   * 这也让裁剪顺序自带「整组丢」的语义：一个老 run 的内容按序被裁光之后，它的锚点
   * 就不再受保护（`runHasContent` 为假）——不会在环里留下一串没有内容的历史锚点。
   * 环头整段都是受保护锚点时（病态流）走 `dropOldestRunGroup`，仍然按「最老的那一组」
   * 整组丢，且绝不动最新那条 run。
   */
  private trimEntries(runId?: string): number {
    let evicted = 0;
    for (const id of runId === undefined ? [...this.runCounts.keys()] : [runId]) {
      let over = (this.runCounts.get(id) ?? 0) - this.maxEventsPerRun;
      while (over > 0) {
        const index = this.oldestEvictableIndex(id);
        if (index < 0) break;
        this.removeEntryAt(index);
        over -= 1;
        evicted += 1;
      }
    }
    // 总量上限：从最旧的**可裁**条目开始丢（受保护的锚点跳过，见上面的口径）。
    while (this.entries.length > this.maxEventsTotal) {
      const index = this.oldestEvictableTotalIndex(MAX_TRIM_SCAN);
      if (index >= 0) {
        this.removeEntryAt(index);
        evicted += 1;
        continue;
      }
      // 环头 `MAX_TRIM_SCAN` 条全是受保护锚点 ⇒ 那是「最老的那一组」，整组丢（口径见下）。
      const dropped = this.dropOldestRunGroup(MAX_TRIM_SCAN);
      if (dropped === 0) break;
      evicted += dropped;
    }
    return evicted;
  }

  /** 从环里删掉第 `index` 条并同步两张计数表（两道闸共用；返回是否真删了）。 */
  private removeEntryAt(index: number): boolean {
    const removed = this.entries.splice(index, 1)[0];
    if (removed === undefined) return false;
    this.noteEntry(removed.event.run_id, removed.event.type, -1);
    return true;
  }

  /** 一个 run 的条目 / 锚点计数（`delta` = +1 进环、−1 出环；两张表必须同步）。 */
  private noteEntry(runId: string, type: string, delta: 1 | -1): void {
    const total = (this.runCounts.get(runId) ?? 0) + delta;
    if (total <= 0) this.runCounts.delete(runId);
    else this.runCounts.set(runId, total);
    if (!RUN_ANCHOR_EVENT_TYPES.has(type)) return;
    const anchors = (this.runAnchorCounts.get(runId) ?? 0) + delta;
    if (anchors <= 0) this.runAnchorCounts.delete(runId);
    else this.runAnchorCounts.set(runId, anchors);
  }

  /** 按环里的条目重建两张计数表（批量并入 / 截断 / 语义删除之后，O(n) 低频路径）。 */
  private rebuildCounts(): void {
    this.runCounts.clear();
    this.runAnchorCounts.clear();
    for (const entry of this.entries) this.noteEntry(entry.event.run_id, entry.event.type, 1);
  }

  /** 这个 run 还有**内容**（非锚点条目）在环里吗 —— 总量裁剪的保护判据（O(1)）。 */
  private runHasContent(runId: string): boolean {
    return (this.runCounts.get(runId) ?? 0) > (this.runAnchorCounts.get(runId) ?? 0);
  }

  /** 环里**最新**那条 run（末条条目的 run）：它的锚点一律不裁（见 `trimEntries` 口径 2）。 */
  private newestRunId(): string | undefined {
    return this.entries[this.entries.length - 1]?.event.run_id;
  }

  /**
   * 从环头往后找最旧的可裁条目下标（最多扫 `limit` 步）；`-1` = 这几步里没有可裁的。
   *
   * 「可以裁」= 非锚点，或锚点但不受保护（该 run 在环里没有内容 / 不是最新那条 run）。
   * 复杂度：一个 run 的锚点紧挨着它自己的内容，所以通常第一步就命中；同一个 run 的锚点
   * 数量被每 run 上限夹住，扫描被 `limit` 再夹一道（超了走 `dropOldestRunGroup`）。
   */
  private oldestEvictableTotalIndex(limit: number): number {
    const newestRunId = this.newestRunId();
    const end = Math.min(this.entries.length, limit);
    for (let index = 0; index < end; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined) continue;
      if (!RUN_ANCHOR_EVENT_TYPES.has(entry.event.type)) return index;
      const runId = entry.event.run_id;
      if (runId === newestRunId) continue;
      if (!this.runHasContent(runId)) return index;
    }
    return -1;
  }

  /**
   * 把「最老的那一组 run」整个从环里删掉（总量裁剪走到「环头全是受保护锚点」时的出口）。
   *
   * 为什么整组删：环头这一段都是同一个 run 的锚点（`user.message` 密集的病态流），逐条跳
   * 太贵（`oldestEvictableTotalIndex` 的 `limit` 就是为了不在这上面退化），而这个 run 的
   * 内容本来也快被裁光了。**绝不动最新那条 run**：它的终态没有人能救（没有后继 run 顶它、
   * 台账也可能是空的），口径见 `trimEntries` 的第 2 条。
   *
   * 返回删掉的条数（0 = 环里只剩最新那条 run 了 ⇒ 宁可超上限也不删）。
   */
  private dropOldestRunGroup(limit: number): number {
    const newestRunId = this.newestRunId();
    const end = Math.min(this.entries.length, limit);
    let runId: string | undefined;
    for (let index = 0; index < end; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined) continue;
      if (entry.event.run_id === newestRunId) continue;
      runId = entry.event.run_id;
      break;
    }
    if (runId === undefined) return 0;
    const kept: StoredEvent[] = [];
    let dropped = 0;
    for (const entry of this.entries) {
      if (entry.event.run_id === runId) {
        dropped += 1;
        continue;
      }
      kept.push(entry);
    }
    if (dropped === 0) return 0;
    this.entries = kept;
    this.runCounts.delete(runId);
    this.runAnchorCounts.delete(runId);
    return dropped;
  }

  /**
   * 删除某个会话的全部事件（rewind 后这些历史已不存在）。
   *
   * 归属判定：事件顶层 / `data.session_id` 等于目标会话的 run 记为目标的 run；该 run
   * 中未带 session_id 的条目一并删除。先按 session 判定而不是直接按 run_id，
   * 避免 `session.rewound` 共用 `run_id: 'manual'` 时误删其它会话的条目。
   * 删除后重建 run 计数，并把「语义删除」转发给物化面：rewind 之后历史真的不存在了，
   * item 必须跟着删（这与缓冲裁剪不同 —— 裁剪删的是传输窗口，不影响 item，I4/I6）。
   * 立即发布快照。返回删除的条目数。
   */
  dropSession(sessionId: string): number {
    const runIds = new Set<string>();
    for (const entry of this.entries) {
      if (this.ownerOf(entry) === sessionId) runIds.add(entry.event.run_id);
    }
    // 语义删除首先转给物化面：即使该 run 的条目已经被环裁光（`runIds` 为空），
    // item 侧仍可能留着它的卡片 —— 按 `sessionId` 兜住那种情况。
    this.sink.dropSession(sessionId, [...runIds]);
    if (runIds.size === 0) {
      // 条目侧没有删除动作，但 item 侧可能刚被删：把变化立刻发出去。
      this.sink.flush();
      return 0;
    }

    const before = this.entries.length;
    const removedRunIds = new Set<string>();
    this.entries = this.entries.filter((entry) => {
      const owner = this.ownerOf(entry);
      const remove = owner === sessionId || (owner === undefined && runIds.has(entry.event.run_id));
      if (remove) removedRunIds.add(entry.event.run_id);
      return !remove;
    });
    const removed = before - this.entries.length;
    if (removed === 0) {
      this.sink.flush();
      return 0;
    }

    this.rebuildCounts();
    for (const runId of removedRunIds) {
      // 已没有条目的 run 不再需要 run→session 映射（留着会让新事件串到旧归属）。
      if (!this.runCounts.has(runId)) this.runSessions.delete(runId);
    }
    this.flush();
    return removed;
  }

  /**
   * 截断到 `nextSeq`：**保留** `seq <= nextSeq` 的条目，丢弃更新的，并把单游标设成它。
   *
   * 三个调用点各有明确语义：① 区间并入时区间起点早于游标（重拉这一段）；
   * ② 服务端 `gap` 帧（旧协议还没删，只能如实转成缺口声明）；③ `nextSeq === 0` 的
   * **纪元重置**（服务端重启后 seq 从 1 重新编号，item 的 seq 身份与新事件不可比，必须
   * 整体作废重来，否则水位会把新事件全部当重放丢掉、时间线从此定格）。
   *
   * 只在**同一订阅作用域内**调用；作用域真的变了（换会话 / 换 Team / chat→Runs）
   * 必须用 `clear()`，否则旧范围的条目会留在屏上串台。
   *
   * **这是传输面操作，不动 item**（I6）：回放靠游标去重 + 物化面的水位幂等，所以这里
   * 既不需要、也**不许**触发整表重算（唯一的例外是纪元重置：那时 item 必须一起作废）。
   */
  truncateAfter(nextSeq: number): number {
    // 纪元重置：item 与新 seq 不可比，整体作废（`sink.reset()` 清空屏上 item）。
    if (nextSeq === 0) this.sink.reset();
    // 左缘跟着退：截断之后 `(nextSeq, 左缘)` 这一段不再「已加载」，滚动加载要从那里重来
    // （`nextSeq === 0` = 什么都还没加载，左缘归零，首屏回填会重新落位）。
    if (this.earliestSeq > nextSeq + 1) this.earliestSeq = nextSeq === 0 ? 0 : nextSeq + 1;
    // entries 按 seq 升序：二分出第一条 seq > nextSeq。
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.entries[mid]?.seq ?? 0) <= nextSeq) low = mid + 1;
      else high = mid;
    }
    const dropped = this.entries.slice(low);
    this.clientTimelineSeq = nextSeq;
    if (dropped.length === 0) {
      // 只推进了游标（没有尾部要丢）：仍然发布一次，保证快照里的 lastSeq 与内部一致。
      this.flush();
      return 0;
    }

    this.entries = this.entries.slice(0, low);
    this.rebuildCounts();
    this.runSessions.clear();
    for (const entry of this.entries) {
      const runId = entry.event.run_id;
      const owner = entry.sessionId ?? eventSessionId(entry.event);
      if (owner !== undefined) this.runSessions.set(runId, owner);
    }
    for (const entry of dropped) {
      const runId = entry.event.run_id;
      // 整个 run 的条目都没了：忘掉它的 run→session 映射。
      if (!this.runCounts.has(runId)) this.runSessions.delete(runId);
    }
    this.flush();
    return dropped.length;
  }

  /**
   * 把渲染侧的可见性口径交给物化面。
   *
   * `isVisibleForGrouping` 决定「哪些事件参与段边界」，所以它必须参与**折叠**而不是渲染时
   * 过滤；口径变化时只能按环里的全部事件重折叠（这是唯一合法的整表重算，人工、低频）。
   * 环里已经取不到的那一段会跟着丢（既有缺陷，见 DESIGN.md §5.4）。
   */
  setItemVisibility(showInternal: boolean, errorLevel: ErrorVisibility): void {
    this.sink.setVisibility(showInternal, errorLevel, this.entries);
  }

  /**
   * 按环里已有的事件**整表重折叠**一遍（`sink.resume`，Rule R 的保留口径）。
   *
   * 唯一合法的整表重算之一（另一个是可见性口径变化）：区间并入时由
   * `applyTimelineRange` 自己调，外部只在对账 / 探针里用。
   */
  refold(): void {
    this.sink.resume(this.entries);
  }

  /**
   * 真清空缓冲（换节点 / 断开连接 / 订阅作用域变化 / gateway 重启）。
   *
   * **不变量**：`scopeSession` 不随 clear 变化 —— 作用域由 `setScopeSession()` 负责，
   * 清空只处理条目。`runSessions`（run→session 自报映射）清空：它只是当前缓冲窗口的
   * 派生数据，重新回放/接收时重建；作用域不依赖它。
   * 单游标一并归零（新作用域的 seq 与旧范围不可比），缺口声明也一并收起。
   */
  clear(nextSeq = 0): void {
    this.entries = [];
    this.runAnchorCounts.clear();
    this.runCounts.clear();
    this.runSessions.clear();
    this.clientTimelineSeq = nextSeq;
    this.gap = emptyGapState();
    // 左缘归零：新作用域的窗口要从首屏的尾部窗口重新开始（见 `earliestSeq`）。
    this.earliestSeq = 0;
    // 两个 seq 面的隔离状态属于**上一个**空间：新作用域从干净状态开始。
    this.suppressLegacyFrames = false;
    this.seqFloor = 0;
    // 作用域真变了：传输窗口清了，物化面必须一起清（否则串台 / 幽灵卡片）。
    this.sink.clear();
    // 在途 epoch 的声明属于**上一个** seq 空间：留着会让新作用域的帧被记进旧区间、
    // 结趟时报一条凭空缺口（0.55 删掉空闲定时器后这里必须显式收掉，不能靠「等它自己停」）。
    this.epoch = undefined;
    this.version += 1;
    this.snapshot = {
      entries: [],
      lastSeq: nextSeq,
      hasEarlier: false,
      version: this.version,
    };
    this.cancelTimer();
    this.notify();
  }

  /** 立即发布待处理事件（测试与路由切换前使用）。 */
  flush(): void {
    this.cancelTimer();
    // 物化面同一节拍发布（它自己判脏）：两条快照的版本号不必一致，但节拍必须一致，
    // 否则「运行详情」与「时间线」会各走一半。
    this.sink.flush();
    this.version += 1;
    this.snapshot = {
      // 复制数组：entries 在 push 中原地追加，复用引用会让 memo 消费者永远看到旧视图。
      entries: [...this.entries],
      lastSeq: this.clientTimelineSeq,
      // 滚动触发器读它（更早的段加载完 / 到 1 了 ⇒ 停止继续要）。
      hasEarlier: this.hasEarlier,
      version: this.version,
    };
    // 快照是整体替换的：没有「增量字段」需要在消费后清空（旧的 truncatedSince 已删）。
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
   * 该 run 最旧的**可裁剪**条目下标（锚点永不裁；整个 run 只剩锚点时退回最旧一条）。
   *
   * 旧实现分两档（先丢「时间线上不产产物」的条目、再丢内容条目）。那两档现在没有意义：
   * 唯一不产产物的大户（`tool_call_delta` / `finish`）在 `push()` 里根本不进环，
   * 剩下的条目在 fold 里都有产物 —— 而**裁剪已经不影响渲染**（I4），口径统一成
   * 「该 run 最旧的非锚点条目」。
   *
   * 没有任何条目时返回 -1。
   */
  private oldestEvictableIndex(runId: string): number {
    let oldestAny = -1;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.event.run_id !== runId) continue;
      if (oldestAny < 0) oldestAny = index;
      if (RUN_ANCHOR_EVENT_TYPES.has(entry.event.type)) continue;
      return index;
    }
    return oldestAny;
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
