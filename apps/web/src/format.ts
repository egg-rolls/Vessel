/** Zero-pad a non-negative integer to the given width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Format an epoch-millisecond timestamp for display in the web console.
 *
 * Uses local time. A timestamp on the same local calendar day as `now`
 * renders as `HH:MM:SS` (or `HH:MM:SS.mmm` with `withMs`); any other day
 * renders as `YYYY-MM-DD HH:MM:SS` (or `YYYY-MM-DD HH:MM:SS.mmm`).
 *
 * `undefined` timestamps render as an empty string.
 */
/** 本地日历日 key（`YYYY-MM-DD`）；用于会话/消息按天分组。 */
export function localDayKey(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** 分组标题：今天/昨天/本地日期。 */
export function localDayLabel(ts: number, now: number = Date.now()): string {
  const key = localDayKey(ts);
  if (!key) return '';
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (key === localDayKey(now)) return '今天';
  if (key === localDayKey(yesterday.getTime())) return '昨天';
  return key;
}

/** 仅显示本地时间 `HH:MM`（逐条消息时间）。 */
export function formatClock(ts: number | undefined): string {
  if (ts === undefined) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}`;
}

export function formatTimestamp(
  ts: number | undefined,
  opts?: { now?: number; withMs?: boolean },
): string {
  if (ts === undefined) return '';

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date(opts?.now ?? Date.now());
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
  const millis = opts?.withMs === true ? `.${pad(date.getMilliseconds(), 3)}` : '';

  if (sameDay) return `${time}${millis}`;

  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
  return `${day} ${time}${millis}`;
}
