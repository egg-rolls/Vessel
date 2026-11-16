/**
 * RunJournal：一次 Run 的唯一持久化写者（Stage 4，ADR-098 C1）。
 *
 * EU 只持只读 EventLog；事实事件追加、RunRecord checkpoint、SessionState 投影
 * 全部经本模块。`ExecutionUnit` 只在 `activeJournal` / transient journal 上委托，
 * 不再直接调用 `eventLog.append` / `runStore.save` / `session.save`。
 *
 * @module @vessel-agent/core/runtime
 */

import { applyDeclaredProjection } from '../context/index.js';
import { assignMessageIdentities } from '../session/index.js';
// 0.54 chunk-slim：瞬时 chunk（`tool_call_delta` / `finish`）的判据同样**只有一个实现**，
// 与块路由放在一起（`timeline/blocks.ts`）—— 它回答的是「这个 chunk 配不配进块」。
import { isTransientChunkEvent } from '../timeline/blocks.js';
// 0.54 stop-write：「什么不算会话事实」只有一处判据（`timeline/types.ts`）。以前 journal 自己
// 有一份 `NON_PERSISTED_EVENT_TYPES`，与旁路侧的白名单漂一次就会多出一个谁也不知道的写入口。
import { isChunkEventType, isNonFactEventType } from '../timeline/types.js';
import type { RunEvent } from '../types/event.js';
import { LeaseExpiredError } from '../types/lease.js';
import type {
  RunJournal,
  RunJournalFactory,
  RunJournalFactoryOptions,
  RunJournalIdentity,
  RunJournalTransientIdentity,
  TimelineDualWritePort,
} from '../types/run-journal.js';
import type { RunRecord } from '../types/run-record-store.js';
import type { SessionState } from '../types/session.js';
import { applyArmedResumeMarker } from './resume-markers.js';

export type {
  RunJournal,
  RunJournalFactory,
  RunJournalFactoryOptions,
  RunJournalIdentity,
  RunJournalTransientIdentity,
  TimelineDualWriteEvent,
  TimelineDualWritePort,
} from '../types/run-journal.js';

/**
 * 由 harness / 插件直接发布到事件流、但必须落盘的交互事件。
 * runtime 在事件流上观察它们（本身不再二次发布，避免回环）。
 */
const OBSERVED_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool.permission.response',
  'ask.user.requested',
  'ask.user.answered',
]);

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 写盘侧裁剪（唯一口径）：`llm.request` 的落盘副本**永不带正文**。
 *
 * 只改日志副本：`publishRaw` 走的仍是调用方给的完整事件，所以 live 订阅、WS 广播
 * （另有 `summarizeBroadcastEvent`）与 trace（另有 `summarizeLlmRequestEvent`）拿到的
 * 内容与今天完全一致。正常路径上 producer 已经只传元信息（`persistData`），这里是
 * 兜底：任何调用方误传完整 payload，也写不进 `events.ndjson`。
 *
 * 摘要永不成为内容权威：重建 messages 的路径（`projectMessages` / resume）只读
 * `user.message` / `llm.response` / `tool.*`，读不到也不读这两类事件。
 */
function stripRequestContent(data: unknown): unknown {
  if (!isRecordValue(data)) return data;
  if (!('messages' in data) && !('tools' in data)) return data;
  const next = { ...data };
  delete next.messages;
  delete next.tools;
  next.content_omitted = true;
  return next;
}

/** 默认 RunJournal：写时间线 / RunRecord / SessionState，并在成功后发布。 */
export class SessionRunJournal implements RunJournal {
  constructor(
    private readonly deps: RunJournalFactoryOptions,
    private readonly identity: RunJournalIdentity | RunJournalTransientIdentity,
  ) {}

  appendFact(event: RunEvent, persistData?: unknown): void {
    const dualWrite = this.deps.timelineDualWrite;
    const sessionId = this.resolveEventSessionId(event);
    // 0.54 stop-write：`events.ndjson` 停写 ⇒ **落盘只剩一条路**（时间线写者）。于是顺序
    // 也只剩一种：先发布（可见性由「WAL fsync 之后才放行」的发送闸门决定，ADR-105 §3 I2），
    // 再把这条事实交给写者；写者失败由闸门 fail-open 放行，UI 一条都不会丢。
    //
    // 0.54 chunk-slim：**瞬时 chunk（`tool_call_delta` / `finish`）在这里就分叉**——
    // 发布照旧（实时通道不变），但**不派给写者**，于是它连 seq 都不会被请求。
    // 这一步就是「本单在哪一层决定不占 seq」的答案：**journal 的派发点**（`appendFact`），
    // 在所有 seq 分配之前；`writer.ts#validateInput` 是第二道闸门。
    this.publishRaw(event);
    if (dualWrite === undefined || sessionId === undefined) return;
    if (isChunkEventType(event.type)) {
      if (!isTransientChunkEvent(event)) this.dispatchToTimeline(sessionId, event, dualWrite);
      return;
    }
    // 「什么不该落盘」的判据只有一处（`timeline/types.ts#isNonFactEventType`）。
    if (isNonFactEventType(event.type)) return;
    this.dispatchToTimeline(sessionId, event, dualWrite, persistData);
  }

