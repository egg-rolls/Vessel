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
import type { SessionState, SessionStore, ResumeMarkerRegistry } from './session.js';

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
}
