/**
 * 有界回放的预算分配：**结构优先 + 动态预算**（纯函数、无 IO、可被门禁 import）。
 *
 * ## 为什么不再是固定 1 MiB
 *
 * 旧实现（`gateway.ts#tailReplayWindow` + `REPLAY_BUDGET_BYTES = 1 MiB` /
 * `REPLAY_MAX_EVENTS = 2000`）从最新事件往回取到预算用完为止。`llm.response` 的正文
 * 不裁剪、`tool.call.*` 每条最多 8 KiB，一个长 run 的尾部就能吃掉全部预算：实测
 * （`docs/dev/reports/run-event-eviction/REPORT.md`）切进大输出 run 时回放只覆盖它最后
 * 18.5%–60.9% 的时长，巨型 run 只剩 5 条事件。`run.started` 一旦落在窗口外，客户端
 * `hasNewestRunStart()` 恒为 false（分组拿不到 sessionId → 整段 live run 消失）。
 *
 * ## 分档：结构（必留）/ 内容（只保尾部）
 *
 * 判据 = **重建骨架与终态是否必需**：
 *
 * - **结构**：`run.*` 生命周期（含终态）、`user.message` / 会话骨架
 *   （`session.*`）、工具调用三态（`tool.call.started|completed|failed`）、
 *   流式段骨架（`llm.stream.summary`，定长、不含正文）、人机交互与权限
 *   （`ask.user.*` / `tool.permission.*`）、压缩与上下文迁移（`message.*` /
 *   `context.compacted` / `context.cleared_tool_result`）、限额与护栏
 *   （`limit.blocked` / `guardrail.*`）、`llm.retry`、`error`。
 *   这些**要么是客户端分组的锚点，要么是终态/不可推导的状态迁移**，缺一条就会让
 *   时间线读到「半轮」。
 * - **内容**：`llm.stream.chunk`（逐 delta）、`llm.response`（正文全量、未裁剪）、
 *   `llm.request` / `context.changed`（线上是摘要，但仍按 payload 计），以及
 *   **所有未登记的类型**。未登记即内容是有意保守：新事件类型的体量未知，宁可让它
 *   只保尾部，也不要因为一条新类型把预算赌掉。
 *
 * 家族前缀（`subagent.` / `team.` / `plugin.` / `node.` / `replay.`）先剥掉再分类，
 * 这样 `subagent.llm.stream.chunk` 也是内容、`subagent.run.started` 也是结构
 * （与 `core/observability/trace-recorder.ts` 的前缀转发口径一致）。
 *
 * ## 地板（floor）：结构必留的实现方式
 *
 * `floorIndex` = 最新一个 `run.started` 的下标；整段窗口里没有时退到最新
 * `user.message`（客户端 `event-store.ts#isRunHeadEvent` 认这两个锚点）。区间
 * `[floorIndex, count)` —— 最新这一轮从起点到当前的**全部**事件（结构与正文都算）
 * —— 是必留地板。预算按地板字节数动态推导，所以地板永远装得下。
 *
 * **为什么地板是整段而不是「只装结构事件」**：窗口只能用**一个 gap** 描述「更早的
 * 那一段没发」（`skippedTo = firstKept.seq - 1`，见 `gateway.ts#tailReplayWindow`），
 * 所以保留下来的事件必须是源的一个**连续后缀**。在地板内部剔掉正文会留下无法上报的
 * 洞：客户端没有任何信号知道那是洞，只会静默地少几条事件。因此正文只在**地板之前**
 * 被整段跳过，不在地板内部被单独剔除 —— 内容永远挤不掉结构。
 *
 * ## 动态预算与硬上限
 *
 * - `budgetBytes = clamp(ceil(floorBytes × BUDGET_SAFETY_FACTOR), MIN, MAX)`
 * - `maxEvents  = clamp(ceil(floorEvents × EVENT_SAFETY_FACTOR), MIN_EVENTS, MAX_EVENTS)`
 *
 * 地板之外**从新到旧**继续装：`skippedTo` 语义、按 seq 升序、无重复、过滤在前
 * 全部不变（本模块只看过滤后的源）。
 *
 * 有界性：`MAX_BUDGET_BYTES` 是硬上限。唯一例外是**地板自己就超过 MAX**（一轮内就
 * 写了数 MB 工具结果 + 正文）：此时硬上限优先，退化成「有界连续后缀」（`floorTruncated
 * = true`），客户端靠既有的 `until_seq` 分页回填把地板找回来 —— 而不是让一次回放变成
 * 几十 MB 触发 WS 硬关闭 / 背压丢帧。极端情形的取舍见 `floorTruncated` 注释。
 *
 * @module @vessel-agent/serve/replay-budget
 */

