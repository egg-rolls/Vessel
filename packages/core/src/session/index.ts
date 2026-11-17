/**
 * @vessel-agent/core/session 模块
 * @module @vessel-agent/core/session
 */

export type { ProjectionCachePort, ProjectionCacheSnapshot } from '../types/projection-cache.js';
export { PROJECTION_CACHE_VERSION } from '../types/projection-cache.js';
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
  ResumeAfterRestart,
  ResumeMarkerRegistry,
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
  type SessionLogDirectoryPort,
} from './delete-session.js';
export { FileSessionStore, SessionCorruptError } from './file-backend.js';
export {
  assignMessageIdentities,
  injectedMessageIdOf,
  userMessageIdOf,
  withMessageId,
  withRunIdentity,
} from './message-identity.js';
export {
  createProjectionCursor,
  extendProjection,
  mergeHistoryProjection,
  PROJECTION_CURSOR_MAX_TOOL_CALLS,
  type ProjectableEvent,
  type ProjectionCursor,
  type ProjectMessagesOptions,
  projectedKeepCount,
  projectMessages,
  reconcileCachedProjection,
} from './project-messages.js';
export {
  cursorFromProjectionSnapshot,
  FileProjectionCache,
  PROJECTION_CACHE_MAX_BYTES,
  PROJECTION_CACHE_SUFFIX,
  serializeProjectionCursor,
} from './projection-cache.js';
export {
  type PruneRunsOptions,
  type PruneRunsResult,
  pruneRuns,
} from './prune.js';
export { FileRunRecordStore, MemoryRunRecordStore } from './run-record-store.js';
export type { SessionLogIndex } from './session-index.js';
export { removeLegacySessionTrace, sessionLogDirExists } from './session-log-dir.js';
export {
  compareSessionInfo,
  deriveSessionMeta,
  MemorySessionStore,
  normalizeResumeAfterRestart,
  toSessionInfo,
  withTitleSource,
} from './session-store.js';
export { SQLiteSessionStore } from './sqlite-backend.js';
