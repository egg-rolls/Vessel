/**
 * 会话后端装配——把 config.session.backend 真正映射到 core 的三种后端。
 *
 * 0.5（DECISION-010 §11.7）：
 * - 缺省 backend = file；无 storagePath 时使用 tenant 的 sessions 目录；
 * - 显式 storagePath 优先；
 * - sqlite 且无 storagePath → legacy `.vessel/sessions.db`；
 * - memory 不变。
 */

import type { SessionConfig } from '../packages/config/src/index';
import {
  FileSessionBackend,
  MemorySessionBackend,
  type SessionBackend,
  SQLiteSessionBackend,
} from '../packages/core/src/index';

export const DEFAULT_SQLITE_PATH = '.vessel/sessions.db';
export const DEFAULT_FILE_DIR = '.vessel/sessions';

/** 会话后端选项 */
export interface SessionBackendOptions {
  /** tenant 的 sessions 目录（`<tenant>/sessions`） */
  tenantSessionsDir?: string;
}

/** 按配置选择会话后端；缺省 file（0.5） */
export function createSessionBackend(
  config?: SessionConfig,
  opts: SessionBackendOptions = {},
): SessionBackend {
  const backend = config?.backend ?? 'file';
  switch (backend) {
    case 'memory':
      return new MemorySessionBackend();
    case 'sqlite':
      return new SQLiteSessionBackend(config?.storagePath ?? DEFAULT_SQLITE_PATH);
    default:
      return new FileSessionBackend(
        config?.storagePath ?? opts.tenantSessionsDir ?? DEFAULT_FILE_DIR,
      );
  }
}
