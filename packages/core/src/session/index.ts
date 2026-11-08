/**
 * @vessel-agent/core/session 模块
 * @module @vessel-agent/core/session
 */

export type {
  RunRecord,
  RunRecordStore,
  RunResumeCode,
  RunStatus,
  RunUsage,
} from '../types/run-record-store.js';
export { RunAlreadyRunningError, RunResumeError } from '../types/run-record-store.js';
export type {
  LegacyRunSnapshot,
  SessionInfo,
  SessionState,
  SessionStatus,
  SessionStore,
} from '../types/session.js';
export {
  AtomicWriteError,
  type AtomicWriteOptions,
  atomicWrite,
} from './atomic-write.js';
export {
  type DeleteSessionDataOptions,
  type DeleteSessionDataResult,
  deleteSessionData,
  SessionDeleteConflictError,
} from './delete-session.js';
export { FileSessionStore, SessionCorruptError } from './file-backend.js';
export {
  mergeHistoryProjection,
  type ProjectableEvent,
  projectedKeepCount,
  projectMessages,
} from './project-messages.js';
export {
  type PruneRunsOptions,
  type PruneRunsResult,
  pruneRuns,
} from './prune.js';
export { FileRunRecordStore, MemoryRunRecordStore } from './run-record-store.js';
export {
  type ReadSessionEventsOptions,
  removeLegacySessionTrace,
  SessionEventLog,
  type SessionEventLogOptions,
  type SessionLogIndex,
  sessionLogDirExists,
} from './session-event-log.js';
export {
  deriveSessionMeta,
  MemorySessionStore,
  toSessionInfo,
} from './session-store.js';
export { SQLiteSessionStore } from './sqlite-backend.js';
