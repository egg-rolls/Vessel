/**
 * RunJournal：一次 Run 的唯一持久化写者（Stage 4，ADR-098 C1）。
 *
 * EU 只持只读 EventLog；事实事件追加、RunRecord checkpoint、SessionState 投影
 * 全部经本模块。`ExecutionUnit` 只在 `activeJournal` / transient journal 上委托，
 * 不再直接调用 `eventLog.append` / `runStore.save` / `session.save`。
 *
 * @module @vessel-agent/core/runtime
 */

import type { RunEvent } from '../types/event.js';
import { LeaseExpiredError } from '../types/lease.js';
import type {
  RunJournal,
  RunJournalFactory,
  RunJournalFactoryOptions,
  RunJournalIdentity,
  RunJournalTransientIdentity,
} from '../types/run-journal.js';
import type { RunRecord } from '../types/run-record-store.js';
import type { SessionState } from '../types/session.js';

export type {
  RunJournal,
  RunJournalFactory,
  RunJournalFactoryOptions,
  RunJournalIdentity,
  RunJournalTransientIdentity,
} from '../types/run-journal.js';

/**
 * 0.18：不写会话事件日志的派生/观测事件。
 *
 * 唯一真相源只保留事实（用户输入、LLM 响应、工具调用、权限、终态）；
 * 流式增量、请求快照、消息镜像、checkpoint 进度与插件生命周期都可重建，
 * 落盘只会放大体积并制造第二份事实。
 */
const NON_PERSISTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'llm.stream.chunk',
  'llm.request',
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
    if (
      !this.deps.eventLog ||
      NON_PERSISTED_EVENT_TYPES.has(event.type) ||
      !this.shouldPersistSessionEvent(event)
    ) {
      this.publishRaw(event);
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
    const done = log
      .append({
        session_id: sessionId,
        run_id: event.run_id,
        type: event.type,
        ts: event.ts,
        data: persistData ?? event.data,
        ...(fencingToken !== undefined ? { fencing_token: fencingToken } : {}),
      })
      .then(
        () => {
          if (publish) this.publishRaw(event);
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
