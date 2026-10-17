/**
 * 会话后端装配——把 config.session.backend 真正映射到 core 的三种后端。
 *
 * 默认 sqlite：与历史行为一致（`.vessel/sessions.db`），但声明不再说谎。
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

/** 按配置选择会话后端；缺省 sqlite */
export function createSessionBackend(config?: SessionConfig): SessionBackend {
  const backend = config?.backend ?? 'sqlite';
  switch (backend) {
    case 'memory':
      return new MemorySessionBackend();
    case 'file':
      return new FileSessionBackend(config?.storagePath ?? DEFAULT_FILE_DIR);
    default:
      return new SQLiteSessionBackend(config?.storagePath ?? DEFAULT_SQLITE_PATH);
  }
}
