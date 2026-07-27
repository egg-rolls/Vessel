/**
 * @vessel/core/session 模块
 * @module @vessel/core/session
 */

export {
  MemorySessionBackend,
  FileSessionBackend,
  deriveSessionMeta,
  toSessionInfo,
} from './session-backend.js';
export type { RunState, SessionBackend, SessionInfo } from '../types/session.js';