/** 事件分档：结构 = 必留；内容 = 只保尾部。 */
export type ReplayEventTier = 'structure' | 'content';

/**
 * 结构事件（必留）：精确类型清单。
 *
 * 增删一条前先问「缺了它能不能重建这一轮的骨架 / 终态」；能，就是内容。
 */
export const STRUCTURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 运行生命周期（含终态）
  'run.started',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.checkpoint',
  'run.finalize.failed',
  // 用户输入与会话消息骨架
  'user.message',
  'message.injected',
  'message.compaction',
  'message.compacted',
  // 工具调用三态（结果正文已在入缓冲前裁到 8 KiB）
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  // 流式段的定长骨架（不含正文）
  'llm.stream.summary',
  'llm.retry',
  // 上下文迁移 / 压缩
  'context.compacted',
  'context.cleared_tool_result',
  // 限额 / 护栏 / 失败
  'limit.blocked',
  'guardrail.blocked',
  'guardrail.error',
  'error',
]);

/**
 * 结构事件（必留）：家族前缀。
 *
 * `ask.user.*` / `tool.permission.*` 是「等待人」的挂起状态，丢了客户端会一直显示
 * 加载；`session.*` 是会话骨架本身。
 */
export const STRUCTURE_EVENT_PREFIXES: readonly string[] = [
  'ask.user.',
  'tool.permission.',
  'session.',
];

/** 分类前先剥掉的家族前缀（子 agent / 团队 / 插件转发的是同构事件）。 */
export const EVENT_TYPE_FAMILIES: readonly string[] = [
  'subagent.',
  'team.',
  'plugin.',
  'node.',
  'replay.',
];

/** 地板锚点：最新一个起点事件决定「必留」从哪里开始。 */
export const FLOOR_ANCHOR_EVENT_TYPES: readonly string[] = ['run.started', 'user.message'];

/** 单次回放的字节预算下限（= 旧固定值：小会话回放逐字节等价）。 */
export const MIN_BUDGET_BYTES = 1024 * 1024;
/**
 * 单次回放的字节预算硬上限（8 MiB = `gateway.ts#MAX_BUFFERED_BYTES`）。
 *
 * 一次回放不允许超过 WS 缓冲的硬关闭阈值；慢客户端仍会在 4 MiB 背压高水位上丢帧，
 * 那是 gap + 回填该管的事，不是把预算无限放大能解决的。
 *
 * 0.53 从 4 MiB 抬到 8 MiB（与环 10000→50000 同批）：字节预算必须跟着环一起抬，
 * 否则「结构优先 + 尾部正文」的窗口对长跑仍然是几百条就咬合，环抬大了也白搭。
 * 代价是**单连接**单次回放的临时内存上限翻倍（不是常驻）：真正超长的历史交给
 * `sessions.events` 磁盘回填分页，不靠把这个上限一路顶上去。
 */
export const MAX_BUDGET_BYTES = 8 * 1024 * 1024;
/**
 * 预算安全系数：地板 × 1.5。
 *
 * - `> 1`：地板之外总能再装一点最新正文（用户切回来先看见内容，而不是只有骨架）；
 * - `< 2`：避免「每个连接都按 MAX 回放」——单 run 尾部接近 2.7 MiB 以上才会顶到上限。
 */
export const BUDGET_SAFETY_FACTOR = 1.5;
/** 条数预算下限（= 旧 `REPLAY_MAX_EVENTS`）：小事件很多的会话行为不变。 */
export const MIN_EVENTS = 2_000;
/**
 * 条数预算上限（= 环形缓冲默认容量 50000）。
 *
 * 取容量而不是更小的数：条数闸门只该是「自定义更大 maxHistory 时的安全网」，不能比
 * 字节预算先咬合（旧实现里 2000 条正是「巨型 run 只剩 5 条事件」的第二凶手）。
 *
 * 0.53 从 10000 抬到 50000（环同批放大）：两者是同一个窗口的两种计量，
 * 不同步抬就会出现「按条数先咬合」—— 涨容量却不涨预算等于没涨。
 * 常驻内存代价见 `event-buffer.ts#DEFAULT_MAX_HISTORY` 的注释。
 */
