/**
 * @vessel/core/session 模块
 * @module @vessel/core/session
 */

export type { RunState, SessionBackend, SessionInfo } from '../types/session.js';
export {
  deriveSessionMeta,
  FileSessionBackend,
  MemorySessionBackend,
  toSessionInfo,
} from './session-backend.js';
