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
// 0.54 A2：chunk 家族的判定**只有一个实现**（`timeline/types.ts`），journal 不再自己写一遍
// 集合。为什么必须共用：ADR-105 §8.1 规则 ④ 的白名单恰好两条（`llm.stream.chunk` 与
// `*.llm.stream.chunk`），抄一份就等于多一个会漂移的口径。
import { isChunkEventType } from '../timeline/types.js';
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
 * 不写会话事件日志的派生/观测事件（chunk 家族**不在**这里，见下）。
 *
 * 唯一真相源只保留事实（用户输入、LLM 响应、工具调用、权限、终态）。下面这些
 * 要么是流式/快照级的派生视图，要么自带另一份 durable 记录：
 *
 * - `context.changed`：派生快照（每条注入上下文的全量镜像），且叙事已由
 *   `context.pressure` / `context.compacted` 承担 —— 落盘等于同一事实两份；
 * - `run.checkpoint`：`RunRecord` 已有 durable checkpoint（含 `event_cursor`），
 *   日志里再写一遍是同一事实的第二份；
 * - `session.saved` / `session.deleted` / `session.log.failed`：进程内状态同步与
 *   写盘失败上报，落盘会递归；
 * - `plugin.*`：进程生命周期，不进会话叙事。
 *
 * `llm.request` **不在**本集合里：它落盘，但只落元信息（`content_omitted: true` +
 * 计数/配置），`messages` / `tools` 正文由 `stripRequestContent` 兜底裁掉。
 *
 * **chunk 家族（`llm.stream.chunk` / `*.llm.stream.chunk`）也不在本集合里**（0.54 A2）。
 * 以前它在，含义是「什么都不落盘」—— 于是刷新/重启后正文与思考永久丢失（ADR-105 §0 P5）。
 * 现在它的去处在 {@link SessionRunJournal.appendFact} 的 chunk 分支：
 *
 * - **不写** `events.ndjson`（一次长 run 上千条 delta，一条一行就是上千行、上千次 fsync）；
 * - **写** timeline 的**块级 WAL**（`wal.blocks/`，`[u64 seq][u32 len][utf8 JSON] × N`，
 *   满 32 KiB 或空闲 150 ms 封块，封块即 fsync）。
 *
 * 判定用 {@link isChunkEventType}（唯一实现），所以**带前缀的转发形态**也走块路径 ——
 * 以前只有精确的 `llm.stream.chunk` 在集合里，`subagent.llm.stream.chunk` 会掉进
 * `enqueuePersistedEvent` 被一行一条写进 `events.ndjson`（块级设计正好被绕过）。
 */
const NON_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.changed',
  'session.saved',
  'run.checkpoint',
  'session.deleted',
  'session.log.failed',
  'plugin.loaded',
  'plugin.failed',
  'plugin.init.failed',
  'plugin.dispose.failed',
]);

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

/** 默认 RunJournal：写 EventLog / RunRecord / SessionState，并在成功后发布。 */
export class SessionRunJournal implements RunJournal {
  private readonly pendingEventLogWrites = new Set<Promise<void>>();
  /** 每个 journal 只报告一次落盘失败，避免刷屏 */
  private eventLogFailureReported = false;

  constructor(
    private readonly deps: RunJournalFactoryOptions,
    private readonly identity: RunJournalIdentity | RunJournalTransientIdentity,
  ) {}

  appendFact(event: RunEvent, persistData?: unknown): void {
    const dualWrite = this.deps.timelineDualWrite;
    // 0.54 A2：chunk 家族**有它自己的落盘去处**，既不是「什么都不落」也不是「写 ndjson」。
    // 顺序与其它事件一致：先发布（旧链路的可见性一字不改），再把落盘交给块级 WAL。
    // 开关关（`dualWrite` 为 undefined）⇒ 只发布，`events.ndjson` 逐字节不变。
    if (isChunkEventType(event.type)) {
      this.publishRaw(event);
      if (dualWrite !== undefined) this.recordTimelineOnly(event, dualWrite);
      return;
    }
    if (
      !this.deps.eventLog ||
      NON_PERSISTED_EVENT_TYPES.has(event.type) ||
      !this.shouldPersistSessionEvent(event)
    ) {
      // 0.54 A：双写旁路（开关关 ⇒ `dualWrite` 是 undefined，这里连分支都不进）。
      this.publishRaw(event);
      if (dualWrite !== undefined) this.recordTimelineOnly(event, dualWrite);
      return;
    }
    this.enqueuePersistedEvent(event, true, persistData);
  }

  appendObserved(event: RunEvent): void {
    if (!this.deps.eventLog || !OBSERVED_PERSISTED_EVENT_TYPES.has(event.type)) return;
    if (!this.shouldPersistSessionEvent(event)) return;
    this.enqueuePersistedEvent(event, false);
  }