export const MAX_EVENTS = 50_000;
/** 条数预算的安全系数，与字节预算同口径。 */
export const EVENT_SAFETY_FACTOR = 1.5;

/** 预算参数（门禁可注入，生产用默认值）。 */
export interface ReplayBudgetTuning {
  minBudgetBytes: number;
  maxBudgetBytes: number;
  budgetSafetyFactor: number;
  minEvents: number;
  maxEvents: number;
  eventSafetyFactor: number;
}

/** 生产默认参数。 */
export const REPLAY_BUDGET_TUNING: ReplayBudgetTuning = {
  minBudgetBytes: MIN_BUDGET_BYTES,
  maxBudgetBytes: MAX_BUDGET_BYTES,
  budgetSafetyFactor: BUDGET_SAFETY_FACTOR,
  minEvents: MIN_EVENTS,
  maxEvents: MAX_EVENTS,
  eventSafetyFactor: EVENT_SAFETY_FACTOR,
};

/**
 * 分类：结构 / 内容。
 *
 * 先按精确清单，再按结构前缀，再剥家族前缀重试（最多 3 层）；都没命中 = 内容。
 */
export function replayEventTier(type: string): ReplayEventTier {
  let current = type;
  for (let depth = 0; depth < 3; depth += 1) {
    if (STRUCTURE_EVENT_TYPES.has(current)) return 'structure';
    for (const prefix of STRUCTURE_EVENT_PREFIXES) {
      if (current.startsWith(prefix)) return 'structure';
    }
    const family = EVENT_TYPE_FAMILIES.find((prefix) => current.startsWith(prefix));
    if (family === undefined) break;
    current = current.slice(family.length);
  }
  return 'content';
}

/** 该类型是否结构（必留）。 */
export function isStructureEvent(type: string): boolean {
  return replayEventTier(type) === 'structure';
}

/**
 * 待分配的事件源（按 seq **升序**、已过滤、无重复）。
 *
 * 调用方把「编码」做成惰性：`bytesAt` 只在真正需要预算时才序列化一条事件，避免为了
 * 找锚点而把整圈缓冲（可能数十 MB）全部编码一遍。
 */
export interface ReplayBudgetUnits {
  readonly count: number;
  /** 第 index 条事件的类型（O(1)，不编码）。 */
  typeAt(index: number): string;
  /** 第 index 条事件出站编码后的 UTF-8 字节数（可惰性计算 / 缓存）。 */
  bytesAt(index: number): number;
}

/** 合成行（门禁 / 探针用）：只要类型与字节数。 */
export interface ReplayBudgetRow {
  type: string;
  bytes: number;
}

/** 把合成行包装成 `ReplayBudgetUnits`。 */
export function replayBudgetUnitsOf(rows: readonly ReplayBudgetRow[]): ReplayBudgetUnits {
  return {
    count: rows.length,
    typeAt: (index) => rows[index]?.type ?? '',
    bytesAt: (index) => rows[index]?.bytes ?? 0,
  };
}

