/**
 * Run 写端口类型（Stage 4，ADR-098 C1）。
 *
 * 放在 types/ 以满足依赖方向：`types/**` 不得 import runtime 实现；
 * 默认实现见 `runtime/run-journal.ts`。
 *
 * @module @vessel-agent/core/types
 */

import type { EventStream, RunEvent, SessionEventLogPort } from './event.js';
import type { LeaseKind } from './lease.js';
import type { Logger } from './logging.js';
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
}

/**
 * 一条交给 timeline 双写的会话事实（0.54 A）。
 *
 * 形状与 `SessionEventInput` 对齐（同样的 `run_id` / `type` / `ts` / `data`），
 * 但**没有 `session_id`**：会话是 `record()` 的第一个实参，避免同一个值出现两次。
 */
export interface TimelineDualWriteEvent {
  run_id: string;
  type: string;
  ts: number;
  data?: unknown;
  fencing_token?: number;
  /**
   * 该事件是否已被旧链路落盘（`events.ndjson`）。
   *
   * `true` = 已落盘事件（双写就写它）；`false` = 旧链路**故意不落盘**的派生事件，
   * 其中 chunk 家族（`llm.stream.chunk` / `*.llm.stream.chunk`）是唯一**必须**在 timeline
   * 侧落盘的一类 —— 它进块级 WAL（`wal.blocks/`），不是「被丢弃」（0.54 A2）。
   * 旁路的取舍（只补 chunk 家族）由实现侧决定，journal 只如实转述，不在这里判断
   * 「什么值得写」。
   */
  persisted: boolean;
}

/**
 * 0.54 A：timeline 双写旁路端口（ADR-105 §11 / plan-054 A4）。
 *
 * 三条硬约束（写在类型上，实现必须自证）：
 * 1. **不装 = 一次都不调**：`undefined` 时 journal 连这个对象都不看 ⇒ 开关关时旧链路
 *    逐字节不变（不是「调了再丢弃」）；
 * 2. **实现永不抛**：`record()` / `endRun()` 都是 fire-and-forget，返回 void；
 *    新链路任何失败只记指标/日志，绝不影响旧链路返回；
 * 3. **不改旧链路顺序**：journal 在「已发布之后」才调 `record()`，因此旧链路的
 *    写入/发布时序一字不改。
 */
export interface TimelineDualWritePort {
  /** 一条会话事实（已落盘或显式旁路写）；实现必须自己吞掉所有异常。 */
  record(sessionId: string, event: TimelineDualWriteEvent): void;
  /** Run 结束（journal.close）：flush 该会话的 writer + 抽样校验。尽力而为，永不抛。 */
  endRun?(sessionId: string, runId: string): void;
}

/** 默认实现的构造依赖：装配层按 tenant 持有 */
export interface RunJournalFactoryOptions {
  eventLog?: SessionEventLogPort;
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
   * 0.54 A：timeline 双写旁路（ADR-105 §11）。
   *
   * 缺省 = 不装：旁路**一次都不调**，旧链路逐字节不变（开关关的那一侧）。
   * 装上时新链路失败不得影响旧链路（实现侧自吞，见 {@link TimelineDualWritePort}）。
   */
  timelineDualWrite?: TimelineDualWritePort;
}