  appendObserved(event: RunEvent): void {
    // 观察外部已发布的事件：只补落盘，不二次发布（避免回环）。
    const dualWrite = this.deps.timelineDualWrite;
    if (dualWrite === undefined) return;
    if (!OBSERVED_PERSISTED_EVENT_TYPES.has(event.type)) return;
    if (isNonFactEventType(event.type)) return;
    const sessionId = this.resolveEventSessionId(event);
    if (sessionId === undefined) return;
    this.dispatchToTimeline(sessionId, event, dualWrite);
  }

  /**
   * 等到「已派出去的事实」真正落盘。
   *
   * 0.54 stop-write：写者自己排队 + fsync，journal 不再持有写入 Promise 链，所以这里
   * 委托写者的 drain（`flushSession`）。冻结会话会抛 `session_frozen_readonly` ——
   * 它不是故障（那个会话本就不该有 timeline），吞掉并记一条 debug 级日志。
   */
  async flush(): Promise<void> {
    const dualWrite = this.deps.timelineDualWrite;
    const sessionId = this.identity.sessionId;
    if (dualWrite?.flushSession === undefined || sessionId === undefined) return;
    try {
      await dualWrite.flushSession(sessionId);
    } catch (error) {
      this.deps.logger?.warn('timeline flush failed (session may be frozen/read-only)', {
        session_id: sessionId,
        error: errorText(error),
      });
    }
  }

  async close(): Promise<void> {
    await this.flush();
    // 0.54 A：run 结束（journal 关闭）通知双写旁路：flush 该会话 writer + 一致性抽样。
    // 未装端口（开关关）⇒ 不做任何事；抛错也只记日志（旁路坏了不影响 run 结果）。
    const dualWrite = this.deps.timelineDualWrite;
    if (dualWrite?.endRun === undefined) return;
    const sessionId = 'sessionId' in this.identity ? this.identity.sessionId : undefined;
    if (sessionId === undefined) return;
    try {
      dualWrite.endRun(sessionId, this.identity.runId);
    } catch (error) {
      this.deps.logger?.warn('timeline dual-write endRun failed', {
        session_id: sessionId,
        run_id: this.identity.runId,
        error: errorText(error),
      });
    }
  }

  async saveCheckpoint(record: RunRecord, opts?: { bestEffort?: boolean }): Promise<void> {
    if (!this.deps.runStore) return;

    // ADR-098 C2：旧 fencing token 不得写 RunRecord（与 SessionEventLog 同口径）。
    if (
      record.fencing_token !== undefined &&
      this.deps.fenceOf !== undefined &&
      record.fencing_token < (await this.deps.fenceOf('session', record.session_id))
    ) {
      if (opts?.bestEffort) return;
      throw new LeaseExpiredError('stale_fence', record.session_id);
    }

    if (this.deps.eventLog) await this.flush();
    const eventCursor = await this.currentSeq(record.session_id);
    if (eventCursor !== undefined) record.event_cursor = eventCursor;

    try {
      await this.deps.runStore.save(record);
    } catch (saveError) {
      if (opts?.bestEffort) return;
      throw new Error(`run_checkpoint_failed: ${errorText(saveError)}`);
    }

    this.publishRaw({
      type: 'run.checkpoint',
      run_id: record.run_id,
      data: {
        run_id: record.run_id,
        session_id: record.session_id,
        status: record.status,
        iteration: record.iteration,
        // 0.18 C2：RunRecord 不再写完整 messages；保持既有事件形状。
        message_count: 0,
      },
      ts: Date.now(),
    });
  }

  async saveSessionState(state: SessionState): Promise<void> {
    if (!this.deps.session) return;
    // 0.52 S1a：进程退出时武装的续跑标记跟着**每一次**状态保存一起落地。
    // 放在这里而不是让退出路径自己写：settle 期间被打断的 run 落终态会话状态时，
    // 用的是它自己那份（可能读于标记之前的）投影，会重建整份 state 把标记冲掉。
    applyArmedResumeMarker(state, this.deps.resumeMarkers);
    // 0.53 U1（ADR-104 §4.6）：会话级投射声明同样是「创建时一次写定」的 additive 字段，
    // 而执行单元重建 state 时不会带走它（本单元不允许改 execution-unit）。所以和续跑
    // 标记同一处理：**落盘前合并回去**。只补 context_projection，不读它去裁剪窗口
    // （0.53 U1 不改任何运行时行为），也不碰 context_projection_audit（U2 写入）。
    await applyDeclaredProjection(
      state,
      (sessionId) => this.deps.session?.load(sessionId) ?? Promise.resolve(null),
    );
    // 消息身份（additive）：`run_segment` 只在**落盘这一处**盖章 —— 本方法是 SessionState
    // 的唯一写口（初始保存 / checkpoint / 终态 / 手动压缩四路都经过它），一个口径、
    // 幂等（已盖过的不重写）。它必须发生在 save 之前：读侧（`sessions.get`）拿到的
    // 就是库里那一份，身份不在库里则刷新后依然没有身份可用。
    if (state.messages !== undefined) assignMessageIdentities(state.messages);
    if (this.deps.eventLog) {
      // 先等待已入队事件落盘，再记录缓存覆盖到的 seq；resume 只重放之后的增量。
      await this.flush();
      const cursor = await this.currentSeq(state.session_id);
      if (cursor !== undefined) state.derived_upto_seq = cursor;
    }
    await this.deps.session.save(state);
    this.publishRaw({
      type: 'session.saved',
      run_id: state.last_run_id ?? 'session',
      data: {
        run_id: state.last_run_id ?? 'session',
        session_id: state.session_id,
        status: state.status,
        message_count: state.messages?.length ?? 0,
      },
      ts: Date.now(),
    });
  }

