/**
 * 会话事件日志的读取面（additive `sessions.events` + `sessions.get.event_cursor`，0.53）的装配实现。
 *
 * ## 为什么需要它
 * 磁盘回填（`docs/specs/refresh-gap-design.md` §3 方案 B）：gateway 的内存环只能回放
 * 一个窗口，进程重启 / 离线超过一个窗口之后，前端 live 流断在哪里就只能来问磁盘。
 * `sessions.events` 是那条读路径；`sessions.get` 的 `event_cursor` 告诉前端「有没有洞、
 * 从哪儿开始补」。
 *
 * ## 与 SSE 回放同形
 * 返回的事件体 = 落盘记录的 `type` / `run_id` / `ts` / `data` 再加 `seq`，与 gateway 广播的
 * `{ seq, event }` 一一对应（`event-buffer` 的 `RunEvent` + 序号），前端按 `seq` 幂等合并：
 * 同一条事件从 live 流和回填两条路各来一次，只留一条。
 * 落盘记录里的 `v` / `fencing_token` / `session_id` 是对外无意义的写入内部字段
 * （`session_id` 就是入参），**不**透出。
 *
 * ## 失败 / 降级语义
 * 事件日志是 append-only NDJSON：崩溃会留下**半行**，轮换写者会留下**错序**行。
 * core 的 `read()` 已经做了：按尾窗定位起点、跳过坏行与别的 session 的记录、按 `seq`
 * 排序，并以一条可诊断 warn 计数。所以本模块**不重复校验、也不吞真错误**：
 * 坏行降级成「少几条 + 一条 warn」，只有真 IO 失败才向上抛（上层是 internal，不是静默空页）。
 *
 * ## 读数成本
 * 一页 = 一次（带 `types` 过滤时是少数几次）`read()`：游标是**排他**的，稳态
 * （`since_seq` 已追平）core 连流都不开，直接返回空。页大小由 `sessions.events` 的
 * `limit`（默认 100 / 硬顶 500）决定，不把整份日志一次读进内存。
 *
 * @module vessel/session-events
 */

import type { SessionEventRecord } from '../packages/core/src/index';

/**
 * `sessions.events` 的事件体：与 SSE 回放**同一个事件对象**（与
 * `packages/serve/src/gateway/methods/sessions.ts#SessionEventView` 同形）。
 */
export interface SessionEventView {
  seq: number;
  type: string;
  ts: number;
  run_id?: string;
  data?: unknown;
}

/** `index.json` 里本模块用到的两个数（结构类型，不绑定 core 的索引类）。 */
export interface SessionEventIndexLike {
  /** 已落盘事件条数；正常等于最后一个 `seq`。 */
  event_count: number;
  /** 元数据派生覆盖到的 `seq`。 */
  derived_upto_seq: number;
}

/**
 * 读事件日志的最小面（装配层传 tenant 的时间线读口 `TimelineEventLog`；探针传假的也行）。
 *
 * `read` 的 `sinceSeq` 是**排他**游标（只回 `seq > sinceSeq`）；不给 `limit` 就是读到尾。
 */
export interface SessionEventLogReader {
  read(
    sessionId: string,
    options?: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventRecord[]>;
  /** 日志最新 `seq`（文件尾定边界）；文件不存在/为空 = `undefined`。 */
  lastSeq(sessionId: string): Promise<number | undefined>;
  /** 读 `index.json`；索引缺失/损坏 = `null`。 */
  readIndex(sessionId: string): Promise<SessionEventIndexLike | null>;
}

export interface SessionEventsSourceOptions {
  /** 事件**读口**（与 `contextUsage` / `systemContext` 同一个实例：时间线读口）。 */
  log: SessionEventLogReader;
  /**
   * 该会话的**尾水位**（缓存键）。0.54 stop-write：装配层不再拼 `events.ndjson` 路径，
   * 水位口径归读口（时间线：`wal.log` 大小/mtime + 尾块名）。
   */
  watermark(sessionId: string): Promise<string | undefined>;
}

/**
 * serve 侧 `SessionEventsPort` 的实现（结构类型对齐，不依赖 serve 的模块）。
 *
 * - `read` / `lastSeq` / `cursor`：直通读口（排他游标语义原样保留）；
 * - `watermark`：只 `stat` 事件文件（`大小:mtime`），用来给 `event_cursor` 做按会话缓存 ——
 *   append-only 意味着「水位没变 ⇒ 读到的游标不会变」，所以稳态下 `sessions.get` 不会每次
 *   都去读 `index.json` + 日志尾。
 */
export interface SessionEventsSource {
  read(
    sessionId: string,
    options: { sinceSeq?: number; limit?: number },
  ): Promise<SessionEventView[]>;
  lastSeq(sessionId: string): Promise<number | undefined>;
  cursor(sessionId: string): Promise<{ derived_upto_seq: number; event_count: number } | undefined>;
  watermark(sessionId: string): Promise<string | undefined>;
}

/** 落盘记录 → 线上事件体：只挑对外有意义的字段，`data` 原样透传（不做 `as` 直转）。 */
function toEventView(record: SessionEventRecord): SessionEventView {
  return {
    seq: Math.floor(record.seq),
    type: record.type,
    ts: record.ts,
    ...(record.run_id !== undefined ? { run_id: record.run_id } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

/** 创建事件日志读取面（装配层在 tenant bundle 里创建一次、复用）。 */
export function createSessionEventsSource(
  options: SessionEventsSourceOptions,
): SessionEventsSource {
  return {
    async read(sessionId, readOptions) {
      // 坏行/半行由 core 跳过并计数（见模块头），这里既不复校验也不 catch：
      // 真正的 IO 失败应当让 RPC 报 internal，而不是假装「日志是空的」。
      const records = await options.log.read(sessionId, {
        ...(readOptions.sinceSeq !== undefined ? { sinceSeq: readOptions.sinceSeq } : {}),
        ...(readOptions.limit !== undefined ? { limit: readOptions.limit } : {}),
      });
      return records.map(toEventView);
    },

    lastSeq(sessionId) {
      return options.log.lastSeq(sessionId);
    },

    async cursor(sessionId) {
      const index = await options.log.readIndex(sessionId);
      if (!index) return undefined;
      return { derived_upto_seq: index.derived_upto_seq, event_count: index.event_count };
    },

    watermark(sessionId) {
      // 尾水位口径归读口（时间线：`wal.log` 大小/mtime + 尾块名）；`undefined` = 还没有
      // 任何事件 ⇒ `sessions.get` 不带 `event_cursor`（与旧行为一致）。
      return options.watermark(sessionId);
    },
  };
}

/**
 * 尾水位 / 读口的失败语义都在实现侧（`TimelineEventLog`）：读不到 = `undefined`，
 * 不在这里重复一遍 `ENOENT` 判定。
 */