/** 一次预算分配的结果（同时是诊断面）。 */
export interface ReplayBudgetSelection {
  /** 保留区的起始下标（含）；`-1` = 窗口为空。 */
  startIndex: number;
  /** 保留条数 / 字节数（= 本次回放实际会发的量）。 */
  keptEvents: number;
  keptBytes: number;
  /** 本次采用的动态预算（诊断：为什么只发了这么多）。 */
  budgetBytes: number;
  /** 本次采用的条数闸门。 */
  maxEvents: number;
  /** 地板起点下标（锚点）；`-1` = 窗口里没有锚点事件。 */
  floorIndex: number;
  floorEvents: number;
  floorBytes: number;
  /**
   * `floorBytes` 只是下界（地板已超硬上限、扫描早停）。
   *
   * 早停是为了把编码量压在 `maxBudgetBytes` 量级：整圈缓冲都落在同一轮里时，
   * 精确统计意味着每次订阅都要重新序列化 10000 条事件。
   */
  floorBytesIsLowerBound: boolean;
  /** 被整段跳过的前缀（= 由 `skippedTo` 上报给客户端的那一段）。 */
  droppedEvents: number;
  /** 被跳过的前缀里的**结构**事件数：正常恒为 0，`> 0` 说明是极端情形。 */
  droppedStructureEvents: number;
  /** 保留区里最大的单条事件（诊断：「预算被哪一条吃掉了」）。 */
  largestEventIndex: number;
  largestEventBytes: number;
  /**
   * 地板自己超过 `maxBudgetBytes`，已退化为「有界连续后缀」。
   *
   * 取舍：硬上限优先。此时最新一轮的 `run.started` 可能落在窗口外 →
   * 客户端 `hasNewestRunStart()` 为 false → 走既有的 `until_seq` 分页回填。宁可让
   * 客户端多翻几页，也不要一次回放几十 MB 把 WS 顶到硬关闭（那会进「重连 → 再回放」
   * 的死循环，比缺一段更糟）。
   */
  floorTruncated: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** 空窗口结果。 */
function emptySelection(tuning: ReplayBudgetTuning): ReplayBudgetSelection {
  return {
    startIndex: -1,
    keptEvents: 0,
    keptBytes: 0,
    budgetBytes: tuning.minBudgetBytes,
    maxEvents: tuning.minEvents,
    floorIndex: -1,
    floorEvents: 0,
    floorBytes: 0,
    floorBytesIsLowerBound: false,
    droppedEvents: 0,
    droppedStructureEvents: 0,
    largestEventIndex: -1,
    largestEventBytes: 0,
    floorTruncated: false,
  };
}

/** 最新锚点（`run.started` 优先，其次 `user.message`）的下标；没有时 -1。 */
export function findFloorAnchorIndex(units: ReplayBudgetUnits): number {
  for (const anchorType of FLOOR_ANCHOR_EVENT_TYPES) {
    for (let index = units.count - 1; index >= 0; index -= 1) {
      if (units.typeAt(index) === anchorType) return index;
    }
  }
  return -1;
}

/**
 * 从最新往回取一个**有界的连续后缀**：不越过 `[firstIndex, count)`，不超预算。
 *
 * `floorIndex` / `floorBytes` / `floorEvents` 是已经付过账的地板（不会被这条路径
 * 丢弃，除非它自己就超 `maxBudgetBytes`）。
 */
function scanBackward(
  units: ReplayBudgetUnits,
  firstIndex: number,
  budgetBytes: number,
  maxEvents: number,
): {
  startIndex: number;
  keptEvents: number;
  keptBytes: number;
  largestIndex: number;
  largestBytes: number;
} {
  let startIndex = firstIndex;
  let keptEvents = 0;
  let keptBytes = 0;
  let largestIndex = -1;
  let largestBytes = 0;
  for (let index = firstIndex; index >= 0; index -= 1) {
    const size = units.bytesAt(index);
    // 至少留一条：单条超预算也照样发（否则窗口会空，客户端只能看到 gap）。
    if (keptEvents > 0 && (keptBytes + size > budgetBytes || keptEvents >= maxEvents)) break;
    keptBytes += size;
    keptEvents += 1;
    startIndex = index;
    if (size > largestBytes) {
      largestBytes = size;
      largestIndex = index;
    }
  }
  return { startIndex, keptEvents, keptBytes, largestIndex, largestBytes };
}

/** 数一数被跳过的前缀里有多少条结构事件（只看类型，不编码）。 */
function countStructureBelow(units: ReplayBudgetUnits, startIndex: number): number {
  let count = 0;
  for (let index = 0; index < startIndex; index += 1) {
    if (isStructureEvent(units.typeAt(index))) count += 1;
  }
  return count;
}

/**
 * 纯函数：给定**过滤后**的事件源，算出这次回放要发哪一段（连续后缀）以及诊断。
 *
 * 不变量（与旧 `tailReplayWindow` 完全一致，只是预算来源变了）：
 * - 结果按 seq 升序、无重复、是源的一个连续后缀；
 * - `skippedTo`（调用方用 `firstKept.seq - 1` 算出）描述被跳过的**整段**前缀；
 * - 至少留一条（单条超预算也发）。
 */
export function selectReplayBudgetWindow(
  units: ReplayBudgetUnits,
  tuning: ReplayBudgetTuning = REPLAY_BUDGET_TUNING,
): ReplayBudgetSelection {
  if (units.count <= 0) return emptySelection(tuning);
  const lastIndex = units.count - 1;
  const floorIndex = findFloorAnchorIndex(units);

  // 无锚点（窄订阅 / 环形缓冲已经把锚点挤掉）：与旧实现逐字节等价 —— 固定下限预算、
  // 尾部连续取。没有地板可推，动态放大也没有依据。
  if (floorIndex < 0) {
    const scan = scanBackward(units, lastIndex, tuning.minBudgetBytes, tuning.minEvents);
    return {
      startIndex: scan.startIndex,
      keptEvents: scan.keptEvents,
      keptBytes: scan.keptBytes,
      budgetBytes: tuning.minBudgetBytes,
      maxEvents: tuning.minEvents,
      floorIndex: -1,
      floorEvents: 0,
      floorBytes: 0,
      floorBytesIsLowerBound: false,
      droppedEvents: scan.startIndex,
      droppedStructureEvents: countStructureBelow(units, scan.startIndex),
      largestEventIndex: scan.largestIndex,
      largestEventBytes: scan.largestBytes,
      floorTruncated: false,
    };
  }

  let floorBytes = 0;
  let floorLargestIndex = -1;
  let floorLargestBytes = 0;
  // 超硬上限之后字节数只剩「至少多少」的意义：早停可以把编码量压到 `maxBudgetBytes`
  // 量级 —— 否则「整圈缓冲都在同一轮里」时每次订阅都要把 10000 条重编码一遍。
  let floorBytesIsLowerBound = false;
  for (let index = floorIndex; index <= lastIndex; index += 1) {
    if (floorBytes > tuning.maxBudgetBytes) {
      floorBytesIsLowerBound = true;
      break;
    }
    const size = units.bytesAt(index);
    floorBytes += size;
    if (size > floorLargestBytes) {
      floorLargestBytes = size;
      floorLargestIndex = index;
    }
  }
  const floorEvents = units.count - floorIndex;
  const maxEvents = clamp(
    Math.ceil(floorEvents * tuning.eventSafetyFactor),
    tuning.minEvents,
    tuning.maxEvents,
  );

  // 极端情形：地板自己就超硬上限 → 有界连续后缀（见 `floorTruncated` 注释）。
  if (floorBytes > tuning.maxBudgetBytes) {
    const scan = scanBackward(units, lastIndex, tuning.maxBudgetBytes, maxEvents);
    return {
      startIndex: scan.startIndex,
      keptEvents: scan.keptEvents,
      keptBytes: scan.keptBytes,
      budgetBytes: tuning.maxBudgetBytes,
      maxEvents,
      floorIndex,
      floorEvents,
      floorBytes,
      floorBytesIsLowerBound,
      droppedEvents: scan.startIndex,
      droppedStructureEvents: countStructureBelow(units, scan.startIndex),
      largestEventIndex: scan.largestIndex,
      largestEventBytes: scan.largestBytes,
      floorTruncated: true,
    };
  }

  const budgetBytes = clamp(
    Math.ceil(floorBytes * tuning.budgetSafetyFactor),
    tuning.minBudgetBytes,
    tuning.maxBudgetBytes,
  );
  // 地板一定装得下（`budgetBytes >= floorBytes`，因为 clamp 的下界不会低于地板，
  // 上界分支已被上面的 `floorBytes > max` 拦掉），所以这里从地板之前继续往旧装。
  let startIndex = floorIndex;
  let keptBytes = floorBytes;
  let keptEvents = floorEvents;
  let largestEventIndex = floorLargestIndex;
  let largestEventBytes = floorLargestBytes;
  for (let index = floorIndex - 1; index >= 0; index -= 1) {
    const size = units.bytesAt(index);
    if (keptBytes + size > budgetBytes || keptEvents >= maxEvents) break;
    keptBytes += size;
    keptEvents += 1;
    startIndex = index;
    if (size > largestEventBytes) {
      largestEventBytes = size;
      largestEventIndex = index;
    }
  }

  return {
    startIndex,
    keptEvents,
    keptBytes,
    budgetBytes,
    maxEvents,
    floorIndex,
    floorEvents,
    floorBytes,
    floorBytesIsLowerBound: false,
    droppedEvents: startIndex,
    droppedStructureEvents: countStructureBelow(units, startIndex),
    largestEventIndex,
    largestEventBytes,
    floorTruncated: false,
  };
}
