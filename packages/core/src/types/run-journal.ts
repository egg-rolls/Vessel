/**
 * Run 写端口类型（Stage 4，ADR-098 C1）。
 *
 * 放在 types/ 以满足依赖方向：`types/**` 不得 import runtime 实现；
 * 默认实现见 `runtime/run-journal.ts`。
 *
 * @module @vessel-agent/core/types
 */

import type { EventStream, RunEvent, SessionEventReadPort } from './event.js';
import type { LeaseKind } from './lease.js';
import type { Logger } from './logging.js';
import type { ProjectionCachePort } from './projection-cache.js';
import type { RunRecord, RunRecordStore } from './run-record-store.js';
import type { ResumeMarkerRegistry, SessionState, SessionStore } from './session.js';

/** 一次 Run 的 journal（begin） */
export interface RunJournalIdentity {
  runId: string;
  sessionId: string;
  /** 该 EU 的观察流；journal 在 append 成功后向它发布（per-EU，不共享） */
  events: EventStream;
  agentId?: string;
  branch?: string;
  /** 当前 SessionLease 的 fencing token（append / checkpoint 校验用） */
  fencingToken?: number;
}

/** 无 Run 的受控写（`/compact`、插件生命周期） */
export interface RunJournalTransientIdentity {
  runId: 'manual' | 'plugin';
  /** 该 EU 的观察流；per-EU */
  events: EventStream;
  sessionId?: string;
  fencingToken?: number;
}

/**
 * Run 写端口。type-only 从 core 根入口导出；Assembly 构造工厂。
 */
export interface RunJournal {
  /** 发布事实/观测事件：先落盘（非持久事件直接发布），成功后发布。 */
  appendFact(event: RunEvent, persistData?: unknown): void;
  /** 观察外部已发布的事件：只补落盘，不二次发布（避免回环）。 */
  appendObserved(event: RunEvent): void;
  /** 等待所有已入队事件落盘并发布 */
  flush(): Promise<void>;
  /** 写 RunRecord；`bestEffort` 用于失败路径的终态写入。 */
  saveCheckpoint(record: RunRecord, opts?: { bestEffort?: boolean }): Promise<void>;
  /** 写 SessionState 投影（含 derived_upto_seq） */
  saveSessionState(state: SessionState): Promise<void>;
  /** 当前会话已落盘的事件游标 */
  currentSeq(sessionId: string): Promise<number | undefined>;
  /** flush 并结束本 journal（幂等） */
  close(): Promise<void>;
}

/** 按 tenant 构造的 journal 工厂 */
export interface RunJournalFactory {
  begin(identity: RunJournalIdentity): RunJournal;
  transient(identity: RunJournalTransientIdentity): RunJournal;
  /**
   * 0.56 send-first：投影续算快照端口（缺省 = 不持久化）。
   *
   * 由装配层在构造工厂时注入，`ExecutionUnit` 只读它。**不是** RunJournal 的方法：
   * 快照不属于「一次 run」的写集合（它是读侧的恢复缓存），挂在这里只是因为它同样是
   * 「写能力」，而工厂是 EU 唯一拿得到的写能力入口。
   */
  readonly projectionCache?: ProjectionCachePort;
}

/**
 * 一条交给 timeline 写者的会话事实（0.54 A）。
 *
 * 形状与 `SessionEventInput` 对齐（同样的 `run_id` / `type` / `ts` / `data`），
 * 但**没有 `session_id`**：会话是 `record()` 的第一个实参，避免同一个值出现两次。
 *
 * 0.54 stop-write：没有 `persisted` 这个字段了。它以前表示「旧链路（`events.ndjson`）
 * 是否已经落盘」，用来让旁路只补 chunk 家族；旧链路停写之后这个问题不存在 ——
 * 时间线是**唯一**落盘口，「什么不该落盘」由 `timeline/types.ts#isExcludedEventType`
 * 一处回答。
 */
