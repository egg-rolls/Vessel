/**
 * 旧格式会话的**只读冻结**（ADR-105 D4；plan-054 §3.4「旧会话误写」/ §C-1）。
 *
 * ## 「旧格式会话」只有一条口径，写在这里，别在别处再写一遍
 *
 * ```
 * sessionDir 里有 events.ndjson（0.54 之前的唯一真相源）
 *   且 没有任何 timeline 标记（timeline.manifest / wal.manifest / wal.log 三者皆无）
 * ```
 *
 * 三个标记都算「有 timeline」的理由各不相同，缺一个都会误判：
 * - `timeline.manifest`：写入侧的创建标记（`TimelineWriter#ensureManifest`），最先出现；
 * - `wal.log`：第一条非 chunk 事件真正落盘的证据（manifest 在、wal 空 ⇒ 可以重新分配 seq）；
 * - `wal.manifest`：块级 WAL 的证据（只有 chunk 的会话可能还没有 `wal.log`）。
 *
 * ## 冻结为什么是抛错，而不是「静默只读」
 *
 * 静默只读会让写路径以为写成功了：上层指标（`counters.appended`）、归档调度、发布闸门
 * 会一起等一条永远不会落盘的 seq，UI 上表现为「会话卡住」而不是「会话只读」。
 * 抛 `session_frozen_readonly` 是唯一能被上层稳定映射成用户可读原因的形状
 * （`TimelineErrorCode` 已冻结，不新增同义码）。
 *
 * ## 已知的判定盲区（保守方向，写清楚免得后来人以为它能自己分辨）
 *
 * 「0.54 之后创建、但第一条事件还没进 timeline」的新会话，形态与旧会话**完全一样**
 * （有 `events.ndjson`、没有标记）⇒ 本谓词也会判成旧格式。谁比这个谓词更懂上下文，
 * 谁负责在调用前分辨（例如装配层知道「这个会话是本进程刚建的」）。本模块**不猜**，
 * 也不提供「放行开关」——放行开关就是冻结的缺口。
 *
 * @module @vessel-agent/core/timeline
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMELINE_LAYOUT, TimelineError } from './types.js';

/** 旧链路的唯一真相源文件名（判定的一半）。 */
export const LEGACY_SESSION_LOG = 'events.ndjson';

/**
 * 「这个会话已经有 timeline 了」的三个标记（判定的另一半）。
 *
 * 与 `isLegacyFrozenSessionDir` 的判据同源：任一存在 ⇒ **不是**旧格式会话。
 * 门禁 `check-legacy-readonly` 直接读这个常量，所以新增标记文件必须改这里（不会漂）。
 */
export const TIMELINE_MARKERS = [
  TIMELINE_LAYOUT.timelineManifest,
  TIMELINE_LAYOUT.walManifest,
  TIMELINE_LAYOUT.walLog,
] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个会话是不是**旧格式（只读冻结）**会话。
 *
 * 纯读盘、无副作用：只 `stat` 四个文件名，不创建目录、不建句柄 —— 所以它可以被
 * **读路径**调用（门禁用它解释「为什么这个会话没有 timeline」而不担心把会话改了）。
 */
export async function isLegacyFrozenSessionDir(sessionDir: string): Promise<boolean> {
  if (!(await fileExists(join(sessionDir, LEGACY_SESSION_LOG)))) return false;
  for (const marker of TIMELINE_MARKERS) {
    if (await fileExists(join(sessionDir, marker))) return false;
  }
  return true;
}

/**
 * 写 timeline 之前的唯一闸门：旧格式会话 ⇒ 抛 `session_frozen_readonly`。
 *
 * 幂等、无副作用（除了那 4 次 `stat`）。返回 `undefined` 只表示「可以写」，
 * **不**表示目录已存在 / 配额够 / 权限对 —— 那些失败仍按 `timeline_write_failed` 报。
 */
export async function assertTimelineWritable(sessionDir: string, sessionId: string): Promise<void> {
  if (!(await isLegacyFrozenSessionDir(sessionDir))) return;
  throw new TimelineError(
    'session_frozen_readonly',
    `${sessionId} has legacy events.ndjson and no timeline marker`,
  );
}
