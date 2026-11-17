/**
 * 图片投递状态（additive `sessions.get` 的 `image_delivery`，0.56）的装配实现。
 *
 * ## 为什么从事件派生，而不是写进 `refs`
 *
 * `refs[]` 里加 `status` / `sent_at` 是双重的坏：① 前缀守卫逐条
 * `JSON.stringify(message)` 比字节 —— 改 status 就是改写历史前缀；② `messageSignature`
 * 只取 `kind:path`，**它根本看不见** `status`（既不进签名、又污染前缀，最坏的一类字段）。
 * 所以投递状态只有**事件**这一个真相源（`image.sent` / `context.image_dropped`），
 * 刷新 / 重启后从日志重新折叠即可（决策 3：P0 就显示，且刷新后仍然正确）。
 *
 * ## 折叠规则（**全量增量折叠**，不是尾窗回扫）
 *
 * 0.56 P1 修的是上一版的一个**假读数**：长会话里一张早就发出去的图，如果它的
 * `image.sent` 落在尾窗（首窗 64 KiB、最多 ≈5.3 MiB）之外，chip 会显示
 * 「未发送 · 没有投递记录」—— 显示错误比不显示更坏（正是隐私知情要防的反面）。
 *
 * 所以这里不用「尾窗猜」，改成**按 seq 从头折到尾、增量续折**：
 * 每个会话缓存 `{ coveredSeq, facts }`（进程内、只做缓存、不进 `refs`），
 * 首次查从 `sinceSeq = 0` 折到日志尾，之后每次只读 `seq > coveredSeq` 的增量
 *（`TimelineEventLog.read({ sinceSeq, limit })` 就是范围读，增量成本 O(新事件)）。
 * 记录按 seq 升序折叠 ⇒ 同一个 `sha8` **后写覆盖先写**（= 最近发生的那件事），于是
 * 「先发过、后来被压缩删掉」的图显示「已丢弃（压缩）」—— 那正是模型现在的视角。
 *
 * ## 「没有记录」与「不知道」是两件事（**不许猜**）
 *
 * 折叠**从 seq 1 开始**，所以「整份日志里没有这个 `sha8` 的事件」是**事实**：
 * 这次查询返回 `coverage: 'complete'`，缺席 = `not_sent / no_delivery_event`。
 * 一旦覆盖不全（旧格式会话整份读抛错、日志有洞、翻页预算用完），返回
 * `coverage: 'partial'`：缺席只能得出「无记录」（serve 映射成 `unknown`），
 * **绝不允许**把它说成「未发送」，更不许编一个「已发送」。
 *
 * 为什么选这条路而不是「按 sha8 建持久索引」：持久索引是第二份真相源，写入侧多一个
 * 落点、删除/迁移/多节点各自一份，还会在「索引里没有」时**无法区分**「没发过」与
 * 「索引没建全」—— 那正是这道题的病根。派生快照可随时重建，坏了只损失一次扫描，
 * 且没有第二份数据需要与人核对。代价是首次查询要整份读一遍该会话的事件（一次/进程/
 * 会话），换来的是「缺席即事实」。
 *
 * @module vessel/image-delivery
 */

import type { SessionEventRecord } from '../packages/core/src/index';

/** 一张图的投递事实（与 `packages/serve` 的 `ImageDeliveryView` 结构一致）。 */
export interface ImageDeliveryView {
  status: 'sent' | 'dropped' | 'not_sent';
  reason?: string;
  sha8?: string;
  tokens?: number;
  backend?: string;
  model?: string;
}

/** 折叠出的投递事实 + **覆盖度**（覆盖度决定「缺席」该怎么解释）。 */
export interface ImageDeliveryFacts {
  /** sha8 → 事实（最近一条事件为准） */
  facts: ReadonlyMap<string, ImageDeliveryView>;
  /**
   * `complete` = 从 seq 1 一路折到日志尾（缺席 = 从未发生）；
   * `partial` = 只覆盖了一段（旧格式会话 / 日志有洞 / 翻页预算用完）⇒ 缺席 = 「无记录」。
   */
  coverage: 'complete' | 'partial';
}

