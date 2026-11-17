/**
 * 旧格式会话（0.54 之前，只有 `events.ndjson`）在 0.55 起**不再被支持**。
 *
 * ## 这条判据现在只有一个用途：**拒绝**，而不是保护
 *
 * 0.54 时代这里叫 `freeze.ts`：旧会话「只读冻结」，写被拒绝（`session_frozen_readonly`），
 * 读面上被当成空时间线。0.55 把 `events.ndjson` 的读写两条路**全部删掉**之后，「只读」
 * 这个中间态没有意义了 —— 那套文件格式已经没有任何代码能解析它。所以：
 *
 * - **读**：`TimelineEventLog` / `heads()` 一拿到这种目录就抛 `legacy_session_unsupported`。
 *   报成「空会话」是**假事实**（用户会以为历史丢了 / 会话坏了却不知道为什么），
 *   这一条是本模块存在的全部理由；
 * - **写**：写者 `open()` 同样拒绝 —— 那会造出「半新半旧」的目录（同一个会话两套 seq、
 *   两份事实），比直接拒绝难收拾得多。
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
 * ## 用户看到什么（文案即产品）
 *
 * 错误码是 `legacy_session_unsupported`（稳定、可被上层映射成用户可读原因），
 * 文案给出**唯一的出路**：用 0.54 导出 / 迁移，再拿 0.55 打开产物 —— 0.55 自己不读、不写、
 * 也不迁移这种目录。
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
 * 任一存在 ⇒ **不是**旧格式会话。新增标记文件必须改这里，否则旧会话判定会漏（反方向、
 * 更危险）。
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
 * 这个目录是不是**0.54 之前的旧格式会话**。
 *
 * 纯读盘、无副作用：只 `stat` 四个文件名，不创建目录、不建句柄。
 */
export async function isLegacySessionDir(sessionDir: string): Promise<boolean> {
  if (!(await fileExists(join(sessionDir, LEGACY_SESSION_LOG)))) return false;
  for (const marker of TIMELINE_MARKERS) {
    if (await fileExists(join(sessionDir, marker))) return false;
  }
  return true;
}

/**
 * 读或写一个会话目录之前的唯一闸门：旧格式 ⇒ 抛 `legacy_session_unsupported`。
 *
 * 幂等、无副作用（除了那 4 次 `stat`）。返回 `undefined` 只表示「格式是 0.55 支持的那种」，
 * **不**表示目录存在 / 配额够 / 权限对 —— 那些失败按各自的错误码报。
 */
export async function assertSessionFormatSupported(
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  if (!(await isLegacySessionDir(sessionDir))) return;
  throw new TimelineError(
    'legacy_session_unsupported',
    `${sessionId} is still in the pre-0.54 format (only ${LEGACY_SESSION_LOG}, no timeline ` +
      'marker) and 0.55 dropped that format: it will not be read, written or migrated here. ' +
      'Fix: open this data dir with Vessel 0.54 and export/migrate the session there ' +
      '(`vessel session migrate`), then use 0.55 on the result — or point 0.55 at a data dir ' +
      'that no longer contains this session. The directory was left untouched.',
  );
}
