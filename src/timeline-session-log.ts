/**
 * 会话事件的**唯一持久化端口**（0.54 stop-write 的接线）。
 *
 * ## 这个对象是什么
 *
 * 它把两件互不重叠的东西拼成 `SessionEventLogPort`：
 *
 * | 半边 | 实现 | 干什么 |
 * | --- | --- | --- |
 * | 读 | `TimelineEventLog`（core，**没有 `append`**） | `read` / `lastSeq` / `readTailMatches` / `readIndex` / `updateIndex` / `watermark` / `hasSession` / `deleteSession` |
 * | 写 | `TimelineDualWrite`（写者 + 闸门 + 归档） | `append` / `appendMany` / `sync` / `release` |
 *
 * 为什么还要这个「拼装层」：`session-liveness` / 通知注入 / ask 恢复 / 种子消息 /
 * 会话删除这几处**必须能写**（它们产出的是事实：停摆会话的终态、注入记录、种子的历史），
 * 而 EU 的读路径**必须不能写**。前者拿本对象（`SessionEventLogPort`），后者拿
 * `TimelineEventLog`（`SessionEventReadPort`）—— 权限差别在**类型**上，不靠自觉。
 *
 * ## 与旧 `SessionEventLog` 的三处语义差异（都是有意为之）
 *
 * 1. **`append` 不再 fsync `events.ndjson`**：它落到时间线 WAL（非 chunk 行一行一条，
 *    chunk 进块），`seq` 是 `timeline_seq`（会话内单调、唯一分配点在写者）。
 * 2. **`lastPersistedSeq` 恒 `undefined`**：那是旧写者的内存游标；时间线的游标只在磁盘上。
 *    调用方要「落盘到哪」一律走 `lastSeq()`（读口）。
 * 3. **`appendMany` 是写者的一次批量 append**（一次 write + 一次 fsync），语义与逐条
 *    `append` 相同：同一个 seq 序列、同样的行字节。
 *
 * 冻结会话（旧格式，`freeze.ts` 判据）：`append` 抛 `session_frozen_readonly`，读侧返回
 * 「空时间线」（那个会话本来就没有 timeline）。
 *
 * @module vessel/timeline-session-log
 */

import type {
  SessionEventInput,
  SessionEventLogPort,
  SessionEventRecord,
} from '../packages/core/src/index';
import type { TimelineEventLog } from '../packages/core/src/timeline/read-port';
import type { SessionEventTailReader } from './context-usage';
import type { SessionEventIndexLike } from './session-events';
import type { TimelineDualWrite } from './timeline-dual-write';

/** 读侧额外能力（`context_usage` / `system_context` / `session-events` / 删除路径要用）。 */
export interface TimelineSessionLog extends SessionEventLogPort, SessionEventTailReader {
  /**
   * 批量写（种子消息）：写者的一次 `appendMany`（一次 write + 一次 fsync）。
   *
   * 不在 `SessionEventLogPort` 上（那是 0.18 的最小面）；`AgentService` 用它做
   * 「结构上有没有」的探测，所以端口对象必须真的带这个方法。
   */
  appendMany(inputs: readonly SessionEventInput[]): Promise<SessionEventRecord[]>;
  /** `index.json`（元数据缓存）；缺失/损坏 = `null`。 */
  readIndex(sessionId: string): Promise<SessionEventIndexLike | null>;
  /** 尾水位（派生读的缓存键）；`undefined` = 该会话还没有任何事件。 */
  watermark(sessionId: string): Promise<string | undefined>;
  /** 会话目录是否存在（删除一致性检查）。 */
  hasSession(sessionId: string): Promise<boolean>;
  /** 删掉整个会话目录（先关写者句柄，Windows 必需）。 */
  deleteSession(sessionId: string): Promise<boolean>;
}

export interface TimelineSessionLogOptions {
  /** 读口（core `TimelineEventLog`，没有 `append`）。 */
  read: TimelineEventLog;
  /** 写者端口；缺省 ⇒ `append` 直接失败（只读执行面本来就不该写）。 */
  dualWrite?: TimelineDualWrite;
}

/** 造一个「时间线实现的 `SessionEventLog`」：读走读口、写走写者。 */
export function createTimelineSessionLog(options: TimelineSessionLogOptions): TimelineSessionLog {
  const { read, dualWrite } = options;
  const writer = (): TimelineDualWrite => {
    if (dualWrite === undefined) {
      throw new Error('timeline_write_unavailable: 这个执行面没有时间线写者');
    }
    return dualWrite;
  };

  return {
    // ── 写：唯一出口是时间线写者（journal 之外的直接写者用这三条） ──
    append(input: SessionEventInput): Promise<SessionEventRecord> {
      return writer().appendFact(input.session_id, {
        run_id: input.run_id,
        type: input.type,
        ts: input.ts,
        data: input.data,
        ...(input.fencing_token !== undefined ? { fencing_token: input.fencing_token } : {}),
        ...(input.durable !== undefined ? { durable: input.durable } : {}),
      });
    },

    appendMany(inputs: readonly SessionEventInput[]): Promise<SessionEventRecord[]> {
      const first = inputs[0];
      if (first === undefined) return Promise.resolve([]);
      return writer().appendFacts(
        first.session_id,
        inputs.map((input) => ({
          run_id: input.run_id,
          type: input.type,
          ts: input.ts,
          data: input.data,
          ...(input.fencing_token !== undefined ? { fencing_token: input.fencing_token } : {}),
          ...(input.durable !== undefined ? { durable: input.durable } : {}),
        })),
      );
    },

    /** 时间线写者每次 append 自己 fsync（chunk 封块时 fsync），没有「攒一批再刷」的口子。 */
    async sync(): Promise<void> {},

    /** 时间线写者按会话缓存、随 `closeAll` / `closeSession` 释放；这里没有单独释放动作。 */
    async release(): Promise<void> {},

    /** 旧写者的内存游标不存在（0.54 stop-write）：落盘到哪一律问 `lastSeq()`。 */
    lastPersistedSeq(): number | undefined {
      return undefined;
    },

    // ── 读：全部转发给读口 ──
    read: (sessionId, opts) => read.read(sessionId, opts),
    lastSeq: (sessionId) => read.lastSeq(sessionId),
    flush: (sessionId) => read.flush(sessionId),
    readTailMatches: (sessionId, types, opts) => read.readTailMatches(sessionId, types, opts),
    updateIndex: (sessionId, patch) => read.updateIndex(sessionId, patch),
    async readIndex(sessionId) {
      const index = await read.readIndex(sessionId);
      if (!index) return null;
      return { event_count: index.event_count, derived_upto_seq: index.derived_upto_seq };
    },
    watermark: (sessionId) => read.watermark(sessionId),
    hasSession: (sessionId) => read.hasSession(sessionId),

    async deleteSession(sessionId: string): Promise<boolean> {
      // 先关写者（Windows 上打开中的文件删不掉），再删目录。写者关失败不阻断删除：
      // 目录删了之后写者下一次 append 会自己失败（写者已标 closed）。
      await dualWrite?.closeSession(sessionId);
      return read.deleteSession(sessionId);
    },
  };
}
