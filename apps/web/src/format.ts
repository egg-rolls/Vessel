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

export type RelativeTimeResult =
  | { key: 'time.justNow' }
  | { key: 'time.minutesAgo'; params: { count: number } }
  | { key: 'time.hoursAgo'; params: { count: number } }
  | { key: 'time.hoursMinutesAgo'; params: { count: number; minutes: number } }
  | { key: 'time.daysAgo'; params: { count: number } };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 相对时间（纯函数，不依赖 i18n）：调用方用返回的 key + params 走 `t()`。
 * 未来时间与 NaN 时间戳按“刚刚”处理。
 */
export function relativeTime(
  ts: number | undefined,
  now: number = Date.now(),
): RelativeTimeResult | null {
  if (ts === undefined || Number.isNaN(ts)) return null;
  const diff = now - ts;
  if (diff < MINUTE_MS) return { key: 'time.justNow' };
  if (diff < HOUR_MS) {
    return { key: 'time.minutesAgo', params: { count: Math.floor(diff / MINUTE_MS) } };
  }
  if (diff < DAY_MS) {
    const count = Math.floor(diff / HOUR_MS);
    const minutes = Math.floor((diff % HOUR_MS) / MINUTE_MS);
    return minutes === 0
      ? { key: 'time.hoursAgo', params: { count } }
      : { key: 'time.hoursMinutesAgo', params: { count, minutes } };
  }
  return { key: 'time.daysAgo', params: { count: Math.floor(diff / DAY_MS) } };
}

/** Token 数量缩写：999 / 1K / 784.4K / 1.2M；非法或负数返回空串。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
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