export interface TimelineDualWriteEvent {
  run_id: string;
  type: string;
  ts: number;
  data?: unknown;
  fencing_token?: number;
}

/**
 * 0.54 A：timeline 写者端口（ADR-105 §11 / plan-054 A4）。
 *
 * 三条硬约束（写在类型上，实现必须自证）：
 * 1. **不装 = 一次都不调**：`undefined` 时 journal 连这个对象都不看；
 * 2. **实现永不抛**：`record()` / `endRun()` 都是 fire-and-forget，返回 void；
 *    新链路任何失败只记指标/日志，绝不影响 run；
 * 3. **不改发布顺序**：journal 在「已发布之后」才调 `record()`，可见性由写者 fsync 之后的
 *    发布点与发送闸门决定（ADR-105 §3 I2）。
 */
export interface TimelineDualWritePort {
  /** 一条会话事实（fire-and-forget；实现必须自己吞掉所有异常）。 */
  record(sessionId: string, event: TimelineDualWriteEvent): void;
  /** Run 结束（journal.close）：flush 该会话的 writer + 抽样校验。尽力而为，永不抛。 */
  endRun?(sessionId: string, runId: string): void;
  /**
   * 等到该会话已派发的事件真正落盘（journal.flush 用）。
   *
   * 与 `record()` 不同，这里**允许**抛：调用方（journal）自己兜住并降级
   * （旧格式会话抛 `legacy_session_unsupported`，那不是故障）。
   */
  flushSession?(sessionId: string): Promise<void>;
}

/** 默认实现的构造依赖：装配层按 tenant 持有 */
export interface RunJournalFactoryOptions {
  /**
   * 会话事件**读口**（只读子集）。
   *
   * 0.54 stop-write：journal 不再 `append` 到它（它类型上也没有 `append`）；这里只用于
   * 读「已落盘到哪」（`lastSeq`，写 RunRecord 的 `event_cursor` 与会话壳的
   * `derived_upto_seq` 都要它）。
   */
  eventLog?: SessionEventReadPort;
  session?: SessionStore;
  runStore?: RunRecordStore;
  /** ADR-098 C2：fencing 校验回调（不持 LeaseService） */
  fenceOf?: (kind: LeaseKind, key: string) => Promise<number>;
  logger?: Logger;
  /**
   * 0.52 S1a：进程退出时「武装」的续跑标记。
   *
   * 装了就由 journal 在**每一次** saveSessionState() 里合并回 state：settle 期间
   * 终态保存会用自己那份投影重建会话状态，可能把 drain 先写下的标记覆盖掉。
   * 不装（旧装配 / 探针）⇒ 行为与 0.51 完全一致。
   */
  resumeMarkers?: ResumeMarkerRegistry;
  /**
   * 0.54：timeline 写者端口（`events.ndjson` 停写之后它是**唯一**落盘口）。
   *
   * 缺省 = 不装：一条事件都不落盘（只发布）。装上时写者失败不得影响 run
   * （实现侧自吞，见 {@link TimelineDualWritePort}）。
   */
  timelineDualWrite?: TimelineDualWritePort;
  /**
   * 0.56 send-first：投影续算快照的读写端口。
   *
   * 缺省 = 不持久化（行为与 0.55 完全一致：进程一重启就整份读）。装上之后
   * `ExecutionUnit.restoreProjection` 会「内存游标 → 落盘快照 → 整份读」三级回退，
   * 于是**重启后的第一条消息**不再付那次整份读。
   *
   * 为什么挂在 journal 工厂上而不是 EU 的 options：它是**写**能力（落盘），而 EU 的
   * 读路径只持只读的事件日志口（0.54 stop-write 的类型边界）。工厂是装配层唯一给出
   * 「写口」的地方，缓存跟着它走就不用再往 EU options 上加一条持久化参数。
   */
  projectionCache?: ProjectionCachePort;
}
