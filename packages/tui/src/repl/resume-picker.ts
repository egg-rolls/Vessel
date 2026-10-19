/**
 * /resume picker 的数据加载——永不 reject
 * @module @vessel/tui
 *
 * 成功返回按 updated_at 倒序的会话列表（listSessions 已排序）；
 * 失败转换为 formatRpcError 的展示文本，由 UI 决定如何呈现。
 */

import type { SessionInfo } from '@vessel/core';
import { listSessions } from '../commands/sessions-command.js';
import type { ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';

export type ResumePickerLoad =
  | { status: 'ready'; sessions: SessionInfo[] }
  | { status: 'error'; message: string };

export async function loadResumeSessions(ctx: ReplContext): Promise<ResumePickerLoad> {
  try {
    return { status: 'ready', sessions: await listSessions(ctx) };
  } catch (error) {
    return { status: 'error', message: formatRpcError(error) };
  }
}
