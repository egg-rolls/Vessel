/**
 * 会话目录的**两个小工具**（0.55：从已删除的 `session-event-log.ts` 里搬出来）。
 *
 * 它们与「事件怎么写」无关，只回答两件删除 / 清理路径要问的事：
 * 这个会话目录还在不在、有没有一版遗留的孤儿 run trace 要删。0.55 删掉
 * `events.ndjson` 的全部读写之后，这两个函数是那份文件里**唯一还有用**的东西，
 * 于是单独留一个模块，而不是留着整份旧日志实现只为这两行。
 *
 * @module @vessel-agent/core/session
 */

import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeSessionDirName, sessionDirPath } from '../tenant/index.js';

/** 删除旧的孤儿 run trace 文件（`<trace_dir>/<session_id>.jsonl`，0.5 删除语义遗留） */
export async function removeLegacySessionTrace(
  traceDir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await unlink(join(traceDir, `${encodeSessionDirName(sessionId)}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

/** 供调用方检查目录存在（不构造完整日志实例） */
export async function sessionLogDirExists(
  sessionsDir: string,
  sessionId: string,
): Promise<boolean> {
  try {
    return (await stat(sessionDirPath(sessionsDir, sessionId))).isDirectory();
  } catch {
    return false;
  }
}