  /**
   * 当前会话已落盘的事件游标。
   *
   * 0.54 stop-write：游标**只由磁盘事实决定**（时间线读口的 `lastSeq`：`wal.log` 尾行 +
   * 尾块最后一帧）。以前先问写者的内存 `lastPersistedSeq` —— 那是内存态的缓存，
   * 换进程就没了，且对读侧没有承诺力。
   */
  async currentSeq(sessionId: string): Promise<number | undefined> {
    const log = this.deps.eventLog;
    if (!log) return undefined;
    try {
      return await log.lastSeq?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** session_id 优先取 payload；否则用当前 Run 的 session 反查 */
  private resolveEventSessionId(event: RunEvent): string | undefined {
    const data = isRecordValue(event.data) ? event.data : undefined;
    const fromData = data !== undefined ? data.session_id : undefined;
    if (typeof fromData === 'string' && fromData.length > 0) return fromData;
    if (event.run_id === this.identity.runId && this.identity.sessionId !== undefined) {
      return this.identity.sessionId;
    }
    return undefined;
  }

  /**
   * 把一条会话事实交给时间线写者（0.54 stop-write 的**唯一**落盘出口）。
   *
   * 三个纪律，缺一条就会回到「两个写口」的老毛病：
   *
   * 1. **落盘副本的裁剪口径在这里定**：`persistData`（producer 给的元信息）优先，
   *    `llm.request` 再过一道 `stripRequestContent` 兜底 —— 发布出去的那一份仍带正文，
   *    只有落到磁盘的这一份被裁（与 0.54 之前逐字节一致）。
   * 2. **不判断值不值得写**：这里只转发，判据在 `timeline/types.ts`（不进 timeline 的
   *    类型由 `isNonFactEventType` 回答）与写者（瞬时 chunk 会被它拒绝）。
   * 3. **永不抛**：写者内部失败只记指标/日志，并通过发送闸门 fail-open 放行那条广播 ——
   *    落盘坏了不能反过来打断 run。
   */
  private dispatchToTimeline(
    sessionId: string,
    event: RunEvent,
    port: TimelineDualWritePort,
    persistData?: unknown,
  ): void {
    // ADR-098 C2：随事件携带当前 SessionLease 的 fencing token（未持有则缺省）。
    const fencingToken = this.identity.fencingToken;
    const persistedData = persistData ?? event.data;
    const data = event.type === 'llm.request' ? stripRequestContent(persistedData) : persistedData;
    try {
      port.record(sessionId, {
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
        data,
        ...(fencingToken !== undefined ? { fencing_token: fencingToken } : {}),
      });
    } catch (error) {
      this.deps.logger?.warn('timeline dispatch failed (event not persisted)', {
        session_id: sessionId,
        run_id: event.run_id,
        type: event.type,
        error: errorText(error),
      });
    }
  }

  /** 发布到内存事件流；订阅者异常不得从异步日志回调里冒泡成 unhandled rejection */
  private publishRaw(event: RunEvent): void {
    try {
      this.identity.events.publish(event);
    } catch (error) {
      this.deps.logger?.warn('event subscriber failed', {
        run_id: event.run_id,
        type: event.type,
        error: errorText(error),
      });
    }
  }
}

/** 默认工厂：依赖按 tenant 注入，journal 的 events 由每次 begin/transient 携带。 */
export class DefaultRunJournalFactory implements RunJournalFactory {
  constructor(private readonly deps: RunJournalFactoryOptions) {}

  begin(identity: RunJournalIdentity): RunJournal {
    return new SessionRunJournal(this.deps, identity);
  }

  transient(identity: RunJournalTransientIdentity): RunJournal {
    return new SessionRunJournal(this.deps, identity);
  }
}

/**
 * 装配缝：Assembly 按 tenant 构造 journal 工厂。
 * 只导出工厂函数，不导出实现类；RunJournal 仍是内部写端口。
 */
export function createRunJournalFactory(options: RunJournalFactoryOptions): RunJournalFactory {
  return new DefaultRunJournalFactory(options);
}
