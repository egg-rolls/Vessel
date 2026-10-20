/**
 * `/status` —— 当前 run / session / provider / context / permissions / queue / instance
 * 的只读快照（0.14 P0）。首行带快照时间；不调用 RPC、不写配置。
 * @module @vessel-agent/tui
 */

import { t } from '../i18n/index.js';
import {
  buildStatusSnapshot,
  formatSnapshotTime,
  formatStatusSnapshot,
} from '../repl/status-snapshot.js';
import type { CommandEntry } from './commands.js';

export function statusCommand(): CommandEntry {
  return {
    name: 'status',
    description: t('command.status.description'),
    usage: '/status',
    category: 'inspect',
    keywords: ['status', 'run', 'session', 'provider', 'context', 'queue'],
    run: (_args, ctx, state) => {
      const snapshot = buildStatusSnapshot(ctx, state);
      return { handled: true, output: formatStatusSnapshot(snapshot) };
    },
  };
}

/** 导出给测试与后续 `/status --json` 复用 */
export { buildStatusSnapshot, formatSnapshotTime, formatStatusSnapshot };