  async flush(): Promise<void> {
    while (this.pendingEventLogWrites.size > 0) {
      await Promise.allSettled([...this.pendingEventLogWrites]);
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

  /** 当前会话已落盘的事件游标（内存优先，否则读文件尾） */
  async currentSeq(sessionId: string): Promise<number | undefined> {
    const log = this.deps.eventLog;
    if (!log) return undefined;
    const inMemory = log.lastPersistedSeq(sessionId);
    if (inMemory !== undefined) return inMemory;
    try {
      return await log.lastSeq?.(sessionId);
    } catch {
      return undefined;
    }
  }

  /** 能否确定该事件属于某个 session（不能时就只发布、不落盘） */
  private shouldPersistSessionEvent(event: RunEvent): boolean {
    return this.resolveEventSessionId(event) !== undefined;
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
   * 0.54 A：把「旧链路（`events.ndjson`）不落盘」的事件转给 timeline 双写旁路。
   *
   * 两类事件走到这里，语义**不同**（`persisted: false` 如实表示「旧链路没有它」）：
   *
   * | 类别 | 例 | timeline 侧 |
   * | --- | --- | --- |
   * | chunk 家族 | `llm.stream.chunk` / `*.llm.stream.chunk` | 块级 WAL（`wal.blocks/`），**必落** |
   * | 其余派生/观测 | `context.changed` / `plugin.*` | 实现侧按白名单取舍 |
   *
   * 只转述、不判断值不值得写；异常一律吞掉 —— 旁路坏了不能影响 run。
   */
  private recordTimelineOnly(event: RunEvent, port: TimelineDualWritePort): void {
    try {
      const sessionId = this.resolveEventSessionId(event);
      if (sessionId === undefined) return;
      port.record(sessionId, {
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
        data: event.data,
        ...(this.identity.fencingToken !== undefined
          ? { fencing_token: this.identity.fencingToken }
          : {}),
        persisted: false,
      });
    } catch (error) {
      this.deps.logger?.warn('timeline dual-write dispatch failed', {
        run_id: event.run_id,
        type: event.type,
        error: errorText(error),
      });
    }
  }

  /**
   * 入队一次 append +（可选）发布。
   * 所有写入按调用顺序串行（日志内部按 session 排队），publish 在 append
   * 成功/失败后执行，因此对外可见顺序始终与 seq 顺序一致。
   */
  private enqueuePersistedEvent(event: RunEvent, publish: boolean, persistData?: unknown): void {
    const log = this.deps.eventLog;
    if (!log) return;
    const sessionId = this.resolveEventSessionId(event);
    if (sessionId === undefined) {
      if (publish) this.publishRaw(event);
      return;
    }

    // ADR-098 C2：随事件携带当前 SessionLease 的 fencing token（未持有则缺省）。
    const fencingToken = this.identity.fencingToken;
    // 落盘副本：producer 给的 persistData 优先；`llm.request` 再过一道正文兜底裁剪。
    const persistedData = persistData ?? event.data;
    const data = event.type === 'llm.request' ? stripRequestContent(persistedData) : persistedData;
    const done = log
      .append({
        session_id: sessionId,
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
        data,
        ...(fencingToken !== undefined ? { fencing_token: fencingToken } : {}),
      })
      .then(
        () => {
          if (publish) this.publishRaw(event);
          // 0.54 A：已落盘事件的双写旁路。放在发布**之后**：旧链路的可见顺序与
          // 失败处理完全不受影响；未装端口（开关关）时这里什么都不做。
          const dualWrite = this.deps.timelineDualWrite;
          if (dualWrite !== undefined) {
            try {
              dualWrite.record(sessionId, {
                run_id: event.run_id,
                type: event.type,
                ts: event.ts,
                data,
                ...(fencingToken !== undefined ? { fencing_token: fencingToken } : {}),
                persisted: true,
              });
            } catch (error) {
              this.deps.logger?.warn('timeline dual-write dispatch failed', {
                session_id: sessionId,
                run_id: event.run_id,
                type: event.type,
                error: errorText(error),
              });
            }
          }
        },
        (error: unknown) => {
          this.reportEventLogFailure(error, event, sessionId);
          if (publish) this.publishRaw(event);
        },
      );
    this.pendingEventLogWrites.add(done);
    void done.then(() => {
      this.pendingEventLogWrites.delete(done);
    });
  }

  /** 落盘失败必须可见：Logger（不落盘事件日志本身，避免递归） */
  private reportEventLogFailure(error: unknown, event: RunEvent, sessionId: string): void {
    this.deps.logger?.error('session event log write failed', {
      session_id: sessionId,
      run_id: event.run_id,
      type: event.type,
      error: errorText(error),
    });
    if (this.eventLogFailureReported) return;
    this.eventLogFailureReported = true;
    try {
      this.identity.events.publish({
        type: 'session.log.failed',
        run_id: event.run_id,
        data: {
          session_id: sessionId,
          run_id: event.run_id,
          event_type: event.type,
          error: errorText(error),
        },
        ts: Date.now(),
      });
    } catch {
      // 事件投递失败不得影响 run
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