/** `sessions.get` 的 `imageDelivery` 端口（结构类型对齐 serve 的同名接口）。 */
export interface ImageDeliveryPort {
  lookup(sessionId: string): Promise<ImageDeliveryFacts | undefined>;
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * 折叠用的**读口**（结构类型对齐 `TimelineSessionLog`）。
 *
 * 三条各自不可替代：`read` 是**全量**事实源（也要它来做增量续折），`readTailMatches`
 * 是整份读不可用时的降级读（旧格式会话），`lastSeq` 用来判「会话是不是被删了重建」。
 */
export interface ImageDeliveryReadPort {
  read(
    sessionId: string,
    options?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]>;
  readTailMatches(
    sessionId: string,
    types: readonly string[],
    opts?: { limit?: number; maxBytes?: number },
  ): Promise<{ records: SessionEventRecord[] }>;
  lastSeq(sessionId: string): Promise<number | undefined>;
}

/** 折叠关心的两类事件（其余类型整条跳过，不解析）。 */
const DELIVERY_EVENT_TYPES: readonly string[] = ['image.sent', 'context.image_dropped'];

/** 一次回扫最多看这么多条匹配记录（降级读的预算，够覆盖「多轮贴图 + 压缩」）。 */
const TAIL_MATCH_LIMIT = 64;

/** 增量读的一页条数（范围读按块开窗；一页 512 条 ≈ 一屏历史）。 */
const FOLD_PAGE = 512;

/** 一页都没折完就停下来的上限（防日志自增把这一趟拖成死循环）。 */
const FOLD_MAX_PAGES = 400;

/** 记住多少个会话的折叠结果（防长期运行无界增长）。 */
const MAX_TRACKED_SESSIONS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** 一条事件 → 投递事实（形状不对返回 `undefined`，调用方按「没有记录」处理）。 */
function deliveryOfRecord(
  record: SessionEventRecord,
): { sha8: string; view: ImageDeliveryView } | undefined {
  const data = record.data;
  const sha8 = textField(data, 'sha8');
  if (sha8 === undefined) return undefined;
  if (record.type === 'image.sent') {
    const tokens = numberField(data, 'tokens');
    const backend = textField(data, 'backend');
    const model = textField(data, 'model');
    return {
      sha8,
      view: {
        status: 'sent',
        sha8,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(backend !== undefined ? { backend } : {}),
        ...(model !== undefined ? { model } : {}),
      },
    };
  }
  if (record.type === 'context.image_dropped') {
    const status = data !== null && isRecord(data) ? data.status : undefined;
    const reason = textField(data, 'reason');
    return {
      sha8,
      view: {
        status: status === 'not_sent' ? 'not_sent' : 'dropped',
        sha8,
        ...(reason !== undefined ? { reason } : {}),
      },
    };
  }
  return undefined;
}

export interface ImageDeliverySourceOptions {
  /** 事件**读口**（与 `contextUsage` / `systemContext` 同一个实例：时间线读口）。 */
  log: ImageDeliveryReadPort;
  /** 该会话的**尾水位**（缓存键：水位不变 ⇒ 派生结果不可能变）。 */
  watermark(sessionId: string): Promise<string | undefined>;
}

/** 一个会话的折叠进度：折到哪了 + 折出了什么（**派生缓存**，随时可丢）。 */
interface FoldEntry {
  /** 已经折进来的最大 seq（`0` = 一条还没折）。 */
  coveredSeq: number;
  facts: Map<string, ImageDeliveryView>;
}

/** 把一页记录折进 `entry`；返回这一页的 seq 是否连续（有洞 ⇒ 覆盖不全）。 */
function foldPage(entry: FoldEntry, page: readonly SessionEventRecord[]): boolean {
  let contiguous = true;
  for (const record of page) {
    if (record.seq > entry.coveredSeq + 1) contiguous = false;
    if (record.seq > entry.coveredSeq) entry.coveredSeq = record.seq;
    const parsed = deliveryOfRecord(record);
    if (parsed !== undefined) entry.facts.set(parsed.sha8, parsed.view);
  }
  return contiguous;
}

/**
 * 整份读不可用时的降级：尾窗回扫（**只报最近的那些**，覆盖度 `partial`）。
 *
 * 这里的第一条 = 最近发生的那件事（`records` 是新 → 旧）。
 */
async function tailFacts(
  log: ImageDeliveryReadPort,
  sessionId: string,
): Promise<Map<string, ImageDeliveryView>> {
  const out = new Map<string, ImageDeliveryView>();
  const { records } = await log.readTailMatches(sessionId, DELIVERY_EVENT_TYPES, {
    limit: TAIL_MATCH_LIMIT,
  });
  for (const record of records) {
    const parsed = deliveryOfRecord(record);
    if (parsed === undefined || out.has(parsed.sha8)) continue;
    out.set(parsed.sha8, parsed.view);
  }
  return out;
}

/**
 * 构造 `sessions.get.image_delivery` 的取值面。
 *
 * `lookup` 永远给出**覆盖度**：`complete` 时「缺席 = 从未发生」是事实；`partial` 时
 * 缺席只能算「无记录」（serve 映射成 `unknown`）。只有「读都读不了」（没有日志、
 * 两类事件一条也拿不到、降级读也抛错）才返回 `undefined` —— 那是「不知道」。
 */
export function createImageDeliverySource(options: ImageDeliverySourceOptions): ImageDeliveryPort {
  const { log } = options;
  /** session_id → 折叠进度（LRU：最近用过的放尾部）。 */
  const folds = new Map<string, FoldEntry>();

  const remember = (sessionId: string, entry: FoldEntry): void => {
    folds.delete(sessionId);
    folds.set(sessionId, entry);
    while (folds.size > MAX_TRACKED_SESSIONS) {
      const oldest = folds.keys().next().value;
      if (oldest === undefined) break;
      folds.delete(oldest);
    }
  };

  return {
    async lookup(sessionId: string): Promise<ImageDeliveryFacts | undefined> {
      let entry = folds.get(sessionId) ?? { coveredSeq: 0, facts: new Map() };
      let coverage: ImageDeliveryFacts['coverage'] = 'complete';
      try {
        // 会话被删了重建：seq 从 1 重新分配，缓存里的 `coveredSeq` 比日志尾还大 ⇒ 作废重折
        //（否则增量读永远返回空，chip 会拿着上一辈子的结论说话）。
        const tailSeq = await log.lastSeq(sessionId);
        if (tailSeq !== undefined && tailSeq < entry.coveredSeq) {
          entry = { coveredSeq: 0, facts: new Map() };
        }
        const foldInto = entry;
        for (let page = 0; page < FOLD_MAX_PAGES; page += 1) {
          const records = await log.read(sessionId, {
            sinceSeq: foldInto.coveredSeq,
            limit: FOLD_PAGE,
          });
          if (records.length === 0) break;
          if (!foldPage(foldInto, records)) coverage = 'partial';
          if (records.length < FOLD_PAGE) break;
          if (page === FOLD_MAX_PAGES - 1) coverage = 'partial';
        }
        // 折完之后没走到开头看到的日志尾 ⇒ 中间有洞（归档/块不一致），覆盖不完整。
        if (tailSeq !== undefined && foldInto.coveredSeq < tailSeq) coverage = 'partial';
      } catch {
        // 旧格式会话 / 读失败：退回尾窗。**覆盖度降到 partial** —— 尾窗之外缺席不代表没发过。
        coverage = 'partial';
        try {
          const recent = await tailFacts(log, sessionId);
          // 尾窗里的是**最近**发生的事：覆盖已折出的结论（同 key 后写生效）。
          for (const [sha8, view] of recent) entry.facts.set(sha8, view);
          remember(sessionId, entry);
          return { facts: entry.facts, coverage };
        } catch {
          folds.delete(sessionId);
          return undefined;
        }
      }
      remember(sessionId, entry);
      return { facts: entry.facts, coverage };
    },

    watermark(sessionId: string): Promise<string | undefined> {
      return options.watermark(sessionId);
    },
  };
}
